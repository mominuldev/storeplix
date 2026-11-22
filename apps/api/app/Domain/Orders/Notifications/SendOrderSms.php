<?php

namespace App\Domain\Orders\Notifications;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * One shopper SMS for one (order, event), at most once (P5-26, §7):
 * - a per-(order, event) cache lock keeps two copies of the job from sending in parallel;
 * - under the order row lock: skip when the timeline already has "SMS sent" for this event, when the order was
 *   cancelled since (a late "order received" / "confirmed" SMS is never sent for a cancelled order), or when the
 *   monthly allowance (`sms_per_month`) is used up (timeline note);
 * - sms_messages gets the template name only, never the body; "SMS sent" goes on the timeline only after the
 *   provider accepted it. A provider failure marks the message failed and throws, so the queue retries with
 *   backoff; after the last try the timeline says "SMS not sent".
 */
class SendOrderSms implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    /** @var list<int> */
    public array $backoff = [10, 60];

    public function __construct(
        public readonly string $orderId,
        public readonly string $event,
        public readonly ?string $carrier = null,
    ) {}

    public function handle(SmsGateway $gateway, TenantContext $context): void
    {
        $order = Order::query()->find($this->orderId); // tenant-scoped: another tenant's order is "not found" (S18)
        if ($order === null) {
            return;
        }
        $lock = Cache::lock("order-sms:{$order->id}:{$this->event}", 120);
        if (! $lock->get()) {
            $this->release(30); // another copy is sending right now; check again later (dedupe skips it)

            return;
        }

        try {
            $this->sendOnce($order, $gateway, $context);
        } finally {
            $lock->release();
        }
    }

    private function sendOnce(Order $order, SmsGateway $gateway, TenantContext $context): void
    {
        $store = Store::query()->with('primaryDomain')->find($order->store_id);
        $settings = StoreSetting::query()->where('store_id', $order->store_id)->first();
        $language = $settings?->sms_language === 'en' ? 'en' : 'bn';

        $planned = DB::transaction(function () use ($order, $store, $language, $context) {
            /** @var Order $locked */
            $locked = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if (self::alreadySent($locked->id, $this->event)) {
                return null;
            }
            if ($locked->status === Order::CANCELLED && $this->event !== 'order_cancelled') {
                OrderTimeline::record($locked, 'notification', null, 'SMS not sent: the order was cancelled', [
                    'channel' => 'sms', 'event' => $this->event, 'status' => 'skipped',
                ]);

                return null;
            }
            $tenant = $context->tenant();
            $limit = FeatureGate::limit($tenant, Limit::SmsPerMonth);
            if ($limit !== null && FeatureGate::usage($tenant, Limit::SmsPerMonth) >= $limit) {
                OrderTimeline::record($locked, 'notification', null, 'SMS not sent: monthly SMS allowance used', [
                    'channel' => 'sms', 'event' => $this->event, 'status' => 'skipped',
                ]);

                return null;
            }
            $message = SmsMessage::query()->create([
                'tenant_id' => $locked->tenant_id,
                'to' => $locked->customer_phone,
                'purpose' => $this->event,
                'template' => "{$this->event}.{$language}",
                'status' => 'queued',
            ]);

            return [$message, SmsTemplates::render($this->event, $language, SmsTemplates::varsFor($locked, $store, $this->carrier))];
        });
        if ($planned === null) {
            return;
        }

        /** @var SmsMessage $message */
        [$message, $text] = $planned;
        try {
            $result = $gateway->send($message->to, $text);
        } catch (SmsSendFailed $e) {
            $message->update(['status' => 'failed', 'error' => Str::limit($e->getMessage(), 250)]);
            Log::warning('order.sms_failed', ['order_id' => $order->id, 'event' => $this->event, 'attempt' => $this->attempts()]);
            if ($this->attempts() < $this->tries) {
                throw $e; // retried with backoff; nothing was recorded as sent
            }
            OrderTimeline::record($order, 'notification', null, 'SMS not sent: the SMS provider failed', [
                'channel' => 'sms', 'event' => $this->event, 'status' => 'failed', 'sms_message_id' => $message->id,
            ]);

            return;
        }

        $message->update(['status' => 'sent', 'provider_message_id' => $result->message_id]);
        OrderTimeline::record($order, 'notification', null, 'SMS sent: '.SmsTemplates::LABELS[$this->event], [
            'channel' => 'sms', 'event' => $this->event, 'status' => 'sent', 'sms_message_id' => $message->id, 'language' => $language,
        ]);
    }

    public static function alreadySent(string $orderId, string $event): bool
    {
        return OrderEvent::query()->where('order_id', $orderId)->where('type', 'notification')->get()
            ->contains(fn (OrderEvent $e) => ($e->meta['channel'] ?? null) === 'sms' && ($e->meta['event'] ?? null) === $event && ($e->meta['status'] ?? null) === 'sent');
    }

    public function attempts(): int
    {
        return $this->job?->attempts() ?? 1;
    }
}

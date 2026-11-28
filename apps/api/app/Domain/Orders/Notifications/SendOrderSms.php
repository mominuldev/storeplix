<?php

namespace App\Domain\Orders\Notifications;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\PaymentPresenter;
use App\Domain\Payments\PaymentUrls;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Pos\PosReceipts;
use App\Domain\Shared\Support\Money;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSender;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Queue\TenantAware;
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
 *
 * PHASE-8-9A §4.3: in the same order-locked transaction the row is created with its store and reference, the text is
 * rendered from the store's template and sender (§4.4) and SmsCharger pays it (allowance, else SMS credits, else the
 * row stays `skipped` and the timeline says "SMS not sent: monthly SMS allowance and SMS credits used up"). The send
 * carries the masked sender ID; a provider failure refunds the credits of that attempt (each retry is a new row).
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
        public readonly ?string $ref = null,
    ) {}

    public function handle(SmsGateway $gateway, SmsCharger $charger): void
    {
        $order = Order::query()->find($this->orderId); // tenant-scoped: another tenant's order is "not found" (S18)
        if ($order === null) {
            return;
        }
        $lock = Cache::lock("order-sms:{$order->id}:{$this->event}:{$this->ref}", 120);
        if (! $lock->get()) {
            $this->release(30); // another copy is sending right now; check again later (dedupe skips it)

            return;
        }

        try {
            $this->sendOnce($order, $gateway, $charger);
        } finally {
            $lock->release();
        }
    }

    private function sendOnce(Order $order, SmsGateway $gateway, SmsCharger $charger): void
    {
        $store = Store::query()->with('primaryDomain')->find($order->store_id);
        $settings = StoreSetting::query()->where('store_id', $order->store_id)->first();
        $language = $settings?->sms_language === 'en' ? 'en' : 'bn';

        $planned = DB::transaction(function () use ($order, $store, $language, $charger) {
            /** @var Order $locked */
            $locked = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if (self::alreadySent($locked->id, $this->event, $this->ref)) {
                return null;
            }
            if ($locked->status === Order::CANCELLED && $this->event !== 'order_cancelled') {
                OrderTimeline::record($locked, 'notification', null, 'SMS not sent: the order was cancelled', [
                    'channel' => 'sms', 'event' => $this->event, 'status' => 'skipped',
                ]);

                return null;
            }
            $vars = SmsTemplates::varsFor($locked, $store, $this->carrier);
            if ($this->event === SmsTemplates::POS_RECEIPT) {
                // PHASE-8-8D S204: a till sale's receipt, only to the phone stored on the order.
                if (! $locked->isPos() || trim($locked->customer_phone) === '') {
                    return null;
                }
                $vars += PosReceipts::smsVars($locked, $language);
            }
            if ($this->event === 'payment_link') {
                // P5B-28: ref = "{link id}:{send #}"; only an active link is sent (never a paid/expired one).
                $link = PaymentLink::query()->whereKey(explode(':', (string) $this->ref)[0])->where('order_id', $locked->id)->first();
                if ($link === null || PaymentPresenter::linkStatus($link) !== PaymentLink::ACTIVE) {
                    return null;
                }
                $vars += ['amount' => Money::plain((int) $link->amount), 'url' => PaymentUrls::linkUrl($store, PaymentPresenter::linkToken($link))];
            }
            $sender = $store !== null ? SmsSender::for($store) : null;
            $pos = $this->event === SmsTemplates::POS_RECEIPT ? PosSale::query()->where('order_id', $locked->id)->value('id') : null;
            $message = SmsMessage::query()->create([
                'tenant_id' => $locked->tenant_id,
                'store_id' => $locked->store_id,
                'to' => $locked->customer_phone,
                'purpose' => $this->event,
                'template' => "{$this->event}.{$language}",
                'status' => SmsMessage::QUEUED,
                'sender_id' => $sender,
                'reference_type' => $pos !== null ? 'pos_sale' : 'order',
                'reference_id' => $pos ?? $locked->id,
            ]);
            $text = SmsTemplates::render($this->event, $language, $vars, $store);
            if ($charger->charge($message, $text)->skipped()) {
                OrderTimeline::record($locked, 'notification', null, 'SMS not sent: monthly SMS allowance and SMS credits used up', [
                    'channel' => 'sms', 'event' => $this->event, 'status' => 'skipped', 'sms_message_id' => $message->id,
                ]);

                return null;
            }

            return [$message, $text, $sender];
        });
        if ($planned === null) {
            return;
        }

        /** @var SmsMessage $message */
        [$message, $text, $sender] = $planned;
        try {
            $result = $gateway->send($message->to, $text, $sender);
        } catch (SmsSendFailed $e) {
            $message->markFailed(Str::limit($e->getMessage(), 250), $e);
            $charger->refund($message);
            Log::warning('order.sms_failed', ['order_id' => $order->id, 'event' => $this->event, 'attempt' => $this->attempts()]);
            // PHASE-8-9B S225: a timeout may have been accepted by the provider — never sent again.
            if ($e->reason !== SmsSendFailed::TIMEOUT && $this->attempts() < $this->tries) {
                throw $e; // retried with backoff; nothing was recorded as sent
            }
            OrderTimeline::record($order, 'notification', null, 'SMS not sent: the SMS provider failed', [
                'channel' => 'sms', 'event' => $this->event, 'status' => 'failed', 'sms_message_id' => $message->id,
            ]);

            return;
        }

        $message->markSent($result->message_id, $result);
        OrderTimeline::record($order, 'notification', null, 'SMS sent: '.SmsTemplates::LABELS[$this->event], [
            'channel' => 'sms', 'event' => $this->event, 'status' => 'sent', 'sms_message_id' => $message->id, 'language' => $language,
        ] + ($this->ref !== null ? ['ref' => $this->ref] : []));
    }

    public static function alreadySent(string $orderId, string $event, ?string $ref = null): bool
    {
        return OrderEvent::query()->where('order_id', $orderId)->where('type', 'notification')->get()
            ->contains(fn (OrderEvent $e) => ($e->meta['channel'] ?? null) === 'sms' && ($e->meta['event'] ?? null) === $event
                && ($e->meta['status'] ?? null) === 'sent' && ($e->meta['ref'] ?? null) === $ref);
    }

    public function attempts(): int
    {
        return $this->job?->attempts() ?? 1;
    }
}

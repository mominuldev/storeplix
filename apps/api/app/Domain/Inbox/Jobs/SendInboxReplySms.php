<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Jobs;

use App\Domain\Inbox\InboxSms;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Inbox\WidgetService;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;

/**
 * The reply SMS (PHASE-8-8E §9.5, P88E-12, S239), 120 s after a reply, on queue `sms`. Under the conversation lock:
 * skip `seen` when the shopper saw the reply meanwhile, `throttled` when an SMS went out for this conversation in the
 * last 30 minutes, `not_applicable` when the thread is not textable any more (blocked, channel off). Otherwise a 7-day
 * magic link and one SMS charged through SmsCharger (purpose `inbox_reply`, reference `conversation`): `sent`,
 * `no_credits` or `failed` (credits refunded by the charger).
 */
class SendInboxReplySms implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public function __construct(public readonly string $messageId)
    {
        $this->onQueue('sms');
    }

    public function handle(InboxSms $sms, WidgetService $widget, InboxVersion $version): void
    {
        $plan = DB::transaction(function () use ($widget) {
            $message = InboxMessage::query()->whereKey($this->messageId)->where('kind', InboxMessage::REPLY)->first();
            if ($message === null) {
                return null;
            }
            $conversation = InboxConversation::query()->whereKey($message->conversation_id)->lockForUpdate()->first();
            $message = InboxMessage::query()->whereKey($this->messageId)->lockForUpdate()->first();
            if ($conversation === null || $message === null || $message->sms_status !== 'pending') {
                return null;
            }
            $settings = InboxSetting::query()->where('store_id', $conversation->store_id)->first();
            $on = $conversation->channel === InboxConversation::WEB_CHAT ? (bool) $settings?->web_chat_enabled : (bool) $settings?->order_messages_enabled;
            $status = match (true) {
                $conversation->customer_seen_at !== null && $conversation->customer_seen_at->gte($message->created_at) => 'seen',
                $conversation->isBlocked() || ! $conversation->textable() || ! $on => 'not_applicable',
                $conversation->reply_sms_sent_at !== null && $conversation->reply_sms_sent_at->gt(now()->subMinutes((int) config('inbox.reply_sms_throttle_minutes', 30))) => 'throttled',
                default => null,
            };
            if ($status !== null) {
                $message->forceFill(['sms_status' => $status])->save();

                return ['done', $message->store_id];
            }
            $previous = $conversation->reply_sms_sent_at;
            $conversation->forceFill(['reply_sms_sent_at' => now()])->save(); // claims the 30-minute slot

            return ['send', $conversation, $message, $previous, $widget->magicLink($conversation)];
        });
        if ($plan === null) {
            return;
        }
        if ($plan[0] === 'done') {
            $version->bump($plan[1]);

            return;
        }
        /** @var InboxConversation $conversation */
        [, $conversation, $message, $previous, $code] = $plan;
        $store = Store::query()->with('primaryDomain')->findOrFail($conversation->store_id);
        $host = $store->primaryDomain?->hostname;
        $result = $host === null ? 'failed' : $sms->sendReply($store, $conversation, "https://{$host}/m/{$code}");

        DB::transaction(function () use ($conversation, $message, $previous, $result) {
            InboxMessage::query()->whereKey($message->id)->update(['sms_status' => $result, 'updated_at' => now()]);
            if ($result !== 'sent') {
                InboxConversation::query()->whereKey($conversation->id)->update(['reply_sms_sent_at' => $previous]); // the slot was not used
            }
        });
        $version->bump($conversation->store_id);
    }
}

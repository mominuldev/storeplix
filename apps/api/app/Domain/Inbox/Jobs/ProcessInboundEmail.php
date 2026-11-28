<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Jobs;

use App\Domain\Inbox\ConversationService;
use App\Domain\Inbox\InboxAttachments;
use App\Domain\Inbox\InboxSettingsService;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Inbox\Support\InboxText;
use App\Domain\Inbox\Support\ReplyAddress;
use App\Domain\Inbox\Support\ThreadKey;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\RateLimiter;

/**
 * One inbound email (PHASE-8-8E §11.2 step 4, S243) on the `webhooks` queue: channel off → drop; loop / bulk / auto
 * mail → drop; per-sender limit 20/h per store; dedupe by Message-ID (unique per store); text part (else HTML → text),
 * quoted history trimmed, ≤ 4000. Target `c-` = that conversation when the sender is its contact, else like the store
 * address; `o-` = thread `email:{sender}` with the order linked; store address = thread `email:{sender}`. Identity
 * `email` only with SPF/DKIM pass (only then auto-linked to a customer). Dropped mail leaves nothing behind.
 */
class ProcessInboundEmail implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    /**
     * @param  array{kind: string, target_id: string, from: string, from_name: string|null, subject: string, text: string, html: string|null, message_id: string|null, in_reply_to: string|null, authenticated: bool, auto: bool}  $mail
     * @param  list<string>  $attachmentIds
     */
    public function __construct(
        public readonly string $storeId,
        public readonly array $mail,
        public readonly array $attachmentIds = [],
        public readonly int $rejected = 0,
    ) {
        $this->onQueue('webhooks');
    }

    public function handle(ConversationService $conversations, InboxAttachments $attachments): void
    {
        $files = InboxAttachment::query()->whereIn('id', $this->attachmentIds)->whereNull('message_id')->get();
        $drop = function (string $reason) use ($attachments, $files) {
            DB::transaction(fn () => $attachments->remove($files));
            Log::info('inbox.inbound_dropped', ['store_id' => $this->storeId, 'reason' => $reason]);
        };
        $store = Store::query()->find($this->storeId);
        $settings = InboxSetting::query()->where('store_id', $this->storeId)->first();
        if ($store === null || $settings === null || ! $settings->email_enabled || ! InboxSettingsService::emailAvailable()) {
            $drop('channel_off');

            return;
        }
        $from = strtolower($this->mail['from']);
        if ($this->mail['auto'] || $from === '' || str_ends_with($from, '@'.ReplyAddress::domain())) {
            $drop('auto');

            return;
        }
        $key = 'inbox-inbound-sender:'.$this->storeId.'|'.hash('sha256', $from);
        if (RateLimiter::tooManyAttempts($key, 20)) {
            $drop('sender_limit');

            return;
        }
        RateLimiter::hit($key, 3600);
        $messageId = $this->mail['message_id'];
        if ($messageId !== null && InboxMessage::query()->where('store_id', $this->storeId)->where('email_message_id', $messageId)->exists()) {
            $drop('duplicate');

            return;
        }
        $text = trim($this->mail['text']) !== '' ? $this->mail['text'] : InboxText::htmlToText((string) $this->mail['html']);
        $body = InboxText::trimEmail(InboxText::clean($text), InboxMessage::BODY_MAX);
        if ($body === '' && $files->isEmpty()) {
            $drop('empty');

            return;
        }

        try {
            DB::transaction(function () use ($conversations, $files, $from, $body, $messageId, $store) {
                $authenticated = (bool) $this->mail['authenticated'];
                $conversation = null;
                if ($this->mail['kind'] === ReplyAddress::CONVERSATION) {
                    $candidate = InboxConversation::query()->whereKey($this->mail['target_id'])->where('store_id', $store->id)->lockForUpdate()->first();
                    $conversation = $candidate !== null && strtolower((string) $candidate->contact_email) === $from ? $candidate : null;
                }
                $order = $this->mail['kind'] === ReplyAddress::ORDER
                    ? Order::query()->whereKey($this->mail['target_id'])->where('store_id', $store->id)->first() : null;
                $conversation ??= $conversations->lockOrCreate($store->id, InboxConversation::EMAIL, ThreadKey::email($from), [
                    'identity' => $authenticated ? InboxConversation::IDENTITY_EMAIL : InboxConversation::EMAIL_UNVERIFIED,
                    'contact_name' => $this->mail['from_name'] ?: explode('@', $from)[0],
                    'contact_email' => $from,
                    'customer_id' => $authenticated ? ConversationService::customerFor($store->id, null, $from) : null,
                    'subject' => $this->mail['subject'] !== '' ? $this->mail['subject'] : null,
                ]);
                if ($authenticated && $conversation->identity === InboxConversation::EMAIL_UNVERIFIED) {
                    $conversation->identity = InboxConversation::IDENTITY_EMAIL;
                    $conversation->customer_id ??= ConversationService::customerFor($store->id, null, $from);
                }
                if ($conversation->subject === null && $this->mail['subject'] !== '') {
                    $conversation->subject = InboxText::line($this->mail['subject'], 200);
                }
                if ($messageId !== null) {
                    $conversation->last_inbound_message_id = $messageId;
                }
                $message = $conversations->appendCustomer($conversation, $body, $files, null, $messageId, $this->rejected);
                if ($message !== null && $order !== null && $conversation->order_id === null && $conversation->channel !== InboxConversation::ORDER) {
                    $conversation->forceFill(['order_id' => $order->id])->save();
                    $conversations->system($conversation, 'order_linked', ['order_number' => $order->number], null);
                }
            });
        } catch (UniqueConstraintViolationException) {
            $drop('duplicate'); // a parallel copy of the same Message-ID won (S246)
        }
    }
}

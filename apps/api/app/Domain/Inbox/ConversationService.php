<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Customers\Models\Customer;
use App\Domain\Identity\Models\User;
use App\Domain\Inbox\Jobs\SendInboxEmailReply;
use App\Domain\Inbox\Jobs\SendInboxReplySms;
use App\Domain\Inbox\Mail\InboxAssignedMail;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxRead;
use App\Domain\Inbox\Models\InboxSavedReply;
use App\Domain\Inbox\Support\InboxText;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Conversations and messages (PHASE-8-8E §5–§6, §9.4, §10, §11.2). Every write takes the conversation row FOR UPDATE
 * first and nothing else of the Inbox (§3.1); the SMS charger lock is only ever taken inside the reply-SMS job. Channel
 * dispatch (email job, delayed reply SMS job) and the poll version bump happen after commit. Inside the tenant context.
 */
final class ConversationService
{
    public function __construct(
        private readonly InboxVersion $version,
        private readonly InboxAttachments $attachments,
        private readonly InboxMembers $members,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /**
     * §3.1 / S246: the conversation of (store, channel, thread_key), created when missing, locked FOR UPDATE. Two
     * concurrent first messages of one thread end on ONE row (`ON CONFLICT DO NOTHING` on the thread unique key, then
     * the lock). Call inside a transaction.
     *
     * @param  array<string, mixed>  $attrs  contact_name, contact_phone, contact_email, identity, customer_id, order_id, subject, context, source_path
     */
    public function lockOrCreate(string $storeId, string $channel, string $threadKey, array $attrs): InboxConversation
    {
        $now = now();
        DB::table('inbox_conversations')->insertOrIgnore([
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => $this->context->requireId(),
            'store_id' => $storeId,
            'channel' => $channel,
            'thread_key' => $threadKey,
            'status' => InboxConversation::OPEN,
            'identity' => $attrs['identity'],
            'customer_id' => $attrs['customer_id'] ?? null,
            'order_id' => $attrs['order_id'] ?? null,
            'contact_name' => mb_substr(InboxText::line($attrs['contact_name'] ?? '', 120) ?: 'Customer', 0, 120),
            'contact_phone' => $attrs['contact_phone'] ?? null,
            'contact_email' => isset($attrs['contact_email']) ? mb_substr((string) $attrs['contact_email'], 0, 254) : null,
            'subject' => isset($attrs['subject']) ? InboxText::line((string) $attrs['subject'], 200) : null,
            'context' => isset($attrs['context']) ? json_encode($attrs['context'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
            'source_path' => $attrs['source_path'] ?? null,
            'preview' => '',
            'last_message_at' => $now,
            'messages_count' => 0,
            'revision' => 1,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return InboxConversation::query()->where('store_id', $storeId)->where('channel', $channel)->where('thread_key', $threadKey)
            ->lockForUpdate()->firstOrFail();
    }

    public function lock(string $id): InboxConversation
    {
        return InboxConversation::query()->whereKey($id)->lockForUpdate()->firstOrFail();
    }

    /**
     * A shopper message (§9.4, §10, §11.2): stored with its attachments, the conversation reopened for its assignee
     * (P88E-5), preview / last_customer_message_* updated. A blocked conversation swallows it: null, attachments
     * deleted (the shopper sees success, P88E-13). A replayed client_id / Message-ID returns the stored row.
     *
     * @param  Collection<int, InboxAttachment>  $files
     */
    public function appendCustomer(InboxConversation $conversation, string $body, Collection $files, ?string $clientId = null, ?string $emailMessageId = null, int $rejected = 0): ?InboxMessage
    {
        if ($conversation->isBlocked()) {
            $this->attachments->remove($files);

            return null;
        }
        if ($clientId !== null && ($existing = InboxMessage::query()->where('conversation_id', $conversation->id)->where('client_id', $clientId)->first()) !== null) {
            $this->attachments->remove($files);

            return $existing;
        }
        if ($rejected > 0) {
            $body = trim($body."\n\n[".$rejected.' attachment'.($rejected === 1 ? ' was' : 's were').' not accepted]');
        }

        $message = new InboxMessage;
        $message->forceFill([
            'store_id' => $conversation->store_id,
            'conversation_id' => $conversation->id,
            'kind' => InboxMessage::CUSTOMER,
            'body' => mb_substr($body, 0, InboxMessage::BODY_MAX),
            'client_id' => $clientId,
            'email_message_id' => $emailMessageId,
        ])->save();
        $this->attach($files, $message);

        $previous = $conversation->status;
        $conversation->forceFill([
            'status' => InboxConversation::OPEN,
            'closed_at' => null,
            'closed_by' => null,
            'preview' => self::preview($body, $files->count()),
            'last_message_at' => $message->created_at,
            'last_customer_message_id' => $message->id,
            'last_customer_message_at' => $message->created_at,
            'messages_count' => $conversation->messages_count + 1,
            'revision' => $conversation->revision + 1,
        ])->save();
        if ($previous !== InboxConversation::OPEN && $conversation->messages_count > 1) {
            $this->system($conversation, 'reopened', ['assignee' => UserRef::of($conversation->assignee)], null);
        }
        $this->version->bump($conversation->store_id);

        return $message;
    }

    /**
     * §6.2 POST messages: a reply or an internal note. Replays of one client_id → [stored row, false].
     *
     * @param  array{kind: string, body: string, attachment_ids?: list<string>, client_id: string, saved_reply_id?: string|null}  $input
     * @return array{0: InboxMessage, 1: bool}
     */
    public function send(Store $store, string $conversationId, User $user, array $input): array
    {
        [$message, $created, $dispatch] = DB::transaction(function () use ($store, $conversationId, $user, $input) {
            $conversation = $this->lock($conversationId);
            $existing = InboxMessage::query()->where('conversation_id', $conversation->id)->where('client_id', $input['client_id'])->first();
            if ($existing !== null) {
                return [$existing, false, null];
            }
            $files = $this->attachments->claim($input['attachment_ids'] ?? [], $store->id, $user->id);
            $body = InboxText::clean($input['body']);
            if ($body === '' && $files->isEmpty()) {
                throw ValidationException::withMessages(['body' => ['Write a message or attach a file.']]);
            }
            $savedReply = ($input['saved_reply_id'] ?? null) === null ? null
                : InboxSavedReply::query()->whereKey(strtolower((string) $input['saved_reply_id']))->where('store_id', $store->id)->lockForUpdate()->first();
            $reply = $input['kind'] === InboxMessage::REPLY;

            $message = new InboxMessage;
            $message->forceFill([
                'store_id' => $conversation->store_id,
                'conversation_id' => $conversation->id,
                'kind' => $reply ? InboxMessage::REPLY : InboxMessage::NOTE,
                'author_user_id' => $user->id,
                'body' => $body,
                'client_id' => $input['client_id'],
                'saved_reply_id' => $savedReply?->id,
            ]);
            $dispatch = null;
            if ($reply) {
                [$message->delivery_status, $message->sms_status, $dispatch] = $this->replyChannel($conversation, $store);
            }
            $message->save();
            $this->attach($files, $message);

            if ($reply) {
                if ($conversation->status === InboxConversation::CLOSED) {
                    $conversation->forceFill(['status' => InboxConversation::OPEN, 'closed_at' => null, 'closed_by' => null]);
                    $this->system($conversation, 'reopened', ['assignee' => UserRef::of($conversation->assignee)], $user->id);
                }
                $conversation->forceFill([
                    'first_response_at' => $conversation->first_response_at ?? $message->created_at,
                    'preview' => self::preview($body, $files->count()),
                    'last_message_at' => $message->created_at,
                ]);
                if ($savedReply !== null) {
                    $savedReply->forceFill(['use_count' => $savedReply->use_count + 1, 'last_used_at' => now()])->save();
                }
            }
            $conversation->forceFill(['messages_count' => $conversation->messages_count + 1, 'revision' => $conversation->revision + 1])->save();
            $this->version->bump($conversation->store_id);

            return [$message, true, $dispatch];
        });

        if ($dispatch === 'email') {
            SendInboxEmailReply::dispatch($message->id)->forTenant($this->context->requireId())->afterCommit();
        } elseif ($dispatch === 'sms') {
            SendInboxReplySms::dispatch($message->id)->forTenant($this->context->requireId())
                ->delay(now()->addSeconds((int) config('inbox.reply_sms_delay_seconds', 120)))->afterCommit();
        }

        return [$message, $created];
    }

    /**
     * §6.2 reply effects per channel: email → `queued` + the email job; verified web chat / order with a phone, not
     * blocked, channel still on → `pending` + the reply SMS job; otherwise SMS `not_applicable` (S239).
     *
     * @return array{0: string|null, 1: string|null, 2: string|null}
     */
    private function replyChannel(InboxConversation $conversation, Store $store): array
    {
        if ($conversation->channel === InboxConversation::EMAIL) {
            return $conversation->contact_email !== null ? ['queued', null, 'email'] : ['failed', null, null];
        }
        $settings = app(InboxSettingsService::class)->find($store->id);
        $on = $conversation->channel === InboxConversation::WEB_CHAT ? (bool) $settings?->web_chat_enabled : (bool) $settings?->order_messages_enabled;
        if ($on && ! $conversation->isBlocked() && $conversation->textable()) {
            return [null, 'pending', 'sms'];
        }

        return [null, 'not_applicable', null];
    }

    /** §6.4 assign (P88E-4): the assignee must hold inbox.manage now; the new assignee is emailed (never on self-assign). */
    public function assign(Store $store, string $conversationId, User $actor, ?string $assigneeId, ?int $revision): InboxConversation
    {
        $assigneeId = $assigneeId === null ? null : strtolower($assigneeId);
        if ($assigneeId !== null && ! $this->members->holds($assigneeId)) {
            throw new ApiException(422, 'inbox_assignee_invalid', 'This teammate can’t be assigned: they don’t have the Inbox permission.');
        }
        $notify = null;
        $conversation = DB::transaction(function () use ($conversationId, $actor, $assigneeId, $revision, &$notify) {
            $conversation = $this->lock($conversationId);
            self::assertRevision($conversation, $revision);
            if ($conversation->assignee_id === $assigneeId) {
                return $conversation;
            }
            $from = $conversation->assignee_id;
            $assignee = $assigneeId === null ? null : User::query()->find($assigneeId);
            $conversation->forceFill(['assignee_id' => $assigneeId, 'revision' => $conversation->revision + 1])->save();
            $this->system($conversation, $assigneeId === null ? 'unassigned' : 'assigned', ['assignee' => UserRef::of($assignee)], $actor->id);
            $this->audit->log('inbox_conversation.assigned', null, ['conversation_id' => $conversation->id, 'from' => $from, 'to' => $assigneeId]);
            $this->version->bump($conversation->store_id);
            if ($assignee !== null && $assignee->id !== $actor->id) {
                $notify = $assignee;
            }

            return $conversation;
        });
        if ($notify instanceof User && $notify->email) {
            $preview = (string) InboxMessage::query()->where('conversation_id', $conversation->id)->whereIn('kind', InboxMessage::SHOPPER_KINDS)
                ->orderByDesc('id')->value('body');
            DB::afterCommit(fn () => Mail::to($notify->email)->queue(new InboxAssignedMail(
                $store->name, (string) $actor->name, $conversation->contact_name, InboxText::line($preview, 160), $conversation->id,
            )));
        }

        return $conversation;
    }

    /** §6.4 status (P88E-5): same status = no-op; system rows pending / closed / reopened. */
    public function setStatus(string $conversationId, User $actor, string $status, ?int $revision): InboxConversation
    {
        return DB::transaction(function () use ($conversationId, $actor, $status, $revision) {
            $conversation = $this->lock($conversationId);
            self::assertRevision($conversation, $revision);
            if ($conversation->status === $status) {
                return $conversation;
            }
            $conversation->forceFill([
                'status' => $status,
                'closed_at' => $status === InboxConversation::CLOSED ? now() : null,
                'closed_by' => $status === InboxConversation::CLOSED ? $actor->id : null,
                'revision' => $conversation->revision + 1,
            ])->save();
            $event = match ($status) {
                InboxConversation::CLOSED => 'closed',
                InboxConversation::PENDING => 'pending',
                default => 'reopened',
            };
            $this->system($conversation, $event, ['assignee' => UserRef::of($conversation->assignee)], $actor->id);
            $this->version->bump($conversation->store_id);

            return $conversation;
        });
    }

    /** §6.4 link / unlink the order (not on order conversations: 422 inbox_order_locked; another store's order → 404). */
    public function linkOrder(Store $store, string $conversationId, User $actor, ?string $orderId): InboxConversation
    {
        $order = null;
        if ($orderId !== null) {
            $order = Order::query()->whereKey(strtolower($orderId))->where('store_id', $store->id)->first()
                ?? throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return DB::transaction(function () use ($conversationId, $actor, $order) {
            $conversation = $this->lock($conversationId);
            if ($conversation->channel === InboxConversation::ORDER) {
                throw new ApiException(422, 'inbox_order_locked', 'The order of an order conversation can’t be changed.');
            }
            if ($conversation->order_id === $order?->id) {
                return $conversation;
            }
            $previous = $conversation->order_id === null ? null : Order::query()->whereKey($conversation->order_id)->value('number');
            $conversation->forceFill(['order_id' => $order?->id, 'revision' => $conversation->revision + 1])->save();
            $this->system($conversation, $order !== null ? 'order_linked' : 'order_unlinked', ['order_number' => $order?->number ?? $previous], $actor->id);
            $this->version->bump($conversation->store_id);

            return $conversation;
        });
    }

    public function block(string $conversationId, User $actor, bool $block): InboxConversation
    {
        return DB::transaction(function () use ($conversationId, $actor, $block) {
            $conversation = $this->lock($conversationId);
            if ($conversation->isBlocked() === $block) {
                return $conversation;
            }
            $conversation->forceFill([
                'blocked_at' => $block ? now() : null,
                'blocked_by' => $block ? $actor->id : null,
                'revision' => $conversation->revision + 1,
            ])->save();
            $this->system($conversation, $block ? 'blocked' : 'unblocked', null, $actor->id);
            $this->audit->log($block ? 'inbox_conversation.blocked' : 'inbox_conversation.unblocked', null, ['conversation_id' => $conversation->id, 'channel' => $conversation->channel]);
            $this->version->bump($conversation->store_id);

            return $conversation;
        });
    }

    /** §6.4 read (P88E-9): never moves backwards. */
    public function markRead(string $conversationId, User $user, string $messageId): void
    {
        DB::transaction(function () use ($conversationId, $user, $messageId) {
            $conversation = $this->lock($conversationId);
            $messageId = strtolower($messageId);
            if (! InboxMessage::query()->where('conversation_id', $conversation->id)->whereKey($messageId)->exists()) {
                throw ValidationException::withMessages(['last_read_message_id' => ['This message is not in the conversation.']]);
            }
            $read = InboxRead::query()->where('conversation_id', $conversation->id)->where('user_id', $user->id)->first();
            if ($read === null) {
                $read = new InboxRead;
                $read->forceFill(['store_id' => $conversation->store_id, 'conversation_id' => $conversation->id, 'user_id' => $user->id]);
            } elseif (strcmp($read->last_read_message_id, $messageId) >= 0) {
                return;
            }
            $shopReadUpTo = InboxPresenter::shopReadUpTo($conversation);
            $read->forceFill(['last_read_message_id' => $messageId, 'read_at' => now()])->save();
            $this->version->bumpReader($conversation->store_id, $user->id);
            if ($shopReadUpTo === null || strcmp($messageId, $shopReadUpTo) > 0) {
                // the shop read further: shopper threads show "Seen" under their message (new ETag for the widget poll)
                $this->version->bump($conversation->store_id);
            }
        });
    }

    /** §6.4 delete (P88E-18): rows now, storage objects after commit; audited with a masked snapshot. */
    public function delete(string $conversationId): void
    {
        DB::transaction(function () use ($conversationId) {
            $conversation = $this->lock($conversationId);
            $messageIds = InboxMessage::query()->where('conversation_id', $conversation->id)->pluck('id')->all();
            $files = InboxAttachment::query()->whereIn('message_id', $messageIds)->get();
            $this->attachments->remove($files);
            InboxConversation::query()->whereKey($conversation->id)->delete();
            $this->audit->log('inbox_conversation.deleted', null, [
                'conversation_id' => $conversation->id,
                'channel' => $conversation->channel,
                'contact' => $conversation->contact_phone !== null ? InboxText::maskPhone($conversation->contact_phone) : (self::maskEmail($conversation->contact_email) ?? '•••'),
                'messages_count' => count($messageIds),
                'attachments_count' => $files->count(),
            ]);
            $this->version->bump($conversation->store_id);
        });
    }

    /** P88E-22: the customer of a proven identity — verified phone or authenticated email (exactly one match). */
    public static function customerFor(string $storeId, ?string $phone, ?string $email): ?string
    {
        if ($phone !== null) {
            return Customer::query()->where('store_id', $storeId)->where('phone', $phone)->orderBy('created_at')->value('id');
        }
        if ($email !== null) {
            $ids = Customer::query()->where('store_id', $storeId)->whereRaw('lower(email) = ?', [strtolower($email)])->limit(2)->pluck('id');

            return $ids->count() === 1 ? (string) $ids->first() : null;
        }

        return null;
    }

    /** @param array<string, mixed>|null $meta */
    public function system(InboxConversation $conversation, string $event, ?array $meta, ?string $actorId): InboxMessage
    {
        $row = new InboxMessage;
        $row->forceFill([
            'store_id' => $conversation->store_id,
            'conversation_id' => $conversation->id,
            'kind' => InboxMessage::SYSTEM,
            'author_user_id' => $actorId,
            'body' => null,
            'system_event' => $event,
            'system_meta' => $meta,
        ])->save();

        return $row;
    }

    /** @param Collection<int, InboxAttachment> $files */
    private function attach(Collection $files, InboxMessage $message): void
    {
        if ($files->isNotEmpty()) {
            InboxAttachment::query()->whereIn('id', $files->pluck('id')->all())->update(['message_id' => $message->id]);
        }
    }

    private static function assertRevision(InboxConversation $conversation, ?int $revision): void
    {
        if ($revision !== null && $revision !== $conversation->revision) {
            throw new ApiException(409, 'revision_conflict', 'This conversation changed meanwhile. Reload and try again.');
        }
    }

    public static function preview(string $body, int $files): string
    {
        $line = InboxText::line($body, 160);
        if ($line === '' && $files > 0) {
            return $files === 1 ? 'Sent an attachment' : "Sent {$files} attachments";
        }

        return $line;
    }

    public static function maskEmail(?string $email): ?string
    {
        if ($email === null || ! str_contains($email, '@')) {
            return null;
        }
        [$local, $domain] = explode('@', $email, 2);

        return mb_substr($local, 0, 1).'•••@'.$domain;
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Support\Phone;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Query\JoinClause;
use Illuminate\Support\Facades\DB;

/**
 * Reads of the merchant Inbox (PHASE-8-8E §5, P88E-9): the list with cursor and per-status counts, the summary
 * (sidebar badge) and per-member unread counts. A conversation is unread for a member when its
 * `last_customer_message_id` is after their `last_read_message_id` (ULIDs sort by time).
 */
final class InboxQuery
{
    public const PER_PAGE = 30;

    /**
     * Shared filters: scope (mine_unassigned | mine | unassigned | all), channel list, q (contact name, phone digits,
     * email, order number; `%` / `_` literal).
     *
     * @param  list<string>  $channels
     * @return Builder<InboxConversation>
     */
    public static function filtered(string $storeId, string $userId, string $scope, array $channels, ?string $q): Builder
    {
        $query = InboxConversation::query()->where('store_id', $storeId);
        match ($scope) {
            'mine' => $query->where('assignee_id', $userId),
            'unassigned' => $query->whereNull('assignee_id'),
            'all' => null,
            default => $query->where(fn ($w) => $w->where('assignee_id', $userId)->orWhereNull('assignee_id')),
        };
        if ($channels !== []) {
            $query->whereIn('channel', $channels);
        }
        $q = trim((string) $q);
        if (mb_strlen($q) >= 2) {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($q)).'%';
            $digits = preg_replace('/\D/', '', $q) ?? '';
            $msisdn = Phone::bdMsisdn($q);
            $orders = Order::query()->where('store_id', $storeId)->whereRaw("lower(number) like ? escape '\\'", [$like])->limit(50)->pluck('id')->all();
            $query->where(function ($w) use ($like, $digits, $msisdn, $orders) {
                $w->whereRaw("lower(contact_name) like ? escape '\\'", [$like])
                    ->orWhereRaw("lower(coalesce(contact_email, '')) like ? escape '\\'", [$like]);
                if ($msisdn !== null) {
                    $w->orWhere('contact_phone', $msisdn);
                } elseif (strlen($digits) >= 4) {
                    $w->orWhere('contact_phone', 'like', '%'.$digits.'%');
                }
                if ($orders !== []) {
                    $w->orWhereIn('order_id', $orders);
                }
            });
        }

        return $query;
    }

    /**
     * Unread customer messages per conversation for a member (capped later at 99).
     *
     * @param  list<string>  $conversationIds
     * @return array<string, int>
     */
    public static function unreadCounts(array $conversationIds, string $userId): array
    {
        if ($conversationIds === []) {
            return [];
        }

        return InboxMessage::query()
            ->leftJoin('inbox_reads as r', function (JoinClause $join) use ($userId) {
                $join->on('r.conversation_id', '=', 'inbox_messages.conversation_id')->on('r.tenant_id', '=', 'inbox_messages.tenant_id')
                    ->where('r.user_id', '=', $userId);
            })
            ->whereIn('inbox_messages.conversation_id', $conversationIds)
            ->where('inbox_messages.kind', InboxMessage::CUSTOMER)
            ->where(fn ($w) => $w->whereNull('r.last_read_message_id')->orWhereColumn('inbox_messages.id', '>', 'r.last_read_message_id'))
            ->groupBy('inbox_messages.conversation_id')
            ->select('inbox_messages.conversation_id', DB::raw('count(*) as unread'))
            ->pluck('unread', 'conversation_id')->map(fn ($v) => (int) $v)->all();
    }

    /** @return array<string, mixed> InboxSummary */
    public static function summary(string $storeId, string $userId): array
    {
        $counts = InboxConversation::query()->where('store_id', $storeId)->whereNull('blocked_at')
            ->selectRaw("sum(case when status = 'open' then 1 else 0 end) as open_count")
            ->selectRaw("sum(case when status = 'pending' then 1 else 0 end) as pending_count")
            ->selectRaw("sum(case when status = 'open' and assignee_id = ? then 1 else 0 end) as mine_open", [$userId])
            ->selectRaw("sum(case when status = 'open' and assignee_id is null then 1 else 0 end) as unassigned_open")
            ->first();
        $unread = InboxConversation::query()->where('inbox_conversations.store_id', $storeId)
            ->where('inbox_conversations.status', '<>', InboxConversation::CLOSED)->whereNull('inbox_conversations.blocked_at')
            ->where(fn ($w) => $w->where('inbox_conversations.assignee_id', $userId)->orWhereNull('inbox_conversations.assignee_id'))
            ->whereNotNull('inbox_conversations.last_customer_message_id')
            ->leftJoin('inbox_reads as r', function (JoinClause $join) use ($userId) {
                $join->on('r.conversation_id', '=', 'inbox_conversations.id')->on('r.tenant_id', '=', 'inbox_conversations.tenant_id')
                    ->where('r.user_id', '=', $userId);
            })
            ->where(fn ($w) => $w->whereNull('r.last_read_message_id')->orWhereColumn('inbox_conversations.last_customer_message_id', '>', 'r.last_read_message_id'))
            ->count();
        $settings = InboxSetting::query()->where('store_id', $storeId)->first();

        return [
            'unread' => $unread,
            'open' => (int) ($counts->open_count ?? 0),
            'pending' => (int) ($counts->pending_count ?? 0),
            'mine_open' => (int) ($counts->mine_open ?? 0),
            'unassigned_open' => (int) ($counts->unassigned_open ?? 0),
            'channels_enabled' => [
                'web_chat' => (bool) $settings?->web_chat_enabled,
                'order_messages' => (bool) $settings?->order_messages_enabled,
                'email' => (bool) $settings?->email_enabled && InboxSettingsService::emailAvailable(),
            ],
        ];
    }

    /** Shopper-side unread: shop replies after the shopper last looked. */
    public static function shopperUnread(?InboxConversation $c): int
    {
        if ($c === null) {
            return 0;
        }

        return InboxMessage::query()->where('conversation_id', $c->id)->where('kind', InboxMessage::REPLY)
            ->when($c->customer_seen_at !== null, fn ($q) => $q->where('created_at', '>', $c->customer_seen_at))
            ->count();
    }
}

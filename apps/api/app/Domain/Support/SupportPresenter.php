<?php

declare(strict_types=1);

namespace App\Domain\Support;

use App\Domain\Help\HelpPresenter;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\Models\SupportTicketAttachment;
use App\Domain\Support\Models\SupportTicketMessage;
use Illuminate\Support\Collection;

/**
 * Merchant ticket shapes (openapi 1.26.0 `support`). S251: every message / attachment read here is filtered with
 * `kind IN ('merchant','staff','system')`; notes and note attachments never appear. Staff appear as
 * "{first name} · Store Plix" without ids.
 */
final class SupportPresenter
{
    /** @return array{id: string|null, name: string, is_staff: bool}|null SupportPerson */
    public static function person(?string $userId, string $kind, Collection $users): ?array
    {
        if ($kind === SupportTicketMessage::STAFF || $kind === SupportTicketMessage::NOTE) {
            $u = $userId === null ? null : $users->get($userId);

            return ['id' => null, 'name' => SupportNotifier::firstName((string) ($u->name ?? '')).' · Store Plix', 'is_staff' => true];
        }
        if ($userId === null) {
            return null;
        }
        $u = $users->get($userId);

        return ['id' => $userId, 'name' => (string) ($u->name ?? 'Former member'), 'is_staff' => false];
    }

    /** @return array<string, mixed> SupportAttachment */
    public static function attachment(SupportTicketAttachment $a, ?string $mediaStatus): array
    {
        return [
            'id' => $a->id,
            'filename' => $a->filename,
            'mime' => $a->mime,
            'size_bytes' => $a->size_bytes,
            'kind' => SupportAttachments::kind($a->mime),
            'status' => $mediaStatus === Media::READY ? 'ready' : 'processing',
        ];
    }

    /**
     * @param  list<SupportTicket>  $tickets
     * @return list<array<string, mixed>> SupportTicketSummary rows
     */
    public static function summaries(array $tickets): array
    {
        if ($tickets === []) {
            return [];
        }
        $ids = array_map(fn (SupportTicket $t) => $t->id, $tickets);
        $last = self::lastReplies($ids);
        $users = User::query()->whereIn('id', array_values(array_unique(array_filter([
            ...array_map(fn (SupportTicket $t) => $t->requester_id, $tickets),
            ...array_map(fn ($m) => $m->author_user_id, array_values($last)),
        ]))))->get(['id', 'name'])->keyBy('id');

        return array_map(fn (SupportTicket $t) => self::summary($t, $last[$t->id] ?? null, $users), $tickets);
    }

    /**
     * Latest merchant / staff message per ticket (never a note).
     *
     * @param  list<string>  $ticketIds
     * @return array<string, SupportTicketMessage>
     */
    public static function lastReplies(array $ticketIds): array
    {
        $out = [];
        $rows = SupportTicketMessage::query()->whereIn('ticket_id', $ticketIds)
            ->whereIn('kind', [SupportTicketMessage::MERCHANT, SupportTicketMessage::STAFF])
            ->orderBy('created_at')->orderBy('id')->get(['id', 'ticket_id', 'kind', 'author_user_id', 'created_at']);
        foreach ($rows as $m) {
            $out[$m->ticket_id] = $m;
        }

        return $out;
    }

    /** @return array<string, mixed> SupportTicketSummary */
    public static function summary(SupportTicket $t, ?SupportTicketMessage $last, Collection $users): array
    {
        return [
            'id' => $t->id,
            'number' => $t->number,
            'reference' => $t->reference(),
            'subject' => $t->subject,
            'category' => $t->category,
            'priority' => $t->priority,
            'status' => $t->status,
            'related_order' => $t->order_number === null ? null : ['id' => $t->order_id, 'number' => $t->order_number],
            'requester' => UserRef::of($t->requester_id === null ? null : $users->get($t->requester_id)),
            'last_reply' => $last === null ? null : ['author' => self::person($last->author_user_id, $last->kind, $users), 'at' => HelpPresenter::ts($last->created_at)],
            'created_at' => HelpPresenter::ts($t->created_at),
            'updated_at' => HelpPresenter::ts($t->updated_at),
        ];
    }

    /** @return array<string, mixed> SupportTicket (merchant detail) */
    public static function ticket(SupportTicket $t, bool $ordersView, bool $canManage): array
    {
        $last = self::lastReplies([$t->id])[$t->id] ?? null;
        $users = User::query()->whereIn('id', array_values(array_filter([$t->requester_id, $t->assignee_id, $last?->author_user_id])))->get(['id', 'name'])->keyBy('id');
        $assignee = $t->assignee_id === null ? null : $users->get($t->assignee_id);
        $order = $ordersView && $t->order_id !== null ? Order::query()->find($t->order_id) : null;
        $store = Store::query()->first();
        $domain = $store === null ? null : StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->value('hostname');

        return self::summary($t, $last, $users) + [
            'assignee_name' => $assignee === null ? null : SupportNotifier::firstName((string) $assignee->name),
            'order_card' => $order === null ? null : [
                'id' => $order->id, 'number' => $order->number, 'status' => $order->status, 'total_amount' => (int) $order->total_amount,
                'currency' => $order->currency, 'placed_at' => HelpPresenter::ts($order->placed_at),
            ],
            'shop' => ['name' => (string) ($store->name ?? ''), 'domain' => $domain],
            'first_staff_reply_at' => HelpPresenter::ts($t->first_staff_reply_at),
            'first_reply_seconds' => $t->first_staff_reply_at === null ? null : max(0, (int) $t->created_at->diffInSeconds($t->first_staff_reply_at)),
            'resolved_at' => HelpPresenter::ts($t->resolved_at),
            'resolution_seconds' => $t->resolved_at === null ? null : max(0, (int) $t->created_at->diffInSeconds($t->resolved_at)),
            'closed_at' => HelpPresenter::ts($t->closed_at),
            'rating' => self::rating($t),
            'files' => self::files($t, false),
            'can' => [
                'reply' => $canManage && ! $t->isClosed(),
                'resolve' => $canManage && in_array($t->status, [SupportTicket::OPEN, SupportTicket::AWAITING_MERCHANT, SupportTicket::AWAITING_SUPPORT], true),
                'rate' => $canManage && $t->canRate(),
            ],
            'revision' => $t->revision,
        ];
    }

    /** @return array{rating: int, comment: string|null, rated_at: string|null}|null */
    public static function rating(SupportTicket $t): ?array
    {
        return $t->csat_rating === null ? null : ['rating' => $t->csat_rating, 'comment' => $t->csat_comment, 'rated_at' => HelpPresenter::ts($t->csat_rated_at)];
    }

    /**
     * Ticket files: attachments of messages of the allowed kinds (S251: notes excluded unless $withNotes).
     *
     * @return list<array<string, mixed>>
     */
    public static function files(SupportTicket $t, bool $withNotes): array
    {
        $kinds = $withNotes ? [...SupportTicketMessage::MERCHANT_KINDS, SupportTicketMessage::NOTE] : SupportTicketMessage::MERCHANT_KINDS;
        $messageIds = SupportTicketMessage::query()->where('ticket_id', $t->id)->whereIn('kind', $kinds)->pluck('id')->all();
        $rows = $messageIds === [] ? collect() : SupportTicketAttachment::query()->where('ticket_id', $t->id)->whereIn('message_id', $messageIds)
            ->orderBy('created_at')->orderBy('id')->get();
        $status = Media::query()->whereIn('id', $rows->pluck('media_id')->all())->pluck('status', 'id');

        return $rows->map(fn (SupportTicketAttachment $a) => self::attachment($a, $status[$a->media_id] ?? null))->values()->all();
    }

    /**
     * Merchant thread (S251: kinds merchant / staff / system only, merchant-visible system events only).
     *
     * @return list<array<string, mixed>> SupportTicketMessage[]
     */
    public static function messages(SupportTicket $t): array
    {
        $messages = SupportTicketService::merchantMessages($t);
        $attachments = SupportTicketAttachment::query()->whereIn('message_id', $messages->pluck('id')->all())->orderBy('id')->get()->groupBy('message_id');
        $status = Media::query()->whereIn('id', $attachments->flatten()->pluck('media_id')->all())->pluck('status', 'id');
        $users = User::query()->whereIn('id', $messages->pluck('author_user_id')->filter()->unique()->values()->all())->get(['id', 'name'])->keyBy('id');

        return $messages->map(function (SupportTicketMessage $m) use ($attachments, $status, $users) {
            $system = null;
            if ($m->kind === SupportTicketMessage::SYSTEM) {
                $meta = $m->system_meta ?? [];
                $system = [
                    'event' => $m->system_event,
                    'status' => $meta['to'] ?? null,
                    'actor_name' => match ($m->system_event) {
                        'assigned' => isset($meta['assignee_name']) ? $meta['assignee_name'].' · Store Plix' : null,
                        'status_changed' => ($meta['by'] ?? null) === 'staff' ? ($meta['actor_name'] ?? 'Store Plix').' · Store Plix' : null,
                        default => null,
                    },
                ];
            }

            return [
                'id' => $m->id,
                'kind' => $m->kind,
                'body' => $m->kind === SupportTicketMessage::SYSTEM ? null : $m->body,
                'author' => $m->kind === SupportTicketMessage::SYSTEM ? null : self::person($m->author_user_id, $m->kind, $users),
                'attachments' => ($attachments->get($m->id) ?? collect())->map(fn (SupportTicketAttachment $a) => self::attachment($a, $status[$a->media_id] ?? null))->values()->all(),
                'system' => $system,
                'created_at' => HelpPresenter::ts($m->created_at),
            ];
        })->values()->all();
    }
}

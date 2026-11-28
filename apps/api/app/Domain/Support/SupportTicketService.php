<?php

declare(strict_types=1);

namespace App\Domain\Support;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Support\Mail\SupportTicketStaffMail;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\Models\SupportTicketAttachment;
use App\Domain\Support\Models\SupportTicketMessage;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Ticket writes (PHASE-8-9C §8–§9, P89C-14 – P89C-19, S259). Every write takes the ticket row FOR UPDATE first (§3.3)
 * and runs inside the ticket's tenant context (merchant requests: the request tenant; staff: TenantContext::run).
 * Mails are sent after commit.
 */
final class SupportTicketService
{
    public function __construct(
        private readonly SupportAttachments $attachments,
        private readonly SupportNotifier $notifier,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /**
     * POST /help/tickets. A replayed client_id → [stored ticket, false].
     *
     * @param  array{category: string, subject: string, description: string, priority?: string|null, order_id?: string|null, attachment_ids?: list<string>, client_id: string}  $input
     * @return array{0: SupportTicket, 1: bool}
     */
    public function create(User $user, array $input): array
    {
        $clientId = strtolower((string) $input['client_id']);
        [$ticket, $created, $description] = DB::transaction(function () use ($user, $input, $clientId) {
            $tenantId = $this->context->requireId();
            if (DB::getDriverName() === 'pgsql') {
                DB::select('SELECT pg_advisory_xact_lock(hashtext(?))', ['support-tickets:'.$tenantId]);
            }
            $existing = SupportTicket::query()->where('client_id', $clientId)->first();
            if ($existing !== null) {
                return [$existing, false, ''];
            }
            if (SupportTicket::query()->where('status', '<>', SupportTicket::CLOSED)->count() >= SupportTicket::OPEN_LIMIT) {
                throw new ApiException(422, 'support_ticket_limit_reached', 'You have '.SupportTicket::OPEN_LIMIT.' open tickets. Close or wait for some to be solved first.');
            }
            $order = null;
            if (($orderId = $input['order_id'] ?? null) !== null && $orderId !== '') {
                if (! $this->context->allows(Permission::OrdersView)) {
                    throw ValidationException::withMessages(['order_id' => ['You need permission to view orders to link one.']]);
                }
                $order = preg_match('/^[0-9A-Za-z]{26}$/', (string) $orderId) === 1 ? Order::query()->whereKey(strtolower((string) $orderId))->first() : null;
                if ($order === null) {
                    throw ValidationException::withMessages(['order_id' => ['Choose an order of this shop.']]);
                }
            }
            $files = $this->attachments->claim((array) ($input['attachment_ids'] ?? []), SupportTicketAttachment::BY_MERCHANT, $user->id, null);
            $now = now();
            $description = SupportText::clean((string) $input['description']);

            $ticket = new SupportTicket;
            $ticket->forceFill([
                'store_id' => Store::query()->value('id'),
                'number' => self::nextNumber(),
                'requester_id' => $user->id,
                'category' => $input['category'],
                'subject' => SupportText::line((string) $input['subject'], 150),
                'priority' => $input['priority'] ?? 'normal',
                'status' => SupportTicket::OPEN,
                'order_id' => $order?->id,
                'order_number' => $order?->number,
                'client_id' => $clientId,
                'messages_count' => 1,
                'last_message_at' => $now,
                'last_merchant_reply_at' => $now,
                'waiting_since' => $now,
                'revision' => 1,
            ])->save();
            $this->system($ticket, 'created', ['by' => 'merchant'], $user->id);
            $message = $this->message($ticket, SupportTicketMessage::MERCHANT, $user->id, $description, null);
            $this->attachments->attach($files, $message);

            return [$ticket, true, $description];
        });
        if ($created) {
            $this->audit->log('support_ticket.created', $ticket, ['reference' => $ticket->reference(), 'category' => $ticket->category, 'priority' => $ticket->priority], $user);
            $fresh = $ticket->fresh() ?? $ticket;
            $this->notifier->received($fresh, $description);
        }

        return [$ticket->fresh() ?? $ticket, $created];
    }

    /**
     * POST /help/tickets/{ticket}/messages (P89C-16): merchant reply; reopens a resolved ticket; closed → 409.
     *
     * @param  array{body: string, attachment_ids?: list<string>, client_id: string}  $input
     * @return array{0: SupportTicketMessage, 1: bool}
     */
    public function reply(string $ticketId, User $user, array $input): array
    {
        $clientId = strtolower((string) $input['client_id']);
        [$message, $created, $event, $ticket] = DB::transaction(function () use ($ticketId, $user, $input, $clientId) {
            $ticket = $this->lock($ticketId);
            $existing = SupportTicketMessage::query()->where('ticket_id', $ticket->id)->where('client_id', $clientId)->first();
            if ($existing !== null) {
                return [$existing, false, null, $ticket];
            }
            if ($ticket->isClosed()) {
                throw new ApiException(409, 'support_ticket_closed', 'This ticket is closed. Open a new ticket.');
            }
            $files = $this->attachments->claim((array) ($input['attachment_ids'] ?? []), SupportTicketAttachment::BY_MERCHANT, $user->id, $ticket->id);
            $body = SupportText::clean((string) $input['body']);
            $now = now();
            $event = SupportTicketStaffMail::REPLIED;
            if ($ticket->status === SupportTicket::RESOLVED) {
                $event = SupportTicketStaffMail::REOPENED;
                $ticket->forceFill(['status' => SupportTicket::AWAITING_SUPPORT, 'resolved_at' => null, 'resolved_by_type' => null,
                    'reopened_count' => $ticket->reopened_count + 1, 'waiting_since' => $now]);
                $this->system($ticket, 'reopened', ['by' => 'merchant'], $user->id);
            } elseif ($ticket->status === SupportTicket::AWAITING_MERCHANT) {
                $ticket->forceFill(['status' => SupportTicket::AWAITING_SUPPORT, 'waiting_since' => $now]);
            }
            $message = $this->message($ticket, SupportTicketMessage::MERCHANT, $user->id, $body, $clientId);
            $this->attachments->attach($files, $message);
            $ticket->forceFill([
                'last_message_at' => $now,
                'last_merchant_reply_at' => $now,
                'messages_count' => $ticket->messages_count + 1,
                'revision' => $ticket->revision + 1,
            ])->save();

            return [$message, true, $event, $ticket];
        });
        if ($created && $event !== null) {
            $this->notifier->staff($ticket, $event, (string) $message->body);
        }

        return [$message, $created];
    }

    /** POST resolve (Mark as solved): open / awaiting_* → resolved; resolved → no-op; closed → 409. */
    public function resolveByMerchant(string $ticketId, User $user): SupportTicket
    {
        return DB::transaction(function () use ($ticketId, $user) {
            $ticket = $this->lock($ticketId);
            if ($ticket->isClosed()) {
                throw new ApiException(409, 'support_ticket_closed', 'This ticket is closed. Open a new ticket.');
            }
            if ($ticket->status === SupportTicket::RESOLVED) {
                return $ticket;
            }
            $from = $ticket->status;
            $ticket->forceFill(['status' => SupportTicket::RESOLVED, 'resolved_at' => now(), 'resolved_by_type' => 'merchant', 'waiting_since' => null,
                'revision' => $ticket->revision + 1])->save();
            $this->system($ticket, 'status_changed', ['from' => $from, 'to' => SupportTicket::RESOLVED, 'by' => 'merchant'], $user->id);

            return $ticket;
        });
    }

    /** PUT rating (P89C-17): 1–5 + comment within 14 days of resolve; changeable; else 409. */
    public function rate(string $ticketId, User $user, int $rating, ?string $comment): SupportTicket
    {
        return DB::transaction(function () use ($ticketId, $user, $rating, $comment) {
            $ticket = $this->lock($ticketId);
            if (! $ticket->canRate()) {
                throw new ApiException(409, 'support_rating_unavailable', 'This ticket can no longer be rated.');
            }
            $comment = $comment === null ? '' : SupportText::clean($comment);
            $ticket->forceFill(['csat_rating' => $rating, 'csat_comment' => $comment === '' ? null : mb_substr($comment, 0, 500),
                'csat_rated_at' => now(), 'revision' => $ticket->revision + 1])->save();
            $this->system($ticket, 'rated', ['rating' => $rating], $user->id);

            return $ticket;
        });
    }

    // ---------------- staff (inside TenantContext::run of the ticket's tenant) ----------------

    /**
     * POST /admin/support/tickets/{ticket}/messages: a reply (emails the merchant, moves the ticket) or an internal note.
     *
     * @param  array{kind: string, body: string, attachment_ids?: list<string>, client_id: string, status?: string|null}  $input
     * @return array{0: SupportTicketMessage, 1: bool}
     */
    public function staffSend(string $ticketId, User $staff, array $input): array
    {
        $clientId = strtolower((string) $input['client_id']);
        $reply = $input['kind'] === 'reply';
        [$message, $created, $ticket, $resolved] = DB::transaction(function () use ($ticketId, $staff, $input, $clientId, $reply) {
            $ticket = $this->lock($ticketId);
            $existing = SupportTicketMessage::query()->where('ticket_id', $ticket->id)->where('client_id', $clientId)->first();
            if ($existing !== null) {
                return [$existing, false, $ticket, false];
            }
            if ($reply && $ticket->isClosed()) {
                throw new ApiException(409, 'support_ticket_closed', 'This ticket is closed.');
            }
            $files = $this->attachments->claim((array) ($input['attachment_ids'] ?? []), SupportTicketAttachment::BY_STAFF, $staff->id, $ticket->id);
            $body = SupportText::clean((string) $input['body']);
            $message = $this->message($ticket, $reply ? SupportTicketMessage::STAFF : SupportTicketMessage::NOTE, $staff->id, $body, $clientId);
            $this->attachments->attach($files, $message);
            $resolved = false;
            $now = now();
            if ($reply) {
                $to = (string) ($input['status'] ?? SupportTicket::AWAITING_MERCHANT);
                $from = $ticket->status;
                $ticket->forceFill([
                    'status' => $to,
                    'first_staff_reply_at' => $ticket->first_staff_reply_at ?? $now,
                    'last_staff_reply_at' => $now,
                    'last_message_at' => $now,
                    'waiting_since' => $to === SupportTicket::AWAITING_SUPPORT ? ($ticket->waiting_since ?? $now) : null,
                ]);
                if ($to === SupportTicket::RESOLVED && $from !== SupportTicket::RESOLVED) {
                    $ticket->forceFill(['resolved_at' => $now, 'resolved_by_type' => 'staff']);
                    $this->system($ticket, 'status_changed', ['from' => $from, 'to' => $to, 'by' => 'staff', 'actor_name' => SupportNotifier::firstName((string) $staff->name)], $staff->id);
                    $resolved = true;
                } elseif ($to !== SupportTicket::RESOLVED) {
                    $ticket->forceFill(['resolved_at' => null, 'resolved_by_type' => null]);
                }
            }
            $ticket->forceFill(['messages_count' => $ticket->messages_count + 1, 'revision' => $ticket->revision + 1])->save();

            return [$message, true, $ticket, $resolved];
        });
        if ($created && $reply) {
            $resolved ? $this->notifier->resolved($ticket) : $this->notifier->replied($ticket, (string) $message->body);
        }

        return [$message, $created];
    }

    /** POST assign (P89C-18): any active staff holding manage_support, or null (unassign). */
    public function assign(string $ticketId, User $staff, ?string $assigneeId, ?int $revision): SupportTicket
    {
        $assignee = null;
        if ($assigneeId !== null) {
            $assignee = preg_match('/^[0-9A-Za-z]{26}$/', $assigneeId) === 1 ? User::query()->find(strtolower($assigneeId)) : null;
            if (! $assignee instanceof User || ! SupportNotifier::activeSupportStaff($assignee)) {
                throw new ApiException(422, 'support_assignee_invalid', 'Choose an active support team member.');
            }
        }
        [$ticket, $changed] = DB::transaction(function () use ($ticketId, $staff, $assignee, $revision) {
            $ticket = $this->lock($ticketId);
            $this->assertRevision($ticket, $revision);
            if ($ticket->assignee_id === $assignee?->id) {
                return [$ticket, false];
            }
            $ticket->forceFill(['assignee_id' => $assignee?->id, 'revision' => $ticket->revision + 1])->save();
            $this->system($ticket, $assignee === null ? 'unassigned' : 'assigned', [
                'assignee_name' => $assignee === null ? null : SupportNotifier::firstName((string) $assignee->name),
                'assignee_id' => $assignee?->id,
                'actor_name' => SupportNotifier::firstName((string) $staff->name),
            ], $staff->id);

            return [$ticket, true];
        });
        if ($changed) {
            $this->audit->log('support_ticket.assigned', $ticket, ['reference' => $ticket->reference(), 'assignee_id' => $assignee?->id], $staff, platform: true);
            if ($assignee !== null) {
                $this->notifier->assigned($ticket, $assignee, $staff);
            }
        }

        return $ticket;
    }

    /** POST status (P89C-16 staff transitions). Same status = no-op; closed is final; staff never set `open`. */
    public function setStatus(string $ticketId, User $staff, string $status, ?int $revision): SupportTicket
    {
        [$ticket, $from] = DB::transaction(function () use ($ticketId, $staff, $status, $revision) {
            $ticket = $this->lock($ticketId);
            $this->assertRevision($ticket, $revision);
            $from = $ticket->status;
            if ($from === $status) {
                return [$ticket, null];
            }
            if ($from === SupportTicket::CLOSED || $status === SupportTicket::OPEN) {
                throw new ApiException(409, 'invalid_state_transition', $from === SupportTicket::CLOSED ? 'A closed ticket is final.' : 'A ticket can’t be set back to new.');
            }
            $now = now();
            $values = ['status' => $status, 'revision' => $ticket->revision + 1];
            $values['waiting_since'] = $status === SupportTicket::AWAITING_SUPPORT ? $now : null;
            if ($status === SupportTicket::RESOLVED) {
                $values += ['resolved_at' => $now, 'resolved_by_type' => 'staff'];
            } elseif ($status === SupportTicket::CLOSED) {
                $values += ['closed_at' => $now];
            } else {
                $values += ['resolved_at' => null, 'resolved_by_type' => null];
            }
            $ticket->forceFill($values)->save();
            $this->system($ticket, 'status_changed', ['from' => $from, 'to' => $status, 'by' => 'staff', 'actor_name' => SupportNotifier::firstName((string) $staff->name)], $staff->id);

            return [$ticket, $from];
        });
        if ($from !== null) {
            $this->audit->log('support_ticket.status_changed', $ticket, ['reference' => $ticket->reference(), 'from' => $from, 'to' => $status], $staff, platform: true);
            if ($status === SupportTicket::RESOLVED) {
                $this->notifier->resolved($ticket);
            }
        }

        return $ticket;
    }

    /** PATCH priority / category (revision required); each change writes a system row. */
    public function update(string $ticketId, User $staff, ?string $priority, ?string $category, int $revision): SupportTicket
    {
        return DB::transaction(function () use ($ticketId, $staff, $priority, $category, $revision) {
            $ticket = $this->lock($ticketId);
            $this->assertRevision($ticket, $revision);
            $actor = SupportNotifier::firstName((string) $staff->name);
            $changed = false;
            if ($priority !== null && $priority !== $ticket->priority) {
                $this->system($ticket, 'priority_changed', ['from' => $ticket->priority, 'to' => $priority, 'actor_name' => $actor], $staff->id);
                $ticket->priority = $priority;
                $changed = true;
            }
            if ($category !== null && $category !== $ticket->category) {
                $this->system($ticket, 'category_changed', ['from' => $ticket->category, 'to' => $category, 'actor_name' => $actor], $staff->id);
                $ticket->category = $category;
                $changed = true;
            }
            if ($changed) {
                $ticket->forceFill(['revision' => $ticket->revision + 1])->save();
            }

            return $ticket;
        });
    }

    /** P89C-18: unassign a staff member (lost manage_support or disabled) from this tenant's not-closed tickets. */
    public function unassignStaff(string $userId): int
    {
        $count = 0;
        foreach (SupportTicket::query()->where('assignee_id', $userId)->where('status', '<>', SupportTicket::CLOSED)->pluck('id') as $id) {
            DB::transaction(function () use ($id, $userId, &$count) {
                $ticket = $this->lock((string) $id);
                if ($ticket->assignee_id !== $userId) {
                    return;
                }
                $ticket->forceFill(['assignee_id' => null, 'revision' => $ticket->revision + 1])->save();
                $this->system($ticket, 'unassigned', ['assignee_id' => $userId, 'reason' => 'staff_inactive'], null);
                $count++;
            });
        }

        return $count;
    }

    /** `support:close-resolved`: resolved for ≥ 7 days → closed (`auto_closed` row). Inside the tenant. */
    public function autoClose(string $ticketId): bool
    {
        return DB::transaction(function () use ($ticketId) {
            $ticket = SupportTicket::query()->whereKey($ticketId)->lockForUpdate()->first();
            if ($ticket === null || $ticket->status !== SupportTicket::RESOLVED || $ticket->resolved_at === null
                || $ticket->resolved_at->gt(now()->subDays(SupportTicket::AUTO_CLOSE_DAYS))) {
                return false;
            }
            $ticket->forceFill(['status' => SupportTicket::CLOSED, 'closed_at' => now(), 'waiting_since' => null, 'revision' => $ticket->revision + 1])->save();
            $this->system($ticket, 'auto_closed', [], null);

            return true;
        });
    }

    // ---------------------------------------------------------------------------------------------------------------

    public function lock(string $id): SupportTicket
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? SupportTicket::query()->whereKey(strtolower($id))->lockForUpdate()->first() : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    private function assertRevision(SupportTicket $ticket, ?int $revision): void
    {
        if ($revision !== null && $revision !== $ticket->revision) {
            throw new ApiException(409, 'revision_conflict', 'This ticket changed meanwhile. Reload and try again.');
        }
    }

    private function message(SupportTicket $ticket, string $kind, ?string $authorId, string $body, ?string $clientId): SupportTicketMessage
    {
        $m = new SupportTicketMessage;
        $m->forceFill([
            'ticket_id' => $ticket->id,
            'kind' => $kind,
            'author_user_id' => $authorId,
            'body' => mb_substr($body, 0, SupportTicketMessage::BODY_MAX),
            'client_id' => $clientId,
            'created_at' => now(),
        ])->save();

        return $m;
    }

    /** @param array<string, mixed> $meta */
    private function system(SupportTicket $ticket, string $event, array $meta, ?string $actorId): SupportTicketMessage
    {
        $m = new SupportTicketMessage;
        $m->forceFill([
            'ticket_id' => $ticket->id,
            'kind' => SupportTicketMessage::SYSTEM,
            'author_user_id' => $actorId,
            'body' => null,
            'system_event' => $event,
            'system_meta' => $meta === [] ? null : $meta,
            'created_at' => now(),
        ])->save();

        return $m;
    }

    /** Global `T-{number}`: a Postgres sequence from 1001; sqlite: max + 1 inside the (serialised) transaction. */
    private static function nextNumber(): int
    {
        if (DB::getDriverName() === 'pgsql') {
            return (int) DB::selectOne("SELECT nextval('support_ticket_number_seq') AS n")->n;
        }

        return max(1000, (int) DB::table('support_tickets')->max('number')) + 1;
    }

    /** @return Collection<int, SupportTicketMessage> */
    public static function merchantMessages(SupportTicket $ticket): Collection
    {
        return SupportTicketMessage::query()->where('ticket_id', $ticket->id)
            ->whereIn('kind', SupportTicketMessage::MERCHANT_KINDS)
            ->where(fn ($q) => $q->where('kind', '<>', SupportTicketMessage::SYSTEM)->orWhereIn('system_event', SupportTicketMessage::MERCHANT_EVENTS))
            ->orderBy('created_at')->orderBy('id')->limit(500)->get();
    }
}

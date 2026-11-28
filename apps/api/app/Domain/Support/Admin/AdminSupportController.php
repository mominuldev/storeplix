<?php

declare(strict_types=1);

namespace App\Domain\Support\Admin;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Help\HelpPresenter;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Support\Http\Controllers\SupportAttachmentController;
use App\Domain\Support\Http\Requests\ReplySupportTicketRequest;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\Models\SupportTicketAttachment;
use App\Domain\Support\Models\SupportTicketMessage;
use App\Domain\Support\SupportAttachments;
use App\Domain\Support\SupportPresenter;
use App\Domain\Support\SupportTicketService;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * `/admin/support/*` (PHASE-8-9C §9; `platform.can:manage_support`). Never reads X-Tenant-Id: lists and counts come
 * from SupportQueue on the platform connection; every per-ticket action resolves the ticket there and then runs inside
 * TenantContext::run($ticket->tenant_id) (`// cross-tenant: support ticket action`).
 */
class AdminSupportController
{
    public function __construct(
        private readonly SupportQueue $queue,
        private readonly SupportTicketService $tickets,
        private readonly SupportOrderCard $orderCard,
        private readonly TenantContext $context,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $input = $request->validate([
            'filter' => ['sometimes', 'array'],
            'filter.status' => ['sometimes', 'nullable', 'string', 'max:120', self::commaIn(SupportTicket::STATUSES)],
            'filter.assignee' => ['sometimes', 'nullable', 'string', 'max:26'],
            'filter.priority' => ['sometimes', 'nullable', 'string', 'max:60', self::commaIn(SupportTicket::PRIORITIES)],
            'filter.category' => ['sometimes', 'nullable', 'string', 'max:300', self::commaIn(SupportTicket::CATEGORIES)],
            'filter.q' => ['sometimes', 'nullable', 'string', 'min:2', 'max:150'],
            'sort' => ['sometimes', 'nullable', Rule::in(SupportQueue::SORTS)],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $staff = AdminBillingController::staff($request);
        $page = $this->queue->page((array) ($input['filter'] ?? []), (string) ($input['sort'] ?? 'waiting'), (int) ($input['per_page'] ?? 25), $staff);

        return AdminPresenter::paginated($page, SupportQueue::summaries($page->getCollection()->all()), [
            'counts' => $this->queue->counts($staff),
            'stats' => $this->queue->stats(),
        ]);
    }

    public function assignees(Request $request): JsonResponse
    {
        return AdminPresenter::json(['data' => $this->queue->assignees(AdminBillingController::staff($request))]);
    }

    public function show(Request $request, string $ticket): JsonResponse
    {
        $row = SupportQueue::locate($ticket);

        return AdminPresenter::json(['data' => $this->present($row, AdminBillingController::staff($request))]);
    }

    public function messages(string $ticket): JsonResponse
    {
        $row = SupportQueue::locate($ticket);

        // cross-tenant: support ticket action (read the thread inside the ticket's tenant)
        return AdminPresenter::json(['data' => $this->context->run($row->tenant_id, fn () => self::messageRows($row))]);
    }

    public function send(ReplySupportTicketRequest $request, string $ticket): JsonResponse
    {
        $row = SupportQueue::locate($ticket);
        $staff = AdminBillingController::staff($request);
        /** @var array{kind: string, body: string, attachment_ids?: list<string>, client_id: string, status?: string|null} $input */
        $input = $request->validated();

        // cross-tenant: support ticket action
        [$data, $created] = $this->context->run($row->tenant_id, function () use ($row, $staff, $input) {
            [$message, $created] = $this->tickets->staffSend($row->id, $staff, $input);
            $one = collect(self::messageRows($row))->firstWhere('id', $message->id);

            return [$one, $created];
        });

        return AdminPresenter::json(['data' => $data], $created ? 201 : 200);
    }

    public function assign(Request $request, string $ticket): JsonResponse
    {
        $input = $request->validate(['assignee_id' => ['present', 'nullable', 'string', 'max:26'], 'revision' => ['sometimes', 'nullable', 'integer', 'min:1']]);
        $row = SupportQueue::locate($ticket);
        $staff = AdminBillingController::staff($request);
        // cross-tenant: support ticket action
        $this->context->run($row->tenant_id, fn () => $this->tickets->assign($row->id, $staff, $input['assignee_id'] ?? null, isset($input['revision']) ? (int) $input['revision'] : null));

        return AdminPresenter::json(['data' => $this->present(SupportQueue::locate($row->id), $staff)]);
    }

    public function status(Request $request, string $ticket): JsonResponse
    {
        $input = $request->validate(['status' => ['required', Rule::in(SupportTicket::STATUSES)], 'revision' => ['sometimes', 'nullable', 'integer', 'min:1']]);
        $row = SupportQueue::locate($ticket);
        $staff = AdminBillingController::staff($request);
        // cross-tenant: support ticket action
        $this->context->run($row->tenant_id, fn () => $this->tickets->setStatus($row->id, $staff, (string) $input['status'], isset($input['revision']) ? (int) $input['revision'] : null));

        return AdminPresenter::json(['data' => $this->present(SupportQueue::locate($row->id), $staff)]);
    }

    public function update(Request $request, string $ticket): JsonResponse
    {
        $input = $request->validate([
            'priority' => ['sometimes', 'nullable', Rule::in(SupportTicket::PRIORITIES)],
            'category' => ['sometimes', 'nullable', Rule::in(SupportTicket::CATEGORIES)],
            'revision' => ['required', 'integer', 'min:1'],
        ]);
        $row = SupportQueue::locate($ticket);
        $staff = AdminBillingController::staff($request);
        // cross-tenant: support ticket action
        $this->context->run($row->tenant_id, fn () => $this->tickets->update($row->id, $staff, $input['priority'] ?? null, $input['category'] ?? null, (int) $input['revision']));

        return AdminPresenter::json(['data' => $this->present(SupportQueue::locate($row->id), $staff)]);
    }

    /** POST …/attachments: stored in the ticket tenant's private media (`// cross-tenant: support reply attachment`). */
    public function upload(Request $request, string $ticket, SupportAttachments $attachments): JsonResponse
    {
        $request->validate(['file' => ['required', 'file']]);
        /** @var UploadedFile $file */
        $file = $request->file('file');
        $row = SupportQueue::locate($ticket);
        $staff = AdminBillingController::staff($request);
        $info = $attachments->inspect($file);
        if (is_string($info)) {
            throw ValidationException::withMessages(['file' => [$info]]);
        }

        // cross-tenant: support reply attachment
        $data = $this->context->run($row->tenant_id, function () use ($attachments, $file, $info, $staff, $row) {
            $a = $attachments->store($file, $info, SupportTicketAttachment::BY_STAFF, $staff->id, $row->id);
            $status = Media::query()->whereKey($a->media_id)->value('status');

            return SupportPresenter::attachment($a, is_string($status) ? $status : null);
        });

        return AdminPresenter::json(['data' => $data], 201);
    }

    /** GET …/attachments/{attachment}: streams a file of THIS ticket (notes included) with the P89C-15 headers. */
    public function attachment(string $ticket, string $attachment, TenantStorage $storage): StreamedResponse
    {
        $row = SupportQueue::locate($ticket);

        // cross-tenant: support ticket action (the file is read as its tenant, under that tenant's storage prefix)
        return $this->context->run($row->tenant_id, function () use ($row, $attachment, $storage) {
            $a = preg_match('/^[0-9A-Za-z]{26}$/', $attachment) === 1
                ? SupportTicketAttachment::query()->whereKey(strtolower($attachment))->where('ticket_id', $row->id)->first() : null;

            return SupportAttachmentController::stream($a, $storage);
        });
    }

    /** @return array<string, mixed> AdminSupportTicket */
    private function present(SupportTicket $t, User $staff): array
    {
        $shops = SupportQueue::shops([$t->tenant_id]);
        $card = $this->orderCard->for($t, $staff);

        // cross-tenant: support ticket action (thread summary and files inside the ticket's tenant)
        [$summary, $files] = $this->context->run($t->tenant_id, function () use ($t, $shops) {
            $last = SupportPresenter::lastReplies([$t->id])[$t->id] ?? null;
            $users = User::query()->whereIn('id', array_values(array_filter([$t->requester_id, $t->assignee_id, $last?->author_user_id])))->get(['id', 'name', 'email'])->keyBy('id');

            return [SupportQueue::summary($t, $shops, $last, $users) + ['requester_email' => $t->requester_id === null ? null : $users->get($t->requester_id)?->email],
                SupportPresenter::files($t, true)];
        });

        return $summary + [
            'order_card' => $card,
            'first_staff_reply_at' => HelpPresenter::ts($t->first_staff_reply_at),
            'last_staff_reply_at' => HelpPresenter::ts($t->last_staff_reply_at),
            'last_merchant_reply_at' => HelpPresenter::ts($t->last_merchant_reply_at),
            'resolved_at' => HelpPresenter::ts($t->resolved_at),
            'resolution_seconds' => $t->resolved_at === null ? null : max(0, (int) $t->created_at->diffInSeconds($t->resolved_at)),
            'closed_at' => HelpPresenter::ts($t->closed_at),
            'reopened_count' => $t->reopened_count,
            'rating' => SupportPresenter::rating($t),
            'files' => $files,
            'can' => ['reply' => ! $t->isClosed(), 'assign' => true, 'set_status' => ! $t->isClosed()],
            'revision' => $t->revision,
        ];
    }

    /**
     * AdminSupportMessage[] (every kind incl. notes; author full name + platform role). Inside the ticket's tenant.
     *
     * @return list<array<string, mixed>>
     */
    private static function messageRows(SupportTicket $t): array
    {
        $messages = SupportTicketMessage::query()->where('ticket_id', $t->id)->orderBy('created_at')->orderBy('id')->limit(1000)->get();
        $attachments = SupportTicketAttachment::query()->whereIn('message_id', $messages->pluck('id')->all())->orderBy('id')->get()->groupBy('message_id');
        $status = Media::query()->whereIn('id', $attachments->flatten()->pluck('media_id')->all())->pluck('status', 'id');
        $users = User::query()->whereIn('id', $messages->pluck('author_user_id')->filter()->unique()->values()->all())->get(['id', 'name', 'platform_role'])->keyBy('id');

        return $messages->map(function (SupportTicketMessage $m) use ($attachments, $status, $users) {
            $u = $m->author_user_id === null ? null : $users->get($m->author_user_id);
            $staffKind = in_array($m->kind, [SupportTicketMessage::STAFF, SupportTicketMessage::NOTE], true);
            $meta = [];
            foreach (($m->system_meta ?? []) as $k => $v) {
                $meta[(string) $k] = is_scalar($v) || $v === null ? $v : json_encode($v);
            }

            return [
                'id' => $m->id,
                'kind' => $m->kind,
                'body' => $m->body,
                'author' => $u === null ? null : [
                    'id' => $u->id, 'name' => (string) $u->name, 'is_staff' => $staffKind || ($m->kind === SupportTicketMessage::SYSTEM && $u->platform_role !== null),
                    'platform_role' => $u->platform_role,
                ],
                'attachments' => ($attachments->get($m->id) ?? collect())->map(fn (SupportTicketAttachment $a) => SupportPresenter::attachment($a, $status[$a->media_id] ?? null))->values()->all(),
                'system' => $m->kind === SupportTicketMessage::SYSTEM ? ['event' => $m->system_event, 'meta' => (object) $meta] : null,
                'created_at' => HelpPresenter::ts($m->created_at),
            ];
        })->values()->all();
    }

    /** @param list<string> $allowed */
    private static function commaIn(array $allowed): \Closure
    {
        return function (string $attribute, mixed $value, \Closure $fail) use ($allowed): void {
            foreach (array_filter(array_map('trim', explode(',', (string) $value))) as $v) {
                if (! in_array($v, $allowed, true)) {
                    $fail('Unknown value: '.$v);

                    return;
                }
            }
        };
    }
}

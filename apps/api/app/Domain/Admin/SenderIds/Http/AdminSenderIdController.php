<?php

declare(strict_types=1);

namespace App\Domain\Admin\SenderIds\Http;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Admin\Tenants\Http\Requests\AdminWriteRequest;
use App\Domain\Identity\Models\User;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Sms\SenderIds\SenderIdPresenter;
use App\Domain\Sms\SenderIds\SenderIdService;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * PHASE-8-9A §10.3, P89A-14 `/admin/sender-ids…` (platform permission `manage_domains`). Reads run cross-tenant on the
 * admin connection; approve / reject / revoke and the document stream run inside the request's tenant context
 * (`// cross-tenant: sender-ID review`). Every action is audited with the platform actor.
 */
class AdminSenderIdController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly SenderIdService $senderIds,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $input = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'filter' => ['sometimes', 'array'],
            'filter.status' => ['sometimes', 'string', Rule::in(SmsSenderId::STATUSES)],
            'filter.q' => ['sometimes', 'nullable', 'string', 'min:2', 'max:100'],
        ]);
        $filter = (array) ($input['filter'] ?? []);
        $status = (string) ($filter['status'] ?? SmsSenderId::PENDING);
        // cross-tenant: sender-ID review queue
        $query = SmsSenderId::withoutTenancy()->where('status', $status);
        if (is_string($q = $filter['q'] ?? null) && ($term = str_replace(['%', '_'], '', mb_strtolower(trim($q)))) !== '') {
            $query->where(fn (Builder $w) => $w->whereRaw('lower(sender_id) like ?', ["%{$term}%"])
                ->orWhereExists(fn ($e) => $e->from('stores as s')->whereColumn('s.id', 'sms_sender_ids.store_id')
                    ->where(fn ($n) => $n->whereRaw('lower(s.name) like ?', ["%{$term}%"])->orWhereLike('s.slug', "{$term}%"))));
        }
        $status === SmsSenderId::PENDING
            ? $query->orderBy('requested_at')->orderBy('id')
            : $query->orderByDesc('requested_at')->orderByDesc('id');
        $page = $query->paginate((int) ($input['per_page'] ?? 25));
        $rows = $page->getCollection()->all();
        $pending = SmsSenderId::withoutTenancy()->where('status', SmsSenderId::PENDING)->count(); // cross-tenant: queue badge

        return AdminPresenter::paginated($page, self::present($rows), ['counts' => ['pending' => $pending]]);
    }

    public function show(string $sender_id): JsonResponse
    {
        return AdminPresenter::json(['data' => self::present([self::locate($sender_id)])[0]]);
    }

    /** Streams the trade licence (attachment, nosniff, sandbox CSP, no-store) whatever the Accept header; audited. */
    public function document(Request $request, string $sender_id, TenantStorage $storage): StreamedResponse
    {
        $row = self::locate($sender_id);
        $staff = AdminBillingController::staff($request);

        // cross-tenant: sender-ID review (the document is read as its tenant, under that tenant's storage prefix)
        return $this->context->run($row->tenant_id, function () use ($row, $staff, $storage) {
            $media = Media::query()->whereKey($row->document_media_id)->first();
            if ($media === null || $media->purpose !== MediaPurpose::SenderIdDocument->value || $media->status === Media::FAILED
                || $media->disk !== $storage->privateDiskName() || ! $storage->ownsPath($media->path) || ! $storage->privateDisk()->exists($media->path)) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            if ($media->status !== Media::READY) {
                throw new ApiException(409, 'document_processing', 'The document is still being processed. Try again in a moment.');
            }
            app(AuditLogger::class)->log('sender_id.document_viewed', $row, ['sender_id' => $row->sender_id, 'document_media_id' => $media->id], $staff, platform: true);
            $name = 'trade-licence-'.strtolower($row->sender_id).'.'.MediaPurpose::extensionFor($media->mime);

            return $storage->privateDisk()->response($media->path, $name, [
                'Content-Type' => $media->mime,
                'X-Content-Type-Options' => 'nosniff',
                'Content-Security-Policy' => "sandbox; default-src 'none'",
                'Cache-Control' => 'private, no-store',
                'Referrer-Policy' => 'no-referrer',
            ], 'attachment');
        });
    }

    public function approve(AdminWriteRequest $request, string $sender_id): JsonResponse
    {
        if (! $request->boolean('provider_registered')) {
            throw ValidationException::withMessages(['provider_registered' => ['Confirm the sender ID is registered on REVE SMS / BTRC.']]);
        }
        $row = self::locate($sender_id);
        $staff = AdminBillingController::staff($request);
        // cross-tenant: sender-ID review
        $moved = $this->context->run($row->tenant_id, fn () => $this->senderIds->approve(SmsSenderId::query()->findOrFail($row->id), $staff, $request->reason()));

        return AdminPresenter::json(['data' => self::present([$moved])[0]]);
    }

    public function reject(AdminWriteRequest $request, string $sender_id): JsonResponse
    {
        $row = self::locate($sender_id);
        $staff = AdminBillingController::staff($request);
        // cross-tenant: sender-ID review
        $moved = $this->context->run($row->tenant_id, fn () => $this->senderIds->reject(SmsSenderId::query()->findOrFail($row->id), $staff, $request->reason()));

        return AdminPresenter::json(['data' => self::present([$moved])[0]]);
    }

    public function revoke(AdminWriteRequest $request, string $sender_id): JsonResponse
    {
        $row = self::locate($sender_id);
        $staff = AdminBillingController::staff($request);
        // cross-tenant: sender-ID review
        $moved = $this->context->run($row->tenant_id, fn () => $this->senderIds->revoke(SmsSenderId::query()->findOrFail($row->id), $staff, $request->reason()));

        return AdminPresenter::json(['data' => self::present([$moved])[0]]);
    }

    /** cross-tenant: admin sender-ID id → its row, else 404. */
    private static function locate(string $id): SmsSenderId
    {
        $row = AdminPresenter::isUlid($id) ? SmsSenderId::withoutTenancy()->whereKey(strtolower($id))->first() : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /**
     * AdminSenderIdRequest rows (cross-tenant: sender-ID review — documents, users, shops and current IDs looked up on
     * the admin connection).
     *
     * @param  list<SmsSenderId>  $rows
     * @return list<array<string, mixed>>
     */
    private static function present(array $rows): array
    {
        if ($rows === []) {
            return [];
        }
        $tenantIds = array_values(array_unique(array_map(fn (SmsSenderId $r) => (string) $r->tenant_id, $rows)));
        $shops = AdminPresenter::shopRefs($tenantIds);
        $documents = Media::withoutTenancy()->whereIn('id', array_map(fn (SmsSenderId $r) => $r->document_media_id, $rows))->get()->keyBy('id');
        $userIds = array_values(array_filter(array_merge(...array_map(fn (SmsSenderId $r) => [$r->requested_by, $r->reviewed_by], $rows))));
        $users = User::query()->whereIn('id', $userIds)->get(['id', 'name', 'email'])->keyBy('id');
        $current = SmsSenderId::withoutTenancy()->whereIn('store_id', array_map(fn (SmsSenderId $r) => $r->store_id, $rows))
            ->where('status', SmsSenderId::APPROVED)->pluck('sender_id', 'store_id');

        return array_map(function (SmsSenderId $r) use ($shops, $documents, $users, $current) {
            $requester = $r->requested_by !== null ? $users->get($r->requested_by) : null;
            $reviewer = $r->reviewed_by !== null ? $users->get($r->reviewed_by) : null;

            return SenderIdPresenter::request($r, $documents->get($r->document_media_id), $requester) + [
                'tenant' => $shops[(string) $r->tenant_id] ?? ['id' => (string) $r->tenant_id, 'name' => '', 'slug' => ''],
                'requested_by_email' => $requester?->email,
                'reviewed_by' => $reviewer !== null ? ['id' => $reviewer->id, 'name' => (string) $reviewer->name] : null,
                'current_sender_id' => $current[$r->store_id] ?? null,
            ];
        }, $rows);
    }
}

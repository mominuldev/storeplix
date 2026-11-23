<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Http\Controllers;

use App\Domain\Admin\Impersonation\Http\Requests\CreateImpersonationRequest;
use App\Domain\Admin\Impersonation\Http\Requests\ListImpersonationsRequest;
use App\Domain\Admin\Impersonation\Http\Requests\RevokeImpersonationRequest;
use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * PHASE-8-1 §6.5 (P8-9, P8-11): `POST /admin/tenants/{tenant}/impersonations` (impersonate),
 * `GET /admin/impersonations` (view_merchants), `POST /admin/impersonations/{impersonation}/revoke` (suspend).
 * Reads run on the platform connection (`pgsql_admin` with RLS on, P8-6): the list joins the tenant's store for its slug.
 */
class AdminImpersonationController
{
    public function __construct(private readonly ImpersonationService $service) {}

    public function store(CreateImpersonationRequest $request, string $tenant): JsonResponse
    {
        $target = Str::isUlid($tenant) ? Tenant::query()->find(strtolower($tenant)) : null;
        if ($target === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        /** @var User $staff */
        $staff = $request->user();
        $data = $request->validated();
        [$row, $url] = $this->service->create(
            $staff, $target, (string) $data['reason'], isset($data['ticket_ref']) ? (string) $data['ticket_ref'] : null,
            $request->ip(), $request->userAgent(),
        );

        return self::json(['data' => [
            'id' => $row->id,
            'url' => $url,
            'ticket_expires_at' => $row->ticket_expires_at->toIso8601ZuluString(),
        ]], 201);
    }

    public function index(ListImpersonationsRequest $request): JsonResponse
    {
        $filter = (array) $request->validated('filter', []);
        $query = self::baseQuery()
            ->when(isset($filter['status']), fn (Builder $q) => $q->where('i.status', $filter['status']))
            ->when(isset($filter['staff']), fn (Builder $q) => $q->where('i.staff_user_id', strtolower((string) $filter['staff'])))
            ->when(isset($filter['tenant']), fn (Builder $q) => $q->where('i.target_tenant_id', strtolower((string) $filter['tenant'])))
            ->orderByDesc('i.created_at')->orderByDesc('i.id');

        $page = $query->paginate((int) $request->validated('per_page', 25), ['*'], 'page', (int) $request->validated('page', 1));

        return self::json([
            'data' => $page->getCollection()->map(fn (object $r) => self::present($r))->values()->all(),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
            ],
        ]);
    }

    public function revoke(RevokeImpersonationRequest $request, string $impersonation): JsonResponse
    {
        $row = Str::isUlid($impersonation) ? PlatformImpersonation::query()->find(strtolower($impersonation)) : null;
        if ($row === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        /** @var User $by */
        $by = $request->user();
        $this->service->revoke($row, $by, (string) $request->validated('reason'));

        return self::json(['data' => self::present(self::baseQuery()->where('i.id', $row->id)->firstOrFail())]);
    }

    private static function baseQuery(): Builder
    {
        return PlatformDb::connection()->table('platform_impersonations as i')
            ->join('users as u', 'u.id', '=', 'i.staff_user_id')
            ->join('tenants as t', 't.id', '=', 'i.target_tenant_id')
            ->leftJoin('stores as s', 's.tenant_id', '=', 'i.target_tenant_id')
            ->select([
                'i.id', 'i.status', 'i.reason', 'i.ticket_ref', 'i.started_at', 'i.expires_at', 'i.ended_at', 'i.ended_by',
                'i.request_count', 'i.created_at', 'i.staff_user_id', 'i.target_tenant_id',
                'u.name as staff_name', 'u.email as staff_email', 't.name as tenant_name', 's.slug as store_slug',
            ]);
    }

    /** @return array<string, mixed> Impersonation (openapi 1.9.0) */
    private static function present(object $r): array
    {
        $at = static fn (mixed $v): ?string => $v === null ? null : Carbon::parse((string) $v)->toIso8601ZuluString();

        return [
            'id' => $r->id,
            'status' => $r->status,
            'staff' => ['id' => $r->staff_user_id, 'name' => $r->staff_name, 'email' => $r->staff_email],
            'tenant' => ['id' => $r->target_tenant_id, 'name' => $r->tenant_name, 'slug' => (string) ($r->store_slug ?? '')],
            'reason' => $r->reason,
            'ticket_ref' => $r->ticket_ref,
            'started_at' => $at($r->started_at),
            'expires_at' => $at($r->expires_at),
            'ended_at' => $at($r->ended_at),
            'ended_by' => $r->ended_by,
            'request_count' => (int) $r->request_count,
            'created_at' => $at($r->created_at),
        ];
    }

    /** @param array<string, mixed> $body */
    private static function json(array $body, int $status = 200): JsonResponse
    {
        return (new JsonResponse($body, $status))->header('Cache-Control', 'private, no-store');
    }
}

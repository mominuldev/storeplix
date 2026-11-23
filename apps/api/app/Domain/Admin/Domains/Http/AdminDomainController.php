<?php

declare(strict_types=1);

namespace App\Domain\Admin\Domains\Http;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Admin\Tenants\Http\Requests\AdminWriteRequest;
use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Domains\DomainService;
use App\Domain\Domains\InvalidDomainTransition;
use App\Domain\Domains\Ops\ReinstateDomain;
use App\Domain\Domains\Ops\SuspendDomain;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-1 §6.4 platform-wide custom domains: list on the admin connection (P8-6); re-check / suspend / reinstate
 * run the Phase 6 Actions as the tenant (P8-7). Platform rows are not part of this table (404).
 */
class AdminDomainController
{
    public const STATES = ['all', 'dns_pending', 'ssl_failing', 'active', 'suspended', 'expired'];

    public function __construct(private readonly TenantContext $context) {}

    public function index(Request $request): JsonResponse
    {
        $input = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'filter' => ['sometimes', 'array'],
            'filter.state' => ['sometimes', 'string', Rule::in(self::STATES)],
            'filter.q' => ['sometimes', 'nullable', 'string', 'max:120'],
        ]);
        $filter = (array) ($input['filter'] ?? []);
        // cross-tenant: admin domains table
        $query = StoreDomain::withoutTenancy()->where('type', StoreDomain::TYPE_CUSTOM);
        self::state($query, (string) ($filter['state'] ?? 'all'));
        if (is_string($q = $filter['q'] ?? null) && ($term = str_replace(['%', '_'], '', mb_strtolower(trim($q)))) !== '') {
            $query->where(fn (Builder $w) => $w->whereLike('hostname', "%{$term}%")
                ->orWhereExists(fn ($e) => $e->from('stores as s')->whereColumn('s.tenant_id', 'store_domains.tenant_id')
                    ->where(fn ($n) => $n->whereLike('s.name', "%{$term}%")->orWhereLike('s.slug', "{$term}%"))));
        }
        $page = $query->orderByDesc('created_at')->orderByDesc('id')->paginate((int) ($input['per_page'] ?? 25));
        $shops = AdminPresenter::shopRefs($page->getCollection()->pluck('tenant_id')->map(fn ($id) => (string) $id)->all());

        return AdminPresenter::paginated($page, $page->getCollection()->map(fn (StoreDomain $d) => AdminPresenter::domain($d, $shops))->all());
    }

    /** Status chips of the domains table (`45:8156`). */
    public static function state(Builder $query, string $state): void
    {
        match ($state) {
            'dns_pending' => $query->whereIn('status', [StoreDomain::STATUS_PENDING_VERIFICATION, StoreDomain::STATUS_VERIFICATION_FAILED]),
            'ssl_failing' => $query->where(fn (Builder $q) => $q->whereIn('failure_code', ['ssl_validation_failed', 'ssl_timeout', 'ssl_lost', 'provider_error', 'provider_blocked'])
                ->whereNotIn('status', [StoreDomain::STATUS_SUSPENDED])),
            'active' => $query->where('status', StoreDomain::STATUS_ACTIVE),
            'suspended' => $query->where('status', StoreDomain::STATUS_SUSPENDED),
            'expired' => $query->where('status', StoreDomain::STATUS_EXPIRED),
            default => null,
        };
    }

    /** §4.2: the merchant re-check Action as the tenant, without the merchant cooldown; the plan gate applies (402). */
    public function recheck(Request $request, string $domain, DomainService $domains): JsonResponse
    {
        $row = self::locate($domain);
        $staff = AdminBillingController::staff($request);
        $checked = $this->context->run((string) $row->tenant_id, fn () => $domains->recheck(StoreDomain::query()->findOrFail($row->id), $staff, throttle: false));

        return AdminPresenter::json(['data' => AdminPresenter::domain($checked, AdminPresenter::shopRefs([(string) $row->tenant_id]))], 202);
    }

    public function suspend(AdminWriteRequest $request, string $domain, SuspendDomain $action): JsonResponse
    {
        $row = self::locate($domain);
        $moved = $action->handle((string) $row->tenant_id, $row->id, OpsActor::staff(AdminBillingController::staff($request), $request->reason()));
        if ($moved === null) {
            throw new InvalidDomainTransition(StoreDomain::STATUS_SUSPENDED, StoreDomain::STATUS_SUSPENDED);
        }

        return AdminPresenter::json(['data' => AdminPresenter::domain($moved, AdminPresenter::shopRefs([(string) $row->tenant_id]))]);
    }

    public function reinstate(AdminWriteRequest $request, string $domain, ReinstateDomain $action): JsonResponse
    {
        $row = self::locate($domain);
        $moved = $action->handle((string) $row->tenant_id, $row->id, OpsActor::staff(AdminBillingController::staff($request), $request->reason()));
        if ($moved === null) {
            throw new InvalidDomainTransition((string) $row->status, StoreDomain::STATUS_ACTIVE);
        }

        return AdminPresenter::json(['data' => AdminPresenter::domain($moved, AdminPresenter::shopRefs([(string) $row->tenant_id]))]);
    }

    /** cross-tenant: admin domain → its row (custom domains only; anything else 404). */
    private static function locate(string $domain): StoreDomain
    {
        $row = AdminPresenter::isUlid($domain)
            ? StoreDomain::withoutTenancy()->whereKey(strtolower($domain))->where('type', StoreDomain::TYPE_CUSTOM)->first(['id', 'tenant_id', 'status'])
            : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }
}

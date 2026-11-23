<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http;

use App\Domain\Admin\Analytics\TenantMetrics;
use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Http\Resources\PlanPresenter;
use App\Domain\Billing\Limit;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\PlatformDb;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/** PHASE-8-1 §6.2 merchant reads (`view_merchants`), on the admin connection (P8-6). */
class AdminTenantController
{
    public function index(Request $request): JsonResponse
    {
        $input = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'filter' => ['sometimes', 'array'],
            'filter.status' => ['sometimes', 'string', Rule::in(TenantDirectory::TABS)],
            'filter.plan' => ['sometimes', 'string', 'max:32'],
            'filter.q' => ['sometimes', 'nullable', 'string', 'max:120'],
            'filter.created_from' => ['sometimes', 'date_format:Y-m-d'],
            'filter.created_to' => ['sometimes', 'date_format:Y-m-d'],
            'sort' => ['sometimes', 'string', Rule::in(TenantDirectory::SORTS)],
        ]);
        $filter = (array) ($input['filter'] ?? []);
        $sort = (string) ($input['sort'] ?? '-created_at');

        $counts = [];
        foreach (['all', 'paying', 'trial', 'past_due', 'suspended'] as $tab) {
            $counts[$tab] = TenantDirectory::tab(TenantDirectory::query($filter), $tab)->distinct()->count('t.id');
        }

        $query = TenantDirectory::tab(TenantDirectory::query($filter), (string) ($filter['status'] ?? 'all'));
        $asOf = TenantMetrics::asOf();
        $column = ltrim($sort, '-');
        if (in_array($sort, TenantMetrics::SORTS, true)) {
            TenantMetrics::sort($query, $sort, $asOf); // PHASE-8-2 §6.1 (snapshot of meta.metrics_as_of, nulls last)
        } else {
            $query->orderBy($column === 'current_period_end' ? 'cs.current_period_end' : 't.'.$column, str_starts_with($sort, '-') ? 'desc' : 'asc');
        }
        $query->orderByDesc('t.id');
        $page = $query->select(['t.id'])->paginate((int) ($input['per_page'] ?? 25));
        $ids = collect($page->items())->map(fn ($row) => (string) $row->id)->unique()->values()->all();

        return AdminPresenter::paginated($page, TenantDirectory::summaries($ids), ['counts' => $counts, 'metrics_as_of' => $asOf]);
    }

    public function show(string $tenant): JsonResponse
    {
        return AdminPresenter::json(['data' => self::detail(TenantDirectory::find($tenant)->id)]);
    }

    /** @return array<string, mixed> AdminTenant */
    public static function detail(string $tenantId): array
    {
        $db = PlatformDb::connection(); // cross-tenant: admin merchant detail
        $summary = TenantDirectory::summaries([$tenantId])[0];
        $row = $db->table('tenants')->where('id', $tenantId)->first();
        $store = $db->table('stores')->where('tenant_id', $tenantId)->first(['status_before_suspension']);
        $tenant = PlatformDb::reroute(Tenant::query())->findOrFail($tenantId);

        [$subscription, $usage] = app(TenantContext::class)->run($tenantId, function () use ($tenant) {
            $current = FeatureGate::currentSubscription();

            return [
                $current !== null ? PlanPresenter::subscription($current) : null,
                array_map(fn (Limit $limit) => [
                    'key' => $limit->value, 'used' => FeatureGate::usage($tenant, $limit), 'limit' => FeatureGate::limit($tenant, $limit),
                ], Limit::cases()),
            ];
        });
        $open = AdminPresenter::invoiceQuery()->where('i.tenant_id', $tenantId)->where('i.status', BillingInvoice::OPEN)->first();

        return $summary + [
            'suspension' => $row->status === Tenant::STATUS_SUSPENDED ? [
                'suspended_at' => AdminPresenter::ts($row->suspended_at ?? null),
                'reason_code' => $row->suspension_reason_code ?? 'other',
                'store_status_before' => $store->status_before_suspension ?? 'active',
            ] : null,
            'subscription' => $subscription,
            'usage' => $usage,
            'member_count' => $db->table('tenant_users')->where('tenant_id', $tenantId)->count(),
            'domain_count' => $db->table('store_domains')->where('tenant_id', $tenantId)->where('type', StoreDomain::TYPE_CUSTOM)->count(),
            'lifetime_paid_amount' => (int) $db->table('billing_invoices')->where('tenant_id', $tenantId)->where('status', BillingInvoice::PAID)->sum('total_amount'),
            'open_invoice' => $open !== null ? AdminPresenter::invoiceSummary($open, AdminPresenter::shopRefs([$tenantId])) : null,
        ];
    }

    public function members(string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $db = PlatformDb::connection(); // cross-tenant: admin merchant members
        $members = $db->table('tenant_users as tu')->join('users as u', 'u.id', '=', 'tu.user_id')->where('tu.tenant_id', $tenantId)
            ->orderByRaw("case tu.role when 'owner' then 0 when 'admin' then 1 else 2 end")->orderBy('tu.created_at')
            ->get(['u.id', 'u.name', 'u.email', 'u.phone', 'tu.role', 'tu.created_at'])
            ->map(fn ($m) => [
                'id' => (string) $m->id, 'name' => (string) $m->name, 'email' => (string) $m->email,
                'phone' => $m->phone !== null ? (string) $m->phone : null, 'role' => (string) $m->role, 'status' => 'active',
                'joined_at' => AdminPresenter::ts($m->created_at),
            ]);
        $invitations = $db->table('staff_invitations')->where('tenant_id', $tenantId)->whereNull('accepted_at')->whereNull('revoked_at')
            ->where('expires_at', '>', now())->orderBy('created_at')->get(['email', 'name', 'role'])
            ->map(fn ($i) => [
                'id' => null, 'name' => $i->name !== null ? (string) $i->name : null, 'email' => (string) $i->email, 'phone' => null,
                'role' => (string) $i->role, 'status' => 'invited', 'joined_at' => null,
            ]);

        return AdminPresenter::json(['data' => $members->concat($invitations)->values()->all()]);
    }

    public function domains(string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $shops = AdminPresenter::shopRefs([$tenantId]);
        // cross-tenant: admin merchant domains
        $rows = StoreDomain::withoutTenancy()->where('tenant_id', $tenantId)
            ->orderByRaw("case when type = 'platform' then 0 else 1 end")->orderBy('created_at')->orderBy('id')->get();

        return AdminPresenter::json(['data' => $rows->map(fn (StoreDomain $d) => AdminPresenter::domain($d, $shops))->all()]);
    }

    public function invoices(Request $request, string $tenant): JsonResponse
    {
        $tenantId = (string) TenantDirectory::find($tenant)->id;
        $input = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'filter.status' => ['sometimes', 'string', Rule::in(BillingInvoice::STATUSES)],
        ]);
        $query = AdminPresenter::invoiceQuery()->where('i.tenant_id', $tenantId)->orderByDesc('i.issued_at')->orderByDesc('i.id');
        if (isset($input['filter']['status'])) {
            $query->where('i.status', $input['filter']['status']);
        }
        $page = $query->paginate((int) ($input['per_page'] ?? 25));
        $shops = AdminPresenter::shopRefs([$tenantId]);

        return AdminPresenter::paginated($page, collect($page->items())->map(fn ($row) => AdminPresenter::invoiceSummary($row, $shops))->all());
    }
}

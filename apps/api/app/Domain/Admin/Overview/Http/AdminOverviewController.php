<?php

declare(strict_types=1);

namespace App\Domain\Admin\Overview\Http;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Http\JsonResponse;

/**
 * PHASE-8-1 P8-18 `GET /admin/overview`: only what a count per status answers, on the admin connection (P8-6).
 * Paying = active non-Free; failing domains = verification_failed + DNS failing on an active row + SSL failures.
 */
class AdminOverviewController
{
    public const SSL_FAILURES = ['ssl_validation_failed', 'ssl_timeout', 'ssl_lost', 'provider_error', 'provider_blocked'];

    public function __invoke(): JsonResponse
    {
        $db = PlatformDb::connection(); // cross-tenant: admin overview counts
        $tenants = $db->table('tenants')->selectRaw('status, count(*) as n')->groupBy('status')->pluck('n', 'status');
        $total = (int) $tenants->sum();

        $subs = $db->table('subscriptions as s')->join('plans as p', 'p.id', '=', 's.plan_id')
            ->whereIn('s.status', Subscription::CURRENT_STATUSES)
            ->selectRaw('s.status, p.code, count(distinct s.tenant_id) as n')->groupBy('s.status', 'p.code')->get();
        $count = fn (callable $where): int => (int) $subs->filter($where)->sum('n');
        $paying = $count(fn ($r) => $r->status === Subscription::ACTIVE && $r->code !== Plan::FREE);
        $trialing = $count(fn ($r) => $r->status === Subscription::TRIALING);
        $pastDue = $count(fn ($r) => $r->status === Subscription::PAST_DUE);
        $withSub = (int) $db->table('subscriptions')->whereIn('status', Subscription::CURRENT_STATUSES)->distinct()->count('tenant_id');
        $free = $count(fn ($r) => $r->status === Subscription::ACTIVE && $r->code === Plan::FREE) + max(0, $total - $withSub);
        $byPlan = $subs->groupBy('code')->map(fn ($rows, $code) => ['plan_code' => (string) $code, 'count' => (int) $rows->sum('n')])
            ->sortBy('plan_code')->values()->all();

        $pastDueAmount = (int) $db->table('billing_invoices as i')->where('i.status', BillingInvoice::OPEN)
            ->whereExists(fn ($e) => $e->from('subscriptions as s')->whereColumn('s.tenant_id', 'i.tenant_id')->where('s.status', Subscription::PAST_DUE))
            ->sum('i.total_amount');

        $custom = $db->table('store_domains')->where('type', StoreDomain::TYPE_CUSTOM);
        $failing = (clone $custom)->where(fn ($q) => $q->where('status', StoreDomain::STATUS_VERIFICATION_FAILED)
            ->orWhere(fn ($a) => $a->where('status', StoreDomain::STATUS_ACTIVE)->whereNotNull('first_failed_at'))
            ->orWhere(fn ($s) => $s->whereIn('status', [StoreDomain::STATUS_VERIFIED, StoreDomain::STATUS_SSL_PROVISIONING])->whereIn('failure_code', self::SSL_FAILURES)))
            ->count();

        $newest = $db->table('tenants')->orderByDesc('created_at')->orderByDesc('id')->limit(10)->pluck('id')->map(fn ($id) => (string) $id)->all();

        return AdminPresenter::json(['data' => [
            'tenants' => [
                'total' => $total,
                'active' => (int) ($tenants[Tenant::STATUS_ACTIVE] ?? 0),
                'suspended' => (int) ($tenants[Tenant::STATUS_SUSPENDED] ?? 0),
            ],
            'subscriptions' => ['paying' => $paying, 'trialing' => $trialing, 'free' => $free, 'past_due' => $pastDue, 'by_plan' => $byPlan],
            'past_due' => ['count' => $pastDue, 'amount' => $pastDueAmount, 'currency' => 'BDT'],
            'open_invoices' => $db->table('billing_invoices')->where('status', BillingInvoice::OPEN)->count(),
            'domains' => [
                'active' => (clone $custom)->where('status', StoreDomain::STATUS_ACTIVE)->whereNull('first_failed_at')->count(),
                'pending' => (clone $custom)->whereIn('status', [StoreDomain::STATUS_PENDING_VERIFICATION, StoreDomain::STATUS_VERIFIED, StoreDomain::STATUS_SSL_PROVISIONING])
                    ->where(fn ($q) => $q->whereNull('failure_code')->orWhereNotIn('failure_code', self::SSL_FAILURES))->count(),
                'failing' => $failing,
                'suspended' => (clone $custom)->where('status', StoreDomain::STATUS_SUSPENDED)->count(),
            ],
            'active_impersonations' => $db->table('platform_impersonations')->where('status', 'active')->where('expires_at', '>', now())->count(),
            'newest_tenants' => TenantDirectory::summaries($newest),
        ]]);
    }
}

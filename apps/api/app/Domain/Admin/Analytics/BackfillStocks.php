<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Models\Tenant;
use Carbon\CarbonImmutable;
use Illuminate\Database\ConnectionInterface;

/**
 * PHASE-8-2 P82-6: stocks of a past day reconstructed from history that is not mutated in place.
 *  - paid: a paid invoice with `period_start ≤ end(D) < period_end` (latest `paid_at` wins) → its plan/interval, active;
 *  - else trial: a subscription row of the tenant with `trial_ends_at > end(D)` and `created_at ≤ end(D)`;
 *  - else Free (plan null when the tenant had no subscription row yet).
 * `past_due` grace, comp plans and suspension history can't be reconstructed: counted as not paying / active.
 * List prices from `plans` today. cross-tenant: platform analytics (B27).
 */
final class BackfillStocks
{
    /** @return array<string, array<string, mixed>> tenant id → stock columns */
    public function stocks(ConnectionInterface $db, string $day): array
    {
        $end = AnalyticsDays::endUtc($day);
        $tenants = $db->table('tenants')->where('created_at', '<', $end)->orderBy('id')->pluck('id')->map(fn ($id) => (string) $id)->all();

        $paid = [];
        $invoices = $db->table('billing_invoices as i')->join('plans as p', 'p.id', '=', 'i.plan_id')
            ->where('i.status', BillingInvoice::PAID)->where('i.period_start', '<=', $end)->where('i.period_end', '>', $end)
            ->orderBy('i.paid_at')->orderBy('i.id')
            ->get(['i.tenant_id', 'i.interval', 'p.code', 'p.price_amount', 'p.price_yearly_amount']);
        foreach ($invoices as $inv) {
            $paid[(string) $inv->tenant_id] = $inv; // later paid_at wins
        }

        $trials = [];
        $withSubscription = [];
        $subs = $db->table('subscriptions as s')->join('plans as p', 'p.id', '=', 's.plan_id')
            ->where('s.created_at', '<=', $end)->orderBy('s.created_at')->orderBy('s.id')
            ->get(['s.tenant_id', 's.trial_ends_at', 's.billing_interval', 'p.code']);
        foreach ($subs as $sub) {
            $tenantId = (string) $sub->tenant_id;
            $withSubscription[$tenantId] = true;
            if ($sub->trial_ends_at !== null && CarbonImmutable::parse((string) $sub->trial_ends_at, 'UTC')->gt($end)) {
                $trials[$tenantId] = $sub;
            }
        }

        $out = [];
        foreach ($tenants as $id) {
            if (isset($paid[$id])) {
                $inv = $paid[$id];
                $interval = (string) $inv->interval;
                $out[$id] = TenantStock::row((string) $inv->code, $interval, Subscription::ACTIVE, Tenant::STATUS_ACTIVE,
                    $inv->code === Plan::FREE ? 0 : TenantStock::monthly($interval, (int) $inv->price_amount, $inv->price_yearly_amount !== null ? (int) $inv->price_yearly_amount : null), false);
            } elseif (isset($trials[$id])) {
                $out[$id] = TenantStock::row((string) $trials[$id]->code, (string) $trials[$id]->billing_interval, Subscription::TRIALING, Tenant::STATUS_ACTIVE, 0, false);
            } else {
                $out[$id] = TenantStock::row(isset($withSubscription[$id]) ? Plan::FREE : null, null, null, Tenant::STATUS_ACTIVE, 0, false);
            }
        }

        return $out;
    }
}

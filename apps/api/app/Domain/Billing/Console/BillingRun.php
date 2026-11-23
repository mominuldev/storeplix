<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Jobs\ProcessSubscriptionJob;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Subscription;
use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;

/** §4.1 `billing:run` (hourly): discovery on the platform connection (B24), one ProcessSubscriptionJob per due tenant. */
class BillingRun extends Command
{
    protected $signature = 'billing:run {--sync : run the per-tenant jobs inline}';

    protected $description = 'Trial ends, renewal invoices and reminders, period ends, past_due expiry and domain detachment';

    public function handle(): int
    {
        $tenants = self::dueQuery()->limit((int) config('billing.run_batch', 1000))->pluck('tenant_id')->unique()->values();
        foreach ($tenants as $tenantId) {
            $job = new ProcessSubscriptionJob((string) $tenantId);
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
        }
        $this->info(sprintf('billing:run: %d tenant(s).', $tenants->count()));

        return self::SUCCESS;
    }

    /**
     * Discovery for the scheduler (pgsql_admin; cross-tenant: billing schedule): tenants whose current subscription or
     * open invoice has anything due within the reminder horizon.
     *
     * @return Builder<Subscription>
     */
    public static function dueQuery(): Builder
    {
        $now = now();
        $lead = $now->copy()->addDays(max((int) config('billing.renewal_lead_days', 7), (int) config('billing.trial_reminder_days', 3)));
        $graceSoon = $now->copy()->addDays((int) config('billing.grace_reminder_days', 2));
        $staleChange = $now->copy()->subHours((int) config('billing.change_invoice_ttl_hours', 24));

        // cross-tenant: billing schedule (B24) — discovery only; each tenant's work runs in its own TenantAware job.
        return Subscription::withoutTenancy()
            ->whereIn('status', Subscription::CURRENT_STATUSES)
            ->where(fn ($q) => $q
                ->where(fn ($t) => $t->where('status', Subscription::TRIALING)->where('trial_ends_at', '<=', $lead))
                ->orWhere(fn ($a) => $a->where('status', Subscription::ACTIVE)->where('current_period_end', '<=', $lead))
                ->orWhere(fn ($p) => $p->where('status', Subscription::PAST_DUE)->where('grace_ends_at', '<=', $graceSoon))
                ->orWhere(fn ($d) => $d->whereNotNull('domain_grace_ends_at')->where('domain_grace_ends_at', '<=', $now))
                ->orWhereExists(fn ($i) => $i->select(DB::raw(1))->from('billing_invoices')
                    ->whereColumn('billing_invoices.tenant_id', 'subscriptions.tenant_id')
                    ->where('billing_invoices.status', BillingInvoice::OPEN)->whereIn('billing_invoices.kind', [BillingInvoice::NEW, BillingInvoice::UPGRADE])
                    ->where('billing_invoices.issued_at', '<=', $staleChange)))
            ->orderByRaw('coalesce(trial_ends_at, current_period_end) asc');
    }
}

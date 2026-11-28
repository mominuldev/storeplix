<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\InvoiceService;
use App\Domain\Billing\Jobs\ProcessSubscriptionJob;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Tenancy\TenantContext;
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
        $expired = $this->expireSmsCreditInvoices();
        if ($expired > 0) {
            $this->info(sprintf('billing:run: %d SMS credit invoice(s) expired.', $expired));
        }

        return self::SUCCESS;
    }

    /**
     * PHASE-8-9A §5.3 step 5: open `sms_credits` invoices past `due_at` become void (`expired`) — no reminders, no
     * dunning, no effect on the subscription. Each void runs inside its tenant (a payment may still pay it late).
     */
    private function expireSmsCreditInvoices(): int
    {
        // cross-tenant: billing schedule — discovery of expired SMS credit invoices only.
        $rows = BillingInvoice::withoutTenancy()->where('kind', BillingInvoice::SMS_CREDITS)->where('status', BillingInvoice::OPEN)
            ->where('due_at', '<', now())->limit((int) config('billing.run_batch', 1000))->get(['id', 'tenant_id']);
        $count = 0;
        foreach ($rows as $row) {
            $count += (int) app(TenantContext::class)->run((string) $row->tenant_id, fn () => BillingLock::run((string) $row->tenant_id,
                fn () => DB::transaction(function () use ($row) {
                    $invoice = BillingInvoice::query()->whereKey($row->id)->lockForUpdate()->first();

                    return $invoice !== null && app(InvoiceService::class)->void($invoice, BillingInvoice::VOID_EXPIRED);
                })));
        }

        return $count;
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

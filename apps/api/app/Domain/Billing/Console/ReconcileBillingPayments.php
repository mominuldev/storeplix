<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Jobs\ReconcileBillingPaymentJob;
use App\Domain\Billing\Models\BillingPayment;
use Illuminate\Console\Command;

/**
 * §4.2 `billing:reconcile-payments` (5 min): pending payments older than 2 min, and failed/cancelled ones younger than
 * 48 h that the provider may still complete (a late success always wins, P7-13). Discovery on the platform connection.
 */
class ReconcileBillingPayments extends Command
{
    protected $signature = 'billing:reconcile-payments {--sync : run the per-payment jobs inline}';

    protected $description = 'Ask the platform gateways about unfinished billing payments';

    public function handle(): int
    {
        // cross-tenant: billing reconcile discovery (B24); each payment is handled in its tenant's job.
        $rows = BillingPayment::withoutTenancy()
            ->whereIn('provider', BillingPayment::GATEWAYS)
            ->where(fn ($q) => $q
                ->where(fn ($p) => $p->where('status', BillingPayment::PENDING)->where('created_at', '<=', now()->subMinutes(2)))
                ->orWhere(fn ($f) => $f->whereIn('status', [BillingPayment::FAILED, BillingPayment::CANCELLED])->where('created_at', '>=', now()->subHours(48))
                    ->where(fn ($c) => $c->whereNull('failure_code')->orWhereNotIn('failure_code', [...BillingPaymentService::MISMATCH_CODES, 'initiation_failed']))))
            ->orderBy('created_at')->limit(1000)->get(['id', 'tenant_id']);
        foreach ($rows as $row) {
            $job = new ReconcileBillingPaymentJob($row->id, $row->tenant_id);
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
        }
        $this->info(sprintf('billing:reconcile-payments: %d payment(s).', $rows->count()));

        return self::SUCCESS;
    }
}

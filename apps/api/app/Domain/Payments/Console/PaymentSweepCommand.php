<?php

declare(strict_types=1);

namespace App\Domain\Payments\Console;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Jobs\RunPaymentSweep;
use App\Domain\Payments\Models\PaymentLink;
use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Builder;

/**
 * `payments:expire` (1 min), `payments:reconcile` (5 min), `payments:refund-status` (10 min),
 * `payment-links:expire` (1 min). Discovery on the platform connection (§2.4 B11), then one tenant-aware job per
 * tenant with work (RunPaymentSweep). `--sync` runs the jobs inline.
 */
abstract class PaymentSweepCommand extends Command
{
    abstract protected function kind(): string;

    public function handle(): int
    {
        // cross-tenant: scheduler discovery (platform connection); each tenant's work runs in its own job.
        $query = match ($this->kind()) {
            RunPaymentSweep::EXPIRE => Order::withoutTenancy()->where('status', Order::PENDING_PAYMENT)->where('payment_expires_at', '<=', now()),
            RunPaymentSweep::RECONCILE => Payment::withoutTenancy()->where('type', Payment::TYPE_CHARGE)->where('status', Payment::STATUS_PENDING)
                ->whereIn('provider', Payment::ONLINE_PROVIDERS)->where('created_at', '<=', now()->subMinutes(2)),
            RunPaymentSweep::REFUND_STATUS => Payment::withoutTenancy()->where('type', Payment::TYPE_REFUND)->where('status', Payment::STATUS_PENDING)
                ->whereIn('provider', Payment::ONLINE_PROVIDERS)->where('created_at', '<=', now()->subMinute()),
            RunPaymentSweep::LINKS => PaymentLink::withoutTenancy()->where('status', PaymentLink::ACTIVE)->where('expires_at', '<=', now()),
        };
        /** @var Builder $query */
        $tenants = $query->distinct()->pluck('tenant_id')->all();
        foreach ($tenants as $tenantId) {
            $job = new RunPaymentSweep($this->kind(), (string) $tenantId);
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
        }
        $this->info(sprintf('%s: %d tenant(s).', $this->getName(), count($tenants)));

        return self::SUCCESS;
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Console;

use App\Domain\Couriers\Jobs\ReconcileTenantBookings;
use App\Domain\Orders\Models\Shipment;
use Illuminate\Console\Command;

/**
 * `couriers:reconcile-bookings` (every 2 min, P5B-33): tenants with shipments stuck in `booking` for over a minute
 * (platform-connection discovery), then one tenant-aware job each that looks the parcels up by invoice.
 */
class ReconcileBookings extends Command
{
    protected $signature = 'couriers:reconcile-bookings {--sync : run the jobs inline}';

    protected $description = 'Finish courier bookings whose outcome was unknown (timeouts).';

    public function handle(): int
    {
        // cross-tenant: scheduler discovery (platform connection); each tenant's work runs in its own job.
        $tenants = Shipment::withoutTenancy()->where('status', Shipment::BOOKING)->where('created_at', '<=', now()->subMinute())
            ->distinct()->pluck('tenant_id')->all();
        foreach ($tenants as $tenantId) {
            $job = (new ReconcileTenantBookings((string) $tenantId))->onQueue('default');
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
        }
        $this->info(sprintf('couriers:reconcile-bookings: %d tenant(s).', count($tenants)));

        return self::SUCCESS;
    }
}

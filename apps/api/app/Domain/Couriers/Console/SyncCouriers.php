<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Console;

use App\Domain\Couriers\Jobs\SyncCourierAccount;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\ShipmentSync;
use App\Domain\Orders\Models\Shipment;
use Illuminate\Console\Command;

/**
 * `couriers:sync` (every 15 min, P5B-38). Discovery on the platform connection (§2.4 B11): connected accounts with
 * non-final shipments; then one tenant-aware SyncCourierAccount job per account. `--sync` runs them inline.
 */
class SyncCouriers extends Command
{
    protected $signature = 'couriers:sync {--sync : run the jobs inline}';

    protected $description = 'Poll courier status APIs for non-final shipments (one job per courier account).';

    public function handle(): int
    {
        // cross-tenant: scheduler discovery (platform connection); each account's work runs in its own tenant job.
        $accounts = Shipment::withoutTenancy()->whereIn('status', ShipmentSync::ACTIVE)->whereNotNull('consignment_id')
            ->whereNotNull('courier_account_id')->distinct()->get(['tenant_id', 'courier_account_id']);
        $connected = CourierAccount::withoutTenancy()->whereIn('id', $accounts->pluck('courier_account_id')->all())
            ->where('status', CourierAccount::CONNECTED)->pluck('tenant_id', 'id');
        foreach ($connected as $accountId => $tenantId) {
            $job = (new SyncCourierAccount((string) $accountId))->forTenant((string) $tenantId)->onQueue(SyncCourierAccount::QUEUE);
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
        }
        $this->info(sprintf('couriers:sync: %d account(s).', count($connected)));

        return self::SUCCESS;
    }
}

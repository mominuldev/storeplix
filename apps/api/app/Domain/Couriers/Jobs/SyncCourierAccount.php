<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Jobs;

use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\ShipmentSync;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * One courier account's poll (P5B-38): non-final shipments with a consignment that weren't synced in the last
 * `couriers.sync_minutes` (all of them for "Sync now"), oldest first, at most `couriers.sync_batch` per run. The first
 * provider_unavailable (timeout, 5xx, 429) stops the run: the next run backs off by one interval.
 */
class SyncCourierAccount implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public const QUEUE = 'default';

    public int $timeout = 85; // default worker --timeout=90; an unfinished batch continues next run

    public int $tries = 1;

    public int $uniqueFor = 600;

    public function __construct(public readonly string $accountId, public readonly bool $force = false) {}

    public function uniqueId(): string
    {
        return 'courier-sync:'.$this->accountId;
    }

    public function handle(ShipmentSync $sync): void
    {
        $account = CourierAccount::query()->find($this->accountId);
        if ($account === null || ! $account->isConnected()) {
            return;
        }
        $query = Shipment::query()->where('courier_account_id', $account->id)->whereIn('status', ShipmentSync::ACTIVE)
            ->whereNotNull('consignment_id');
        if (! $this->force) {
            $cutoff = now()->subMinutes((int) config('couriers.sync_minutes', 15));
            $query->where(fn ($w) => $w->whereNull('last_synced_at')->orWhere('last_synced_at', '<', $cutoff));
        }
        $shipments = $query->orderByRaw('COALESCE(last_synced_at, booked_at, created_at)')->limit(max(1, (int) config('couriers.sync_batch', 100)))->get();
        $error = null;
        foreach ($shipments as $shipment) {
            try {
                $sync->refresh($shipment, 'poll');
            } catch (CourierException $e) {
                Log::warning('couriers.sync_item_failed', ['shipment_id' => $shipment->id, 'code' => $e->errorCode]);
                $error = $e->errorCode;
                if ($e->errorCode === CourierException::PROVIDER_UNAVAILABLE || $e->errorCode === CourierException::CREDENTIALS_INVALID) {
                    break; // back off (429 / outage / revoked keys): the next run tries again
                }
            } catch (Throwable $e) {
                report($e);
                $error = 'error';
            }
        }
        CourierAccount::query()->whereKey($account->id)->update([
            'last_synced_at' => now(),
            'last_error_code' => $error,
            'updated_at' => now(),
        ]);
    }
}

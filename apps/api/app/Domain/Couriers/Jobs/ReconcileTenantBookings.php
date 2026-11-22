<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Jobs;

use App\Domain\Couriers\BookingService;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Throwable;

/** One tenant's `booking` rows older than a minute → BookingService::reconcile (P5B-33). Items are isolated. */
class ReconcileTenantBookings implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public const BATCH = 200;

    public int $timeout = 85;

    public int $uniqueFor = 300;

    public function __construct(string $tenantId)
    {
        $this->tenantId = $tenantId;
    }

    public function uniqueId(): string
    {
        return 'courier-reconcile:'.$this->tenantId;
    }

    public function handle(BookingService $booking): void
    {
        $rows = Shipment::query()->where('status', Shipment::BOOKING)->where('created_at', '<=', now()->subMinute())
            ->orderBy('created_at')->limit(self::BATCH)->get();
        foreach ($rows as $shipment) {
            try {
                $booking->reconcile($shipment);
            } catch (Throwable $e) {
                report($e);
            }
        }
    }
}

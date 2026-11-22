<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Jobs;

use App\Domain\Couriers\BookingService;
use App\Domain\Couriers\CourierManager;
use App\Domain\Couriers\Drivers\BookingRequest;
use App\Domain\Couriers\Drivers\BookingResult;
use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\ShipmentBatch;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Bulk booking (P5B-40) on the `bulk` queue. Per order: transaction 1 (lock, state, area) writes a `booking` row —
 * or a `skipped` result (`invalid_state_transition`, `shipment_booked`, `area_unmapped`); then the courier is called
 * per chunk (Steadfast bulk endpoint ≤ 500, others one by one inside the driver) outside any transaction; then
 * transaction 2 per parcel. Unknown outcomes stay `booking` for couriers:reconcile-bookings.
 */
class RunBulkBooking implements ShouldQueue
{
    use Queueable, TenantAware;

    public const QUEUE = 'bulk';

    public const CHUNK = 500;

    public int $timeout = 300; // the `bulk` worker runs with --timeout=310 (docker-compose)

    public int $tries = 1;

    /** @param list<string> $orderIds */
    public function __construct(public readonly string $batchId, public readonly array $orderIds) {}

    public function handle(BookingService $booking, CourierManager $couriers): void
    {
        $batch = ShipmentBatch::query()->find($this->batchId);
        if ($batch === null || $batch->status !== ShipmentBatch::QUEUED) {
            return;
        }
        $batch->forceFill(['status' => ShipmentBatch::RUNNING, 'started_at' => now()])->save();
        $results = [];
        try {
            $account = CourierAccount::query()->where('store_id', $batch->store_id)->where('provider', $batch->provider)->first();
            $numbers = Order::query()->where('store_id', $batch->store_id)->whereIn('id', $this->orderIds)->pluck('number', 'id');
            $pending = []; // shipment id => [order id, request]
            foreach ($this->orderIds as $orderId) {
                $results[$orderId] = ['order_id' => $orderId, 'order_number' => (string) ($numbers[$orderId] ?? ''), 'shipment_id' => null, 'status' => 'skipped', 'reason' => null];
                if ($account === null || ! $account->isConnected()) {
                    $results[$orderId]['reason'] = 'gateway_not_connected';

                    continue;
                }
                try {
                    [$shipment, $request] = $this->prepare($booking, $account, $batch, $orderId);
                    $results[$orderId]['shipment_id'] = $shipment->id;
                    $pending[$shipment->id] = [$orderId, $request, $shipment];
                } catch (ApiException $e) {
                    $results[$orderId]['reason'] = $e->errorCode;
                } catch (ValidationException) {
                    $results[$orderId]['reason'] = 'area_unmapped';
                }
            }

            foreach (array_chunk($pending, self::CHUNK, true) as $chunk) {
                $requests = array_map(fn (array $p) => $p[1], $chunk);
                try {
                    $answers = $couriers->driver($batch->provider)->bookBulk($account, $requests);
                } catch (CourierException $e) {
                    $answers = array_map(fn () => $e, $requests);
                } catch (Throwable $e) {
                    report($e);
                    $answers = array_map(fn () => new CourierException(CourierException::PROVIDER_UNAVAILABLE), $requests);
                }
                foreach ($chunk as $shipmentId => [$orderId, , $shipment]) {
                    $answer = $answers[$shipmentId] ?? new CourierException(CourierException::PROVIDER_UNAVAILABLE);
                    if ($answer instanceof BookingResult) {
                        $booking->markBooked($shipment, $answer);
                        $results[$orderId]['status'] = 'booked';
                    } elseif ($answer->errorCode === CourierException::PROVIDER_UNAVAILABLE) {
                        // Outcome unknown (courier down / timeout): reported as failed; the row stays `booking` and
                        // couriers:reconcile-bookings books it if the courier has it, else marks it booking_failed.
                        $results[$orderId]['status'] = 'failed';
                        $results[$orderId]['reason'] = CourierException::PROVIDER_UNAVAILABLE;
                    } else {
                        $booking->fail($shipment, CourierException::sanitise($answer->getMessage()));
                        $results[$orderId]['status'] = 'failed';
                        $results[$orderId]['reason'] = $answer->errorCode;
                    }
                }
            }
            $this->finish($batch, $results, ShipmentBatch::COMPLETED);
        } catch (Throwable $e) {
            report($e);
            Log::warning('couriers.bulk_failed', ['batch_id' => $batch->id]);
            $this->finish($batch, $results, ShipmentBatch::FAILED);
        }
    }

    /** @return array{0: Shipment, 1: BookingRequest} */
    private function prepare(BookingService $booking, CourierAccount $account, ShipmentBatch $batch, string $orderId): array
    {
        return DB::transaction(function () use ($booking, $account, $batch, $orderId) {
            /** @var Order|null $o */
            $o = Order::query()->where('store_id', $batch->store_id)->whereKey($orderId)->lockForUpdate()->first();
            if ($o === null) {
                throw new ApiException(404, 'not_found', 'Unknown order.');
            }
            $booking->assertBookable($o);
            $area = $booking->area($account, $o, null, 'area');
            $shipment = $booking->newShipment($o, $account, [], null, null, $batch->id);
            $booking->save($shipment);
            OrderTimeline::record($o, 'shipment', null, null, ['action' => 'booking', 'shipment_id' => $shipment->id, 'provider' => $account->provider, 'batch_id' => $batch->id], actorType: 'system');

            return [$shipment, $booking->request($o, $shipment, $account, [], $area)];
        });
    }

    /** @param array<string, array<string, mixed>> $results */
    private function finish(ShipmentBatch $batch, array $results, string $status): void
    {
        $list = array_values($results);
        $count = fn (string $s) => count(array_filter($list, fn (array $r) => $r['status'] === $s));
        $batch->forceFill([
            'status' => $status,
            'results' => $list,
            'booked' => $count('booked'),
            'skipped' => $count('skipped'),
            'failed' => $count('failed') + ($status === ShipmentBatch::FAILED ? max(0, $batch->total - count($list)) : 0),
            'finished_at' => now(),
        ])->save();
    }
}

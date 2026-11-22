<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/** P5B-33 on Postgres (fork-based, like CommerceSecurityTest): parallel bookings of one order → one parcel. */
#[Group('security')]
#[Group('couriers')]
class ShipmentRaceTest extends TestCase
{
    use ForksRaces, RefreshDatabase, ShipmentFixtures;

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_bookings_create_one_shipment(): void
    {
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            [, $tenant, $store, $h, $variant] = $this->courierShop();
            $order = $this->confirmedOrder($h, $store, $variant);

            // 8 bookings of the same order at once, each with its own Idempotency-Key.
            $results = $this->parallel(8, fn (int $i) => $this->book($h, $store, $order, [], 'race-'.$i.'-'.Str::random(8))->status());
            sort($results);
            $this->assertSame([201, 409, 409, 409, 409, 409, 409, 409], $results);

            $this->inTenant($tenant, function () use ($order) {
                $this->assertSame(1, Shipment::query()->where('order_id', $order)->count());
                $this->assertSame('booked', Shipment::query()->where('order_id', $order)->value('status'));
                $this->assertSame('ready_to_ship', Order::query()->whereKey($order)->value('status'));
            });
        } finally {
            $this->raceCleanup();
        }
    }
}

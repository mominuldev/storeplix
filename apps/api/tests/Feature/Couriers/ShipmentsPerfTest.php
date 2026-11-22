<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\Database\RlsSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/**
 * §13 perf: the Shipments list (page 1, default sort, counts + KPIs) with 10 000 shipments in the store answers with
 * p95 < 200 ms, RLS on (CI api-rls). Rows are bulk-inserted (setup is not timed); 30 timed requests after a warm-up.
 */
#[Group('perf')]
#[Group('couriers')]
class ShipmentsPerfTest extends TestCase
{
    use RefreshDatabase, ShipmentFixtures;

    public const ROWS = 10000;

    public const RUNS = 30;

    public const P95_BUDGET_MS = 200.0;

    public function test_shipments_list_p95_with_ten_thousand_rows(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Needs Postgres (CI perf job).');
        }
        $this->withoutMiddleware(ThrottleRequests::class);
        [, $tenant, $store, $h, $variant, $account] = $this->courierShop();
        $seed = $this->confirmedOrder($h, $store, $variant);
        $this->inTenant($tenant, function () use ($seed, $store, $account) {
            $o = Order::query()->findOrFail($seed)->getAttributes();
            $statuses = ['booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivery_failed', 'on_hold', 'delivered', 'delivered', 'delivered', 'returned', 'returning', 'cancelled'];
            $now = now();
            for ($chunk = 0; $chunk < self::ROWS / 500; $chunk++) {
                $orders = [];
                $shipments = [];
                for ($i = 0; $i < 500; $i++) {
                    $n = $chunk * 500 + $i + 1;
                    $orderId = strtolower((string) Str::ulid());
                    $status = $statuses[$n % count($statuses)];
                    $at = $now->copy()->subMinutes($n * 7);
                    $orders[] = array_merge($o, [
                        'id' => $orderId, 'number' => 'PF-'.(100000 + $n), 'sequence' => 100000 + $n, 'idempotency_key' => null,
                        'confirmation_token_hash' => null, 'status' => 'shipped', 'customer_phone' => '88017'.str_pad((string) $n, 8, '0', STR_PAD_LEFT),
                        'created_at' => $at, 'updated_at' => $at, 'placed_at' => $at,
                    ]);
                    $shipments[] = [
                        'id' => strtolower((string) Str::ulid()), 'tenant_id' => $store->tenant_id, 'store_id' => $store->id, 'order_id' => $orderId,
                        'provider' => 'steadfast', 'courier_account_id' => $account->id, 'carrier_name' => 'Steadfast', 'status' => $status,
                        'consignment_id' => 'PF'.$n, 'tracking_code' => 'PF'.$n, 'cod_amount' => 1000 + $n, 'provider_status' => $status,
                        'problem' => in_array($status, ['delivery_failed', 'on_hold', 'returning'], true) ? $status : null,
                        'cod_collected_amount' => $status === 'delivered' ? 1000 + $n : null, 'booked_at' => $at, 'last_event_at' => $at,
                        'delivered_at' => $status === 'delivered' ? $at : null, 'returned_at' => $status === 'returned' ? $at : null,
                        'weight_grams' => 500, 'attempts' => 1, 'cod_overridden' => false, 'created_at' => $at, 'updated_at' => $at,
                    ];
                }
                DB::table('orders')->insert(array_map(fn ($r) => array_map(fn ($v) => is_array($v) ? json_encode($v) : $v, $r), $orders));
                DB::table('shipments')->insert($shipments);
            }
        });
        DB::connection((string) config('tenancy.owner_connection'))->statement('ANALYZE shipments');
        DB::connection((string) config('tenancy.owner_connection'))->statement('ANALYZE orders');

        $url = "/api/v1/stores/{$store->id}/shipments";
        $durations = [];
        for ($run = 0; $run <= self::RUNS; $run++) {
            $query = match ($run % 3) {
                0 => '',
                1 => '?filter[status]=active',
                default => '?filter[provider]=steadfast&sort=-cod',
            };
            $start = hrtime(true);
            $this->api($h, 'GET', $url.$query)->assertOk()->assertJsonPath('meta.counts.all', fn ($n) => $n > 0);
            if ($run > 0) {
                $durations[] = (hrtime(true) - $start) / 1e6;
            }
        }
        sort($durations);
        $p95 = $durations[(int) ceil(0.95 * count($durations)) - 1];
        fwrite(STDERR, sprintf("[perf] shipments list, %d rows, RLS %s, %d runs: p50 %.1f ms, p95 %.1f ms, max %.1f ms\n",
            self::ROWS + 1, app(RlsSession::class)->enabled() ? 'on' : 'off', self::RUNS, $durations[(int) (count($durations) / 2)], $p95, end($durations)));
        $this->assertLessThan(self::P95_BUDGET_MS, $p95, "shipments list p95 {$p95} ms ≥ ".self::P95_BUDGET_MS.' ms');
    }
}

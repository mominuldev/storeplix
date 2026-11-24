<?php

declare(strict_types=1);

namespace Tests\Feature\Reports;

use App\Domain\Billing\Models\Plan;
use App\Domain\Reports\Http\ReportController;
use App\Domain\Reports\ReportRange;
use App\Domain\Tenancy\Support\TenantCache;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

/** PHASE-7-CONTRACT §6.4 budget: p95 < 800 ms for a 366-day range over 50 000 orders + 5 000 expenses (PHASE-8-7 §7.2; Postgres only). */
#[Group('reports')]
#[Group('perf')]
class ReportsPerfTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, ReportFixtures;

    public function test_366_day_reports_over_50k_orders_stay_under_800ms_p95(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Report perf budget runs on Postgres only.');
        }
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->travelTo(CarbonImmutable::parse('2026-11-20 06:00:00', 'UTC'));
        [, $t, $store, $h] = $this->shop();
        $this->onPlan($t, Plan::GROWTH);

        $start = CarbonImmutable::parse('2025-11-20 00:00:00', 'UTC');
        $statuses = ['delivered', 'delivered', 'shipped', 'cancelled', 'pending', 'confirmed'];
        $this->inTenant($t, function () use ($t, $store, $start, $statuses) {
            for ($chunk = 0; $chunk < 50; $chunk++) {
                $orders = $items = [];
                for ($i = 0; $i < 1000; $i++) {
                    $n = $chunk * 1000 + $i;
                    $id = strtolower((string) Str::ulid());
                    $at = $start->addSeconds(($n * 631) % (365 * 86400))->format('Y-m-d H:i:s');
                    $status = $statuses[$n % count($statuses)];
                    $orders[] = [
                        'id' => $id, 'tenant_id' => $t->id, 'store_id' => $store->id, 'number' => 'P'.$n, 'sequence' => 100000 + $n,
                        'status' => $status, 'payment_status' => 'unpaid', 'payment_method' => 'cod', 'created_via' => 'storefront',
                        'channel' => ['website', 'facebook'][$n % 2], 'customer_name' => 'C', 'customer_phone' => '8801711000000',
                        'shipping_address' => '{}', 'district_code' => ['dhaka', 'chattogram', 'sylhet'][$n % 3], 'currency' => 'BDT',
                        'subtotal_amount' => 100000, 'total_amount' => 100000, 'refunded_amount' => 0, 'shipping_zone_name' => 'Z', 'tags' => '[]',
                        'placed_at' => $at, 'delivered_at' => $status === 'delivered' ? $at : null, 'created_at' => $at, 'updated_at' => $at,
                    ];
                    $items[] = [
                        'id' => strtolower((string) Str::ulid()), 'tenant_id' => $t->id, 'store_id' => $store->id, 'order_id' => $id,
                        'product_name' => 'P'.($n % 40), 'variant_title' => 'D', 'option_values' => '[]', 'unit_price_amount' => 100000,
                        'unit_cost_amount' => 60000, 'subtotal_amount' => 100000, 'discount_amount' => 0, 'total_amount' => 100000,
                        'quantity' => 1, 'tracked' => false, 'created_at' => $at, 'updated_at' => $at,
                    ];
                }
                DB::table('orders')->insert($orders);
                DB::table('order_items')->insert($items);
            }
        });
        // PHASE-8-7 §7.2: + 5,000 expenses over the same year (one grouped aggregate per window).
        $this->inTenant($t, function () use ($t, $store, $start) {
            $categories = ['ads', 'packaging', 'salaries', 'rent_bills', 'courier', 'other'];
            foreach (array_chunk(range(0, 4999), 1000) as $chunk) {
                DB::table('expenses')->insert(array_map(fn (int $n) => [
                    'id' => strtolower((string) Str::ulid()), 'tenant_id' => $t->id, 'store_id' => $store->id,
                    'category' => $categories[$n % 6], 'paid_from' => 'cash', 'amount' => 1000 + $n, 'currency' => 'BDT',
                    'spent_on' => $start->addDays($n % 365)->format('Y-m-d'), 'created_at' => now(), 'updated_at' => now(),
                ], $chunk));
            }
        });
        DB::statement('ANALYZE expenses');
        DB::statement('ANALYZE orders');
        DB::statement('ANALYZE order_items');

        $query = ['from' => '2025-11-20', 'to' => '2026-11-20'];
        $times = [];
        $byType = [];
        foreach (['sales', 'profit', 'delivery'] as $type) {
            for ($run = 0; $run < 4; $run++) {
                $this->inTenant($t, fn () => app(TenantCache::class)->forget(ReportController::cacheKey($type, ReportRange::resolve($query['from'], $query['to'], 'Asia/Dhaka')->cacheHash($store->id), $type === 'profit' ? '0' : null)));
                $began = microtime(true);
                $this->report($h, $store, $type, $query)->assertOk();
                $times[] = $ms = (microtime(true) - $began) * 1000;
                $byType[$type][] = (int) round($ms);
            }
        }
        sort($times);
        $p95 = $times[(int) ceil(0.95 * count($times)) - 1];
        $this->assertLessThan(800, $p95, 'report p95 '.round($p95).' ms '.json_encode($byType));
    }
}

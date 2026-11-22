<?php

namespace Tests\Feature\Commerce;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * §12 perf budget (QA phase-5a F-M3): checkout p95 < 300 ms with a 10-line cart on CI Postgres, 50 sequential runs.
 * Only the checkout request is timed (cart building is setup); notifications are queued as in production.
 * Postgres-only; no fork and no commit, so it stays inside the RefreshDatabase transaction.
 */
#[Group('perf')]
#[Group('checkout-perf')]
class CheckoutPerfTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    public const RUNS = 50;

    public const LINES = 10;

    public const P95_BUDGET_MS = 300.0;

    public function test_checkout_p95_with_a_ten_line_cart(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Needs Postgres (CI perf job).');
        }
        $this->withoutMiddleware(ThrottleRequests::class);
        Queue::fake();
        [, , $store, $h] = $this->liveShop();
        $variants = [];
        for ($i = 0; $i < self::LINES; $i++) {
            $variants[] = $this->stocked($h, $store, 10000 + $i * 100, 1000)[1];
        }
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'PERF5', 'type' => 'percentage', 'percent_bps' => 500, 'status' => 'active', 'usage_per_customer' => null])->assertCreated();

        $durations = [];
        for ($run = 0; $run <= self::RUNS; $run++) { // run 0 warms up opcache / connections and isn't counted
            $token = null;
            foreach ($variants as $variant) {
                $token = $this->cartWith($store, $variant, 1, $token);
            }
            $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'PERF5'], $token)->assertOk();
            $expected = $this->sf($store, 'GET', '/cart', [], $token)->json('data.estimated_total_amount') + 7000;
            $body = $this->checkoutBody($expected, ['contact' => ['phone' => sprintf('0171500%04d', $run)]]);

            $start = hrtime(true);
            $this->checkout($store, $token, $body)->assertCreated();
            if ($run > 0) {
                $durations[] = (hrtime(true) - $start) / 1e6;
            }
        }

        sort($durations);
        $p95 = $durations[(int) ceil(0.95 * count($durations)) - 1];
        fwrite(STDERR, sprintf("[perf] checkout %d lines × %d runs: p50 %.1f ms, p95 %.1f ms, max %.1f ms\n",
            self::LINES, self::RUNS, $durations[(int) (count($durations) / 2)], $p95, end($durations)));
        $this->assertLessThan(self::P95_BUDGET_MS, $p95, "checkout p95 {$p95} ms ≥ ".self::P95_BUDGET_MS.' ms');
    }
}

<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\OnlinePaymentFixtures;
use Tests\TestCase;

/**
 * §13 perf: online checkout (fake gateway) p95 < 300 ms with a 10-line cart, 50 sequential runs, on Postgres (RLS on in
 * `api-rls`). Same harness as CheckoutPerfTest; the fake gateway's initiate() is in-process, so the time measured is
 * our own (commit + initiation bookkeeping).
 */
#[Group('perf')]
#[Group('checkout-perf')]
class OnlineCheckoutPerfTest extends TestCase
{
    use OnlinePaymentFixtures, RefreshDatabase;

    public const RUNS = 50;

    public const LINES = 10;

    public const P95_BUDGET_MS = 300.0;

    public function test_online_checkout_p95_with_the_fake_gateway(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Needs Postgres (CI perf job).');
        }
        $this->withoutMiddleware(ThrottleRequests::class);
        Queue::fake();
        [, , $store, $h] = $this->onlineShop();
        $variants = [];
        for ($i = 0; $i < self::LINES; $i++) {
            $variants[] = $this->stocked($h, $store, 10000 + $i * 100, 1000)[1];
        }

        $durations = [];
        for ($run = 0; $run <= self::RUNS; $run++) {
            $token = null;
            foreach ($variants as $variant) {
                $token = $this->cartWith($store, $variant, 1, $token);
            }
            $expected = $this->sf($store, 'GET', '/cart', [], $token)->json('data.estimated_total_amount') + 7000;
            $body = $this->checkoutBody($expected, ['payment_method' => $run % 2 === 0 ? 'bkash' : 'sslcommerz', 'contact' => ['phone' => sprintf('0171600%04d', $run)]]);

            $start = hrtime(true);
            $this->checkout($store, $token, $body)->assertCreated()->assertJsonPath('data.payment.status', 'redirect');
            if ($run > 0) {
                $durations[] = (hrtime(true) - $start) / 1e6;
            }
        }

        sort($durations);
        $p95 = $durations[(int) ceil(0.95 * count($durations)) - 1];
        fwrite(STDERR, sprintf("[perf] online checkout %d lines × %d runs: p50 %.1f ms, p95 %.1f ms, max %.1f ms\n",
            self::LINES, self::RUNS, $durations[(int) (count($durations) / 2)], $p95, end($durations)));
        $this->assertLessThan(self::P95_BUDGET_MS, $p95, "online checkout p95 {$p95} ms ≥ ".self::P95_BUDGET_MS.' ms');
    }
}

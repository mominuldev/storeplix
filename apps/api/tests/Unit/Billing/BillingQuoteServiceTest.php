<?php

declare(strict_types=1);

namespace Tests\Unit\Billing;

use App\Domain\Billing\BillingQuoteService;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Support\VatCalculator;
use App\Domain\Shared\Http\ApiException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/** PHASE-7 §3.3 classification over every (current, target) pair, P7-6 rounding and the VAT split. */
#[Group('billing')]
class BillingQuoteServiceTest extends TestCase
{
    private static function plan(string $code): Plan
    {
        $plan = new Plan;
        $plan->forceFill(match ($code) {
            'free' => ['id' => 'p-free', 'code' => 'free', 'name' => 'Free', 'price_amount' => 0, 'price_yearly_amount' => null, 'sort' => 1, 'is_active' => true],
            'starter' => ['id' => 'p-starter', 'code' => 'starter', 'name' => 'Starter', 'price_amount' => 49900, 'price_yearly_amount' => 499000, 'sort' => 2, 'is_active' => true],
            'growth' => ['id' => 'p-growth', 'code' => 'growth', 'name' => 'Growth', 'price_amount' => 149900, 'price_yearly_amount' => 1499000, 'sort' => 3, 'is_active' => true],
        });

        return $plan;
    }

    /** @return iterable<string, array{string, string, string, string, string, string}> current, interval, status, target, interval, expected */
    public static function pairs(): iterable
    {
        // From Free / trialing
        foreach (['active' => 'free', 'trialing' => 'starter'] as $status => $current) {
            foreach (['starter', 'growth'] as $target) {
                foreach (['month', 'year'] as $interval) {
                    yield "{$status} {$current} → {$target} {$interval}" => [$current, 'month', $status, $target, $interval, 'new'];
                }
            }
        }
        yield 'free → free' => ['free', 'month', 'active', 'free', 'month', '409:plan_unchanged'];
        yield 'trialing → free' => ['starter', 'month', 'trialing', 'free', 'month', 'cancel'];
        yield 'free yearly unavailable' => ['starter', 'month', 'active', 'free', 'year', '422:plan_unavailable'];
        // Paid → paid
        yield 'starter m → growth m' => ['starter', 'month', 'active', 'growth', 'month', 'upgrade'];
        yield 'starter m → starter y' => ['starter', 'month', 'active', 'starter', 'year', 'upgrade'];
        yield 'starter m → growth y' => ['starter', 'month', 'active', 'growth', 'year', 'upgrade'];
        yield 'starter y → growth y' => ['starter', 'year', 'active', 'growth', 'year', 'upgrade'];
        yield 'starter y → growth m' => ['starter', 'year', 'active', 'growth', 'month', '422:plan_unavailable'];
        yield 'starter y → starter m' => ['starter', 'year', 'active', 'starter', 'month', 'downgrade'];
        yield 'growth m → starter m' => ['growth', 'month', 'active', 'starter', 'month', 'downgrade'];
        yield 'growth m → starter y' => ['growth', 'month', 'active', 'starter', 'year', 'downgrade'];
        yield 'growth y → starter m' => ['growth', 'year', 'active', 'starter', 'month', 'downgrade'];
        yield 'growth y → starter y' => ['growth', 'year', 'active', 'starter', 'year', 'downgrade'];
        yield 'growth y → growth m' => ['growth', 'year', 'active', 'growth', 'month', 'downgrade'];
        yield 'growth m → growth y' => ['growth', 'month', 'active', 'growth', 'year', 'upgrade'];
        yield 'starter m → starter m' => ['starter', 'month', 'active', 'starter', 'month', '409:plan_unchanged'];
        yield 'growth y → growth y' => ['growth', 'year', 'active', 'growth', 'year', '409:plan_unchanged'];
        yield 'starter → free' => ['starter', 'month', 'active', 'free', 'month', 'cancel'];
        yield 'growth y → free' => ['growth', 'year', 'active', 'free', 'month', 'cancel'];
        // past_due: only Free
        yield 'past_due → free' => ['starter', 'month', 'past_due', 'free', 'month', 'cancel'];
        yield 'past_due → growth' => ['starter', 'month', 'past_due', 'growth', 'month', '409:invoice_overdue'];
        yield 'past_due → same' => ['starter', 'month', 'past_due', 'starter', 'month', '409:invoice_overdue'];
    }

    #[DataProvider('pairs')]
    public function test_classify(string $current, string $currentInterval, string $status, string $target, string $interval, string $expected): void
    {
        try {
            $kind = BillingQuoteService::classify(self::plan($current), $currentInterval, $status, self::plan($target), $interval);
        } catch (ApiException $e) {
            $kind = $e->getStatusCode().':'.$e->errorCode;
        }
        $this->assertSame($expected, $kind);
    }

    public function test_inactive_target_is_unavailable(): void
    {
        $growth = self::plan('growth');
        $growth->is_active = false;
        try {
            BillingQuoteService::classify(self::plan('starter'), 'month', 'active', $growth, 'month');
            $this->fail('expected plan_unavailable');
        } catch (ApiException $e) {
            $this->assertSame([422, 'plan_unavailable'], [$e->getStatusCode(), $e->errorCode]);
        }
    }

    public function test_round_up_to_whole_taka(): void
    {
        $this->assertSame(100, BillingQuoteService::ceilToTaka(1, 1));          // 1 paisa → ৳1
        $this->assertSame(100, BillingQuoteService::ceilToTaka(100, 1));
        $this->assertSame(200, BillingQuoteService::ceilToTaka(101, 1));
        $this->assertSame(0, BillingQuoteService::ceilToTaka(0, 7));
        // half of ৳1,000 over a 30-day period with 15 days left = ৳500 exactly
        $this->assertSame(50000, BillingQuoteService::ceilToTaka(100000 * 15 * 86400, 30 * 86400));
        // ৳1,000 × 1/3 = ৳333.33… → ৳334
        $this->assertSame(33400, BillingQuoteService::ceilToTaka(100000, 3));
    }

    public function test_vat_is_included_in_the_price(): void
    {
        $this->assertSame(['subtotal_amount' => 43392, 'tax_amount' => 6508, 'tax_rate_bps' => 1500], VatCalculator::split(49900, 1500));
        $this->assertSame(['subtotal_amount' => 130348, 'tax_amount' => 19552, 'tax_rate_bps' => 1500], VatCalculator::split(149900, 1500));
        $this->assertSame(['subtotal_amount' => 100, 'tax_amount' => 0, 'tax_rate_bps' => 0], VatCalculator::split(100, 0));
        foreach ([100, 999, 49900, 499000, 1499000] as $total) {
            $split = VatCalculator::split($total, 1500);
            $this->assertSame($total, $split['subtotal_amount'] + $split['tax_amount']);
        }
    }
}

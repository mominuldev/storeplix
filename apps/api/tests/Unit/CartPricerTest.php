<?php

namespace Tests\Unit;

use App\Domain\Pricing\CartPricer;
use PHPUnit\Framework\TestCase;

/** P5-12 discount math: integer, deterministic, exact allocation. */
class CartPricerTest extends TestCase
{
    private function line(int $price, int $qty, string $product = 'p', array $categories = [], array $extra = []): array
    {
        return $extra + ['key' => $product, 'variant_id' => 'v-'.$product, 'product_id' => $product, 'category_ids' => $categories,
            'quantity' => $qty, 'price' => $price, 'compare_at' => null, 'purchasable' => true, 'tracked' => false, 'backorder' => false, 'available' => 0, 'threshold' => 5];
    }

    public function test_percentage_floor_then_cap_then_eligible_subtotal(): void
    {
        $coupon = ['type' => 'percentage', 'percent_bps' => 1500, 'amount' => null, 'max_discount_amount' => null, 'applies_to' => 'all'];
        $this->assertSame(1499, CartPricer::discount($coupon, 9999)); // floor(1499.85)
        $this->assertSame(500, CartPricer::discount(['max_discount_amount' => 500] + $coupon, 9999));
        $this->assertSame(100, CartPricer::discount(['percent_bps' => 10000] + $coupon, 100));
        $fixed = ['type' => 'fixed', 'amount' => 5000, 'percent_bps' => null, 'max_discount_amount' => null, 'applies_to' => 'all'];
        $this->assertSame(3000, CartPricer::discount($fixed, 3000));
        $this->assertSame(5000, CartPricer::discount($fixed, 3001 + 5000));
        $this->assertSame(0, CartPricer::discount(['type' => 'free_shipping'] + $fixed, 3000));
    }

    public function test_eligibility_by_product_and_category(): void
    {
        $lines = [$this->line(1000, 1, 'a', ['c1']), $this->line(2000, 1, 'b', ['c2']), $this->line(4000, 1, 'c', [])];
        $byProduct = CartPricer::price($lines, ['type' => 'fixed', 'amount' => 999999, 'percent_bps' => null, 'max_discount_amount' => null, 'applies_to' => 'products', 'product_ids' => ['b'], 'category_ids' => []]);
        $this->assertSame([2000, 2000], [$byProduct['eligible_subtotal'], $byProduct['discount']]);
        $this->assertSame([0, 2000, 0], array_column($byProduct['lines'], 'discount_amount'));
        $byCategory = CartPricer::price($lines, ['type' => 'percentage', 'percent_bps' => 5000, 'amount' => null, 'max_discount_amount' => null, 'applies_to' => 'categories', 'product_ids' => [], 'category_ids' => ['c1', 'c2']]);
        $this->assertSame([3000, 1500], [$byCategory['eligible_subtotal'], $byCategory['discount']]);
        $this->assertSame([500, 1000, 0], array_column($byCategory['lines'], 'discount_amount'));
    }

    public function test_largest_remainder_ties_go_to_the_lower_index(): void
    {
        $this->assertSame([34, 33, 33], CartPricer::allocate(100, [1, 1, 1]));
        $this->assertSame([1, 0, 0], CartPricer::allocate(1, [5, 5, 5]));
        $this->assertSame([0, 0], CartPricer::allocate(10, [0, 0]));
        $this->assertSame([0, 7, 3], CartPricer::allocate(10, [0, 700, 300]));
    }

    /** Property: 1 000 random carts — Σ line discounts = order discount, each share ≤ its line, ineligible lines get 0. */
    public function test_allocation_sums_exactly_for_random_carts(): void
    {
        mt_srand(20261122);
        for ($run = 0; $run < 1000; $run++) {
            $lines = [];
            $n = mt_rand(1, 12);
            for ($i = 0; $i < $n; $i++) {
                $lines[] = $this->line(mt_rand(1, 1_000_000_000), mt_rand(1, 99), "p{$i}", mt_rand(0, 1) ? ['c'] : []);
            }
            $coupon = mt_rand(0, 1)
                ? ['type' => 'percentage', 'percent_bps' => mt_rand(1, 10000), 'amount' => null, 'max_discount_amount' => mt_rand(0, 1) ? mt_rand(1, 10_000_000) : null]
                : ['type' => 'fixed', 'amount' => mt_rand(1, 1_000_000_000), 'percent_bps' => null, 'max_discount_amount' => null];
            $coupon += ['applies_to' => mt_rand(0, 1) ? 'all' : 'categories', 'category_ids' => ['c'], 'product_ids' => []];
            $priced = CartPricer::price($lines, $coupon);
            $shares = array_column($priced['lines'], 'discount_amount');
            $this->assertSame($priced['discount'], array_sum($shares), "run {$run}");
            $this->assertLessThanOrEqual($priced['eligible_subtotal'], $priced['discount']);
            foreach ($priced['lines'] as $line) {
                $this->assertLessThanOrEqual($line['line_amount'], $line['discount_amount']);
                if (! $line['eligible']) {
                    $this->assertSame(0, $line['discount_amount']);
                }
            }
        }
    }

    public function test_issues_low_stock_and_shipping_rules(): void
    {
        $priced = CartPricer::price([
            $this->line(1000, 3, 'a', [], ['tracked' => true, 'available' => 2]),
            $this->line(1000, 2, 'b', [], ['tracked' => true, 'available' => 4, 'threshold' => 5]),
            $this->line(1000, 1, 'c', [], ['purchasable' => false]),
            $this->line(1000, 9, 'd', [], ['tracked' => true, 'backorder' => true, 'available' => 0]),
            $this->line(1000, 1, 'e', [], ['compare_at' => 1500]),
        ]);
        $this->assertSame(['insufficient_stock', null, 'unavailable', null, null], array_column($priced['lines'], 'issue'));
        $this->assertSame(2, $priced['lines'][0]['max_quantity']);
        $this->assertSame(4, $priced['lines'][1]['low_stock']);
        $this->assertSame(12000, $priced['subtotal']);
        $this->assertSame(500, $priced['compare_savings']);
        $this->assertTrue($priced['has_issues']);

        $this->assertSame(0, CartPricer::shipping(7000, 300000, 300000, false)['shipping']);
        $this->assertSame(7000, CartPricer::shipping(7000, 300000, 299999, false)['shipping']);
        $this->assertSame(['shipping' => 0, 'shipping_discount' => 7000, 'coupon_shipping_discount' => 7000, 'free_by_threshold' => false], CartPricer::shipping(7000, null, 100, true));
        $this->assertSame(2500, CartPricer::shipping(7000, null, 100, true, 2500)['shipping']);
    }
}

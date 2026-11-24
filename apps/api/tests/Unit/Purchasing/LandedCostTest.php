<?php

declare(strict_types=1);

namespace Tests\Unit\Purchasing;

use App\Domain\Purchasing\LandedCost;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/** S172 cost vectors (PHASE-8-8B §5.4, P88B-5/6): landed allocation and the weighted average, integer only. */
#[Group('purchasing')]
#[Group('security')]
class LandedCostTest extends TestCase
{
    public function test_no_charges_keeps_the_unit_cost(): void
    {
        $this->assertSame(['a' => 1000, 'b' => 250], LandedCost::unitCosts([
            ['key' => 'a', 'unit_cost' => 1000, 'quantity' => 3], ['key' => 'b', 'unit_cost' => 250, 'quantity' => 8],
        ], 0, 0));
    }

    public function test_transport_is_spread_by_line_value(): void
    {
        // subtotal 60 000 + 10 000 = 70 000; transport 7 000 → shares 6 000 / 1 000 → +100 and +50 per unit.
        $this->assertSame(['a' => 1100, 'b' => 550], LandedCost::unitCosts([
            ['key' => 'a', 'unit_cost' => 1000, 'quantity' => 60], ['key' => 'b', 'unit_cost' => 500, 'quantity' => 20],
        ], 7000, 0));
    }

    public function test_discount_lowers_and_transport_minus_discount_is_netted(): void
    {
        // net = 1 000 − 5 000 = −4 000 over one line of 10 × 2 000 → (20 000 − 4 000) ÷ 10 = 1 600.
        $this->assertSame(['a' => 1600], LandedCost::unitCosts([['key' => 'a', 'unit_cost' => 2000, 'quantity' => 10]], 1000, 5000));
        // never below 0
        $this->assertSame(['a' => 0], LandedCost::unitCosts([['key' => 'a', 'unit_cost' => 100, 'quantity' => 10]], 0, 1000));
    }

    public function test_the_remainder_goes_to_the_largest_line_and_rounding_is_half_up(): void
    {
        // three equal-value lines, transport 100: shares 33/33/33 + remainder 1 to the largest (first on a tie).
        // a: (300 + 34) ÷ 3 = 111.33 → 111; b, c: (300 + 33) ÷ 3 = 111.
        $this->assertSame(['a' => 111, 'b' => 111, 'c' => 111], LandedCost::unitCosts([
            ['key' => 'a', 'unit_cost' => 100, 'quantity' => 3], ['key' => 'b', 'unit_cost' => 100, 'quantity' => 3], ['key' => 'c', 'unit_cost' => 100, 'quantity' => 3],
        ], 100, 0));
        // largest line by value takes the remainder: a 1×100, b 2×100 (value 200); transport 1 → shares 0 / 0 + 1 to b.
        // b: (200 + 1) ÷ 2 = 100.5 → 101 (half up).
        $this->assertSame(['a' => 100, 'b' => 101], LandedCost::unitCosts([
            ['key' => 'a', 'unit_cost' => 100, 'quantity' => 1], ['key' => 'b', 'unit_cost' => 100, 'quantity' => 2],
        ], 1, 0));
    }

    public function test_free_items_spread_charges_by_quantity(): void
    {
        $this->assertSame(['a' => 75, 'b' => 75], LandedCost::unitCosts([
            ['key' => 'a', 'unit_cost' => 0, 'quantity' => 4], ['key' => 'b', 'unit_cost' => 0, 'quantity' => 4],
        ], 600, 0));
    }

    /** @return array<string, array{0: int|null, 1: int, 2: int, 3: int, 4: int}> old, on hand, qty, landed → new */
    public static function averages(): array
    {
        return [
            'null old cost → landed' => [null, 10, 5, 1200, 1200],
            'nothing on hand → landed' => [1000, 0, 5, 1200, 1200],
            'negative on hand counts as 0' => [1000, -3, 5, 1200, 1200],
            'plain average' => [1000, 10, 10, 1200, 1100],
            'weighted' => [1000, 30, 10, 2000, 1250],
            'rounds half up' => [1000, 1, 1, 1001, 1001], // 1000.5 → 1001
            'rounds down below half' => [1000, 2, 1, 1001, 1000], // 1000.33 → 1000
        ];
    }

    #[DataProvider('averages')]
    public function test_weighted_average_vectors(?int $old, int $onHand, int $qty, int $landed, int $expected): void
    {
        $this->assertSame($expected, LandedCost::weightedAverage($old, $onHand, $qty, $landed));
    }
}

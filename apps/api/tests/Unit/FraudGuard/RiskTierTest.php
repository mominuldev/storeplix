<?php

declare(strict_types=1);

namespace Tests\Unit\FraudGuard;

use App\Domain\FraudGuard\FraudGuard;
use App\Domain\FraudGuard\RiskTier;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/** S163: P88-4 tier vectors (0, < min_parcels, thresholds ± 1) and the rate rounding (half down). */
#[Group('fraud')]
class RiskTierTest extends TestCase
{
    /** @return array<string, array{0: int, 1: int, 2: string}> */
    public static function vectors(): array
    {
        return [
            'no parcels' => [0, 0, 'new'],
            '1 delivered' => [1, 0, 'good'],
            '2 delivered' => [2, 0, 'good'],
            '1 returned (thin)' => [0, 1, 'careful'],
            '1/1 (thin)' => [1, 1, 'careful'],
            '0/2 (thin, was risky in 8.5)' => [0, 2, 'careful'],
            '3 returned' => [0, 3, 'risky'],
            '59 % (risky)' => [59, 41, 'risky'],
            '60 % (hold line: careful)' => [60, 40, 'careful'],
            '61 %' => [61, 39, 'careful'],
            '74 % (careful)' => [74, 26, 'careful'],
            '75 % (advance line: good)' => [75, 25, 'good'],
            '76 %' => [76, 24, 'good'],
            '3/1 = 75 % (was careful in 8.5)' => [3, 1, 'good'],
            '2/2 = 50 %' => [2, 2, 'risky'],
            '6/3 = 67 %' => [6, 3, 'careful'],
            '59.5 % rounds half down to 59' => [119, 81, 'risky'],
            '59.6 % rounds to 60' => [149, 101, 'careful'],
        ];
    }

    #[DataProvider('vectors')]
    public function test_tier_vectors(int $delivered, int $returned, string $tier): void
    {
        $this->assertSame($tier, RiskTier::classify($delivered, $returned));
    }

    public function test_rate_and_custom_thresholds(): void
    {
        $this->assertNull(RiskTier::rate(0, 0));
        $this->assertSame([33, 60, 59, 60, 67, 100], [RiskTier::rate(1, 3), RiskTier::rate(3, 5), RiskTier::rate(119, 200), RiskTier::rate(149, 250), RiskTier::rate(6, 9), RiskTier::rate(5, 5)]);
        $t = ['hold_below' => 50, 'advance_below' => 90, 'min_parcels' => 5];
        $this->assertSame('careful', RiskTier::classify(1, 3, $t)); // total 4 < 5
        $this->assertSame('good', RiskTier::classify(4, 0, $t));
        $this->assertSame('careful', RiskTier::classify(3, 2, $t)); // 60 %: ≥ 50, < 90
        $this->assertSame('risky', RiskTier::classify(2, 3, $t)); // 40 %
        $this->assertSame('good', RiskTier::classify(9, 1, $t)); // 90 %
    }

    public function test_mask(): void
    {
        $this->assertSame('01712•••678', FraudGuard::mask('8801712345678'));
        $this->assertSame('01712•••678', FraudGuard::mask('+8801712345678'));
        $this->assertSame('01712•••678', FraudGuard::mask('01712345678'));
    }
}

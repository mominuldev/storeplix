<?php

declare(strict_types=1);

namespace Tests\Unit\Reports;

use App\Domain\Reports\ReportMath;
use App\Domain\Reports\ReportRange;
use Carbon\CarbonImmutable;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** P7-18 range rules, store-local instants, ISO weeks, and the integer ratio helpers. */
#[Group('reports')]
class ReportRangeTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2026-01-02 20:00:00', 'UTC')); // 3 Jan 02:00 in Dhaka
    }

    public function test_defaults_use_the_local_today_and_month(): void
    {
        $r = ReportRange::resolve(null, null, 'Asia/Dhaka');
        $this->assertSame(['2026-01-01', '2026-01-03'], [$r->from->format('Y-m-d'), $r->to->format('Y-m-d')]);
        $this->assertSame('2025-12-31 18:00:00', $r->startUtc()->format('Y-m-d H:i:s'));
        $this->assertSame('2026-01-03 18:00:00', $r->endUtc()->format('Y-m-d H:i:s'));
        $this->assertSame(['2025-12-29', '2025-12-31'], [$r->previous()->from->format('Y-m-d'), $r->previous()->to->format('Y-m-d')]);

        $ny = ReportRange::resolve(null, null, 'America/New_York');
        $this->assertSame('2026-01-02', $ny->to->format('Y-m-d'));
    }

    public function test_iso_weeks_cross_the_year(): void
    {
        $r = ReportRange::resolve('2025-12-01', '2026-01-03', 'Asia/Dhaka');
        $this->assertSame([
            ['week' => '2025-W52', 'week_start' => '2025-12-22'],
            ['week' => '2026-W01', 'week_start' => '2025-12-29'],
        ], $r->isoWeeks(2));
        $this->assertSame('2026-W01', $r->localWeek('2025-12-28 18:30:00')); // Mon 29 Dec 00:30 Dhaka
        $this->assertSame('2025-12-28', $r->localDate('2025-12-28 17:59:59'));
    }

    public function test_span_and_order_are_validated(): void
    {
        $this->assertSame(366, ReportRange::resolve('2025-01-03', '2026-01-03', 'Asia/Dhaka')->days());
        foreach ([['2025-01-02', '2026-01-03'], ['2026-01-03', '2026-01-02']] as [$from, $to]) {
            try {
                ReportRange::resolve($from, $to, 'Asia/Dhaka');
                $this->fail('expected a validation error');
            } catch (ValidationException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function test_ratio_helpers(): void
    {
        $this->assertNull(ReportMath::ratio(1, 0));
        $this->assertSame(0.6667, ReportMath::ratio(2, 3));
        $this->assertSame(-34, ReportMath::perUnit(-100, 3)); // floor toward −∞
        $this->assertSame(33, ReportMath::perUnit(100, 3));
        $this->assertNull(ReportMath::perUnit(5, 0));
        $this->assertSame(1.3, ReportMath::oneDecimal(4, 3));
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

use App\Domain\Expenses\Models\Expense;
use App\Domain\Orders\Models\Order;
use App\Domain\Reports\ProfitReport;
use App\Domain\Reports\ReportMath;
use App\Domain\Reports\ReportRange;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * GET …/expenses/summary (PHASE-8-7 §6.3). Month `m` in the store timezone, range [first day, min(last day, today)].
 * No currency filter (P87-11). `profit_after_expenses_amount` is ProfitReport's net profit for the same range when the
 * caller allows it (P87-5), so it always equals Profit & loss (AC 3).
 */
final class ExpenseSummary
{
    public const MAX_MONTHS = 36;

    public function __construct(private readonly ProfitReport $profit) {}

    /** @return array<string, mixed> ExpenseSummary */
    public function build(Store $store, ?string $month, bool $withProfit): array
    {
        $tz = $store->timezone ?: 'Asia/Dhaka';
        $today = CarbonImmutable::now($tz)->startOfDay();
        $first = $month !== null ? CarbonImmutable::createFromFormat('!Y-m', $month, $tz) : $today->startOfMonth();
        $current = $first->format('Y-m') === $today->format('Y-m');
        $to = $current ? $today : $first->endOfMonth()->startOfDay();
        [$from, $toDate] = [$first->format('Y-m-d'), $to->format('Y-m-d')];

        $byCategory = [];
        $total = $count = 0;
        $rows = Expense::query()->where('store_id', $store->id)->whereBetween('spent_on', [$from, $toDate])
            ->groupBy('category')->selectRaw('category, SUM(amount) AS amount, COUNT(*) AS n')->get();
        foreach ($rows as $r) {
            $total += (int) $r->getAttribute('amount');
            $count += (int) $r->getAttribute('n');
        }
        foreach ($rows as $r) {
            $amount = (int) $r->getAttribute('amount');
            if ($amount > 0) {
                $byCategory[] = ['category' => (string) $r->getAttribute('category'), 'amount' => $amount, 'count' => (int) $r->getAttribute('n'), 'share' => ReportMath::share($amount, $total)];
            }
        }
        usort($byCategory, fn (array $a, array $b) => [$b['amount'], array_search($a['category'], ExpenseCategory::values(), true)]
            <=> [$a['amount'], array_search($b['category'], ExpenseCategory::values(), true)]);
        $ads = 0;
        foreach ($byCategory as $c) {
            $ads += $c['category'] === ExpenseCategory::Ads->value ? $c['amount'] : 0;
        }

        $range = ReportRange::resolve($from, $toDate, $tz);
        $delivered = (int) DB::table('orders')->where('tenant_id', $store->tenant_id)->where('store_id', $store->id)
            ->where('status', Order::DELIVERED)->where('delivered_at', '>=', $range->startUtc())->where('delivered_at', '<', $range->endUtc())->count();

        return [
            'month' => $first->format('Y-m'),
            'from' => $from,
            'to' => $toDate,
            'currency' => $store->currency ?: 'BDT',
            'total_amount' => $total,
            'count' => $count,
            'ads_amount' => $ads,
            'ads_share' => ReportMath::ratio($ads, $total),
            'by_category' => $byCategory,
            'compare' => $this->compare($store, $first, $today, $current, $total),
            'delivered_orders_count' => $delivered,
            'cost_per_order_amount' => $delivered === 0 ? null : intdiv($total, $delivered),
            'profit_after_expenses_amount' => $withProfit ? (int) $this->profit->summaryFor($store, $range)['net_profit_amount'] : null,
            'months' => $this->months($store, $today),
        ];
    }

    /**
     * P87-15: the current month compares day 1 … today's day with the same span of the previous month (clamped to its
     * last day); a past month compares full month with full month. Whole percent, half away from zero.
     *
     * @return array{label_month: string, total_amount: int, change_pct: int|null}
     */
    private function compare(Store $store, CarbonImmutable $first, CarbonImmutable $today, bool $current, int $total): array
    {
        $prev = $first->subMonthNoOverflow()->startOfMonth();
        $lastDay = $current ? min($today->day, $prev->daysInMonth) : $prev->daysInMonth;
        $prevTotal = (int) Expense::query()->where('store_id', $store->id)
            ->whereBetween('spent_on', [$prev->format('Y-m-d'), $prev->setDay($lastDay)->format('Y-m-d')])->sum('amount');

        return [
            'label_month' => $prev->format('Y-m'),
            'total_amount' => $prevTotal,
            'change_pct' => $prevTotal === 0 ? null : (int) round(($total - $prevTotal) * 100 / $prevTotal),
        ];
    }

    /** @return list<string> months with expenses plus the current one, newest first, ≤ 36 */
    private function months(Store $store, CarbonImmutable $today): array
    {
        $months = [$today->format('Y-m') => true];
        Expense::query()->where('store_id', $store->id)->select('spent_on')->distinct()->orderByDesc('spent_on')
            ->pluck('spent_on')->each(function ($d) use (&$months) {
                $months[substr((string) $d, 0, 7)] = true;
            });
        $out = array_keys($months);
        rsort($out);

        return array_slice($out, 0, self::MAX_MONTHS);
    }
}

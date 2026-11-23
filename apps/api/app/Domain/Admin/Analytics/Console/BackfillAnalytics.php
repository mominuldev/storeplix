<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics\Console;

use App\Domain\Admin\Analytics\AnalyticsDays;
use App\Domain\Admin\Analytics\MetricsAggregator;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Console\Command;

/**
 * PHASE-8-2 §4.2 (P82-6, Q110): one-off history before the 8.2 deploy. Flows exact from orders; stocks reconstructed
 * from paid invoices (`source = backfill`). Refuses to overwrite `nightly`/`late` rows; `--force` in production.
 * Default `--to` = the day before the first nightly/late row (else yesterday). RUNBOOK §12.
 */
class BackfillAnalytics extends Command
{
    protected $signature = 'analytics:backfill
        {--from= : First Dhaka day (Y-m-d), e.g. the oldest tenants.created_at}
        {--to= : Last Dhaka day (default: the day before the first nightly row)}
        {--force : Required in production}';

    protected $description = 'Reconstruct analytics history from paid invoices and orders (PHASE-8-2 §4.2)';

    public function handle(MetricsAggregator $aggregator): int
    {
        $from = $this->option('from');
        if (! is_string($from) || ! AggregateAnalytics::isDay($from)) {
            $this->error('--from=Y-m-d is required.');

            return self::FAILURE;
        }
        if ($this->laravel->environment('production') && ! $this->option('force')) {
            $this->error('analytics:backfill writes history: add --force in production.');

            return self::FAILURE;
        }
        $db = PlatformDb::connection(); // cross-tenant: platform analytics (B27)
        $yesterday = AnalyticsDays::add(AnalyticsDays::today(), -1);
        $to = $this->option('to');
        if ($to === null) {
            $firstLive = $db->table('platform_daily_metrics')->whereIn('source', [MetricsAggregator::NIGHTLY, MetricsAggregator::LATE])->min('day');
            $to = $firstLive !== null ? AnalyticsDays::add(substr((string) $firstLive, 0, 10), -1) : $yesterday;
        }
        if (! is_string($to) || ! AggregateAnalytics::isDay($to)) {
            $this->error('--to must be Y-m-d.');

            return self::FAILURE;
        }
        if ($to > $yesterday) {
            $this->error("Only closed days can be backfilled (--to ≤ {$yesterday}).");

            return self::FAILURE;
        }
        if ($from > $to) {
            $this->warn("Nothing to backfill ({$from} > {$to}).");

            return self::SUCCESS;
        }
        $live = $db->table('platform_daily_metrics')->whereBetween('day', [$from, $to])
            ->whereIn('source', [MetricsAggregator::NIGHTLY, MetricsAggregator::LATE])->orderBy('day')->pluck('day');
        if ($live->isNotEmpty()) {
            $this->error('Refusing to overwrite nightly/late snapshots: '.$live->map(fn ($d) => substr((string) $d, 0, 10))->implode(', ').'. Narrow --from/--to.');

            return self::FAILURE;
        }

        $months = [];
        for ($day = $from; $day <= $to; $day = AnalyticsDays::add($day, 1)) {
            try {
                $s = $aggregator->run($day, MetricsAggregator::MODE_BACKFILL);
            } catch (\Throwable $e) {
                $this->error("{$day}: failed and rolled back: {$e->getMessage()}");

                return self::FAILURE;
            }
            $m = AnalyticsDays::month($day);
            $months[$m] = [
                'days' => ($months[$m]['days'] ?? 0) + 1,
                'mrr' => $s['mrr_amount'],
                'gmv' => ($months[$m]['gmv'] ?? 0) + $s['gmv_amount'],
                'orders' => ($months[$m]['orders'] ?? 0) + $s['orders_count'],
                'tenants' => $s['tenants'],
            ];
        }
        $this->table(['Month', 'Days', 'Tenants (last day)', 'MRR (last day)', 'GMV', 'Orders'],
            array_map(fn (string $m, array $r) => [$m, $r['days'], $r['tenants'], $r['mrr'], $r['gmv'], $r['orders']], array_keys($months), $months));

        return self::SUCCESS;
    }
}

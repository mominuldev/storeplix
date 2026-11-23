<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics\Console;

use App\Domain\Admin\Analytics\AnalyticsDays;
use App\Domain\Admin\Analytics\MetricsAggregator;
use Illuminate\Console\Command;

/**
 * PHASE-8-2 §4.1 (P82-3 – P82-5): nightly snapshots. Scheduled hourly at :20 Dhaka; without options it fills the
 * missing closed days of the last ANALYTICS_CATCHUP_DAYS and, when that created yesterday, restates the flows of the
 * ANALYTICS_RESTATE_DAYS before it. A run with nothing missing does nothing.
 */
class AggregateAnalytics extends Command
{
    protected $signature = 'analytics:aggregate
        {--date= : One Dhaka day (Y-m-d)}
        {--from= : First Dhaka day (Y-m-d), with --to}
        {--to= : Last Dhaka day (Y-m-d)}
        {--rebuild-stocks : Overwrite stocks with the backfill reconstruction (P82-6)}
        {--force : Required with --rebuild-stocks in production}';

    protected $description = 'Compute the nightly platform analytics snapshots (PHASE-8-2 §4.1)';

    public function handle(MetricsAggregator $aggregator): int
    {
        $date = $this->option('date');
        $from = $this->option('from') ?? $date;
        $to = $this->option('to') ?? $date ?? $from;
        $rebuild = (bool) $this->option('rebuild-stocks');

        if ($from === null) {
            if ($rebuild) {
                $this->error('--rebuild-stocks needs --date or --from/--to.');

                return self::FAILURE;
            }
            $result = $aggregator->catchUp();
            $this->info(sprintf('analytics:aggregate created %d day(s)%s, restated %d.', count($result['created']),
                $result['created'] === [] ? '' : ' ('.implode(', ', $result['created']).')', count($result['restated'])));

            return self::SUCCESS;
        }

        foreach ([$from, $to] as $day) {
            if (! is_string($day) || ! self::isDay($day)) {
                $this->error('Dates must be Y-m-d.');

                return self::FAILURE;
            }
        }
        if ($from > $to) {
            $this->error('--from must be on or before --to.');

            return self::FAILURE;
        }
        if ($rebuild && $this->laravel->environment('production') && ! $this->option('force')) {
            $this->error('--rebuild-stocks overwrites point-in-time stocks: add --force in production.');

            return self::FAILURE;
        }

        for ($day = $from; $day <= $to; $day = AnalyticsDays::add($day, 1)) {
            try {
                $s = $aggregator->runDay($day, $rebuild);
            } catch (\InvalidArgumentException $e) {
                $this->error($e->getMessage());

                return self::FAILURE;
            } catch (\Throwable $e) {
                $this->error("{$day}: failed and rolled back: {$e->getMessage()}");

                return self::FAILURE;
            }
            $this->line(sprintf('%s  tenants %d  MRR %d  GMV %d  orders %d  source %s  %d ms',
                $s['day'], $s['tenants'], $s['mrr_amount'], $s['gmv_amount'], $s['orders_count'], $s['source'], $s['ms']));
        }

        return self::SUCCESS;
    }

    public static function isDay(string $value): bool
    {
        $d = \DateTimeImmutable::createFromFormat('!Y-m-d', $value);

        return $d !== false && $d->format('Y-m-d') === $value;
    }
}

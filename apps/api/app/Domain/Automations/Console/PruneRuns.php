<?php

declare(strict_types=1);

namespace App\Domain\Automations\Console;

use App\Domain\Automations\Models\AutomationConversion;
use App\Domain\Automations\Models\AutomationRun;
use Illuminate\Console\Command;

/**
 * `automations:prune-runs` (daily, P86-6 / Q162): finished runs older than 90 days are deleted in batches (their steps
 * cascade; conversions keep the automation with run/step set null); conversions older than 13 months are deleted.
 */
class PruneRuns extends Command
{
    protected $signature = 'automations:prune-runs';

    protected $description = 'Delete automation runs and conversions older than the retention windows';

    public function handle(): int
    {
        $cutoff = now()->subDays((int) config('automations.run_retention_days', 90));
        $runs = 0;
        do {
            // cross-tenant: retention sweep on the platform connection.
            $ids = AutomationRun::withoutTenancy()->where('created_at', '<', $cutoff)
                ->whereNotIn('status', AutomationRun::OPEN)->limit(1000)->pluck('id')->all();
            if ($ids !== []) {
                // cross-tenant: retention sweep on the platform connection.
                $runs += AutomationRun::withoutTenancy()->whereIn('id', $ids)->delete();
            }
        } while (count($ids) === 1000);
        // cross-tenant: retention sweep on the platform connection.
        $conversions = AutomationConversion::withoutTenancy()
            ->where('placed_at', '<', now()->subMonths((int) config('automations.conversion_retention_months', 13)))->delete();
        $this->info("automations:prune-runs: {$runs} run(s), {$conversions} conversion(s) deleted.");

        return self::SUCCESS;
    }
}

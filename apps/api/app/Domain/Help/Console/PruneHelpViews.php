<?php

declare(strict_types=1);

namespace App\Domain\Help\Console;

use App\Domain\Help\HelpDb;
use App\Domain\Help\HelpViews;
use Illuminate\Console\Command;

/** PHASE-8-9C P89C-22 / S261: daily view rows older than 13 months are pruned. */
class PruneHelpViews extends Command
{
    protected $signature = 'help:prune-views';

    protected $description = 'Delete help article daily view rows older than 13 months';

    public function handle(): int
    {
        $before = now()->setTimezone(HelpViews::TIMEZONE)->subMonths(13)->toDateString();
        $deleted = HelpDb::connection()->table('help_article_daily_views')->where('day', '<', $before)->delete();
        $this->info("deleted={$deleted}");

        return self::SUCCESS;
    }
}

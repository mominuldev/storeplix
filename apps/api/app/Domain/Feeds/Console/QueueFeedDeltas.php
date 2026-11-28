<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Console;

use Illuminate\Console\Command;

/** `feeds:sync-deltas` (every 5 minutes, PHASE-8-9D P89D-29): alias of `feeds:sync --deltas`. */
class QueueFeedDeltas extends Command
{
    protected $signature = 'feeds:sync-deltas {--sync : run inline}';

    protected $description = 'Queue delta syncs for product feeds with price / stock / product changes';

    public function handle(): int
    {
        return $this->call('feeds:sync', ['--deltas' => true, '--sync' => (bool) $this->option('sync')]);
    }
}

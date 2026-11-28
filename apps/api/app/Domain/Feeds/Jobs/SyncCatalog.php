<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Jobs;

use App\Domain\Feeds\CatalogSync;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** PHASE-8-9D §7.4: one feed sync run inside the integration's tenant, on queue `feeds` (ids only, never tokens). */
class SyncCatalog implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public int $timeout = 900;

    public function __construct(
        public readonly string $integrationId,
        public readonly string $kind,
        public readonly string $trigger,
        public readonly ?string $runId = null,
    ) {
        $this->onQueue((string) config('feeds.queue', 'feeds'));
        $connection = config('feeds.connection');
        if (is_string($connection) && $connection !== '') {
            $this->onConnection($connection); // QA P89D-QA-A4: a connection whose retry_after outlives $timeout
        }
    }

    public function handle(CatalogSync $sync): void
    {
        $sync->run($this->integrationId, $this->kind, $this->trigger, $this->runId);
    }
}

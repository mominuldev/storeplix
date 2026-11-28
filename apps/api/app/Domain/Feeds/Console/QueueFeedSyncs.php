<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Console;

use App\Domain\Feeds\Jobs\SyncCatalog;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * `feeds:sync` (hourly) and `feeds:sync-deltas` (every 5 minutes) — PHASE-8-9D P89D-29. Discovery on the platform
 * connection, one tenant-aware SyncCatalog per connected feed (deltas: only feeds with dirty items). The job takes the
 * per-feed lock, so an overlap with a running sync is skipped.
 */
class QueueFeedSyncs extends Command
{
    protected $signature = 'feeds:sync {--deltas : only feeds with dirty items (price / stock / product changes)} {--sync : run inline}';

    protected $description = 'Queue the hourly full product-feed sync (or the 5-minute delta sync)';

    public function handle(): int
    {
        $deltas = (bool) $this->option('deltas');
        // cross-tenant: scheduler discovery (platform connection); each sync runs in its own tenant job.
        $rows = StoreIntegration::withoutTenancy()->whereIn('provider', IntegrationProvider::FEEDS)
            ->whereIn('status', StoreIntegration::ACTIVE)
            ->when($deltas, fn ($q) => $q->whereExists(fn ($e) => $e->select(DB::raw(1))->from('catalog_items')
                ->whereColumn('catalog_items.store_integration_id', 'store_integrations.id')->whereNotNull('catalog_items.dirty_at')))
            ->orderBy('id')->get(['id', 'tenant_id']);
        foreach ($rows as $row) {
            $job = (new SyncCatalog((string) $row->id, $deltas ? 'delta' : 'full', $deltas ? 'product_change' : 'schedule'))->forTenant((string) $row->tenant_id);
            $this->option('sync') ? dispatch_sync($job) : dispatch($job);
        }
        $this->info(sprintf('feeds:sync%s: %d feed(s).', $deltas ? ' (deltas)' : '', $rows->count()));

        return self::SUCCESS;
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Feeds;

use App\Domain\Billing\FeatureGate;
use App\Domain\Feeds\Drivers\FeedDrivers;
use App\Domain\Feeds\Drivers\FeedException;
use App\Domain\Feeds\Models\CatalogItem;
use App\Domain\Feeds\Models\CatalogSyncRun;
use App\Domain\Integrations\IntegrationAttention;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-9D §7.4 (P89D-29, P89D-30): one sync run. One run per feed at a time (tenant cache lock `feeds:{id}`); items
 * built from the catalogue (CatalogItemBuilder), unchanged items skipped by content hash, changed ones upserted in
 * batches, excluded / removed ones deleted remotely, then statuses fetched into review_status + issues. No row lock is
 * held across HTTP calls. 429 → stop, run `partial`; auth → run `failed`, attention `token_invalid`.
 */
final class CatalogSync
{
    public function __construct(
        private readonly FeedDrivers $drivers,
        private readonly FeedTokens $tokens,
        private readonly TenantCache $cache,
        private readonly TenantContext $context,
    ) {}

    public function lockKey(string $integrationId): string
    {
        return $this->cache->key('feeds:'.$integrationId);
    }

    /** Runs a sync; returns the run, or null when another run holds the lock (a scheduled run then just skips). */
    public function run(string $integrationId, string $kind, string $trigger, ?string $runId = null): ?CatalogSyncRun
    {
        $lock = Cache::lock($this->lockKey($integrationId), 900);
        if (! $lock->get()) {
            if ($runId !== null) {
                DB::table('catalog_sync_runs')->where('id', $runId)->where('status', CatalogSyncRun::RUNNING)
                    ->update(['status' => CatalogSyncRun::FAILED, 'error_code' => 'sync_in_progress', 'finished_at' => now()]);
            }

            return null;
        }
        try {
            return $this->locked($integrationId, $kind, $trigger, $runId);
        } finally {
            $lock->release();
        }
    }

    private function locked(string $integrationId, string $kind, string $trigger, ?string $runId): ?CatalogSyncRun
    {
        $integration = StoreIntegration::query()->find($integrationId);
        if ($integration === null || ! $integration->isActive()) {
            return $runId !== null ? $this->close(CatalogSyncRun::query()->find($runId), CatalogSyncRun::FAILED, 'integration_not_connected') : null;
        }
        $store = Store::query()->findOrFail($integration->store_id);
        $run = $runId !== null ? CatalogSyncRun::query()->find($runId) : null;
        if ($run === null) {
            $run = new CatalogSyncRun;
            $run->forceFill(['store_id' => $store->id, 'store_integration_id' => $integration->id, 'kind' => $kind, 'trigger' => $trigger,
                'status' => CatalogSyncRun::RUNNING, 'started_at' => now()])->save();
        }
        $feature = IntegrationProvider::feature($integration->provider);
        $tenant = $this->context->tenant();
        if ($feature !== null && $tenant !== null && ! FeatureGate::allows($tenant, $feature)) {
            $this->attention($integration, ['plan_required' => null]);

            return $this->close($run, CatalogSyncRun::FAILED, 'plan_required');
        }
        if ($store->status !== Store::STATUS_ACTIVE) {
            $this->attention($integration, ['store_not_live' => null]);

            return $this->close($run, CatalogSyncRun::FAILED, 'store_not_live');
        }

        try {
            $integration = $this->tokens->fresh($integration);
            $this->sync($store, $integration, $run, $kind);
        } catch (FeedException $e) {
            if ($e->reason === FeedException::AUTH) {
                $this->tokens->flag($integration, 'token_invalid');
            }
            $partial = $e->reason === FeedException::RATE_LIMITED;

            return $this->close($run, $partial ? CatalogSyncRun::PARTIAL : CatalogSyncRun::FAILED, $e->reason);
        }
        $this->recomputeAttention($store, $integration->refresh());

        return $this->close($run, $run->items_failed > 0 ? CatalogSyncRun::PARTIAL : CatalogSyncRun::DONE, null);
    }

    private function sync(Store $store, StoreIntegration $integration, CatalogSyncRun $run, string $kind): void
    {
        $driver = $this->drivers->for($integration->provider);
        $existing = CatalogItem::query()->where('store_integration_id', $integration->id)->get()->keyBy('variant_id');
        $productIds = null;
        if ($kind === 'delta') {
            $dirty = $existing->filter(fn (CatalogItem $i) => $i->dirty_at !== null);
            if ($dirty->isEmpty()) {
                return;
            }
            $productIds = $dirty->pluck('product_id')->unique()->values()->all();
            $existing = $existing->filter(fn (CatalogItem $i) => in_array($i->product_id, $productIds, true));
        }
        $built = CatalogItemBuilder::build($store, $integration, $productIds);
        $force = $kind === 'manual';
        $now = now();

        $upserts = [];
        $deletes = [];
        $vanished = [];
        foreach ($built as $variantId => $item) {
            $row = $existing->get($variantId);
            if ($item['excluded_reason'] !== null) {
                if ($row !== null && in_array($row->status, [CatalogItem::SYNCED, CatalogItem::ERROR, CatalogItem::PENDING, CatalogItem::DELETING], true) && $row->last_synced_at !== null) {
                    $deletes[] = $variantId;
                }
                $this->upsertRow($integration, $item, $row, ['status' => CatalogItem::EXCLUDED, 'excluded_reason' => $item['excluded_reason'], 'review_status' => null,
                    'issues' => '[]', 'content_hash' => null, 'dirty_at' => null]);

                continue;
            }
            if (! $force && $row !== null && $row->status === CatalogItem::SYNCED && $row->content_hash === $item['hash']) {
                if ($row->dirty_at !== null) {
                    DB::table('catalog_items')->where('id', $row->id)->update(['dirty_at' => null]);
                }

                continue;
            }
            $upserts[$variantId] = $item;
        }
        foreach ($existing as $variantId => $row) {
            if (! isset($built[$variantId])) {
                $vanished[] = $variantId; // product / variant deleted or disabled: remove remotely, then locally
            }
        }

        foreach (array_chunk($upserts, 500, true) as $chunk) {
            $refused = $driver->upsertItems($integration, array_values(array_map(fn (array $i) => $i['data'], $chunk)));
            foreach ($chunk as $variantId => $item) {
                $issues = $refused[$variantId] ?? null;
                $this->upsertRow($integration, $item, $existing->get($variantId), $issues === null
                    ? ['status' => CatalogItem::SYNCED, 'excluded_reason' => null, 'content_hash' => $item['hash'], 'dirty_at' => null, 'last_synced_at' => $now]
                    : ['status' => CatalogItem::ERROR, 'excluded_reason' => null, 'issues' => json_encode($issues), 'content_hash' => null, 'dirty_at' => null]);
                $issues === null ? $run->items_sent++ : $run->items_failed++;
            }
            DB::table('catalog_sync_runs')->where('id', $run->id)->update(['items_sent' => $run->items_sent, 'items_failed' => $run->items_failed]);
        }
        $remove = [...$deletes, ...$vanished];
        if ($remove !== []) {
            foreach (array_chunk($remove, 500) as $chunk) {
                $driver->deleteItems($integration, $chunk);
            }
            $run->items_deleted += count($remove);
            DB::table('catalog_items')->where('store_integration_id', $integration->id)->whereIn('variant_id', $vanished)->delete();
            DB::table('catalog_items')->where('store_integration_id', $integration->id)->whereIn('variant_id', $deletes)->update(['last_synced_at' => null, 'updated_at' => $now]);
            DB::table('catalog_sync_runs')->where('id', $run->id)->update(['items_deleted' => $run->items_deleted]);
        }

        $synced = CatalogItem::query()->where('store_integration_id', $integration->id)->where('status', CatalogItem::SYNCED)
            ->when($productIds !== null, fn ($q) => $q->whereIn('product_id', $productIds))->pluck('variant_id')->all();
        foreach (array_chunk($synced, 1000) as $chunk) {
            foreach ($driver->fetchStatuses($integration, $chunk) as $variantId => $status) {
                $issues = array_slice(array_map(fn (array $i) => [
                    'code' => Str::limit((string) ($i['code'] ?? 'issue'), 60, ''), 'severity' => ($i['severity'] ?? 'warning') === 'error' ? 'error' : 'warning',
                    'message' => Str::limit(strip_tags((string) ($i['message'] ?? '')), (int) config('feeds.issue_message_max', 300), '…'),
                    'attribute' => isset($i['attribute']) ? Str::limit(strip_tags((string) $i['attribute']), 60, '') : null,
                    'fix' => in_array($i['fix'] ?? null, ['product_editor', 'feed_settings', 'store_settings'], true) ? $i['fix'] : null,
                ], (array) $status['issues']), 0, 20);
                DB::table('catalog_items')->where('store_integration_id', $integration->id)->where('variant_id', (string) $variantId)
                    ->update(['review_status' => in_array($status['review_status'], ['approved', 'in_review', 'limited', 'disapproved'], true) ? $status['review_status'] : null,
                        'issues' => json_encode($issues), 'updated_at' => $now]);
            }
        }
    }

    /** @param array{product_id: string, variant_id: string} $item @param array<string, mixed> $values */
    private function upsertRow(StoreIntegration $integration, array $item, ?CatalogItem $row, array $values): void
    {
        $now = now();
        if ($row !== null) {
            DB::table('catalog_items')->where('id', $row->id)->update($values + ['product_id' => $item['product_id'], 'updated_at' => $now]);

            return;
        }
        DB::table('catalog_items')->insertOrIgnore($values + [
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $integration->tenant_id, 'store_id' => $integration->store_id,
            'store_integration_id' => $integration->id, 'product_id' => $item['product_id'], 'variant_id' => $item['variant_id'],
            'issues' => $values['issues'] ?? '[]', 'created_at' => $now, 'updated_at' => $now,
        ]);
    }

    /** P89D-30: items_with_issues (disapproved), website_not_claimed (Google), store live; plan restored. */
    public function recomputeAttention(Store $store, StoreIntegration $integration): void
    {
        $disapproved = CatalogItem::query()->where('store_integration_id', $integration->id)
            ->where(fn ($q) => $q->where('review_status', 'disapproved')->orWhere('status', CatalogItem::ERROR))->count();
        $set = [];
        $remove = ['plan_required', 'store_not_live'];
        $disapproved > 0 ? $set['items_with_issues'] = $disapproved : $remove[] = 'items_with_issues';
        if ($integration->provider === IntegrationProvider::GOOGLE_MERCHANT) {
            (bool) $integration->setting('website_claimed', false) ? $remove[] = 'website_not_claimed' : $set['website_not_claimed'] = null;
        }
        $this->attention($integration, $set, $remove);
    }

    /** @param array<string, int|null> $set @param list<string> $remove */
    private function attention(StoreIntegration $integration, array $set, array $remove = []): void
    {
        DB::transaction(function () use ($integration, $set, $remove) {
            $locked = StoreIntegration::query()->whereKey($integration->id)->lockForUpdate()->first();
            if ($locked !== null && $locked->status !== StoreIntegration::DISCONNECTED) {
                IntegrationAttention::apply($locked, $set, $remove);
            }
        });
    }

    private function close(?CatalogSyncRun $run, string $status, ?string $error): ?CatalogSyncRun
    {
        if ($run === null) {
            return null;
        }
        DB::table('catalog_sync_runs')->where('id', $run->id)->update([
            'status' => $status, 'error_code' => $error, 'finished_at' => now(),
            'items_sent' => $run->items_sent, 'items_failed' => $run->items_failed, 'items_deleted' => $run->items_deleted,
        ]);

        return $run->refresh();
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Feeds;

use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * PHASE-8-9D P89D-29: price, stock and product changes mark feed items dirty (after commit, next to the points that emit
 * `product.updated` / `stock.low`); `feeds:sync-deltas` pushes them every 5 minutes (≤ 15 minutes end to end). A new
 * product gets pending rows so the delta sends it. Never throws into the caller; a store without a feed costs one
 * indexed lookup.
 */
final class FeedHooks
{
    /** A product was created, updated, duplicated, bulk-edited or deleted. */
    public static function product(string $storeId, string $productId): void
    {
        self::later($storeId, function (array $integrations) use ($productId) {
            $variants = DB::table('product_variants')->where('product_id', $productId)->whereNull('deleted_at')->pluck('id')->all();
            $now = now();
            foreach ($integrations as $integration) {
                DB::table('catalog_items')->where('store_integration_id', $integration->id)->where('product_id', $productId)->update(['dirty_at' => $now]);
                foreach ($variants as $variantId) {
                    DB::table('catalog_items')->insertOrIgnore([
                        'id' => strtolower((string) Str::ulid()), 'tenant_id' => $integration->tenant_id, 'store_id' => $integration->store_id,
                        'store_integration_id' => $integration->id, 'product_id' => $productId, 'variant_id' => (string) $variantId,
                        'status' => 'pending', 'issues' => '[]', 'dirty_at' => $now, 'created_at' => $now, 'updated_at' => $now,
                    ]);
                }
            }
        });
    }

    /** Stock of a variant changed (any location; availability reads the online one). */
    public static function stock(string $storeId, string $variantId): void
    {
        self::later($storeId, function (array $integrations) use ($variantId) {
            DB::table('catalog_items')->whereIn('store_integration_id', array_map(fn ($i) => $i->id, $integrations))
                ->where('variant_id', $variantId)->update(['dirty_at' => now()]);
        });
    }

    /** @param callable(list<StoreIntegration>): void $work */
    private static function later(string $storeId, callable $work): void
    {
        try {
            $context = app(TenantContext::class);
            if (! $context->has()) {
                return;
            }
            $tenantId = (string) $context->id();
            DB::afterCommit(function () use ($context, $tenantId, $storeId, $work) {
                $run = function () use ($storeId, $work) {
                    $integrations = StoreIntegration::query()->where('store_id', $storeId)->whereIn('provider', IntegrationProvider::FEEDS)
                        ->whereIn('status', [...StoreIntegration::ACTIVE, StoreIntegration::ERROR])->get()->all();
                    if ($integrations !== []) {
                        $work($integrations);
                    }
                };
                try {
                    $context->id() === $tenantId ? $run() : $context->run($tenantId, $run);
                } catch (Throwable $e) {
                    Log::warning('feeds.hook_failed', ['error' => $e::class]);
                    report($e);
                }
            });
        } catch (Throwable $e) {
            report($e);
        }
    }
}

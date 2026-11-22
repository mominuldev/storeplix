<?php

namespace App\Domain\Stores\Revalidation;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Database\Eloquent\Model;

/**
 * Dispatches RevalidateStorefront (after commit, queued → never blocks the request) when
 * anything the storefront renders changes. Phase 3 (P3-18): theme publish/apply (published_config or is_active
 * changed — never draft-only saves), page changes when the page is or was published, navigation saves.
 * Phase 4 (P4-23): product create/update/delete when the product is or was active; any category change.
 * Muted inside StorefrontRevalidation::muted() (imports dispatch once at the end).
 */
class StorefrontRevalidationObserver
{
    private const STORE_FIELDS = ['status', 'name', 'slug', 'currency', 'country'];

    public function saved(Model $model): void
    {
        if (StorefrontRevalidation::isMuted()) {
            return;
        }

        if ($model instanceof Product) {
            $wasActive = ! $model->wasRecentlyCreated && $model->getOriginal('status') === Product::ACTIVE;
            if (($model->isActive() || $wasActive) && ($model->wasRecentlyCreated || $model->wasChanged())) {
                $this->dispatch($model->tenant_id, $model->store_id);
            }
        } elseif ($model instanceof Category) {
            $this->dispatch($model->tenant_id, $model->store_id);
        } elseif ($model instanceof Store) {
            if ($model->wasChanged(self::STORE_FIELDS)) { // empty on insert
                $this->dispatch($model->tenant_id, $model->id);
            }
        } elseif ($model instanceof StoreSetting) {
            $this->dispatch($model->tenant_id, $model->store_id);
        } elseif ($model instanceof StoreTheme) {
            if ($model->wasChanged(['published_config', 'is_active', 'applied_at']) || ($model->wasRecentlyCreated && $model->is_active)) {
                $this->dispatch($model->tenant_id, $model->store_id);
            }
        } elseif ($model instanceof StorePage) {
            $wasPublished = $model->getOriginal('status') === StorePage::PUBLISHED && ! $model->wasRecentlyCreated;
            if (($model->isPublished() || $wasPublished) && ($model->wasRecentlyCreated || $model->wasChanged())) {
                $this->dispatch($model->tenant_id, $model->store_id);
            }
        } elseif ($model instanceof StoreNavigation) {
            $this->dispatch($model->tenant_id, $model->store_id);
        } elseif ($model instanceof StoreDomain) {
            $old = $model->wasChanged('hostname') ? [(string) $model->getOriginal('hostname')] : [];
            $this->dispatch($model->tenant_id, $model->store_id, $old);
        }
    }

    public function deleted(Model $model): void
    {
        if (StorefrontRevalidation::isMuted()) {
            return;
        }

        if ($model instanceof Product && $model->isActive()) {
            $this->dispatch($model->tenant_id, $model->store_id);
        } elseif ($model instanceof Category) {
            $this->dispatch($model->tenant_id, $model->store_id);
        } elseif ($model instanceof StoreDomain) {
            $this->dispatch($model->tenant_id, $model->store_id, [$model->hostname]);
        } elseif ($model instanceof StorePage && $model->isPublished()) {
            $this->dispatch($model->tenant_id, $model->store_id);
        }
    }

    /**
     * @param  list<string>  $extraHosts
     */
    public function dispatch(string $tenantId, string $storeId, array $extraHosts = []): void
    {
        RevalidateStorefront::dispatch($storeId, array_values(array_filter($extraHosts)))
            ->forTenant($tenantId)
            ->afterCommit();
    }
}

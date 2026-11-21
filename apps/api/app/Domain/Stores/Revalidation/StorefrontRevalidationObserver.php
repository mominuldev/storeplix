<?php

namespace App\Domain\Stores\Revalidation;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Database\Eloquent\Model;

/**
 * Dispatches RevalidateStorefront (after commit, queued → never blocks the request) when
 * anything the storefront renders changes.
 */
class StorefrontRevalidationObserver
{
    private const STORE_FIELDS = ['status', 'name', 'slug', 'currency', 'country'];

    public function saved(Model $model): void
    {
        if ($model instanceof Store) {
            if ($model->wasChanged(self::STORE_FIELDS)) { // empty on insert
                $this->dispatch($model->tenant_id, $model->id);
            }
        } elseif ($model instanceof StoreSetting) {
            $this->dispatch($model->tenant_id, $model->store_id);
        } elseif ($model instanceof StoreDomain) {
            $old = $model->wasChanged('hostname') ? [(string) $model->getOriginal('hostname')] : [];
            $this->dispatch($model->tenant_id, $model->store_id, $old);
        }
    }

    public function deleted(Model $model): void
    {
        if ($model instanceof StoreDomain) {
            $this->dispatch($model->tenant_id, $model->store_id, [$model->hostname]);
        }
    }

    /**
     * @param  list<string>  $extraHosts
     */
    private function dispatch(string $tenantId, string $storeId, array $extraHosts = []): void
    {
        RevalidateStorefront::dispatch($storeId, array_values(array_filter($extraHosts)))
            ->forTenant($tenantId)
            ->afterCommit();
    }
}

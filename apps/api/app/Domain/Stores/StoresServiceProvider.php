<?php

namespace App\Domain\Stores;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Observers\StoreDomainObserver;
use App\Domain\Stores\Observers\StoreObserver;
use App\Domain\Stores\Policies\StorePolicy;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

class StoresServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Gate::policy(Store::class, StorePolicy::class);

        Store::observe(StoreObserver::class);
        StoreDomain::observe(StoreDomainObserver::class);
    }
}

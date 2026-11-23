<?php

namespace App\Domain\Catalog;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Policies\CatalogPolicy;
use App\Domain\Customers\Models\Customer;
use App\Domain\Customers\Models\CustomerNote;
use App\Domain\Customers\Policies\CustomerPolicy;
use App\Domain\DataTransfer\Console\ExpireExports;
use App\Domain\DataTransfer\Console\PruneImports;
use App\Domain\Stores\Revalidation\StorefrontRevalidationObserver;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

/** Phase 4: catalog, inventory, customers and bulk data (policies, observers, commands). */
class CatalogServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([PruneImports::class, ExpireExports::class]);
        }

        Gate::policy(Product::class, CatalogPolicy::class);
        Gate::policy(Category::class, CatalogPolicy::class);
        Gate::policy(Customer::class, CustomerPolicy::class);
        Gate::policy(CustomerNote::class, CustomerPolicy::class);

        // PHASE-8-3 §3.2: the old `bulk-data` gate is split into the data.import / data.export keys.
        Gate::define('data.import', fn () => $this->app->make(TenantContext::class)->allows(Permission::DataImport));
        Gate::define('data.export', fn () => $this->app->make(TenantContext::class)->allows(Permission::DataExport));

        Product::observe(StorefrontRevalidationObserver::class);
        Category::observe(StorefrontRevalidationObserver::class);
    }
}

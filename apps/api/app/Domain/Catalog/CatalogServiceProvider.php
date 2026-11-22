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

        Gate::define('bulk-data', fn () => Permission::BulkData->grantedTo($this->app->make(TenantContext::class)->role()));

        Product::observe(StorefrontRevalidationObserver::class);
        Category::observe(StorefrontRevalidationObserver::class);
    }
}

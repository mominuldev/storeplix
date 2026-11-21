<?php

namespace App\Domain\Stores;

use App\Domain\Media\Models\Media;
use App\Domain\Media\Policies\MediaPolicy;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Staff\Policies\StaffPolicy;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Stores\Observers\StoreDomainObserver;
use App\Domain\Stores\Observers\StoreObserver;
use App\Domain\Stores\Policies\StorePolicy;
use App\Domain\Stores\Revalidation\StorefrontRevalidationObserver;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

/** Stores + the merchant modules that hang off a tenant (staff, media, audit). */
class StoresServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Gate::policy(Store::class, StorePolicy::class);
        Gate::policy(StaffInvitation::class, StaffPolicy::class);
        Gate::policy(TenantUser::class, StaffPolicy::class);
        Gate::policy(Media::class, MediaPolicy::class);

        Gate::define('audit.view', fn () => Permission::ViewAudit->grantedTo($this->app->make(TenantContext::class)->role()));

        Store::observe([StoreObserver::class, StorefrontRevalidationObserver::class]);
        StoreDomain::observe([StoreDomainObserver::class, StorefrontRevalidationObserver::class]);
        StoreSetting::observe(StorefrontRevalidationObserver::class);

        // {member} = tenant_users.id, resolved ONLY inside the current tenant (foreign id → 404).
        Route::bind('member', fn (string $id) => TenantUser::query()
            ->forTenant($this->app->make(TenantContext::class)->requireId())
            ->whereKey(strtolower($id))
            ->firstOrFail());
    }
}

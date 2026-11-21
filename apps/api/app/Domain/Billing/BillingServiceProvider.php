<?php

namespace App\Domain\Billing;

use App\Domain\Billing\Console\EndTrials;
use App\Domain\Billing\Listeners\StartTrial;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Events\TenantCreated;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

class BillingServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Event::listen(TenantCreated::class, StartTrial::class);

        // Bust the per-tenant plan cache on any subscription change.
        Subscription::saved(fn (Subscription $s) => FeatureGate::forget($s->tenant_id));
        Subscription::deleted(fn (Subscription $s) => FeatureGate::forget($s->tenant_id));

        $role = fn () => $this->app->make(TenantContext::class)->role();
        Gate::define('billing.view', fn () => Permission::ViewBilling->grantedTo($role()));
        Gate::define('billing.features', fn () => Permission::Operate->grantedTo($role()));

        if ($this->app->runningInConsole()) {
            $this->commands([EndTrials::class]);
        }
    }
}

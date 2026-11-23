<?php

namespace App\Domain\Billing;

use App\Domain\Billing\Console\BillingChangePlan;
use App\Domain\Billing\Console\BillingExtend;
use App\Domain\Billing\Console\BillingMarkPaid;
use App\Domain\Billing\Console\BillingRun;
use App\Domain\Billing\Console\BillingShow;
use App\Domain\Billing\Console\BillingVoid;
use App\Domain\Billing\Console\EndTrials;
use App\Domain\Billing\Console\ReconcileBillingPayments;
use App\Domain\Billing\Gateways\BillingGatewayManager;
use App\Domain\Billing\Listeners\StartTrial;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Events\TenantCreated;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Cache\RateLimiting\Limit as RateLimit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

class BillingServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(BillingGatewayManager::class);
    }

    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);

        Event::listen(TenantCreated::class, StartTrial::class);

        // Bust the per-tenant plan cache on any subscription change (conditional updates call FeatureGate::forget too).
        Subscription::saved(fn (Subscription $s) => FeatureGate::forget($s->tenant_id));
        Subscription::deleted(fn (Subscription $s) => FeatureGate::forget($s->tenant_id));

        $context = fn () => $this->app->make(TenantContext::class);
        Gate::define('billing.view', fn () => $context()->allows(Permission::BillingView));
        Gate::define('billing.manage', fn () => $context()->allows(Permission::BillingManage)); // owner only (Q88, Q123)
        Gate::define('billing.features', fn () => $context()->has()); // base (PHASE-8-3 §3.1)

        // §6.1: billing POST/DELETE, 20/min per tenant + user (pay adds 10/min per tenant in the controller).
        RateLimiter::for('billing', fn (Request $r) => RateLimit::perMinute(20)
            ->by('billing:'.strtolower((string) $r->header('X-Tenant-Id')).'|'.($r->user()?->getAuthIdentifier() ?? $r->ip())));

        if ($this->app->runningInConsole()) {
            $this->commands([
                EndTrials::class, BillingRun::class, ReconcileBillingPayments::class,
                BillingMarkPaid::class, BillingVoid::class, BillingExtend::class, BillingChangePlan::class, BillingShow::class,
            ]);
        }
    }

    /** P7-20 / S65: BILLING_FAKE=true in production refuses to boot. */
    public static function assertSafeConfiguration(Application $app): void
    {
        if ((bool) config('billing.fake') && $app->environment('production')) {
            throw new RuntimeException('BILLING_FAKE=true is not allowed in production.');
        }
    }
}

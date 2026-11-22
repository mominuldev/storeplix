<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Integrations\Console\RotateIntegrationKey;
use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Payments\Policies\PaymentGatewayPolicy;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

/**
 * Phase 5b-2 gateways (API-1): driver manager, the dedicated credentials encrypter, the `integrations.view` /
 * `integrations.manage` abilities, `integrations:rotate-key`, and the P5B-29 boot check (fake drivers never run in
 * production).
 */
final class GatewaysServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(IntegrationCredentials::class);
        $this->app->singleton(PaymentManager::class);
    }

    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);

        Gate::define('integrations.view', [PaymentGatewayPolicy::class, 'view']);
        Gate::define('integrations.manage', [PaymentGatewayPolicy::class, 'manage']);

        if ($this->app->runningInConsole()) {
            $this->commands([RotateIntegrationKey::class]);
        }
    }

    /** P5B-29: PAYMENTS_FAKE=true in production refuses to boot. */
    public static function assertSafeConfiguration(Application $app): void
    {
        if ((bool) config('payments.fake') && $app->environment('production')) {
            throw new RuntimeException('PAYMENTS_FAKE=true is not allowed in production.');
        }
    }
}

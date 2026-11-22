<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

/**
 * Phase 5b-3 couriers: the driver manager, the area mapper, and the boot check (COURIERS_FAKE never runs in
 * production). API-C2 registers its commands/schedules here or in its own provider.
 */
final class CouriersServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(CourierManager::class);
    }

    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);
        if ($this->app->runningInConsole()) {
            // API-C2: polling, booking reconciliation and the fake-courier tool (schedules in routes/console.php).
            $this->commands([Console\SyncCouriers::class, Console\ReconcileBookings::class, Console\FakeAdvance::class]);
        }
    }

    /** §15: COURIERS_FAKE=true in production refuses to boot. */
    public static function assertSafeConfiguration(Application $app): void
    {
        if ((bool) config('couriers.fake') && $app->environment('production')) {
            throw new RuntimeException('COURIERS_FAKE=true is not allowed in production.');
        }
    }
}

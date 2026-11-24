<?php

declare(strict_types=1);

namespace App\Domain\Automations;

use App\Domain\Automations\Console\DetectAbandonedCheckouts;
use App\Domain\Automations\Console\PruneRuns;
use App\Domain\Automations\Console\ReapStuckSteps;
use App\Domain\Automations\Console\ResumeDueRuns;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.6 automations: console commands (schedules in routes/console.php) and the limiters — storefront cart contact
 * (10/min per shopper IP, S132), cart recover (20/min per shopper IP, S133), dry run (30/min per user, §9.1).
 * Registered from AppServiceProvider.
 */
final class AutomationsServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([DetectAbandonedCheckouts::class, ResumeDueRuns::class, ReapStuckSteps::class, PruneRuns::class]);
        }

        RateLimiter::for('storefront-cart-contact', fn (Request $r) => Limit::perMinute((int) config('automations.cart_contact_per_minute', 10))
            ->by('storefront-cart-contact:'.StorefrontContext::ipKey(StorefrontContext::clientIp($r))));
        RateLimiter::for('storefront-cart-recover', fn (Request $r) => Limit::perMinute((int) config('automations.recover_per_minute', 20))
            ->by('storefront-cart-recover:'.StorefrontContext::ipKey(StorefrontContext::clientIp($r))));
        RateLimiter::for('automations-dry-run', fn (Request $r) => Limit::perMinute((int) config('automations.dry_runs_per_minute', 30))
            ->by('automations-dry-run:'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'))));
    }
}

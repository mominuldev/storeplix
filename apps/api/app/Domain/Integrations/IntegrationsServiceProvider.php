<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

use App\Domain\Feeds\Console\QueueFeedDeltas;
use App\Domain\Feeds\Console\QueueFeedSyncs;
use App\Domain\Integrations\Console\IntegrationsHealth;
use App\Domain\Stores\Services\StorefrontContext;
use App\Domain\Tracking\Console\DispatchDueTrackingEvents;
use App\Domain\Tracking\Console\PruneTracking;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

/**
 * Phase 8.9d part A: commands (schedule in routes/console.php), limiters (P89D-59) and the boot check that refuses
 * TRACKING_FAKE / FEEDS_FAKE in production. Registered from AppServiceProvider.
 */
final class IntegrationsServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);
        if ($this->app->runningInConsole()) {
            $this->commands([DispatchDueTrackingEvents::class, PruneTracking::class, QueueFeedSyncs::class, QueueFeedDeltas::class, IntegrationsHealth::class]);
        }

        $store = function (Request $r): string {
            $s = $r->route('store');

            return strtolower(is_object($s) && method_exists($s, 'getKey') ? (string) $s->getKey() : (is_string($s) ? $s : ''));
        };
        RateLimiter::for('integration-verify', fn (Request $r) => Limit::perMinute(10)->by('integration-verify:'.$store($r)));
        RateLimiter::for('integration-test', fn (Request $r) => Limit::perMinute(10)->by('integration-test:'.$store($r)));
        RateLimiter::for('feed-sync-now', fn (Request $r) => Limit::perMinutes(10, 1)->by('feed-sync-now:'.$store($r).'|'.$r->route('provider')));
        RateLimiter::for('oauth-callback', fn (Request $r) => Limit::perMinute(30)->by('oauth-callback:'.StorefrontContext::ipKey((string) $r->ip())));
        RateLimiter::for('tracking-beacon', function (Request $r) {
            $host = strtolower(trim((string) $r->header('X-Storefront-Host')));

            return [
                Limit::perMinute((int) config('tracking.beacon_per_ip_per_minute', 120))->by('tracking-beacon-ip:'.$host.'|'.StorefrontContext::ipKey(StorefrontContext::clientIp($r))),
                Limit::perMinute((int) config('tracking.beacon_per_host_per_minute', 6000))->by('tracking-beacon-host:'.$host),
            ];
        });
    }

    /** P89D: the fake drivers never run in production. */
    public static function assertSafeConfiguration(Application $app): void
    {
        if (! $app->environment('production')) {
            return;
        }
        foreach (['tracking.fake' => 'TRACKING_FAKE', 'feeds.fake' => 'FEEDS_FAKE'] as $key => $env) {
            if ((bool) config($key)) {
                throw new RuntimeException("{$env}=true is not allowed in production.");
            }
        }
    }
}

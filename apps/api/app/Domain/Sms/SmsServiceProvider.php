<?php

namespace App\Domain\Sms;

use App\Domain\Sms\Console\FetchSmsBalances;
use App\Domain\Sms\Console\PruneBroadcastRecipients;
use App\Domain\Sms\Console\PruneSenderDocuments;
use App\Domain\Sms\Console\PruneSmsPreviews;
use App\Domain\Sms\Console\RunPlatformBroadcasts;
use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\Drivers\LogSmsGateway;
use App\Domain\Sms\Routing\RoutingSmsGateway;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use InvalidArgumentException;
use RuntimeException;

/**
 * SMS gateway binding (Phase 2; PHASE-8-9B §4.3: `revesms` binds the router, `log` / `fake` bind that driver directly and
 * never route to a database provider, P89B-2 / S231) + PHASE-8-9A limiters (S219): `sms-test` 5/hour per member and
 * store, `sms-template-preview` 60/min per member, `sms-sender-id` 5/day per store; PHASE-8-9B limiters (S232):
 * `admin-sms-test` 10/hour, `admin-sms-export` 5/hour, `admin-sms-preview` 60/min per staff member,
 * `admin-sms-refresh-balance` 6/hour per provider, `platform-sms-opt-out` 30/min per IP.
 */
class SmsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(SmsGateway::class, fn ($app) => match ($app['config']->get('sms.driver')) {
            'revesms' => $app->make(RoutingSmsGateway::class),
            'log' => new LogSmsGateway,
            'fake' => new FakeSmsGateway,
            default => throw new InvalidArgumentException('Unknown SMS_DRIVER.'),
        });
    }

    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);

        $tenant = fn (Request $r) => strtolower((string) $r->header('X-Tenant-Id'));
        $store = fn (Request $r) => strtolower((string) (is_object($s = $r->route('store')) ? $s->getKey() : $s));
        $user = fn (Request $r) => (string) ($r->user()?->getAuthIdentifier() ?? $r->ip());

        RateLimiter::for('sms-test', fn (Request $r) => Limit::perHour((int) config('sms.test_per_hour', 5))
            ->by('sms-test:'.$user($r).'|'.$tenant($r).'|'.$store($r)));
        RateLimiter::for('sms-template-preview', fn (Request $r) => Limit::perMinute(60)->by('sms-template-preview:'.$user($r).'|'.$tenant($r)));
        RateLimiter::for('sms-sender-id', fn (Request $r) => Limit::perDay((int) config('sms.sender_id_requests_per_day', 5))
            ->by('sms-sender-id:'.$tenant($r).'|'.$store($r)));

        // PHASE-8-9B S232.
        RateLimiter::for('admin-sms-test', fn (Request $r) => Limit::perHour((int) config('sms.platform.test_per_hour', 10))->by('admin-sms-test:'.$user($r)));
        RateLimiter::for('admin-sms-export', fn (Request $r) => Limit::perHour((int) config('sms.platform.export_per_hour', 5))->by('admin-sms-export:'.$user($r)));
        RateLimiter::for('admin-sms-preview', fn (Request $r) => Limit::perMinute(60)->by('admin-sms-preview:'.$user($r)));
        RateLimiter::for('admin-sms-refresh-balance', fn (Request $r) => Limit::perHour((int) config('sms.platform.refresh_balance_per_hour', 6))
            ->by('admin-sms-refresh-balance:'.strtolower((string) $r->route('provider'))));
        RateLimiter::for('platform-sms-opt-out', fn (Request $r) => Limit::perMinute((int) config('sms.platform.opt_out_per_minute', 30))
            ->by('platform-sms-opt-out:'.$r->ip()));

        if ($this->app->runningInConsole()) {
            $this->commands([PruneSmsPreviews::class, PruneSenderDocuments::class, FetchSmsBalances::class, RunPlatformBroadcasts::class,
                PruneBroadcastRecipients::class]);
        }
    }

    /** S231: `SMS_PROVIDERS_HTTP_FAKE=true` refuses to boot in production. */
    public static function assertSafeConfiguration(Application $app): void
    {
        if ((bool) config('sms.providers_http_fake') && $app->environment('production')) {
            throw new RuntimeException('SMS_PROVIDERS_HTTP_FAKE=true is not allowed in production.');
        }
    }
}

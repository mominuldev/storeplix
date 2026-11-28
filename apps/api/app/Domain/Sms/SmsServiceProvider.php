<?php

namespace App\Domain\Sms;

use App\Domain\Sms\Console\PruneSenderDocuments;
use App\Domain\Sms\Console\PruneSmsPreviews;
use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\Drivers\LogSmsGateway;
use App\Domain\Sms\Drivers\RevesmsGateway;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use InvalidArgumentException;

/**
 * SMS gateway binding (Phase 2) + PHASE-8-9A limiters (S219) and console commands:
 * `sms-test` 5/hour per member and store, `sms-template-preview` 60/min per member, `sms-sender-id` 5/day per store.
 */
class SmsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(SmsGateway::class, fn ($app) => match ($app['config']->get('sms.driver')) {
            'revesms' => new RevesmsGateway($app['config']->get('sms.revesms')),
            'log' => new LogSmsGateway,
            'fake' => new FakeSmsGateway,
            default => throw new InvalidArgumentException('Unknown SMS_DRIVER.'),
        });
    }

    public function boot(): void
    {
        $tenant = fn (Request $r) => strtolower((string) $r->header('X-Tenant-Id'));
        $store = fn (Request $r) => strtolower((string) (is_object($s = $r->route('store')) ? $s->getKey() : $s));
        $user = fn (Request $r) => (string) ($r->user()?->getAuthIdentifier() ?? $r->ip());

        RateLimiter::for('sms-test', fn (Request $r) => Limit::perHour((int) config('sms.test_per_hour', 5))
            ->by('sms-test:'.$user($r).'|'.$tenant($r).'|'.$store($r)));
        RateLimiter::for('sms-template-preview', fn (Request $r) => Limit::perMinute(60)->by('sms-template-preview:'.$user($r).'|'.$tenant($r)));
        RateLimiter::for('sms-sender-id', fn (Request $r) => Limit::perDay((int) config('sms.sender_id_requests_per_day', 5))
            ->by('sms-sender-id:'.$tenant($r).'|'.$store($r)));

        if ($this->app->runningInConsole()) {
            $this->commands([PruneSmsPreviews::class, PruneSenderDocuments::class]);
        }
    }
}

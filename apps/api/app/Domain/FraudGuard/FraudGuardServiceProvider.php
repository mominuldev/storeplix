<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard;

use App\Domain\FraudGuard\Console\PruneFraudGuard;
use App\Domain\FraudGuard\Console\ResolveStaleChecks;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.8a fake-order guard: GuardSettings is SCOPED (its per-store memo is reset per request and per queued job),
 * console commands (schedules in routes/console.php) and the limiters (PHASE-8-8 §8.4):
 * `fraud-check` 30/min per user (and tenant); `checkout-otp` 5/h per store + phone and 20/h per store + shopper IP.
 */
final class FraudGuardServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->scoped(GuardSettings::class);
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([ResolveStaleChecks::class, PruneFraudGuard::class]);
        }

        RateLimiter::for('fraud-check', fn (Request $r) => Limit::perMinute((int) config('fraud_guard.check_per_minute', 30))
            ->by('fraud-check:'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'))));

        RateLimiter::for('checkout-otp', function (Request $r) {
            $host = strtolower((string) $r->header('X-Storefront-Host'));
            $limits = [Limit::perHour((int) config('fraud_guard.otp.per_ip_per_hour', 20))->by('checkout-otp-ip:'.$host.'|'.StorefrontContext::clientIp($r))];
            $phone = Phone::bdMsisdn(is_string($r->input('phone')) ? $r->input('phone') : null);
            if ($phone !== null) {
                $limits[] = Limit::perHour((int) config('fraud_guard.otp.per_phone_per_hour', 5))->by('checkout-otp-phone:'.$host.'|'.$phone);
            }

            return $limits;
        });
    }
}

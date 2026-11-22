<?php

namespace App\Providers;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use Laravel\Sanctum\Sanctum;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        // Phase 4.7c: no Bearer / personal-access-token authentication. Merchant and admin SPAs use same-origin cookie
        // sessions; Phase 8 API keys will be a separate mechanism. A Bearer header is simply ignored → 401.
        Sanctum::getAccessTokenFromRequestUsing(fn () => null);

        // QA M-3: per-identifier limits for credential attempts + a looser per-IP ceiling
        // (many Bangladeshi mobile users share one carrier-NAT IP). Every 429 carries retry_after.
        $ip = fn (Request $r) => (string) $r->ip();
        $email = fn (Request $r) => strtolower(trim((string) $r->input('email')));

        RateLimiter::for('login', fn (Request $r) => [
            Limit::perMinute(5)->by('login:'.$email($r).'|'.$ip($r)),
            Limit::perMinute(60)->by('login-ip:'.$ip($r)),
        ]);

        RateLimiter::for('register', fn (Request $r) => Limit::perMinute(10)->by('register-ip:'.$ip($r)));

        RateLimiter::for('password-reset', fn (Request $r) => [
            Limit::perMinute(5)->by('pw-reset:'.($email($r) ?: strtolower(trim((string) $r->input('phone'))))),
            Limit::perMinute(30)->by('pw-reset-ip:'.$ip($r)),
        ]);

        RateLimiter::for('invitation', fn (Request $r) => [
            Limit::perMinute(10)->by('invitation:'.hash('sha256', (string) $r->route('token'))),
            Limit::perMinute(60)->by('invitation-ip:'.$ip($r)),
        ]);

        // Coarse per-IP guard for OTP endpoints (verify attempts are also capped per code).
        RateLimiter::for('otp', fn (Request $request) => Limit::perMinute(30)->by('otp-ip:'.$request->ip()));

        // 1 resend per minute per invitation.
        RateLimiter::for('invitation-resend', function (Request $request) {
            $invitation = $request->route('invitation');

            return Limit::perMinute(1)->by('invitation-resend:'.(is_object($invitation) ? $invitation->getKey() : (string) $invitation));
        });

        // Phase 4: default merchant limiter (per user + tenant) and the bulk-data limiter (imports/exports, per tenant).
        RateLimiter::for('merchant', fn (Request $r) => Limit::perMinute(300)
            ->by('merchant:'.($r->user()?->getAuthIdentifier() ?? $ip($r)).'|'.strtolower((string) $r->header('X-Tenant-Id'))));
        RateLimiter::for('merchant-bulk', fn (Request $r) => Limit::perHour((int) config('storeplix.bulk_per_hour', 10))
            ->by('merchant-bulk:'.strtolower((string) $r->header('X-Tenant-Id'))));

        // Storefront traffic is proxied by the Next.js server, so limit per resolved host.
        RateLimiter::for('storefront', fn (Request $request) => Limit::perMinute(1200)
            ->by('storefront:'.strtolower((string) $request->header('X-Storefront-Host'))));
    }
}

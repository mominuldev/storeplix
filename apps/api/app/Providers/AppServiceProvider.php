<?php

namespace App\Providers;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
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

        // Storefront traffic is proxied by the Next.js server, so limit per resolved host.
        RateLimiter::for('storefront', fn (Request $request) => Limit::perMinute(1200)
            ->by('storefront:'.strtolower((string) $request->header('X-Storefront-Host'))));
    }
}

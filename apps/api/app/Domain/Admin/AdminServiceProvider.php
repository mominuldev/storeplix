<?php

declare(strict_types=1);

namespace App\Domain\Admin;

use App\Domain\Admin\Team\Console\PlatformGrant;
use App\Domain\Admin\Team\Console\PlatformResetTotp;
use App\Domain\Admin\Team\Console\PlatformRevoke;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.1 super admin (PHASE-8-1-CONTRACT): rate limiters for the admin surface (P8-19) and the `platform:*`
 * break-glass commands (§4.4). Owner: API-1.
 */
final class AdminServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([PlatformGrant::class, PlatformRevoke::class, PlatformResetTotp::class]);
        }

        $ip = fn (Request $r): string => (string) $r->ip();
        $user = fn (Request $r): string => (string) ($r->user()?->getAuthIdentifier() ?? 'ip:'.$r->ip());

        // P8-19: 5/min per email + IP and 20/min per IP on the pre-auth steps. Steps without an email (TOTP, enrolment,
        // invitation) count per login token / invitation token instead; five wrong codes lock the account anyway.
        RateLimiter::for('admin-login', function (Request $r) use ($ip) {
            $email = strtolower(trim((string) $r->input('email')));
            $subject = $email !== '' ? $email : 'token:'.hash('sha256', (string) ($r->input('login_token') ?? $r->route('token') ?? ''));

            return [
                Limit::perMinute(5)->by('admin-login:'.$subject.'|'.$ip($r)),
                Limit::perMinute(20)->by('admin-login-ip:'.$ip($r)),
            ];
        });

        // P8-19: every authenticated /admin/* request, 120/min per staff user; writes also 30/min per staff user.
        RateLimiter::for('admin', fn (Request $r) => Limit::perMinute(120)->by('admin:'.$user($r)));
        RateLimiter::for('admin-write', fn (Request $r) => Limit::perMinute(30)->by('admin-write:'.$user($r)));
    }
}

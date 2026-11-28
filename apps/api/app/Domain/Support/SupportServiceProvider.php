<?php

declare(strict_types=1);

namespace App\Domain\Support;

use App\Domain\Identity\Models\User;
use App\Domain\Support\Admin\UnassignSupportStaff;
use App\Domain\Support\Console\CloseResolvedTickets;
use App\Domain\Support\Console\PruneSupport;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.9c support tickets: commands (schedule in routes/console.php), limiters (PHASE-8-9C P89C-14, §8.2, §9) and
 * the hook that unassigns platform staff who are disabled or lose `manage_support` (P89C-18).
 */
final class SupportServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([CloseResolvedTickets::class, PruneSupport::class]);
        }

        $tenant = fn (Request $r) => strtolower((string) $r->header('X-Tenant-Id'));
        $member = fn (string $name, Request $r) => $name.':'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.$tenant($r);
        RateLimiter::for('support-ticket-create', fn (Request $r) => Limit::perHour(10)->by('support-ticket-create:'.$tenant($r)));
        RateLimiter::for('support-reply', fn (Request $r) => Limit::perMinute(60)->by($member('support-reply', $r)));
        RateLimiter::for('support-upload', fn (Request $r) => Limit::perMinute(30)->by($member('support-upload', $r)));
        RateLimiter::for('support-staff-reply', fn (Request $r) => Limit::perMinute(120)->by('support-staff-reply:'.($r->user()?->getAuthIdentifier() ?? $r->ip())));

        User::updated(function (User $user) {
            if ($user->wasChanged(['platform_role', 'platform_disabled_at']) && $user->getOriginal('platform_role') !== null
                && ! SupportNotifier::activeSupportStaff($user)) {
                UnassignSupportStaff::dispatch($user->id)->afterCommit();
            }
        });
    }
}

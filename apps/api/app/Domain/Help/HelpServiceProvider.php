<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Help\Console\PruneHelpMedia;
use App\Domain\Help\Console\PruneHelpViews;
use App\Domain\Help\Console\PublishScheduledHelpArticles;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.9c help center: commands (schedule in routes/console.php) and limiters (PHASE-8-9C §5, §6, §7.3): help-read
 * 120/min, help-search 60/min, help-feedback 30/min per member; help-media-upload 30/min per staff user.
 */
final class HelpServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([PublishScheduledHelpArticles::class, PruneHelpMedia::class, PruneHelpViews::class]);
        }

        $member = fn (string $name, Request $r) => $name.':'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'));
        RateLimiter::for('help-read', fn (Request $r) => Limit::perMinute(120)->by($member('help-read', $r)));
        RateLimiter::for('help-search', fn (Request $r) => Limit::perMinute(60)->by($member('help-search', $r)));
        RateLimiter::for('help-feedback', fn (Request $r) => Limit::perMinute(30)->by($member('help-feedback', $r)));
        RateLimiter::for('help-media-upload', fn (Request $r) => Limit::perMinute(30)->by('help-media-upload:'.($r->user()?->getAuthIdentifier() ?? $r->ip())));
    }
}

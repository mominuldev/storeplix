<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Marketing\Console\DispatchDueCampaigns;
use App\Domain\Marketing\Console\PruneCampaignRecipients;
use App\Domain\Marketing\Console\ReapStuckRecipients;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

/**
 * Phase 8.5 marketing campaigns: console commands (schedules in routes/console.php), the storefront unsubscribe
 * limiter (20/min per shopper IP, §4.2), the audience-preview limiter (30/min per user, §6.1) and the S125 boot guard.
 */
final class MarketingServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);
        if ($this->app->runningInConsole()) {
            $this->commands([DispatchDueCampaigns::class, ReapStuckRecipients::class, PruneCampaignRecipients::class]);
        }

        RateLimiter::for('storefront-unsubscribe', fn (Request $r) => Limit::perMinute(20)
            ->by('storefront-unsubscribe:'.StorefrontContext::ipKey(StorefrontContext::clientIp($r))));
        RateLimiter::for('campaigns-preview', fn (Request $r) => Limit::perMinute(30)
            ->by('campaigns-preview:'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'))));
    }

    /**
     * S125 / §5.4: in production CAMPAIGNS_DEV_SINK=true refuses to boot, and so does a log/array campaign mailer while
     * SMS go to the real provider (SMS_DRIVER=revesms) — a misconfiguration that would silently drop campaign email.
     */
    public static function assertSafeConfiguration(Application $app): void
    {
        if (! $app->environment('production')) {
            return;
        }
        if ((bool) config('campaigns.dev_sink')) {
            throw new RuntimeException('CAMPAIGNS_DEV_SINK=true is not allowed in production.');
        }
        $transport = (string) config('mail.mailers.'.config('campaigns.mailer', 'campaigns').'.transport');
        if (in_array($transport, ['log', 'array'], true) && config('sms.driver') === 'revesms') {
            throw new RuntimeException('CAMPAIGN_MAILER must be a real mail transport in production (log/array would drop campaign email).');
        }
    }
}

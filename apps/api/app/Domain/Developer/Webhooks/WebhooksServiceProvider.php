<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks;

use App\Domain\Developer\Console\AutoDisableWebhookEndpoints;
use App\Domain\Developer\Console\DispatchDueWebhooks;
use App\Domain\Developer\Console\PruneWebhookDeliveries;
use App\Domain\Developer\Webhooks\Sending\FakeWebhookClient;
use App\Domain\Developer\Webhooks\Sending\HostResolver;
use App\Domain\Developer\Webhooks\Sending\OutboundWebhookClient;
use App\Domain\Developer\Webhooks\Sending\SystemHostResolver;
use App\Domain\Developer\Webhooks\Sending\WebhookSender;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

/**
 * Phase 8.4 outbound webhooks: sender binding (fake or real, decided per resolve), DNS resolver, console commands
 * (schedules in routes/console.php), and the S112 boot check.
 */
final class WebhooksServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bindIf(HostResolver::class, SystemHostResolver::class);
        $this->app->bind(WebhookSender::class, fn (Application $app) => (bool) config('webhooks_out.fake')
            ? $app->make(FakeWebhookClient::class)
            : $app->make(OutboundWebhookClient::class));
    }

    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);
        if ($this->app->runningInConsole()) {
            $this->commands([DispatchDueWebhooks::class, PruneWebhookDeliveries::class, AutoDisableWebhookEndpoints::class]);
        }
    }

    /** S112: WEBHOOKS_OUT_FAKE / WEBHOOKS_OUT_ALLOW_HTTP in production refuse to boot. */
    public static function assertSafeConfiguration(Application $app): void
    {
        if (! $app->environment('production')) {
            return;
        }
        if ((bool) config('webhooks_out.fake')) {
            throw new RuntimeException('WEBHOOKS_OUT_FAKE=true is not allowed in production.');
        }
        if ((bool) config('webhooks_out.allow_http')) {
            throw new RuntimeException('WEBHOOKS_OUT_ALLOW_HTTP=true is not allowed in production.');
        }
    }
}

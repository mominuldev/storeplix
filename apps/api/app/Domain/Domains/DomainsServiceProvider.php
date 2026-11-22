<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use App\Domain\Domains\Dns\ConsensusResolver;
use App\Domain\Domains\Dns\DohResolver;
use App\Domain\Domains\Dns\FakeDnsResolver;
use App\Domain\Domains\Events\DomainStatusChanged;
use App\Domain\Domains\Listeners\SendDomainStatusEmail;
use App\Domain\Domains\Policies\StoreDomainPolicy;
use App\Domain\Domains\Providers\CloudflareCustomHostnames;
use App\Domain\Domains\Providers\CustomHostnameProvider;
use App\Domain\Domains\Providers\FakeCustomHostnames;
use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

/**
 * Phase 6 custom domains (PHASE-6-CONTRACT §3.4): driver bindings (DOMAINS_FAKE → fakes for DNS and the provider),
 * boot checks, policy, limiters, commands and the email listener. Schedules live in routes/console.php.
 */
final class DomainsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(FakeCustomHostnames::class);
        $this->app->singleton(CloudflareCustomHostnames::class);
        $this->app->bind(CustomHostnameProvider::class, fn (Application $app) => config('domains.fake')
            ? $app->make(FakeCustomHostnames::class)
            : $app->make(CloudflareCustomHostnames::class));

        $this->app->bind(ConsensusResolver::class, function () {
            $resolvers = [];
            foreach ((array) config('domains.doh.resolvers') as $name => $endpoint) {
                $resolvers[] = config('domains.fake')
                    ? new FakeDnsResolver((string) $name)
                    : new DohResolver((string) $name, (string) $endpoint, (int) config('domains.doh.timeout', 3));
            }

            return new ConsensusResolver($resolvers);
        });
    }

    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);

        Gate::policy(StoreDomain::class, StoreDomainPolicy::class);
        Event::listen(DomainStatusChanged::class, SendDomainStatusEmail::class);

        // §4.1: POST/DELETE on domains, 30/min per tenant + user.
        RateLimiter::for('domains', fn (Request $r) => Limit::perMinute(30)
            ->by('domains:'.strtolower((string) $r->header('X-Tenant-Id')).'|'.($r->user()?->getAuthIdentifier() ?? $r->ip())));
        // P6-17: the internal `ask` endpoint, 1 200/min per IP.
        RateLimiter::for('domains-ask', fn (Request $r) => Limit::perMinute(1200)->by('domains-ask:'.$r->ip()));

        if ($this->app->runningInConsole()) {
            $this->commands([
                Console\CheckDomains::class,
                Console\ReconcileProviderHostnames::class,
                Console\SuspendDomain::class,
                Console\ReinstateDomain::class,
                Console\UpdatePublicSuffixList::class,
            ]);
        }
    }

    /** P6-13: DOMAINS_FAKE never in production; production needs the Cloudflare token and zone. */
    public static function assertSafeConfiguration(Application $app): void
    {
        if (! $app->environment('production')) {
            return;
        }
        if ((bool) config('domains.fake')) {
            throw new RuntimeException('DOMAINS_FAKE=true is not allowed in production.');
        }
        if ((string) config('domains.cloudflare.api_token') === '' || (string) config('domains.cloudflare.zone_id') === '') {
            throw new RuntimeException('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are required in production (custom domains).');
        }
    }
}

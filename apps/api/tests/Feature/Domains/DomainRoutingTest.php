<?php

declare(strict_types=1);

namespace Tests\Feature\Domains;

use App\Domain\Domains\Dns\FakeDnsResolver;
use App\Domain\Domains\DomainsServiceProvider;
use App\Domain\Domains\Providers\FakeCustomHostnames;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Preview\PreviewTokenService;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Stores\Services\StorefrontResolver;
use Illuminate\Cache\RateLimiter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\DomainFixtures;
use Tests\TestCase;

/**
 * §10: storefront config `redirect_host` (P6-15), non-active hosts never serve (S42), revalidation/cache rules (P6-16),
 * the `ask` endpoint (P6-17, S49), the dev routes (§4.4) and the boot checks (P6-13).
 */
#[Group('domains')]
class DomainRoutingTest extends TestCase
{
    use DomainFixtures, RefreshDatabase;

    private function sfConfig(string $host, ?string $preview = null): TestResponse
    {
        return $this->flushHeaders()->withHeaders(array_filter([
            'X-Storefront-Key' => (string) config('storeplix.storefront_api_key'),
            'X-Storefront-Host' => $host,
            'X-Storefront-Preview' => $preview,
        ]))->getJson('/api/v1/storefront/config');
    }

    private function ask(?string $domain, ?string $key = 'test-ask-key-0123456789abcdef0123'): TestResponse
    {
        $query = http_build_query(array_filter(['domain' => $domain, 'key' => $key], fn ($v) => $v !== null));

        return $this->flushHeaders()->getJson('/api/v1/internal/domains/allowed?'.$query);
    }

    public function test_redirect_host_matrix(): void
    {
        [, $tenant, , $h] = $this->domainShop();
        $store = $this->inTenant($tenant, fn () => Store::query()->firstOrFail());
        $this->inTenant($tenant, fn () => StoreDomain::query()->create([
            'store_id' => $store->id, 'hostname' => 'alias.localhost', 'type' => 'platform', 'status' => 'active', 'is_primary' => false,
        ]));
        $platform = $store->slug.'.storeplix.test';
        $custom = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        $apex = $this->activeDomain($h, $tenant, $store, 'acme.com');

        // platform primary: platform hosts never redirect; an active non-primary custom host does
        $this->sfConfig($platform)->assertOk()->assertJsonPath('data.store.redirect_host', null)->assertJsonPath('data.store.primary_host', $platform);
        $this->sfConfig('alias.localhost:3000')->assertOk()->assertJsonPath('data.store.redirect_host', null);
        $this->sfConfig('shop.acme.com')->assertOk()->assertJsonPath('data.store.redirect_host', $platform);

        // custom primary: every other host redirects to it; the primary itself doesn't
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$custom->id.'/primary'))->assertOk();
        $this->sfConfig('shop.acme.com')->assertJsonPath('data.store.redirect_host', null)->assertJsonPath('data.store.primary_host', 'shop.acme.com');
        $this->sfConfig($platform)->assertJsonPath('data.store.redirect_host', 'shop.acme.com');
        $this->sfConfig('alias.localhost')->assertJsonPath('data.store.redirect_host', 'shop.acme.com');
        $this->sfConfig('acme.com')->assertJsonPath('data.store.redirect_host', 'shop.acme.com');

        // a valid preview never redirects
        $token = app(PreviewTokenService::class)->issue($store)['token'];
        $this->sfConfig($platform, $token)->assertJsonPath('data.store.redirect_host', null)->assertJsonPath('data.preview', true);
        $this->assertNotNull($apex);
    }

    #[Group('security')]
    public function test_non_active_custom_hosts_never_serve_store_data(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        $this->sfConfig('shop.acme.com')->assertNotFound()->assertJsonPath('error.code', 'store_not_found');
        $this->dnsFor($this->domainRow($tenant, $id));
        FakeCustomHostnames::override('shop.acme.com', 'pending', 'pending_validation');
        $this->assertSame('ssl_provisioning', $this->check($tenant, $id)->status);
        $this->sfConfig('shop.acme.com')->assertNotFound();
        FakeCustomHostnames::override('shop.acme.com', 'active', 'active');
        $this->check($tenant, $id);
        $this->sfConfig('shop.acme.com')->assertOk(); // cache forgotten on the status change
        $this->artisan('domains:suspend', ['hostname' => 'shop.acme.com'])->assertSuccessful();
        $this->sfConfig('shop.acme.com')->assertNotFound();
    }

    public function test_fake_mode_custom_localhost_host_serves_the_storefront(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop-e2e.localhost');
        $this->assertTrue($row->display_hostname === 'shop-e2e.localhost');
        $this->sfConfig('shop-e2e.localhost:3000')->assertOk()->assertJsonPath('data.store.id', $store->id);

        config(['domains.fake' => false]);
        $this->addDomain($h, $store, 'other.localhost')->assertStatus(422)->assertJsonPath('error.code', 'domain_invalid');
    }

    public function test_revalidation_only_on_routing_changes(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        Queue::fake();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');
        Queue::assertPushed(RevalidateStorefront::class, 1); // create

        Queue::fake();
        $row = $this->domainRow($tenant, $id);
        $this->check($tenant, $id); // bookkeeping only
        $this->inTenant($tenant, function () use ($id) {
            $model = StoreDomain::query()->findOrFail($id);
            $model->forceFill(['last_checked_at' => now(), 'check_attempts' => 9, 'failure_code' => 'txt_missing'])->save();
        });
        Queue::assertNotPushed(RevalidateStorefront::class);

        $this->dnsFor($row);
        FakeCustomHostnames::override('shop.acme.com', 'active', 'active');
        $this->check($tenant, $id); // pending → verified → ssl_provisioning
        Queue::assertPushed(RevalidateStorefront::class, fn ($j) => $j->storeId === $store->id && $j->tenantId === $tenant->id);

        Queue::fake();
        $this->check($tenant, $id); // → active
        Queue::assertPushed(RevalidateStorefront::class, 1);

        Queue::fake();
        $this->api($h, 'POST', $this->domainsUrl($store, '/'.$id.'/primary'))->assertOk();
        Queue::assertPushed(RevalidateStorefront::class, 1);

        Queue::fake();
        $this->api($h, 'DELETE', $this->domainsUrl($store, '/'.$id))->assertNoContent();
        Queue::assertPushed(RevalidateStorefront::class, fn ($j) => in_array('shop.acme.com', $j->extraHosts, true));
    }

    public function test_resolver_cache_is_forgotten_for_status_and_hostname_changes(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $row = $this->activeDomain($h, $tenant, $store, 'shop.acme.com');
        $this->assertNotNull(app(StorefrontResolver::class)->resolve('shop.acme.com'));
        $this->assertTrue(Cache::has('domain:shop.acme.com'));
        FakeDnsResolver::set('shop.acme.com', 'CNAME', null);
        $this->check($tenant, $row->id); // failing but still active: bookkeeping only, cache kept
        $this->assertTrue(Cache::has('domain:shop.acme.com'));
        $this->ageDomain($tenant, $row->id, 24 * 8);
        $this->check($tenant, $row->id); // → expired
        $this->assertFalse(Cache::has('domain:shop.acme.com'));
        $this->assertNull(app(StorefrontResolver::class)->resolve('shop.acme.com'));

        $this->inTenant($tenant, function () use ($store) {
            app(StorefrontResolver::class)->resolve($store->slug.'.storeplix.test');
            $d = StoreDomain::query()->where('hostname', $store->slug.'.storeplix.test')->firstOrFail();
            $d->hostname = 'renamed.storeplix.test';
            $d->save();
        });
        $this->assertFalse(Cache::has('domain:'.$store->slug.'.storeplix.test'));
    }

    #[Group('security')]
    public function test_ask_endpoint(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $pending = $this->addDomain($h, $store, 'pending.acme.com')->json('data.id');
        $this->activeDomain($h, $tenant, $store, 'live.acme.com');

        $this->ask('live.acme.com')->assertOk()->assertExactJson(['data' => ['allowed' => true]])->assertHeader('Cache-Control', 'no-store, private');
        $this->ask('LIVE.acme.com.')->assertOk();
        $this->ask($store->slug.'.storeplix.test')->assertOk();

        $unknown = $this->ask('unknown.example.com')->assertNotFound()->assertJsonPath('error.code', 'domain_not_allowed');
        foreach (['pending.acme.com', 'bad host', '', str_repeat('a', 300)] as $host) {
            $this->assertSame($unknown->getContent(), $this->ask($host)->assertNotFound()->getContent(), $host);
        }
        // verified / ssl_provisioning are allowed (a certificate may be issued before active)
        $this->dnsFor($this->domainRow($tenant, $pending));
        FakeCustomHostnames::override('pending.acme.com', 'pending', 'pending_validation');
        $this->check($tenant, $pending);
        $this->ask('pending.acme.com')->assertOk();

        $this->ask('live.acme.com', null)->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
        $this->ask('live.acme.com', 'wrong')->assertUnauthorized();
        config(['domains.ask_key' => '']);
        $this->ask('live.acme.com', '')->assertUnauthorized();
        config(['domains.ask_key' => 'test-ask-key-0123456789abcdef0123']);

        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_SUSPENDED]));
        $this->ask('live.acme.com')->assertNotFound();
    }

    #[Group('security')]
    public function test_ask_endpoint_is_rate_limited_per_ip(): void
    {
        $limiter = app(RateLimiter::class);
        $key = md5('domains-ask'.'domains-ask:127.0.0.1');
        for ($i = 0; $i < 1200; $i++) {
            $limiter->hit($key, 60);
        }
        $this->ask('x.example.com')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
    }

    public function test_dev_routes_drive_the_fakes(): void
    {
        [, $tenant, $store, $h] = $this->domainShop();
        $id = $this->addDomain($h, $store, 'shop.acme.com')->json('data.id');

        $this->postJson("/api/v1/dev/domains/{$id}/dns", ['ownership' => 'wrong', 'routing' => 'correct'])->assertOk()
            ->assertJsonPath('data.status', 'pending_verification');
        $this->postJson("/api/v1/dev/domains/{$id}/dns?check=1", ['ownership' => 'wrong', 'routing' => 'correct'])->assertOk()
            ->assertJsonPath('data.dns_records.0.status', 'mismatch')->assertJsonPath('data.can_remove', false);
        $this->postJson("/api/v1/dev/domains/{$id}/dns?check=1", ['ownership' => 'correct', 'routing' => 'flattened'])->assertOk()
            ->assertJsonPath('data.status', 'ssl_provisioning');
        $this->postJson("/api/v1/dev/domains/{$id}/provider?check=1", ['hostname_status' => 'active', 'ssl_status' => 'active'])->assertOk()
            ->assertJsonPath('data.status', 'active');
        $this->postJson("/api/v1/dev/domains/{$id}/dns", ['ownership' => 'missing', 'routing' => 'missing'])->assertOk();
        $this->postJson("/api/v1/dev/domains/{$id}/dns?check=1", ['ownership' => 'missing', 'routing' => 'missing'])->assertJsonPath('data.failure_code', 'txt_missing');
        $this->postJson("/api/v1/dev/domains/{$id}/age?check=1", ['hours' => 200])->assertOk()->assertJsonPath('data.status', 'expired');

        $this->postJson("/api/v1/dev/domains/{$id}/age", ['hours' => 0])->assertStatus(422);
        $this->postJson('/api/v1/dev/domains/01jaaaaaaaaaaaaaaaaaaaaaaa/age', ['hours' => 1])->assertNotFound();
        config(['domains.fake' => false]);
        $this->postJson("/api/v1/dev/domains/{$id}/age", ['hours' => 1])->assertNotFound();
        $this->assertNotNull($tenant);
    }

    public function test_boot_checks(): void
    {
        $this->app['env'] = 'production';
        try {
            config(['domains.fake' => true, 'domains.cloudflare.api_token' => 't', 'domains.cloudflare.zone_id' => 'z']);
            $this->assertThrowsMessage(fn () => DomainsServiceProvider::assertSafeConfiguration($this->app), 'DOMAINS_FAKE');
            config(['domains.fake' => false, 'domains.cloudflare.api_token' => '']);
            $this->assertThrowsMessage(fn () => DomainsServiceProvider::assertSafeConfiguration($this->app), 'CLOUDFLARE_API_TOKEN');
            config(['domains.cloudflare.api_token' => 't', 'domains.cloudflare.zone_id' => '']);
            $this->assertThrowsMessage(fn () => DomainsServiceProvider::assertSafeConfiguration($this->app), 'CLOUDFLARE_ZONE_ID');
            config(['domains.cloudflare.zone_id' => 'z']);
            DomainsServiceProvider::assertSafeConfiguration($this->app);
        } finally {
            $this->app['env'] = 'testing';
        }
        config(['domains.fake' => true]);
        DomainsServiceProvider::assertSafeConfiguration($this->app);
        $this->addToAssertionCount(1);
    }

    private function assertThrowsMessage(callable $fn, string $needle): void
    {
        try {
            $fn();
            $this->fail('did not throw');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString($needle, $e->getMessage());
        }
    }
}

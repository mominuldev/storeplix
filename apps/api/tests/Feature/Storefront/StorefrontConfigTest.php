<?php

namespace Tests\Feature\Storefront;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Services\StorefrontResolver;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

#[Group('tenancy')]
#[Group('tenancy')]
class StorefrontConfigTest extends TestCase
{
    use RefreshDatabase;

    private const KEY = 'test-storefront-key';

    private function config(?string $host, ?string $key = self::KEY, array $extra = [])
    {
        $this->flushHeaders();

        $headers = array_filter([
            'X-Storefront-Key' => $key,
            'X-Storefront-Host' => $host,
        ], fn ($v) => $v !== null) + $extra;

        return $this->withHeaders($headers)->getJson('/api/v1/storefront/config');
    }

    public function test_returns_only_public_render_fields(): void
    {
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'demo', ['demo.localhost']);

        $response = $this->config('demo.storeplix.test')->assertOk();

        $response->assertExactJsonStructure(['data' => [
            'store' => ['id', 'name', 'slug', 'status', 'currency', 'logo_url', 'favicon_url', 'icons' => ['apple_touch', 'icon_192', 'icon_512']],
            'contact' => ['phone', 'email', 'whatsapp', 'support_hours'],
            'social' => ['facebook', 'instagram', 'youtube'],
            'preview',
            'theme' => ['theme', 'version', 'settings' => ['primaryColor', 'secondaryColor', 'fontFamily'], 'sections' => ['*' => ['type', 'enabled']]],
            'seo' => ['title', 'description'],
        ]])
            ->assertJsonPath('data.store.id', $store->id)
            ->assertJsonPath('data.store.slug', 'demo')
            ->assertJsonPath('data.store.status', 'active')
            ->assertJsonPath('data.preview', false)
            ->assertJsonPath('data.store.currency', 'BDT')
            ->assertJsonPath('data.theme.theme', 'modern-commerce')
            ->assertJsonPath('data.theme.settings.primaryColor', '#5b53ff')
            ->assertJsonPath('data.theme.sections.1.type', 'featured-products')
            ->assertJsonPath('data.seo.title', 'Demo Store');

        $body = $response->getContent();
        $this->assertStringNotContainsString($tenant->id, $body, 'tenant id must not be exposed');
        $this->assertStringNotContainsString('verification_token', $body);
        $this->assertStringNotContainsString('tenant_id', $body);
    }

    public function test_host_is_normalized(): void
    {
        [, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'demo', ['demo.localhost']);

        foreach (['DEMO.storeplix.test', 'demo.storeplix.test.', 'demo.localhost:3000', ' demo.localhost '] as $host) {
            $this->config($host)->assertOk()->assertJsonPath('data.store.slug', 'demo');
        }
    }

    public function test_rejects_missing_or_wrong_key(): void
    {
        [, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'demo');

        $this->config('demo.storeplix.test', null)->assertUnauthorized()->assertJsonPath('error.code', 'invalid_storefront_key');
        $this->config('demo.storeplix.test', 'wrong-key')->assertUnauthorized()->assertJsonPath('error.code', 'invalid_storefront_key');
    }

    public function test_fails_closed_when_key_not_configured(): void
    {
        config(['storeplix.storefront_api_key' => '']);
        [, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'demo');

        $this->config('demo.storeplix.test', '')->assertUnauthorized();
    }

    public function test_unknown_host_returns_store_not_found(): void
    {
        $this->config('nope.storeplix.test')->assertNotFound()->assertJsonPath('error.code', 'store_not_found');
        $this->config('bad host!!')->assertNotFound()->assertJsonPath('error.code', 'store_not_found');
    }

    public function test_missing_host_header_is_rejected(): void
    {
        $this->config(null)->assertStatus(400)->assertJsonPath('error.code', 'storefront_host_required');
    }

    public function test_spoofed_host_headers_are_ignored_and_unregistered_host_rejected(): void
    {
        [, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'demo');

        // Real store in Host / X-Forwarded-Host must NOT be trusted; only X-Storefront-Host counts.
        $this->config('evil.example.com', self::KEY, [
            'Host' => 'demo.storeplix.test',
            'X-Forwarded-Host' => 'demo.storeplix.test',
        ])->assertNotFound()->assertJsonPath('error.code', 'store_not_found');

        $this->flushHeaders()->withHeaders([
            'X-Storefront-Key' => self::KEY,
            'Host' => 'demo.storeplix.test',
            'X-Forwarded-Host' => 'demo.storeplix.test',
        ])->getJson('/api/v1/storefront/config')->assertStatus(400);
    }

    public function test_inactive_domains_and_suspended_stores_do_not_resolve(): void
    {
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'demo');

        $this->tenancy()->run($tenant, fn () => StoreDomain::query()->create([
            'store_id' => $store->id,
            'hostname' => 'shop.example.com',
            'type' => StoreDomain::TYPE_CUSTOM,
            'status' => StoreDomain::STATUS_PENDING_VERIFICATION,
            'verification_token' => 'secret-token',
        ]));

        $this->config('shop.example.com')->assertNotFound();

        $this->config('demo.storeplix.test')->assertOk();
        $this->tenancy()->run($tenant, fn () => $store->update(['status' => Store::STATUS_SUSPENDED]));
        $this->config('demo.storeplix.test')->assertNotFound();
    }

    public function test_domain_cache_uses_tenant_neutral_key_and_is_invalidated_on_change(): void
    {
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'demo');

        // Negative cache entry for a not-yet-active custom domain.
        $this->config('shop.example.com')->assertNotFound();
        $this->assertNotNull(Cache::get(StorefrontResolver::cacheKey('shop.example.com')));

        $domain = $this->tenancy()->run($tenant, fn () => StoreDomain::query()->create([
            'store_id' => $store->id,
            'hostname' => 'Shop.Example.com',
            'type' => StoreDomain::TYPE_CUSTOM,
            'status' => StoreDomain::STATUS_ACTIVE,
        ]));

        $this->config('shop.example.com')->assertOk()->assertJsonPath('data.store.id', $store->id);
        $this->assertSame(
            ['tenant_id' => $tenant->id, 'store_id' => $store->id],
            Cache::get('domain:shop.example.com'),
        );

        $this->tenancy()->run($tenant, fn () => $domain->update(['status' => StoreDomain::STATUS_SUSPENDED]));
        $this->config('shop.example.com')->assertNotFound();
    }

    public function test_each_host_resolves_to_its_own_tenant(): void
    {
        [, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $a = $this->storeFor($tenantA, 'alpha');
        $b = $this->storeFor($tenantB, 'bravo');

        $this->config('alpha.storeplix.test')->assertOk()->assertJsonPath('data.store.id', $a->id);
        $this->config('bravo.storeplix.test')->assertOk()->assertJsonPath('data.store.id', $b->id);
    }

    public function test_draft_store_resolves_with_draft_status_and_suspended_stays_404(): void
    {
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'soon', status: Store::STATUS_DRAFT);

        $this->config('soon.storeplix.test')->assertOk()
            ->assertJsonPath('data.store.status', 'draft')
            ->assertJsonPath('data.preview', false);

        $this->tenancy()->run($tenant, fn () => $store->update(['status' => Store::STATUS_SUSPENDED]));
        $this->config('soon.storeplix.test')->assertNotFound()->assertJsonPath('error.code', 'store_not_found');
    }
}

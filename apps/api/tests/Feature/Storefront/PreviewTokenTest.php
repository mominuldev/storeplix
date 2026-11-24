<?php

namespace Tests\Feature\Storefront;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StorefrontResolver;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

#[Group('tenancy')]
class PreviewTokenTest extends TestCase
{
    use RefreshDatabase;

    private function mint(Store $store, array $headers)
    {
        return $this->flushHeaders()->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/preview-token");
    }

    private function storefront(string $host, ?string $preview)
    {
        return $this->flushHeaders()->withHeaders(array_filter([
            'X-Storefront-Key' => 'test-storefront-key',
            'X-Storefront-Host' => $host,
            'X-Storefront-Preview' => $preview,
        ], fn ($v) => $v !== null))->getJson('/api/v1/storefront/config');
    }

    public function test_member_mints_token_and_storefront_reports_preview(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);
        $store = $this->storeFor($tenant, 'soon', status: Store::STATUS_DRAFT);

        $this->freezeSecond();
        $response = $this->mint($store, $this->tenantHeaders($user, $tenant))
            ->assertCreated()
            ->assertExactJsonStructure(['data' => ['token', 'url', 'expires_at']])
            ->assertJsonPath('data.expires_at', now()->addMinutes(60)->toIso8601ZuluString());

        $token = $response->json('data.token');
        $this->assertSame('https://soon.storeplix.test/?preview='.rawurlencode($token), $response->json('data.url'));

        $this->storefront('soon.storeplix.test', $token)->assertOk()
            ->assertJsonPath('data.preview', true)
            ->assertJsonPath('data.store.status', 'draft')
            ->assertHeader('Cache-Control', 'no-store, private');

        $this->storefront('soon.storeplix.test', null)->assertOk()->assertJsonPath('data.preview', false);

        // Host cache holds only ids, never preview state.
        $this->assertSame(
            ['tenant_id' => $tenant->id, 'store_id' => $store->id],
            Cache::get(StorefrontResolver::cacheKey('soon.storeplix.test')),
        );
    }

    public function test_local_env_url_uses_http_and_port_3000(): void
    {
        $this->app['env'] = 'local';
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'loc');

        $url = $this->mint($store, $this->tenantHeaders($user, $tenant))->assertCreated()->json('data.url');
        $this->assertStringStartsWith('http://loc.storeplix.test:3010/?preview=', $url);
    }

    public function test_token_for_store_a_is_rejected_on_store_b(): void
    {
        [$user, $tenant] = $this->merchant();
        [, $otherTenant] = $this->merchant();
        [, $siblingTenant] = $this->merchant();
        $a = $this->storeFor($tenant, 'alpha', status: Store::STATUS_DRAFT);
        $this->storeFor($siblingTenant, 'sibling', status: Store::STATUS_DRAFT);
        $this->storeFor($otherTenant, 'bravo', status: Store::STATUS_DRAFT);

        $token = $this->mint($a, $this->tenantHeaders($user, $tenant))->json('data.token');

        $this->storefront('alpha.storeplix.test', $token)->assertOk()->assertJsonPath('data.preview', true);
        $this->storefront('sibling.storeplix.test', $token)->assertOk()->assertJsonPath('data.preview', false);
        $this->storefront('bravo.storeplix.test', $token)->assertOk()->assertJsonPath('data.preview', false);
    }

    public function test_expired_token_is_treated_as_public_visitor(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'soon', status: Store::STATUS_DRAFT);
        $token = $this->mint($store, $this->tenantHeaders($user, $tenant))->json('data.token');

        $this->travel(59)->minutes();
        $this->storefront('soon.storeplix.test', $token)->assertJsonPath('data.preview', true);

        $this->travel(2)->minutes();
        $this->storefront('soon.storeplix.test', $token)->assertOk()->assertJsonPath('data.preview', false);
    }

    public function test_tampered_tokens_are_rejected(): void
    {
        [$user, $tenant] = $this->merchant();
        [, $otherTenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'soon', status: Store::STATUS_DRAFT);
        $other = $this->storeFor($otherTenant, 'other', status: Store::STATUS_DRAFT);
        $token = $this->mint($store, $this->tenantHeaders($user, $tenant))->json('data.token');
        [$payload, $sig] = explode('.', $token);

        $b64 = fn (string $raw) => rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
        $data = json_decode(base64_decode(strtr($payload, '-_', '+/')), true);

        $forgedOtherStore = $b64(json_encode(['s' => $other->id, 'e' => $data['e']])).'.'.$sig;
        $forgedExpiry = $b64(json_encode(['s' => $store->id, 'e' => $data['e'] + 86400])).'.'.$sig;
        $flippedSig = $payload.'.'.strrev($sig);

        foreach ([$flippedSig, $forgedExpiry, $payload, 'garbage', $token.'x', str_repeat('a', 600)] as $bad) {
            $this->storefront('soon.storeplix.test', $bad)->assertOk()->assertJsonPath('data.preview', false);
        }
        $this->storefront('other.storeplix.test', $forgedOtherStore)->assertOk()->assertJsonPath('data.preview', false);
    }

    public function test_another_tenant_cannot_mint_a_token_for_your_store(): void
    {
        [, $tenantA] = $this->merchant();
        [$userB, $tenantB] = $this->merchant();
        $storeA = $this->storeFor($tenantA, 'alpha', status: Store::STATUS_DRAFT);

        // B using its own tenant: store is out of scope → 404.
        $this->mint($storeA, $this->tenantHeaders($userB, $tenantB))
            ->assertNotFound()->assertJsonPath('error.code', 'not_found');

        // B spoofing A's tenant id: not a member → 403.
        $this->mint($storeA, $this->tenantHeaders($userB, $tenantA))
            ->assertForbidden()->assertJsonPath('error.code', 'tenant_forbidden');

        // Unauthenticated.
        $this->app['auth']->forgetGuards();
        $this->flushHeaders()->postJson("/api/v1/stores/{$storeA->id}/preview-token")->assertUnauthorized();
    }
}

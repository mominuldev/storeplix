<?php

namespace Tests\Feature\Tenancy;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use App\Domain\Tenancy\Exceptions\TenantMismatchException;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

#[Group('tenancy')]
#[Group('tenancy')]
class CrossTenantIsolationTest extends TestCase
{
    use RefreshDatabase;

    public function test_user_cannot_list_another_tenants_stores_by_spoofing_x_tenant_id(): void
    {
        [$userA, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $this->storeFor($tenantB, 'bravo');

        $this->withHeaders($this->tenantHeaders($userA, $tenantB))->getJson('/api/v1/stores')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'tenant_forbidden');
    }

    public function test_unknown_and_malformed_tenant_ids_are_indistinguishable_from_foreign_ones(): void
    {
        [$userA] = $this->merchant();

        foreach ([strtolower((string) Str::ulid()), 'not-a-ulid', "' OR 1=1 --"] as $tenantId) {
            $this->withHeaders($this->tenantHeaders($userA, $tenantId))->getJson('/api/v1/stores')
                ->assertForbidden()
                ->assertJsonPath('error.code', 'tenant_forbidden');
        }
    }

    public function test_user_cannot_read_another_tenants_store_through_own_tenant(): void
    {
        [$userA, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $own = $this->storeFor($tenantA, 'alpha');
        $foreign = $this->storeFor($tenantB, 'bravo');

        $headers = $this->tenantHeaders($userA, $tenantA);

        $this->withHeaders($headers)->getJson("/api/v1/stores/{$own->id}")->assertOk()->assertJsonPath('data.slug', 'alpha');

        $this->withHeaders($headers)->getJson("/api/v1/stores/{$foreign->id}")
            ->assertNotFound()
            ->assertJsonPath('error.code', 'not_found');

        $this->withHeaders($headers)->getJson('/api/v1/stores')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $own->id);
    }

    public function test_store_created_via_api_belongs_to_header_tenant_even_if_body_claims_otherwise(): void
    {
        [$userA, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();

        $this->withHeaders($this->tenantHeaders($userA, $tenantA))
            ->postJson('/api/v1/stores', ['name' => 'Sneaky', 'slug' => 'sneaky', 'tenant_id' => $tenantB->id])
            ->assertCreated()
            ->assertJsonPath('data.tenant_id', $tenantA->id);
    }

    public function test_member_of_two_tenants_sees_only_the_selected_one(): void
    {
        [$user, $tenantA] = $this->merchant();
        $tenantB = Tenant::factory()->create();
        $this->merchant(tenant: $tenantB); // someone else owns B
        TenantUser::query()->create(['tenant_id' => $tenantB->id, 'user_id' => $user->id, 'role' => 'staff']);
        $this->storeFor($tenantA, 'alpha');
        $this->storeFor($tenantB, 'bravo');

        $this->withHeaders($this->tenantHeaders($user, $tenantB))->getJson('/api/v1/stores')
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.slug', 'bravo');
    }

    public function test_tenant_scoped_query_without_context_throws(): void
    {
        [, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'alpha');

        $this->assertFalse($this->tenancy()->has());

        $this->expectException(MissingTenantContextException::class);
        Store::query()->get();
    }

    public function test_tenant_scoped_create_without_context_throws(): void
    {
        $this->expectException(MissingTenantContextException::class);
        Store::query()->create(['name' => 'Orphan', 'slug' => 'orphan', 'country' => 'BD', 'currency' => 'BDT']);
    }

    public function test_cannot_create_row_for_other_tenant_inside_a_context(): void
    {
        [, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();

        $this->expectException(TenantMismatchException::class);

        $this->tenancy()->run($tenantA, function () use ($tenantB) {
            $store = new Store(['name' => 'X', 'slug' => 'xx-x', 'country' => 'BD', 'currency' => 'BDT']);
            $store->tenant_id = $tenantB->id;
            $store->save();
        });
    }

    public function test_scope_filters_to_current_tenant_and_without_tenancy_is_explicit(): void
    {
        [, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $this->storeFor($tenantA, 'alpha');
        $this->storeFor($tenantB, 'bravo');

        $slugs = $this->tenancy()->run($tenantA, fn () => Store::query()->pluck('slug')->all());
        $this->assertSame(['alpha'], $slugs);

        $domains = $this->tenancy()->run($tenantB, fn () => StoreDomain::query()->pluck('hostname')->all());
        $this->assertSame(['bravo.storeplix.test'], $domains);

        $this->assertSame(2, Store::withoutTenancy()->count());
        $this->assertFalse($this->tenancy()->has(), 'run() must restore the previous (empty) context');
    }

    public function test_tenant_id_is_immutable(): void
    {
        [, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $store = $this->storeFor($tenantA, 'alpha');

        $this->expectException(TenantMismatchException::class);
        $this->tenancy()->run($tenantA, fn () => $store->forceFill(['tenant_id' => $tenantB->id])->save());
    }

    public function test_tenant_cache_prefixes_keys_and_requires_context(): void
    {
        [, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        $cache = app(TenantCache::class);

        $this->tenancy()->run($tenantA, fn () => $cache->put('stats', 'A'));
        $this->tenancy()->run($tenantB, fn () => $cache->put('stats', 'B'));

        $this->assertSame('A', $this->tenancy()->run($tenantA, fn () => $cache->get('stats')));
        $this->assertSame('B', $this->tenancy()->run($tenantB, fn () => $cache->get('stats')));
        $this->assertSame("tenant:{$tenantA->id}:stats", $this->tenancy()->run($tenantA, fn () => $cache->key('stats')));

        $this->expectException(MissingTenantContextException::class);
        $cache->get('stats');
    }
}

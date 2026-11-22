<?php

namespace Tests\Feature\Stores;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Stores\Services\StoreLimitReachedException;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

class StoreApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_owner_creates_store_with_platform_domain_and_default_theme(): void
    {
        [$user, $tenant] = $this->merchant();

        $response = $this->withHeaders($this->tenantHeaders($user, $tenant))->postJson('/api/v1/stores', [
            'name' => 'Rahim Fashion',
            'slug' => 'Rahim-Fashion',
            'business_categories' => ['fashion', 'kids'],
            'name_bn' => 'রহিম ফ্যাশন',
            'country' => 'bd',
            'currency' => 'bdt',
        ]);

        $response->assertCreated()
            ->assertExactJsonStructure(['data' => [
                'id', 'tenant_id', 'name', 'slug', 'status', 'country', 'currency',
                'business_categories', 'name_bn', 'timezone', 'primary_domain', 'created_at',
            ]])
            ->assertJsonPath('data.tenant_id', $tenant->id)
            ->assertJsonPath('data.slug', 'rahim-fashion')
            ->assertJsonPath('data.status', 'draft')
            ->assertJsonPath('data.country', 'BD')
            ->assertJsonPath('data.currency', 'BDT')
            ->assertJsonPath('data.business_categories', ['fashion', 'kids'])
            ->assertJsonPath('data.timezone', 'Asia/Dhaka')
            ->assertJsonPath('data.primary_domain', 'rahim-fashion.storeplix.test');

        $storeId = $response->json('data.id');

        $domain = StoreDomain::withoutTenancy()->where('store_id', $storeId)->sole();
        $this->assertSame('platform', $domain->type);
        $this->assertSame('active', $domain->status);
        $this->assertTrue($domain->is_primary);
        $this->assertSame($tenant->id, $domain->tenant_id);

        $settings = StoreSetting::withoutTenancy()->where('store_id', $storeId)->sole();
        // Phase 3 (P3-13): default theme lives in store_themes (active, draft = published).
        $theme = StoreTheme::withoutTenancy()->where('store_id', $storeId)->sole();
        $this->assertTrue($theme->is_active);
        $this->assertSame('modern-commerce', $theme->theme_code);
        $this->assertSame($theme->draft_config, $theme->published_config);
        $this->assertSame($tenant->id, $settings->tenant_id);

        $this->assertTrue(AuditLog::query()->where('action', 'store.created')->where('subject_id', $storeId)->exists());
    }

    public function test_store_listing_returns_paginated_envelope(): void
    {
        [$user, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'alpha');

        $this->withHeaders($this->tenantHeaders($user, $tenant))->getJson('/api/v1/stores')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.slug', 'alpha')
            ->assertJsonPath('meta.total', 1)
            ->assertJsonStructure(['meta' => ['current_page', 'per_page', 'total', 'last_page']]);
    }

    public function test_slug_validation(): void
    {
        [$user, $tenant] = $this->merchant();
        [, $other] = $this->merchant();
        $this->storeFor($other, 'taken');
        $headers = $this->tenantHeaders($user, $tenant);

        foreach (['taken', 'www', '-bad-', 'a', 'has space', 'ünï'] as $slug) {
            $this->withHeaders($headers)->postJson('/api/v1/stores', ['name' => 'X Store', 'slug' => $slug])
                ->assertStatus(422)
                ->assertJsonPath('error.code', 'validation_failed')
                ->assertJsonStructure(['error' => ['details' => ['slug']]]);
        }

        $this->assertSame(1, Store::withoutTenancy()->count());
    }

    public function test_staff_cannot_create_store(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);

        $this->withHeaders($this->tenantHeaders($user, $tenant))
            ->postJson('/api/v1/stores', ['name' => 'Nope', 'slug' => 'nope-store'])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');
    }

    public function test_store_endpoints_require_tenant_header_and_auth(): void
    {
        [$user] = $this->merchant();

        $this->getJson('/api/v1/stores')->assertUnauthorized();

        $this->withHeaders(['X-Testing-User' => $user->id])->getJson('/api/v1/stores')
            ->assertStatus(400)
            ->assertJsonPath('error.code', 'tenant_required');
    }

    #[Group('tenancy')]
    public function test_second_store_for_same_tenant_returns_409(): void
    {
        [$user, $tenant] = $this->merchant();
        $headers = $this->tenantHeaders($user, $tenant);

        $this->withHeaders($headers)->postJson('/api/v1/stores', ['name' => 'Shop', 'slug' => 'shop-one'])->assertCreated();

        // Even with an otherwise-invalid (taken) slug, the limit wins.
        foreach (['shop-two', 'shop-one'] as $slug) {
            $this->withHeaders($headers)->postJson('/api/v1/stores', ['name' => 'Shop', 'slug' => $slug])
                ->assertStatus(409)
                ->assertJsonPath('error.code', 'store_limit_reached')
                ->assertJsonStructure(['error' => ['code', 'message']]);
        }

        $this->assertSame(1, Store::withoutTenancy()->where('tenant_id', $tenant->id)->count());
        $this->assertSame(1, StoreDomain::withoutTenancy()->where('tenant_id', $tenant->id)->count());
    }

    public function test_provisioner_also_enforces_the_limit(): void
    {
        [, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'first');

        $this->expectException(StoreLimitReachedException::class);
        $this->storeFor($tenant, 'second');
    }

    #[Group('tenancy')]
    public function test_database_enforces_one_store_per_tenant_when_api_is_bypassed(): void
    {
        [, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'first');

        $this->expectException(UniqueConstraintViolationException::class);

        DB::table('stores')->insert([
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => $tenant->id,
            'name' => 'Second',
            'slug' => 'second',
            'status' => 'draft',
            'country' => 'BD',
            'currency' => 'BDT',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    #[Group('tenancy')]
    public function test_member_of_two_tenants_sees_each_tenants_single_store_and_foreign_ids_404(): void
    {
        [$user, $tenantA] = $this->merchant();
        [, $tenantB] = $this->merchant();
        TenantUser::query()->create(['tenant_id' => $tenantB->id, 'user_id' => $user->id, 'role' => TenantUser::ROLE_STAFF]);
        [, $tenantC] = $this->merchant();

        $a = $this->storeFor($tenantA, 'shop-a');
        $b = $this->storeFor($tenantB, 'shop-b');
        $c = $this->storeFor($tenantC, 'shop-c');

        $headersA = $this->tenantHeaders($user, $tenantA);
        $headersB = $this->tenantHeaders($user, $tenantB);

        $this->withHeaders($headersA)->getJson('/api/v1/stores')
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $a->id);
        $this->withHeaders($headersB)->getJson('/api/v1/stores')
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $b->id);

        // B's store is not reachable through tenant A (even though the user is a member of B).
        $this->withHeaders($headersA)->getJson("/api/v1/stores/{$b->id}")
            ->assertNotFound()->assertJsonPath('error.code', 'not_found');

        // Non-member tenant C: 404 through own tenant, 403 when spoofing X-Tenant-Id.
        $this->withHeaders($headersA)->getJson("/api/v1/stores/{$c->id}")->assertNotFound();
        $this->withHeaders($headersA)->postJson("/api/v1/stores/{$c->id}/preview-token")->assertNotFound();
        $this->withHeaders($this->tenantHeaders($user, $tenantC))->getJson('/api/v1/stores')
            ->assertForbidden()->assertJsonPath('error.code', 'tenant_forbidden');
    }
}

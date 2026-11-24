<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\ApiKeys;

use App\Domain\Developer\ApiKeys\ApiKeyService;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/** PHASE-8-4 P84-3 / S102 under Postgres RLS: api_keys is tenant-isolated; `sp_api_key_owner` returns ids of live keys only. */
#[Group('developer-api')]
#[Group('rls')]
#[Group('security')]
class ApiKeysRlsTest extends TestCase
{
    use ApiKeyFixtures, RefreshDatabase, RlsFixtures {
        ApiKeyFixtures::liveShop insteadof RlsFixtures;
        ApiKeyFixtures::stocked insteadof RlsFixtures;
        ApiKeyFixtures::host insteadof RlsFixtures;
        ApiKeyFixtures::sf insteadof RlsFixtures;
        ApiKeyFixtures::cartWith insteadof RlsFixtures;
        ApiKeyFixtures::checkoutBody insteadof RlsFixtures;
        ApiKeyFixtures::checkout insteadof RlsFixtures;
        ApiKeyFixtures::placeOrder insteadof RlsFixtures;
        ApiKeyFixtures::manualBody insteadof RlsFixtures;
        ApiKeyFixtures::manual insteadof RlsFixtures;
        ApiKeyFixtures::shop insteadof RlsFixtures;
        ApiKeyFixtures::member insteadof RlsFixtures;
        ApiKeyFixtures::api insteadof RlsFixtures;
        ApiKeyFixtures::simpleProduct insteadof RlsFixtures;
        ApiKeyFixtures::variableProduct insteadof RlsFixtures;
        ApiKeyFixtures::createProduct insteadof RlsFixtures;
        ApiKeyFixtures::productImage insteadof RlsFixtures;
        ApiKeyFixtures::assertStoreIsolation insteadof RlsFixtures;
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
        Mail::fake();
    }

    public function test_api_keys_rows_are_invisible_across_tenants_and_the_definer_function_returns_ids_only(): void
    {
        [, $tenantA, , $ha] = $this->devShop('alpha');
        [, $tenantB, , $hb] = $this->devShop('beta');
        [$keyA, $plainA] = $this->createKey($ha, ['orders:read']);
        [$keyB] = $this->createKey($hb, ['orders:read']);

        $this->setGuc($tenantA->id);
        $this->assertSame([$keyA], DB::table('api_keys')->pluck('id')->all());
        $this->setGuc(null);
        $this->assertSame(0, DB::table('api_keys')->count());

        $row = DB::selectOne('select tenant_id, key_id from sp_api_key_owner(?)', [ApiKeyService::hash($plainA)]);
        $this->assertSame([$tenantA->id, $keyA], [trim($row->tenant_id), trim($row->key_id)]);
        $this->assertNull(DB::selectOne('select * from sp_api_key_owner(?)', [str_repeat('0', 64)]));

        // another tenant's row can't be changed (invisible) nor inserted into
        $this->setGuc($tenantA->id);
        $this->assertSame(0, DB::table('api_keys')->where('id', $keyB)->update(['name' => 'x']));
        $this->assertSame('42501', $this->sqlState(fn () => DB::table('api_keys')->insert([
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenantB->id, 'name' => 'x', 'prefix' => 'sp_live_abcd',
            'last_four' => 'abcd', 'key_hash' => str_repeat('a', 64), 'scopes' => '[]', 'created_at' => now(), 'updated_at' => now(),
        ])));
        $this->setGuc(null);

        // revoked → the function no longer finds it, the external API answers 401
        $this->api($ha, 'DELETE', "/api/v1/api-keys/{$keyA}")->assertOk();
        $this->assertNull(DB::selectOne('select * from sp_api_key_owner(?)', [ApiKeyService::hash($plainA)]));
        $this->ext($plainA, 'GET', '/me')->assertUnauthorized();
        $this->assertSame(1, $this->platformQuery(ApiKey::class)->where('tenant_id', $tenantB->id)->count());
    }

    public function test_external_requests_run_with_the_key_tenant_guc(): void
    {
        [, $tenant, $store, $h] = $this->devShop();
        [, $plain] = $this->createKey($h, ['orders:read']);
        $this->pendingOrder($h, $store);

        $this->ext($plain, 'GET', "/stores/{$store->id}/orders")->assertOk()->assertJsonCount(1, 'data');
        $this->assertSame('', $this->guc()); // cleared after the request
        $this->assertNotSame('', $tenant->id);
    }
}

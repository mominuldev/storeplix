<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\ApiKeys;

use App\Domain\Billing\Models\Plan;
use App\Domain\Developer\ApiKeys\ApiKeyService;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-8-4 §6.1 API key management: CRUD, validation, non-delegation (S105), limits (P84-14), plan (S106), audit, S100. */
#[Group('developer-api')]
class ApiKeysApiTest extends TestCase
{
    use ApiKeyFixtures, RefreshDatabase, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    private function audit(string $action): AuditLog
    {
        return $this->platformQuery(AuditLog::class)->where('action', $action)->latest('id')->firstOrFail();
    }

    public function test_create_returns_the_plain_key_once_and_stores_only_its_sha256(): void
    {
        [$owner, $tenant, , $h] = $this->devShop();

        $res = $this->api($h, 'POST', '/api/v1/api-keys', ['name' => '  Zapier  ', 'scopes' => ['orders:write', 'customers:read']])
            ->assertCreated();
        $this->assertStringContainsString('no-store', (string) $res->headers->get('Cache-Control'));
        $data = $res->json('data');

        $this->assertMatchesRegularExpression('/^sp_live_[A-Za-z0-9]{40}$/', $data['plain_key']);
        $this->assertSame('Zapier', $data['name']);
        $this->assertSame(substr($data['plain_key'], 0, 12), $data['prefix']);
        $this->assertSame(substr($data['plain_key'], -4), $data['last_four']);
        $this->assertSame('sp_live_••••'.$data['last_four'], $data['masked']);
        // implied read added, catalogue order
        $this->assertSame(['orders:read', 'orders:write', 'customers:read'], $data['scopes']);
        $this->assertSame('active', $data['status']);
        $this->assertFalse($data['include_costs']);
        $this->assertSame(['id' => $owner->id, 'name' => $owner->name], $data['created_by']);
        $this->assertNull($data['last_used_at']);
        $this->assertArrayNotHasKey('key_hash', $data);

        $row = $this->platformQuery(ApiKey::class)->findOrFail($data['id']);
        $this->assertSame($tenant->id, $row->tenant_id);
        $this->assertSame(hash('sha256', $data['plain_key']), $row->key_hash);

        // S100: the plain key is nowhere in the database and never returned again.
        $this->assertStringNotContainsString($data['plain_key'], json_encode($this->platformTable('api_keys')->get()));
        $this->assertStringNotContainsString($data['plain_key'], json_encode($this->platformTable('audit_logs')->get()));
        $list = $this->api($h, 'GET', '/api/v1/api-keys')->assertOk();
        $this->assertStringNotContainsString($data['plain_key'], (string) $list->getContent());
        $this->assertArrayNotHasKey('plain_key', $list->json('data.0'));
        $this->assertArrayNotHasKey('meta', $list->json());

        $audit = $this->audit('api_key.created');
        $this->assertSame('api_key', $audit->subject_type);
        $this->assertSame($data['id'], $audit->subject_id);
        $this->assertSame('user', $audit->actor_type);
        $this->assertSame(['orders:read', 'orders:write', 'customers:read'], $audit->meta['scopes']);
    }

    public function test_validation(): void
    {
        [, , , $h] = $this->devShop();

        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => 'X', 'scopes' => ['orders:delete']])->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');
        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => '', 'scopes' => ['orders:read']])->assertStatus(422);
        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => str_repeat('a', 61), 'scopes' => ['orders:read']])->assertStatus(422);
        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => 'X', 'scopes' => []])->assertStatus(422);
        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => 'X'])->assertStatus(422);
        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => 'X', 'scopes' => ['orders:read', 'orders:read']])->assertStatus(422);
        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => "Bad\x07", 'scopes' => ['orders:read']])->assertStatus(422);
        $this->assertSame(0, $this->platformQuery(ApiKey::class)->count());
    }

    public function test_rename_and_idempotent_revoke_are_audited_and_keep_the_row(): void
    {
        [$owner, , , $h] = $this->devShop();
        [$id, $plain] = $this->createKey($h, ['orders:read']);

        $this->api($h, 'PATCH', "/api/v1/api-keys/{$id}", ['name' => 'Accounting'])->assertOk()->assertJsonPath('data.name', 'Accounting');
        $this->assertSame(['from' => 'Zapier', 'to' => 'Accounting'], $this->audit('api_key.renamed')->meta);
        $this->api($h, 'PATCH', "/api/v1/api-keys/{$id}", ['name' => ''])->assertStatus(422);
        $this->api($h, 'PATCH', "/api/v1/api-keys/{$id}", ['name' => 'Accounting', 'scopes' => ['orders:write']])->assertOk()
            ->assertJsonPath('data.scopes', ['orders:read']); // rename only

        $this->ext($plain, 'GET', '/me')->assertOk();
        $res = $this->api($h, 'DELETE', "/api/v1/api-keys/{$id}")->assertOk();
        $this->assertSame('revoked', $res->json('data.status'));
        $this->assertNotNull($res->json('data.revoked_at'));
        $this->api($h, 'DELETE', "/api/v1/api-keys/{$id}")->assertOk()->assertJsonPath('data.status', 'revoked');
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'api_key.revoked')->count());
        $this->assertSame($owner->id, $this->platformQuery(ApiKey::class)->findOrFail($id)->revoked_by_user_id);

        $this->ext($plain, 'GET', '/me')->assertUnauthorized()->assertJsonPath('error.code', 'invalid_api_key');
    }

    public function test_list_shows_active_first_then_revoked_of_the_last_90_days(): void
    {
        [, $tenant, , $h] = $this->devShop();
        [$a] = $this->createKey($h, ['orders:read'], 'A');
        [$b] = $this->createKey($h, ['orders:read'], 'B');
        [$old] = $this->createKey($h, ['orders:read'], 'Old');
        [$c] = $this->createKey($h, ['orders:read'], 'C');
        $this->api($h, 'DELETE', "/api/v1/api-keys/{$a}")->assertOk();
        $this->api($h, 'DELETE', "/api/v1/api-keys/{$old}")->assertOk();
        $this->inTenant($tenant, fn () => ApiKey::query()->whereKey($old)->update(['revoked_at' => now()->subDays(91)]));

        $data = $this->api($h, 'GET', '/api/v1/api-keys')->assertOk()->json('data');
        $this->assertSame([$c, $b, $a], array_column($data, 'id'));
        $this->assertSame(['active', 'active', 'revoked'], array_column($data, 'status'));
    }

    public function test_at_most_ten_active_keys(): void
    {
        [, , , $h] = $this->devShop();
        $ids = [];
        for ($i = 0; $i < ApiKey::MAX_ACTIVE; $i++) {
            [$ids[]] = $this->createKey($h, ['orders:read'], "Key {$i}");
        }

        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => 'Eleven', 'scopes' => ['orders:read']])
            ->assertStatus(422)->assertJsonPath('error.code', 'limit_reached');

        $this->api($h, 'DELETE', "/api/v1/api-keys/{$ids[0]}")->assertOk();
        $this->createKey($h, ['orders:read'], 'Eleven');
    }

    public function test_non_delegation_for_custom_roles(): void
    {
        [, $tenant, , $h] = $this->devShop();
        $role = $this->customRole($h, 'Integrator', ['developers.manage', 'orders.view']);
        [, $ih] = $this->memberWithRole($tenant, $role);

        $this->createKey($ih, ['orders:read', 'products:read', 'inventory:read']);
        $this->api($ih, 'POST', '/api/v1/api-keys', ['name' => 'X', 'scopes' => ['orders:write']])
            ->assertStatus(422)->assertJsonPath('error.code', 'scope_not_grantable')->assertJsonPath('error.details.scopes', ['orders:write']);
        $this->api($ih, 'POST', '/api/v1/api-keys', ['name' => 'X', 'scopes' => ['customers:read', 'products:write']])
            ->assertStatus(422)->assertJsonPath('error.details.scopes', ['products:write', 'customers:read']);
        $this->api($ih, 'POST', '/api/v1/api-keys', ['name' => 'X', 'scopes' => ['orders:read'], 'include_costs' => true])
            ->assertStatus(422)->assertJsonPath('error.code', 'scope_not_grantable');

        $catalogue = collect($this->api($ih, 'GET', '/api/v1/api-scopes')->assertOk()->json('data'))->keyBy('key');
        $this->assertSame(['orders:read', 'orders:write', 'products:read', 'products:write', 'inventory:read', 'inventory:write', 'customers:read'], $catalogue->keys()->all());
        $this->assertSame([true, false, true, false, true, false, false], $catalogue->pluck('grantable')->all());
        $this->assertSame(['key' => 'orders:write', 'label' => 'Orders · write', 'group' => 'orders', 'backing_permission' => 'orders.process', 'implies' => ['orders:read'], 'grantable' => false], $catalogue['orders:write']);
        $this->assertNull($catalogue['products:read']['backing_permission']);

        // the owner may grant all, with costs
        [$id] = $this->createKey($h, ['orders:write', 'products:write', 'inventory:write', 'customers:read'], 'All', true);
        $this->assertTrue($this->platformQuery(ApiKey::class)->findOrFail($id)->include_costs);
    }

    public function test_staff_and_roles_without_developers_manage_are_refused(): void
    {
        [, $tenant, , $h] = $this->devShop();
        [$id] = $this->createKey($h, ['orders:read']);
        [, $sh] = $this->memberAs($tenant, TenantUser::ROLE_STAFF);
        [, $ah] = $this->memberAs($tenant, TenantUser::ROLE_ADMIN);

        foreach ([['GET', '/api/v1/api-keys'], ['POST', '/api/v1/api-keys', ['name' => 'X', 'scopes' => ['orders:read']]],
            ['PATCH', "/api/v1/api-keys/{$id}", ['name' => 'Y']], ['DELETE', "/api/v1/api-keys/{$id}"], ['GET', '/api/v1/api-scopes']] as $req) {
            $this->api($sh, $req[0], $req[1], $req[2] ?? [])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }
        $this->api($ah, 'GET', '/api/v1/api-keys')->assertOk()->assertJsonCount(1, 'data');
        $this->createKey($ah, ['orders:write']);
    }

    public function test_without_api_webhooks_reads_work_and_writes_answer_402_nothing_deleted(): void
    {
        [, $tenant, , $h] = $this->devShop();
        [$id, $plain] = $this->createKey($h, ['orders:read']);
        $this->planFor($tenant, Plan::FREE);

        $this->api($h, 'GET', '/api/v1/api-keys')->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', '/api/v1/api-scopes')->assertOk();
        $this->api($h, 'POST', '/api/v1/api-keys', ['name' => 'X', 'scopes' => ['orders:read']])
            ->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan')->assertJsonPath('error.details.upgrade_plan', ['growth']);
        $this->api($h, 'PATCH', "/api/v1/api-keys/{$id}", ['name' => 'Y'])->assertStatus(402);
        $this->api($h, 'DELETE', "/api/v1/api-keys/{$id}")->assertStatus(402);
        $this->ext($plain, 'GET', '/me')->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->assertSame(1, $this->platformQuery(ApiKey::class)->whereNull('revoked_at')->count());

        $this->planFor($tenant, Plan::GROWTH);
        $this->ext($plain, 'GET', '/me')->assertOk();
    }

    public function test_keys_of_another_tenant_answer_404(): void
    {
        [, , , $ha] = $this->devShop('alpha');
        [, , , $hb] = $this->devShop('beta');
        [$keyB] = $this->createKey($hb, ['orders:read']);

        $this->assertTenantIsolation($ha, [
            ['PATCH', "/api/v1/api-keys/{$keyB}", ['name' => 'Mine']],
            ['DELETE', "/api/v1/api-keys/{$keyB}"],
        ]);
        $this->api($ha, 'GET', '/api/v1/api-keys')->assertOk()->assertJsonCount(0, 'data');
        $this->assertNull($this->platformQuery(ApiKey::class)->findOrFail($keyB)->revoked_at);
    }

    public function test_generated_keys_are_unique_base62(): void
    {
        $keys = array_map(fn () => ApiKeyService::generate(), range(1, 50));
        $this->assertCount(50, array_unique($keys));
        foreach ($keys as $key) {
            $this->assertMatchesRegularExpression(ApiKey::PLAIN_PATTERN, $key);
        }
        $this->assertSame(64, strlen(ApiKeyService::hash($keys[0])));
        $this->assertSame(0, DB::table('api_keys')->count());
    }
}

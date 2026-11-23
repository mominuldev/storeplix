<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\Support\RoleFixtures;
use Tests\TestCase;

/**
 * PHASE-8-3 §10 `rls` items (Postgres, TENANCY_RLS=true as storeplix_app): a user reads the roles of the tenants they
 * belong to (also without a tenant context, for /auth/me) and never another tenant's; writes stay in the current tenant.
 */
#[Group('roles')]
#[Group('rls')]
#[Group('security')]
class RolesRlsTest extends TestCase
{
    use RefreshDatabase, RlsFixtures, RoleFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    public function test_member_read_policy_and_current_tenant_writes(): void
    {
        [$user, $tenantA, , $hA] = $this->growthShop('alpha');
        [, $tenantB, , $hB] = $this->growthShop('bravo');
        [, $tenantC, , $hC] = $this->growthShop('charlie');
        $roleB = $this->customRole($hB, 'Packer', ['shipments.manage']);
        $roleC = $this->customRole($hC, 'Secret', ['orders.view']);
        $this->inTenant($tenantB, fn () => TenantUser::query()->create(['tenant_id' => $tenantB->id, 'user_id' => $user->id, 'role_id' => $roleB]));

        // /auth/me (no tenant context) shows B's custom role and its permissions
        $tenants = collect($this->call2($hA, 'GET', '/api/v1/auth/me')->assertOk()->json('data.tenants'))->keyBy('id');
        $this->assertSame(['shipments.manage'], $tenants[$tenantB->id]['permissions']);
        $this->assertSame('Packer', $tenants[$tenantB->id]['role_name']);

        // raw: only the user GUC → roles of A and B, never C
        $this->setGuc(null, $user->id);
        $visible = DB::table('roles')->pluck('tenant_id')->unique()->sort()->values()->all();
        $this->assertSame(collect([$tenantA->id, $tenantB->id])->sort()->values()->all(), $visible);
        $this->assertSame(0, DB::table('roles')->where('id', $roleC)->count());
        $this->assertSame(0, DB::table('role_permissions')->where('role_id', $roleC)->count());
        $this->assertSame(1, DB::table('role_permissions')->where('role_id', $roleB)->count());

        // writes: only within app.tenant_id (A); reads of B as a member never allow writing B
        $this->setGuc($tenantA->id, $user->id);
        $this->assertSame('42501', $this->sqlState(fn () => DB::table('roles')->insert([
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenantB->id, 'name' => 'Injected', 'is_system' => false, 'revision' => 1,
            'created_at' => now(), 'updated_at' => now(),
        ])));
        $this->assertSame('42501', $this->sqlState(fn () => DB::table('role_permissions')->insert([
            'tenant_id' => $tenantB->id, 'role_id' => $roleB, 'permission' => 'costs.view', 'created_at' => now(),
        ])));
        $this->assertSame(0, DB::table('roles')->where('id', $roleB)->update(['name' => 'Pwned']));
        $this->assertSame(0, DB::table('role_permissions')->where('role_id', $roleB)->delete());
        $this->setGuc(null, null);
        $this->assertSame('Packer', $this->roleRow($tenantB, $roleB)?->name);

        // a user of C only can't read A's roles
        [$cOwner] = [$this->platformTable('tenant_users')->where('tenant_id', $tenantC->id)->where('role', 'owner')->value('user_id')];
        $this->setGuc(null, $cOwner);
        $this->assertSame([$tenantC->id], DB::table('roles')->pluck('tenant_id')->unique()->values()->all());
        $this->setGuc(null, null);
    }
}

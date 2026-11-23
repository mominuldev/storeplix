<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RoleFixtures;
use Tests\TestCase;

/** PHASE-8-3 §10 MeTest: TenantMembership.role_id / role_name / permissions per membership (§6.2), S97. */
#[Group('roles')]
class MeTest extends TestCase
{
    use RefreshDatabase, RoleFixtures;

    public function test_each_membership_carries_its_own_role_and_permissions(): void
    {
        [$user, $tenantA, , $hA] = $this->growthShop('alpha');
        [, $tenantB, , $hB] = $this->growthShop('bravo');
        $role = $this->customRole($hB, 'Packer', ['shipments.manage', 'orders.view']);
        $this->inTenant($tenantB, fn () => TenantUser::query()->create(['tenant_id' => $tenantB->id, 'user_id' => $user->id, 'role_id' => $role]));
        [, $tenantC] = $this->growthShop('charlie');
        $this->inTenant($tenantC, fn () => TenantUser::query()->create(['tenant_id' => $tenantC->id, 'user_id' => $user->id, 'role' => 'staff']));

        $tenants = collect($this->call2($hA, 'GET', '/api/v1/auth/me')->assertOk()->json('data.tenants'))->keyBy('id');
        $this->assertSame([
            'id' => $tenantA->id, 'name' => $tenantA->name, 'role' => 'owner', 'role_id' => $this->systemRoleId($tenantA, 'owner'),
            'role_name' => 'Owner', 'permissions' => SystemRole::Owner->permissions()->keys(),
        ], $tenants[$tenantA->id]);
        $this->assertSame(['custom', $role, 'Packer', ['orders.view', 'shipments.manage']], [
            $tenants[$tenantB->id]['role'], $tenants[$tenantB->id]['role_id'], $tenants[$tenantB->id]['role_name'], $tenants[$tenantB->id]['permissions'],
        ]);
        $this->assertSame(SystemRole::Staff->permissions()->keys(), $tenants[$tenantC->id]['permissions']);
        $this->assertSame('Staff', $tenants[$tenantC->id]['role_name']);
    }

    /** S97: a role change shows on the next /auth/me. */
    public function test_changes_apply_on_the_next_request(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        [, $m] = $this->memberWithRole($tenant, $role);
        $this->call2($m, 'GET', '/api/v1/auth/me')->assertJsonPath('data.tenants.0.permissions', ['shipments.manage']);

        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['revision' => 1, 'permissions' => ['shipments.manage', 'shipments.cancel']])->assertOk();
        $this->call2($m, 'GET', '/api/v1/auth/me')->assertJsonPath('data.tenants.0.permissions', ['shipments.manage', 'shipments.cancel']);
    }
}

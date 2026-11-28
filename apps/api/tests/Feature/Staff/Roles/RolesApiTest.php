<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Billing\Models\Plan;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Staff\Roles\RoleService;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RoleFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-8-3 §10 RolesApiTest: /permissions, /roles CRUD, N1–N9, plan gate, audit (§6). */
#[Group('roles')]
class RolesApiTest extends TestCase
{
    use RefreshDatabase, RoleFixtures, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    private function audit(string $action): AuditLog
    {
        return $this->platformQuery(AuditLog::class)->where('action', $action)->latest('id')->firstOrFail();
    }

    private function invite(array $h, string $email, string $roleId): string
    {
        return $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => $email, 'role_id' => $roleId])->assertCreated()->json('data.id');
    }

    public function test_catalogue_lists_groups_in_order_with_billing_manage_not_grantable(): void
    {
        [, , , $h] = $this->growthShop();
        $data = $this->call2($h, 'GET', '/api/v1/permissions')->assertOk()->json('data');

        $this->assertSame(['orders', 'shipping', 'products', 'customers', 'money', 'store', 'team'], array_column($data, 'key'));
        $this->assertSame('Orders', $data[0]['label']);
        $this->assertSame([
            'key' => 'orders.refund', 'label' => 'Refunds & paid cancellations',
            'description' => 'Refund money, cancel paid orders, change COD amount', 'requires' => ['orders.process'],
            'sensitive' => true, 'grantable' => true,
        ], $data[0]['permissions'][2]);
        $team = collect($data[6]['permissions'])->keyBy('key');
        $this->assertFalse($team['billing.manage']['grantable']);
        $this->assertSame(29, collect($data)->sum(fn ($g) => count($g['permissions']))); // PHASE-8-8E: + inbox.manage; PHASE-8-8B: + purchasing.manage; PHASE-8-8D: + pos.sell
    }

    public function test_list_puts_system_roles_first_then_custom_by_name_with_meta(): void
    {
        [$owner, $tenant, , $h] = $this->growthShop();
        $zeta = $this->customRole($h, 'Zeta', ['orders.view']);
        $alpha = $this->customRole($h, 'alpha packers', ['shipments.manage']);
        [, , $m] = $this->memberWithRole($tenant, $alpha);
        $this->invite($h, 'packer@example.test', $alpha);

        $res = $this->call2($h, 'GET', '/api/v1/roles')->assertOk();
        $this->assertSame(['owner', 'admin', 'staff', null, null], array_column($res->json('data'), 'key'));
        $this->assertSame(['Owner', 'Manager', 'Staff', 'alpha packers', 'Zeta'], array_column($res->json('data'), 'name'));
        $this->assertSame(['custom_roles_used' => 2, 'custom_roles_limit' => 20, 'custom_roles_enabled' => true], $res->json('meta'));

        [$o, $a, $s, $p, $z] = $res->json('data');
        $this->assertCount(29, $o['permissions']); // PHASE-8-8D: + pos.sell; PHASE-8-8E: + inbox.manage
        $this->assertCount(28, $a['permissions']); // PHASE-8-8E: + inbox.manage
        $this->assertSame('Products, inventory, orders & customers', $s['description']);
        $this->assertTrue($o['is_system']);
        $this->assertFalse($o['editable']);
        $this->assertSame(1, $o['members_count']);
        $this->assertSame([['id' => $this->membershipOf($owner, $tenant)->id, 'name' => $owner->name]], $o['members_preview']);
        $this->assertSame(['shipments.manage'], $p['permissions']);
        $this->assertSame(1, $p['members_count']);
        $this->assertSame(1, $p['invitations_count']);
        $this->assertSame($m->id, $p['members_preview'][0]['id']); // members first
        $this->assertTrue($p['editable']);
        $this->assertSame($zeta, $z['id']);
        $this->assertSame(['id' => $owner->id, 'name' => $owner->name], $z['updated_by']);
    }

    public function test_create_validates_names_prerequisites_keys_and_the_limit(): void
    {
        [$owner, , , $h] = $this->growthShop();

        $res = $this->createRole($h, '  Order staff ', ['orders.view', 'orders.process', 'shipments.manage'], 'Packs and ships')->assertCreated();
        $this->assertSame('Order staff', $res->json('data.name'));
        $this->assertNull($res->json('data.key'));
        $this->assertSame(['orders.view', 'orders.process', 'shipments.manage'], $res->json('data.permissions'));
        $this->assertSame(1, $res->json('data.revision'));
        $this->assertSame([], $res->json('data.members'));
        $log = $this->audit('role.created');
        $this->assertSame(['name' => 'Order staff', 'permissions' => ['orders.view', 'orders.process', 'shipments.manage']], $log->meta);
        $this->assertSame('role', $log->subject_type);
        $this->assertSame($owner->id, $log->actor_id);

        foreach (['order STAFF', 'manager', 'OWNER', 'Staff'] as $taken) {
            $this->createRole($h, $taken, [])->assertStatus(422)->assertJsonValidationErrors('name', 'error.details');
        }
        $this->createRole($h, 'Refunder', ['orders.refund'])->assertStatus(422)->assertJsonValidationErrors('permissions', 'error.details');
        $this->createRole($h, 'Bad', ['orders.delete'])->assertStatus(422);
        $this->createRole($h, 'Billing', ['billing.view', 'billing.manage'])->assertStatus(422);
        $this->createRole($h, 'Dupes', ['orders.view', 'orders.view'])->assertStatus(422);
        $this->createRole($h, str_repeat('x', 41), [])->assertStatus(422);
        $this->call2($h, 'POST', '/api/v1/roles', ['name' => 'No perms key'])->assertStatus(422);
        $this->createRole($h, 'Empty', [])->assertCreated()->assertJsonPath('data.permissions', []); // base access only

        for ($i = 3; $i <= 20; $i++) {
            $this->customRole($h, "Role {$i}", []);
        }
        $this->createRole($h, 'Role 21', [])->assertStatus(409)->assertJsonPath('error.code', 'role_limit_reached');
        $this->call2($h, 'GET', '/api/v1/roles')->assertJsonPath('meta.custom_roles_used', 20);
    }

    public function test_detail_lists_members_then_open_invitations_by_name(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        [$b] = $this->memberWithRole($tenant, $role);
        $b->update(['name' => 'Bashir']);
        [$a] = $this->memberWithRole($tenant, $role);
        $a->update(['name' => 'Anika']);
        $inv = $this->invite($h, 'zed@example.test', $role);
        $revoked = $this->invite($h, 'gone@example.test', $role);
        $this->call2($h, 'DELETE', "/api/v1/staff/invitations/{$revoked}")->assertNoContent();

        $members = $this->call2($h, 'GET', "/api/v1/roles/{$role}")->assertOk()->json('data.members');
        $this->assertSame(['Anika', 'Bashir', null], array_column($members, 'name'));
        $this->assertSame(['member', 'member', 'invitation'], array_column($members, 'kind'));
        $this->assertSame(['active', 'active', 'invited'], array_column($members, 'status'));
        $this->assertSame($inv, $members[2]['id']);
        $this->assertSame(['id', 'kind', 'user_id', 'name', 'email', 'phone', 'status', 'is_you'], array_keys($members[0]));

        $this->call2($h, 'GET', '/api/v1/roles/'.Str::ulid())->assertNotFound();
    }

    public function test_patch_checks_revision_replaces_permissions_and_audits_changes(): void
    {
        [, , , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage', 'orders.view']);

        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['revision' => 2, 'name' => 'X'])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['name' => 'X'])->assertStatus(422);

        $res = $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", [
            'revision' => 1, 'name' => 'Packers', 'description' => 'Warehouse', 'permissions' => ['shipments.manage', 'shipments.cancel'],
        ])->assertOk();
        $this->assertSame(2, $res->json('data.revision'));
        $this->assertSame(['shipments.manage', 'shipments.cancel'], $res->json('data.permissions'));
        $this->assertSame([
            'name' => ['from' => 'Packer', 'to' => 'Packers'],
            'description' => ['from' => null, 'to' => 'Warehouse'],
            'permissions' => ['added' => ['shipments.cancel'], 'removed' => ['orders.view']],
        ], $this->audit('role.updated')->meta['changes']);

        // no-op: revision still increments, no audit row
        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['revision' => 2, 'name' => 'Packers'])->assertOk()->assertJsonPath('data.revision', 3);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'role.updated')->count());

        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['revision' => 3, 'permissions' => ['shipments.cancel']])->assertStatus(422);
        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['revision' => 3, 'name' => 'manager'])->assertStatus(422);
    }

    public function test_delete_unused_in_use_and_with_reassignment(): void
    {
        [$owner, $tenant, , $h] = $this->growthShop();
        $unused = $this->customRole($h, 'Unused', []);
        $this->call2($h, 'DELETE', "/api/v1/roles/{$unused}?revision=1")->assertNoContent();
        $this->assertNull($this->roleRow($tenant, $unused));
        $this->assertSame(['name' => 'Unused', 'reassigned_to' => null, 'members_moved' => 0, 'invitations_moved' => 0], $this->audit('role.deleted')->meta);

        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        $target = $this->customRole($h, 'Senior packer', ['shipments.manage', 'shipments.cancel']);
        [$u1, , $m1] = $this->memberWithRole($tenant, $role);
        [, , $m2] = $this->memberWithRole($tenant, $role);
        $inv = $this->invite($h, 'new@example.test', $role);

        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=1")->assertStatus(409)->assertJsonPath('error.code', 'role_in_use')
            ->assertJsonPath('error.details.invitations', [$inv])
            ->assertJsonPath('error.details.members', fn ($ids) => collect($ids)->sort()->values()->all() === collect([$m1->id, $m2->id])->sort()->values()->all());

        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=1&reassign_to={$role}")->assertStatus(422);
        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=1&reassign_to=".$this->systemRoleId($tenant, 'owner'))->assertStatus(422);
        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=1&reassign_to=".Str::ulid())->assertStatus(422);
        [, $other] = $this->growthShop('other');
        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=1&reassign_to=".$this->systemRoleId($other, 'staff'))->assertStatus(422)
            ->assertJsonValidationErrors('reassign_to', 'error.details');

        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=1&reassign_to={$target}")->assertNoContent();
        $this->assertNull($this->roleRow($tenant, $role));
        foreach ([$m1, $m2] as $m) {
            $row = $this->platformQuery(TenantUser::class)->find($m->id);
            $this->assertSame([$target, 'custom'], [$row->role_id, $row->role]);
        }
        $this->assertSame($target, $this->platformQuery(StaffInvitation::class)->find($inv)->role_id);
        $this->assertSame(['name' => 'Packer', 'reassigned_to' => ['id' => $target, 'name' => 'Senior packer'], 'members_moved' => 2, 'invitations_moved' => 1], $this->audit('role.deleted')->meta);
        $changes = $this->platformQuery(AuditLog::class)->where('action', 'staff.role_changed')->get();
        $this->assertCount(2, $changes);
        $this->assertSame(['changes' => ['role' => ['from' => 'Packer', 'to' => 'Senior packer']], 'role_id' => ['from' => $role, 'to' => $target]], $changes[0]->meta);

        // members moved to a system role become that kind
        [, , $m3] = $this->memberWithRole($tenant, $target);
        $staff = $this->systemRoleId($tenant, 'staff');
        $this->call2($h, 'DELETE', "/api/v1/roles/{$target}?revision=1&reassign_to={$staff}")->assertNoContent();
        $this->assertSame(['staff', $staff], [$this->platformQuery(TenantUser::class)->find($m3->id)->role, $this->platformQuery(TenantUser::class)->find($m3->id)->role_id]);
        $this->assertSame($owner->id, $this->audit('role.deleted')->actor_id);
    }

    public function test_system_roles_are_locked_and_nobody_edits_their_own_role(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        foreach (['owner', 'admin', 'staff'] as $key) {
            $id = $this->systemRoleId($tenant, $key);
            $this->call2($h, 'PATCH', "/api/v1/roles/{$id}", ['revision' => 1, 'name' => 'Boss'])->assertStatus(409)->assertJsonPath('error.code', 'system_role_locked');
            $this->call2($h, 'DELETE', "/api/v1/roles/{$id}?revision=1")->assertStatus(409)->assertJsonPath('error.code', 'system_role_locked');
        }

        $leads = $this->customRole($h, 'Team lead', ['staff.manage', 'orders.view']);
        [, $lead] = $this->memberWithRole($tenant, $leads);
        $this->call2($lead, 'PATCH', "/api/v1/roles/{$leads}", ['revision' => 1, 'permissions' => ['staff.manage', 'orders.view', 'orders.process']])
            ->assertForbidden()->assertJsonPath('error.code', 'cannot_edit_own_role');
        $this->call2($lead, 'DELETE', "/api/v1/roles/{$leads}?revision=1")->assertForbidden()->assertJsonPath('error.code', 'cannot_edit_own_role');
        $this->call2($lead, 'GET', "/api/v1/roles/{$leads}")->assertOk()->assertJsonPath('data.editable', false);
    }

    /** S92: N1 / N2. */
    #[Group('security')]
    public function test_nobody_grants_or_edits_more_than_they_hold(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $leads = $this->customRole($h, 'Team lead', ['staff.manage', 'orders.view']);
        [, $lead] = $this->memberWithRole($tenant, $leads);

        $this->createRole($lead, 'Accountant', ['costs.view', 'orders.view'])->assertForbidden()
            ->assertJsonPath('error.code', 'permission_not_held')->assertJsonPath('error.details.permissions', ['costs.view']);
        $this->createRole($lead, 'Viewer', ['orders.view'])->assertCreated();

        $acct = $this->customRole($h, 'Accountant', ['costs.view']);
        $this->call2($lead, 'PATCH', "/api/v1/roles/{$acct}", ['revision' => 1, 'name' => 'Acct'])->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'DELETE', "/api/v1/roles/{$acct}?revision=1")->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'GET', "/api/v1/roles/{$acct}")->assertOk()->assertJsonPath('data.editable', false);

        // An admin can grant everything grantable; nobody can grant billing.manage.
        [, $admin] = $this->memberAs($tenant, 'admin');
        $this->createRole($admin, 'Everything', array_values(array_diff(Permission::values(), ['billing.manage'])))->assertCreated();
        $this->createRole($admin, 'Payer', ['billing.view', 'billing.manage'])->assertStatus(422);
    }

    /** S93: N5 / N6 on assignments, removals and invitations. */
    #[Group('security')]
    public function test_nobody_assigns_or_removes_roles_beyond_their_own(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $leads = $this->customRole($h, 'Team lead', ['staff.manage', 'orders.view']);
        [, $lead] = $this->memberWithRole($tenant, $leads);
        $admin = $this->systemRoleId($tenant, 'admin');
        $owner = $this->systemRoleId($tenant, 'owner');
        [, , $manager] = $this->memberWithRole($tenant, $admin);
        $viewer = $this->customRole($h, 'Viewer', ['orders.view']);
        [, , $viewerMember] = $this->memberWithRole($tenant, $viewer);
        $managerInvite = $this->invite($h, 'mgr@example.test', $admin);

        $this->call2($lead, 'POST', '/api/v1/staff/invitations', ['email' => 'x@example.test', 'role_id' => $admin])->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'POST', '/api/v1/staff/invitations', ['email' => 'x@example.test', 'role' => 'admin'])->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'POST', '/api/v1/staff/invitations', ['email' => 'x@example.test', 'role_id' => $owner])->assertStatus(422)->assertJsonValidationErrors('role_id', 'error.details');
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'x@example.test', 'role_id' => $owner])->assertStatus(422);
        $this->call2($lead, 'PATCH', "/api/v1/staff/{$viewerMember->id}", ['role_id' => $admin])->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'PATCH', "/api/v1/staff/{$viewerMember->id}", ['role_id' => $owner])->assertStatus(422);
        $this->call2($lead, 'PATCH', "/api/v1/staff/{$manager->id}", ['role_id' => $viewer])->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'DELETE', "/api/v1/staff/{$manager->id}")->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'DELETE', "/api/v1/staff/invitations/{$managerInvite}")->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'POST', "/api/v1/staff/invitations/{$managerInvite}/resend")->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
        $this->call2($lead, 'DELETE', "/api/v1/roles/{$viewer}?revision=1&reassign_to={$admin}")->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');

        // within their own permissions it works
        $this->call2($lead, 'POST', '/api/v1/staff/invitations', ['email' => 'v@example.test', 'role_id' => $viewer])->assertCreated()->assertJsonPath('data.role', 'custom')->assertJsonPath('data.role_name', 'Viewer');
        $this->call2($lead, 'PATCH', "/api/v1/staff/{$viewerMember->id}", ['role_id' => $leads])->assertOk()->assertJsonPath('data.role_id', $leads);
        $this->call2($lead, 'DELETE', "/api/v1/staff/{$viewerMember->id}")->assertNoContent();
    }

    /** S94: N7 / N8. */
    #[Group('security')]
    public function test_own_membership_and_the_owner_are_protected(): void
    {
        [$owner, $tenant, , $h] = $this->growthShop();
        $leads = $this->customRole($h, 'Team lead', ['staff.manage']);
        [$leadUser, $lead] = $this->memberWithRole($tenant, $leads);
        $viewer = $this->customRole($h, 'Viewer', []);

        $this->call2($lead, 'PATCH', '/api/v1/staff/'.$this->membershipOf($leadUser, $tenant)->id, ['role_id' => $viewer])
            ->assertForbidden()->assertJsonPath('error.code', 'cannot_change_own_role');
        $this->call2($h, 'PATCH', '/api/v1/staff/'.$this->membershipOf($owner, $tenant)->id, ['role_id' => $viewer])
            ->assertForbidden()->assertJsonPath('error.code', 'cannot_change_own_role');
        [, $admin] = $this->memberAs($tenant, 'admin');
        $this->call2($admin, 'PATCH', '/api/v1/staff/'.$this->membershipOf($owner, $tenant)->id, ['role_id' => $viewer])
            ->assertStatus(409)->assertJsonPath('error.code', 'last_owner');
        $this->call2($admin, 'DELETE', '/api/v1/staff/'.$this->membershipOf($owner, $tenant)->id)
            ->assertStatus(409)->assertJsonPath('error.code', 'last_owner');
        // leaving is always allowed
        $this->call2($lead, 'DELETE', '/api/v1/staff/'.$this->membershipOf($leadUser, $tenant)->id)->assertNoContent();
    }

    /** N9 / S98 (P83-8). */
    #[Group('security')]
    public function test_custom_roles_need_growth_and_stay_enforced_after_a_downgrade(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $role = $this->customRole($h, 'Viewer', ['customers.view']);
        $spare = $this->customRole($h, 'Spare', []);
        [, $viewer, $member] = $this->memberWithRole($tenant, $role);
        $this->memberAs($tenant, 'staff');
        $this->planFor($tenant, Plan::STARTER);

        $this->createRole($h, 'New', [])->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan')->assertJsonPath('error.details.upgrade_plan', ['growth']);
        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['revision' => 1, 'name' => 'V'])->assertStatus(402);
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'c@example.test', 'role_id' => $role])->assertStatus(402);
        $staffMember = $this->platformQuery(TenantUser::class)->where('tenant_id', $tenant->id)->where('role', 'staff')->firstOrFail();
        $this->call2($h, 'PATCH', "/api/v1/staff/{$staffMember->id}", ['role_id' => $role])->assertStatus(402);
        $this->call2($h, 'DELETE', "/api/v1/roles/{$spare}?revision=1&reassign_to={$role}")->assertStatus(402);

        $this->call2($h, 'GET', '/api/v1/roles')->assertOk()->assertJsonPath('meta.custom_roles_enabled', false)
            ->assertJsonPath('data.3.editable', false);
        $this->call2($h, 'GET', "/api/v1/roles/{$role}")->assertOk();

        // still assigned and enforced, never widened
        $this->call2($viewer, 'GET', "/api/v1/stores/{$store->id}/customers")->assertOk();
        $this->call2($viewer, 'GET', "/api/v1/stores/{$store->id}/orders")->assertForbidden();
        $this->call2($viewer, 'GET', '/api/v1/auth/me')->assertJsonPath('data.tenants.0.permissions', ['customers.view']);

        // members can be moved to a system role and the custom role deleted
        $this->call2($h, 'PATCH', "/api/v1/staff/{$member->id}", ['role' => 'staff'])->assertOk()->assertJsonPath('data.role', 'staff');
        $this->call2($h, 'DELETE', "/api/v1/roles/{$spare}?revision=1&reassign_to=".$this->systemRoleId($tenant, 'staff'))->assertNoContent();
        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=1")->assertNoContent();
    }

    /** S95 / S99: rows of a system role and unknown keys in the database grant nothing. */
    #[Group('security')]
    public function test_injected_permission_rows_are_ignored(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $staff = $this->systemRoleId($tenant, 'staff');
        $role = $this->customRole($h, 'Viewer', ['orders.view']);
        $this->platformTable('role_permissions')->insert([
            ['tenant_id' => $tenant->id, 'role_id' => $staff, 'permission' => 'costs.view', 'created_at' => now()],
            ['tenant_id' => $tenant->id, 'role_id' => $role, 'permission' => 'orders.delete', 'created_at' => now()],
        ]);
        [, $s] = $this->memberAs($tenant, 'staff');
        [, $v] = $this->memberWithRole($tenant, $role);

        $this->call2($s, 'GET', "/api/v1/stores/{$store->id}/reports/profit")->assertForbidden();
        $this->call2($h, 'GET', "/api/v1/roles/{$staff}")->assertJsonMissingPath('data.permissions.11'); // 11 staff keys (PHASE-8-8D: + pos.sell; PHASE-8-8E: + inbox.manage)
        $this->call2($v, 'GET', '/api/v1/auth/me')->assertJsonPath('data.tenants.0.permissions', ['orders.view']);
    }

    /** S97: a change applies on the member's next request, without a cache flush. */
    #[Group('security')]
    public function test_removing_a_key_applies_on_the_next_request(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $role = $this->customRole($h, 'Viewer', ['customers.view', 'orders.view']);
        [, $v] = $this->memberWithRole($tenant, $role);
        $this->call2($v, 'GET', "/api/v1/stores/{$store->id}/customers")->assertOk(); // warms the permission cache

        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['revision' => 1, 'permissions' => ['orders.view']])->assertOk();
        $this->call2($v, 'GET', "/api/v1/stores/{$store->id}/customers")->assertForbidden();
        $this->call2($v, 'GET', "/api/v1/stores/{$store->id}/orders")->assertOk();
    }

    /** S96 / §10 isolation. */
    #[Group('security')]
    #[Group('tenancy')]
    public function test_roles_are_isolated_by_tenant(): void
    {
        [, $tenantA, , $hA] = $this->growthShop('alpha');
        [, $tenantB, , $hB] = $this->growthShop('bravo');
        $roleB = $this->customRole($hB, 'Packer', ['shipments.manage']);
        $staffB = $this->systemRoleId($tenantB, 'staff');
        $this->memberAs($tenantA, 'staff');
        $memberA = $this->platformQuery(TenantUser::class)->where('tenant_id', $tenantA->id)->where('role', 'staff')->firstOrFail();
        $roleA = $this->customRole($hA, 'Packer', ['shipments.manage']); // same name in another tenant is fine

        $this->assertTenantIsolation($hA, [
            ['GET', "/api/v1/roles/{$roleB}"],
            ['PATCH', "/api/v1/roles/{$roleB}", ['revision' => 1, 'name' => 'Pwned']],
            ['DELETE', "/api/v1/roles/{$roleB}?revision=1"],
        ]);
        $this->assertNotContains($roleB, $this->call2($hA, 'GET', '/api/v1/roles')->json('data.*.id'));
        $this->call2($hA, 'POST', '/api/v1/staff/invitations', ['email' => 'x@example.test', 'role_id' => $roleB])->assertStatus(422);
        $this->call2($hA, 'PATCH', "/api/v1/staff/{$memberA->id}", ['role_id' => $staffB])->assertStatus(422);
        $this->call2($hA, 'DELETE', "/api/v1/roles/{$roleA}?revision=1&reassign_to={$roleB}")->assertStatus(422);
        $this->assertSame('Packer', $this->roleRow($tenantB, $roleB)?->name);
    }

    /** SEC-L3: DELETE takes the caller's `revision` like PATCH (missing → 422, stale → 409 revision_conflict). */
    public function test_delete_needs_the_current_revision(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        $this->call2($h, 'PATCH', "/api/v1/roles/{$role}", ['revision' => 1, 'name' => 'Packers'])->assertOk();

        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}")->assertStatus(422)->assertJsonValidationErrors('revision', 'error.details');
        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=1")->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->assertNotNull($this->roleRow($tenant, $role));
        $this->call2($h, 'DELETE', "/api/v1/roles/{$role}?revision=2")->assertNoContent();
    }

    /** SEC-L3: N2 is re-checked on the locked row, so a role widened after the pre-check can't be deleted. */
    #[Group('security')]
    public function test_delete_rechecks_n2_on_the_locked_role(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $leads = $this->customRole($h, 'Leads', ['staff.manage', 'orders.view']);
        $role = $this->customRole($h, 'Viewer', ['orders.view']);
        $model = $this->roleRow($tenant, $role);

        // Between the controller's unlocked N2 check and the lock, someone widens the role to costs.view.
        $this->inTenant($tenant, function () use ($tenant, $role) {
            DB::table('role_permissions')->insert(['tenant_id' => $tenant->id, 'role_id' => $role, 'permission' => 'costs.view', 'created_at' => now()]);
            Role::query()->whereKey($role)->update(['revision' => 2]);
        });

        $denied = $this->inTenant($tenant, function () use ($tenant, $leads, $model) {
            app(TenantContext::class)->set($tenant, 'custom', PermissionSet::fromKeys(['staff.manage', 'orders.view']), $leads);
            try {
                app(RoleService::class)->delete($model, null, 2);
            } catch (ApiException $e) {
                return [$e->getStatusCode(), $e->errorCode, $e->details];
            }

            return null;
        });
        $this->assertSame([403, 'permission_not_held', ['permissions' => ['costs.view']]], $denied);
        $this->assertNotNull($this->roleRow($tenant, $role));
    }

    /** SEC-L5: a member or invitation whose role row can't be read fails N6 closed: only the owner may act. */
    #[Group('security')]
    public function test_n6_fails_closed_when_the_role_row_is_missing(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Ghost', ['orders.view']);
        [, , $member] = $this->memberWithRole($tenant, $role);
        $invitation = $this->invite($h, 'ghost@example.test', $role);
        [, $manager] = $this->memberAs($tenant, 'admin');

        Role::addGlobalScope('sec-l5-hidden', fn ($q) => $q->whereKeyNot($role));
        try {
            $this->call2($manager, 'PATCH', "/api/v1/staff/{$member->id}", ['role' => 'staff'])->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
            $this->call2($manager, 'DELETE', "/api/v1/staff/{$member->id}")->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
            $this->call2($manager, 'POST', "/api/v1/staff/invitations/{$invitation}/resend")->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
            $this->call2($manager, 'DELETE', "/api/v1/staff/invitations/{$invitation}")->assertForbidden()->assertJsonPath('error.code', 'permission_not_held');
            $this->assertNotNull($this->platformQuery(TenantUser::class)->find($member->id));

            // The owner holds every permission, so it can still clean up.
            $this->call2($h, 'DELETE', "/api/v1/staff/invitations/{$invitation}")->assertNoContent();
            $this->call2($h, 'DELETE', "/api/v1/staff/{$member->id}")->assertNoContent();
        } finally {
            $scopes = (fn () => static::$globalScopes)->call(new Role);
            unset($scopes[Role::class]['sec-l5-hidden']);
            (fn () => static::$globalScopes = $scopes)->call(new Role);
        }
    }

    /** ARCH follow-up: the audit log can be filtered to role rows (`subject_type=role`). */
    public function test_audit_log_filters_by_role_subject(): void
    {
        [, , , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        $this->call2($h, 'GET', '/api/v1/audit-logs?filter[subject_type]=role')->assertOk()
            ->assertJsonPath('data.0.action', 'role.created')->assertJsonPath('data.0.subject', ['type' => 'role', 'id' => $role])
            ->assertJsonCount(1, 'data');
    }
}

<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Billing\Models\Plan;
use App\Domain\Staff\Mail\StaffInvitationMail;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RoleFixtures;
use Tests\TestCase;

/** PHASE-8-3 §10 StaffRolesTest: invitations and members with role_id (§6.2), role kind always in sync (P83-3). */
#[Group('roles')]
class StaffRolesTest extends TestCase
{
    use RefreshDatabase, RoleFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    private function tokenFor(string $email): string
    {
        $token = null;
        Mail::assertQueued(StaffInvitationMail::class, function (StaffInvitationMail $mail) use ($email, &$token) {
            if ($mail->hasTo($email)) {
                $token = $mail->token;
            }

            return true;
        });

        return (string) $token;
    }

    public function test_invite_with_role_id_or_legacy_role_but_not_both(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);

        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'a@example.test', 'role_id' => $role])->assertCreated()
            ->assertJsonPath('data.role', 'custom')->assertJsonPath('data.role_id', $role)->assertJsonPath('data.role_name', 'Packer');
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'b@example.test', 'role' => 'admin'])->assertCreated()
            ->assertJsonPath('data.role', 'admin')->assertJsonPath('data.role_id', $this->systemRoleId($tenant, 'admin'))->assertJsonPath('data.role_name', 'Manager');
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'c@example.test', 'role' => 'staff', 'role_id' => $role])->assertStatus(422);
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'c@example.test'])->assertStatus(422);
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'c@example.test', 'role' => 'owner'])->assertStatus(422);

        $log = $this->platformQuery(AuditLog::class)->where('action', 'staff.invited')->orderBy('id')->firstOrFail();
        $this->assertSame(['role' => 'custom', 'role_id' => $role, 'role_name' => 'Packer'], $log->meta);
        Mail::assertQueued(StaffInvitationMail::class, fn (StaffInvitationMail $m) => $m->hasTo('a@example.test') && $m->roleName === 'Packer');

        $list = collect($this->call2($h, 'GET', '/api/v1/staff')->assertOk()->json('data'))->keyBy('email');
        $this->assertSame(['owner', 'Owner'], [$list->first()['role'], $list->first()['role_name']]);
        $this->assertSame(['custom', $role, 'Packer'], [$list['a@example.test']['role'], $list['a@example.test']['role_id'], $list['a@example.test']['role_name']]);
    }

    public function test_accepting_gives_the_invitations_role_and_seats_are_unchanged(): void
    {
        [$owner, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'new@example.test', 'role_id' => $role, 'name' => 'Rafi'])->assertCreated();
        $seats = $this->call2($h, 'GET', '/api/v1/staff')->json('meta.seats_used');
        $token = $this->tokenFor('new@example.test');

        $this->flushHeaders()->getJson("/api/v1/invitations/{$token}")->assertOk()
            ->assertJsonPath('data.role', 'custom')->assertJsonPath('data.role_name', 'Packer');
        $this->flushHeaders()->postJson("/api/v1/invitations/{$token}/accept", [
            'name' => 'Rafi', 'password' => 'secret12', 'password_confirmation' => 'secret12',
        ])->assertCreated();

        $m = $this->platformQuery(TenantUser::class)->where('tenant_id', $tenant->id)->where('role_id', $role)->sole();
        $this->assertSame('custom', $m->role);
        $this->assertSame($seats, $this->call2($h, 'GET', '/api/v1/staff')->json('meta.seats_used'));
        // owner lookups (notifications, seat counter) still find exactly the owner
        $this->assertSame([$owner->id], $this->platformQuery(TenantUser::class)->where('tenant_id', $tenant->id)->where('role', 'owner')->pluck('user_id')->all());
    }

    public function test_member_role_changes_keep_role_and_role_id_in_sync(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        [$user] = $this->memberAs($tenant, 'staff');
        $m = $this->membershipOf($user, $tenant);
        $this->assertSame($this->systemRoleId($tenant, 'staff'), $m->role_id);

        $this->call2($h, 'PATCH', "/api/v1/staff/{$m->id}", ['role_id' => $role])->assertOk()
            ->assertJsonPath('data.role', 'custom')->assertJsonPath('data.role_id', $role)->assertJsonPath('data.role_name', 'Packer');
        $this->assertSame(['custom', $role], [$this->membershipOf($user, $tenant)->role, $this->membershipOf($user, $tenant)->role_id]);

        $this->call2($h, 'PATCH', "/api/v1/staff/{$m->id}", ['role' => 'admin'])->assertOk()->assertJsonPath('data.role', 'admin');
        $this->assertSame($this->systemRoleId($tenant, 'admin'), $this->membershipOf($user, $tenant)->role_id);
        $log = $this->platformQuery(AuditLog::class)->where('action', 'staff.role_changed')->orderByDesc('id')->firstOrFail();
        $this->assertSame(['role' => ['from' => 'Packer', 'to' => 'Manager']], $log->meta['changes']);

        // no-op: no audit row
        $count = $this->platformQuery(AuditLog::class)->where('action', 'staff.role_changed')->count();
        $this->call2($h, 'PATCH', "/api/v1/staff/{$m->id}", ['role_id' => $this->systemRoleId($tenant, 'admin')])->assertOk();
        $this->assertSame($count, $this->platformQuery(AuditLog::class)->where('action', 'staff.role_changed')->count());

        // legacy writes of the kind keep role_id in step
        $this->inTenant($tenant, fn () => TenantUser::query()->whereKey($m->id)->first()->update(['role' => 'staff']));
        $this->assertSame($this->systemRoleId($tenant, 'staff'), $this->membershipOf($user, $tenant)->role_id);
        $inv = $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'z@example.test', 'role_id' => $role])->json('data.id');
        $this->assertSame('custom', $this->platformQuery(StaffInvitation::class)->find($inv)->role);
    }

    public function test_registration_creates_the_three_system_roles(): void
    {
        $this->postJson('/api/v1/auth/register', [
            'name' => 'Nadia Rahman', 'email' => 'nadia@example.test', 'phone' => '01712340000',
            'password' => 'secret-pass-12', 'password_confirmation' => 'secret-pass-12',
        ])->assertCreated();

        $tenant = $this->platformTable('tenant_users')->where('role', 'owner')->sole();
        $roles = $this->platformTable('roles')->where('tenant_id', $tenant->tenant_id)->orderBy('key')->get();
        $this->assertSame(['admin', 'owner', 'staff'], $roles->pluck('key')->all());
        $this->assertSame(['Manager', 'Owner', 'Staff'], $roles->pluck('name')->all());
        $this->assertSame($roles->firstWhere('key', 'owner')->id, $tenant->role_id);
    }

    /** SEC-L4 (N9 on accept): after a downgrade an open custom-role invitation can't be accepted → 402. */
    public function test_accepting_a_custom_role_invitation_needs_the_feature(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'late@example.test', 'role_id' => $role])->assertCreated();
        $this->call2($h, 'POST', '/api/v1/staff/invitations', ['email' => 'sys@example.test', 'role' => 'staff'])->assertCreated();
        $this->planFor($tenant, Plan::STARTER);

        $body = ['name' => 'Late', 'password' => 'secret12', 'password_confirmation' => 'secret12'];
        $this->flushHeaders()->postJson('/api/v1/invitations/'.$this->tokenFor('late@example.test').'/accept', $body)
            ->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan')->assertJsonPath('error.details.upgrade_plan', ['growth']);
        $this->assertFalse($this->platformQuery(TenantUser::class)->where('tenant_id', $tenant->id)->where('role_id', $role)->exists());
        $this->assertNull($this->platformQuery(StaffInvitation::class)->where('email', 'late@example.test')->value('accepted_at'));

        // System-role invitations still work on any plan.
        $this->flushHeaders()->postJson('/api/v1/invitations/'.$this->tokenFor('sys@example.test').'/accept', $body)->assertCreated();
    }
}

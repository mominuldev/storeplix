<?php

namespace Tests\Feature\Staff;

use App\Domain\Identity\Models\User;
use App\Domain\Staff\Mail\StaffInvitationMail;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

class StaffTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    private function member(Tenant $tenant, string $role): array
    {
        return $this->merchant($role, $tenant);
    }

    private function membership(User $user, Tenant $tenant): TenantUser
    {
        return TenantUser::query()->where('tenant_id', $tenant->id)->where('user_id', $user->id)->sole();
    }

    /** Invite and return the plaintext token from the queued mail. */
    private function invite(User $by, Tenant $tenant, string $email, string $role = 'staff'): string
    {
        $this->flushHeaders()->withHeaders($this->tenantHeaders($by, $tenant))
            ->postJson('/api/v1/staff/invitations', ['email' => $email, 'role' => $role, 'name' => 'Rafi'])
            ->assertCreated();

        $token = null;
        Mail::assertQueued(StaffInvitationMail::class, function (StaffInvitationMail $mail) use ($email, &$token) {
            if ($mail->hasTo($email)) {
                $token = $mail->token;
            }

            return true;
        });

        return $token;
    }

    public function test_owner_lists_members_and_invites(): void
    {
        [$owner, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'shop');

        $response = $this->withHeaders($this->tenantHeaders($owner, $tenant))
            ->postJson('/api/v1/staff/invitations', ['email' => 'Rafi@Example.com', 'name' => 'Rafi', 'role' => 'admin'])
            ->assertCreated()
            ->assertJsonPath('data.kind', 'invitation')
            ->assertJsonPath('data.email', 'rafi@example.com')
            ->assertJsonPath('data.status', 'invited')
            ->assertJsonPath('data.invited_by.id', $owner->id);

        Mail::assertQueued(StaffInvitationMail::class, fn ($m) => $m->hasTo('rafi@example.com')
            && str_starts_with($m->url(), 'http://localhost:5173/invite?token=') && $m->shopName === 'Shop Store');

        $this->getJson('/api/v1/staff')
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.kind', 'member')
            ->assertJsonPath('data.0.role', 'owner')
            ->assertJsonPath('data.0.is_you', true)
            ->assertJsonPath('data.1.id', $response->json('data.id'))
            ->assertJsonPath('meta.seats_used', 1)
            ->assertJsonPath('meta.seats_limit', 5);

        $this->assertTrue(AuditLog::query()->where('action', 'staff.invited')->where('tenant_id', $tenant->id)->exists());
        $this->assertStringNotContainsString('token', json_encode(AuditLog::query()->pluck('meta')));
    }

    #[Group('tenancy')]
    public function test_staff_cannot_invite_or_list_or_manage(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$staff] = $this->member($tenant, 'staff');
        $headers = $this->tenantHeaders($staff, $tenant);

        $this->withHeaders($headers)->postJson('/api/v1/staff/invitations', ['email' => 'x@example.com', 'role' => 'staff'])
            ->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->withHeaders($headers)->getJson('/api/v1/staff')->assertForbidden();
        $this->withHeaders($headers)->patchJson('/api/v1/staff/'.$this->membership($owner, $tenant)->id, ['role' => 'staff'])->assertForbidden();
        Mail::assertNothingQueued();
    }

    #[Group('tenancy')]
    public function test_admin_cannot_remove_or_demote_the_owner(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$admin] = $this->member($tenant, 'admin');
        $ownerMember = $this->membership($owner, $tenant);
        $headers = $this->tenantHeaders($admin, $tenant);

        $this->withHeaders($headers)->deleteJson("/api/v1/staff/{$ownerMember->id}")
            ->assertStatus(409)->assertJsonPath('error.code', 'last_owner');
        $this->withHeaders($headers)->patchJson("/api/v1/staff/{$ownerMember->id}", ['role' => 'staff'])
            ->assertStatus(409)->assertJsonPath('error.code', 'last_owner');

        $this->assertSame('owner', $ownerMember->refresh()->role);
    }

    #[Group('tenancy')]
    public function test_owner_cannot_leave_and_nobody_changes_their_own_role(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$admin] = $this->member($tenant, 'admin');

        $this->withHeaders($this->tenantHeaders($owner, $tenant))
            ->deleteJson('/api/v1/staff/'.$this->membership($owner, $tenant)->id)
            ->assertStatus(409)->assertJsonPath('error.code', 'last_owner');

        $this->flushHeaders()->withHeaders($this->tenantHeaders($admin, $tenant))
            ->patchJson('/api/v1/staff/'.$this->membership($admin, $tenant)->id, ['role' => 'staff'])
            ->assertForbidden()->assertJsonPath('error.code', 'cannot_change_own_role');

        // "owner" is never assignable.
        [$staff] = $this->member($tenant, 'staff');
        $this->withHeaders($this->tenantHeaders($owner, $tenant))
            ->patchJson('/api/v1/staff/'.$this->membership($staff, $tenant)->id, ['role' => 'owner'])
            ->assertStatus(422);
    }

    #[Group('tenancy')]
    public function test_admin_manages_staff_and_staff_can_leave(): void
    {
        [, $tenant] = $this->merchant();
        [$admin] = $this->member($tenant, 'admin');
        [$staffA] = $this->member($tenant, 'staff');
        [$staffB] = $this->member($tenant, 'staff');

        $this->withHeaders($this->tenantHeaders($admin, $tenant))
            ->patchJson('/api/v1/staff/'.$this->membership($staffA, $tenant)->id, ['role' => 'admin'])
            ->assertOk()->assertJsonPath('data.role', 'admin');

        $log = AuditLog::query()->where('action', 'staff.role_changed')->sole();
        $this->assertSame(['role' => ['from' => 'staff', 'to' => 'admin']], $log->meta['changes']);

        $this->flushHeaders()->withHeaders($this->tenantHeaders($staffB, $tenant))
            ->deleteJson('/api/v1/staff/'.$this->membership($staffB, $tenant)->id)
            ->assertNoContent();
        $this->assertTrue(AuditLog::query()->where('action', 'staff.left')->exists());

        $this->flushHeaders()->withHeaders($this->tenantHeaders($admin, $tenant))
            ->deleteJson('/api/v1/staff/'.$this->membership($staffA, $tenant)->id)
            ->assertNoContent();
        $this->assertTrue(AuditLog::query()->where('action', 'staff.removed')->exists());
    }

    #[Group('tenancy')]
    public function test_another_tenant_cannot_see_or_touch_your_staff(): void
    {
        [$ownerA, $tenantA] = $this->merchant();
        [$staffA] = $this->member($tenantA, 'staff');
        [$ownerB, $tenantB] = $this->merchant();
        $this->invite($ownerA, $tenantA, 'pending@example.com');
        $invitationA = StaffInvitation::withoutTenancy()->where('tenant_id', $tenantA->id)->sole();
        $memberA = $this->membership($staffA, $tenantA);

        $headersB = $this->tenantHeaders($ownerB, $tenantB);
        $this->flushHeaders()->withHeaders($headersB)->getJson('/api/v1/staff')
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.user_id', $ownerB->id)
            ->assertJsonPath('meta.seats_used', 0);

        $this->withHeaders($headersB)->patchJson("/api/v1/staff/{$memberA->id}", ['role' => 'admin'])->assertNotFound();
        $this->withHeaders($headersB)->deleteJson("/api/v1/staff/{$memberA->id}")->assertNotFound();
        $this->withHeaders($headersB)->deleteJson("/api/v1/staff/invitations/{$invitationA->id}")->assertNotFound();
        $this->withHeaders($headersB)->postJson("/api/v1/staff/invitations/{$invitationA->id}/resend")->assertNotFound();

        // Spoofing A's tenant id.
        $this->flushHeaders()->withHeaders($this->tenantHeaders($ownerB, $tenantA))->getJson('/api/v1/staff')
            ->assertForbidden()->assertJsonPath('error.code', 'tenant_forbidden');

        $this->assertSame('staff', $memberA->refresh()->role);
        $this->assertNull($invitationA->refresh()->revoked_at);
    }

    public function test_duplicate_member_and_pending_invitation_conflicts(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$staff] = $this->member($tenant, 'staff');
        $headers = $this->tenantHeaders($owner, $tenant);

        $this->withHeaders($headers)->postJson('/api/v1/staff/invitations', ['email' => $staff->email, 'role' => 'staff'])
            ->assertStatus(409)->assertJsonPath('error.code', 'already_member');

        $this->withHeaders($headers)->postJson('/api/v1/staff/invitations', ['email' => 'a@example.com', 'role' => 'staff'])->assertCreated();
        $this->withHeaders($headers)->postJson('/api/v1/staff/invitations', ['email' => 'a@example.com', 'role' => 'admin'])
            ->assertStatus(409)->assertJsonPath('error.code', 'invitation_pending');

        // An expired invitation no longer blocks a new one.
        $this->travel(8)->days();
        $this->flushHeaders()->withHeaders($this->tenantHeaders($owner, $tenant))
            ->postJson('/api/v1/staff/invitations', ['email' => 'a@example.com', 'role' => 'admin'])->assertCreated();
    }

    public function test_seat_limit_returns_402(): void
    {
        [$owner, $tenant] = $this->merchant(); // trial = Starter, 5 seats
        foreach (range(1, 3) as $i) {
            $this->member($tenant, 'staff');
        }
        $headers = $this->tenantHeaders($owner, $tenant);

        $this->withHeaders($headers)->postJson('/api/v1/staff/invitations', ['email' => 'four@example.com', 'role' => 'staff'])->assertCreated();
        $this->withHeaders($headers)->postJson('/api/v1/staff/invitations', ['email' => 'five@example.com', 'role' => 'staff'])->assertCreated();
        $this->withHeaders($headers)->postJson('/api/v1/staff/invitations', ['email' => 'six@example.com', 'role' => 'staff'])
            ->assertStatus(402)
            ->assertJsonPath('error.code', 'plan_limit_reached')
            ->assertJsonPath('error.details.staff_seats.0', 'Your plan allows 5 staff seats.');
    }

    public function test_new_user_accepts_invitation(): void
    {
        [$owner, $tenant] = $this->merchant();
        $this->storeFor($tenant, 'shop');
        $token = $this->invite($owner, $tenant, 'new@example.com', 'admin');

        $this->flushHeaders()->getJson("/api/v1/invitations/{$token}")
            ->assertOk()
            ->assertJsonPath('data.email', 'new@example.com')
            ->assertJsonPath('data.role', 'admin')
            ->assertJsonPath('data.store_name', 'Shop Store')
            ->assertJsonPath('data.tenant_name', $tenant->name)
            ->assertJsonPath('data.invited_by_name', $owner->name)
            ->assertJsonPath('data.user_exists', false);

        $this->postJson("/api/v1/invitations/{$token}/accept", ['name' => 'New Person', 'password' => 'secret12', 'password_confirmation' => 'secret12'])
            ->assertCreated()
            ->assertJsonStructure(['data' => ['token', 'expires_at', 'user']])
            ->assertJsonPath('data.user.tenants.0.id', $tenant->id)
            ->assertJsonPath('data.user.tenants.0.role', 'admin');

        $user = User::query()->where('email', 'new@example.com')->sole();
        $this->assertNotNull($user->email_verified_at);
        $this->assertSame($owner->id, $this->membership($user, $tenant)->invited_by);
        $this->assertTrue(AuditLog::query()->where('action', 'staff.joined')->where('tenant_id', $tenant->id)->exists());

        // Single use.
        $this->getJson("/api/v1/invitations/{$token}")->assertNotFound()->assertJsonPath('error.code', 'invitation_invalid');
    }

    #[Group('tenancy')]
    public function test_existing_user_must_sign_in_with_matching_email(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$existing] = $this->merchant(); // owner of another tenant
        [$stranger] = $this->merchant();
        $token = $this->invite($owner, $tenant, $existing->email);

        $this->flushHeaders()->getJson("/api/v1/invitations/{$token}")->assertJsonPath('data.user_exists', true);

        $this->postJson("/api/v1/invitations/{$token}/accept", ['name' => 'X', 'password' => 'secret12', 'password_confirmation' => 'secret12'])
            ->assertStatus(409)->assertJsonPath('error.code', 'login_required');

        $this->withToken($stranger->createToken('t')->plainTextToken)->postJson("/api/v1/invitations/{$token}/accept")
            ->assertForbidden()->assertJsonPath('error.code', 'invitation_email_mismatch');
        $this->app['auth']->forgetGuards();

        $this->withToken($existing->createToken('t')->plainTextToken)->postJson("/api/v1/invitations/{$token}/accept")
            ->assertOk()
            ->assertExactJson(['data' => ['id' => $tenant->id, 'name' => $tenant->name, 'role' => 'staff']]);

        $this->assertSame('staff', $this->membership($existing, $tenant)->role);
        $this->assertSame(2, $existing->tenants()->count());
    }

    public function test_expired_revoked_and_resent_tokens(): void
    {
        [$owner, $tenant] = $this->merchant();
        $token = $this->invite($owner, $tenant, 'late@example.com');
        $invitation = StaffInvitation::withoutTenancy()->sole();

        $this->travel(8)->days();
        $headers = $this->tenantHeaders($owner, $tenant); // (Sanctum tokens expire after 7 days)
        $this->flushHeaders()->getJson("/api/v1/invitations/{$token}")->assertNotFound();

        Mail::fake();
        $this->withHeaders($headers)->postJson("/api/v1/staff/invitations/{$invitation->id}/resend")
            ->assertOk()->assertJsonPath('data.status', 'invited');
        $this->withHeaders($headers)->postJson("/api/v1/staff/invitations/{$invitation->id}/resend")
            ->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');

        $newToken = null;
        Mail::assertQueued(StaffInvitationMail::class, function ($m) use (&$newToken) {
            $newToken = $m->token;

            return true;
        });
        $this->flushHeaders()->getJson("/api/v1/invitations/{$token}")->assertNotFound(); // old token dead
        $this->getJson("/api/v1/invitations/{$newToken}")->assertOk();

        $this->withHeaders($headers)->deleteJson("/api/v1/staff/invitations/{$invitation->id}")->assertNoContent();
        $this->withHeaders($headers)->deleteJson("/api/v1/staff/invitations/{$invitation->id}")
            ->assertStatus(409)->assertJsonPath('error.code', 'invitation_not_pending');
        $this->flushHeaders()->getJson("/api/v1/invitations/{$newToken}")->assertNotFound();
    }
}

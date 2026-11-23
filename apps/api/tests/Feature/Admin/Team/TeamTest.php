<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Team;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
use App\Domain\Admin\Team\Mail\PlatformInvitationMail;
use App\Domain\Admin\Team\Models\PlatformInvitation;
use App\Domain\Admin\Team\TeamManager;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\PlatformStaffFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** PHASE-8-1 P8-16, §6.1 invitations, §6.5 team rows, §4.4 `platform:*` commands; S79. */
#[Group('admin')]
#[Group('security')]
class TeamTest extends TestCase
{
    use PlatformStaffFixtures, RefreshDatabase, SpaBrowser {
        SpaBrowser::browser as spaBrowser;
    }

    private User $sa;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        config(['admin.email_domains' => [], 'admin.ip_allowlist' => []]);
        $this->sa = $this->staffUser(PlatformRole::SuperAdmin, ['name' => 'Asha Admin']);
    }

    /**
     * The database session handler fills `sessions.user_id` from the `auth.driver` singleton, which outlives the
     * per-request guard reset in TestCase::call(); forget it so each simulated request records its own user.
     *
     * @param  array<string, string>  $headers
     */
    protected function browser(string $method, string $uri, array $data = [], array $headers = [], bool $csrf = true): TestResponse
    {
        $this->app->forgetInstance('auth.driver');

        return $this->spaBrowser($method, $uri, $data, $headers, $csrf);
    }

    /** @param array<string, mixed> $data */
    private function admin(string $method, string $uri, array $data = [], ?User $as = null): TestResponse
    {
        $this->app->forgetInstance('auth.driver');
        $this->unencryptedCookies = []; // never reuse the SPA browser's cookie jar on the fast path

        // Sec-Fetch-Site: same-origin satisfies the strict CSRF check once a test switched to the SPA browser.
        return $this->asAdminSurface()->withHeaders($this->adminHeaders($as ?? $this->sa) + ['Sec-Fetch-Site' => 'same-origin'])->json($method, $uri, $data);
    }

    private function invite(string $email = 'new@storeplix.com', string $role = 'support'): string
    {
        $this->admin('POST', '/api/v1/admin/team/invitations', ['email' => $email, 'role' => $role])->assertCreated();
        $token = null;
        Mail::assertQueued(PlatformInvitationMail::class, function (PlatformInvitationMail $mail) use (&$token, $email) {
            if ($mail->hasTo($email)) {
                $token = $mail->token;
            }

            return true;
        });

        return (string) $token;
    }

    public function test_list_shows_staff_and_open_invitations_with_counts_matrix_and_security(): void
    {
        $this->staffUser(PlatformRole::Billing, ['name' => 'Bilal Billing']);
        $this->staffUser(PlatformRole::Support, ['name' => 'Disabled Dan', 'platform_disabled_at' => now()]);
        $this->staffUser(PlatformRole::ReadOnly, ['name' => 'Locked Lina', 'platform_locked_until' => now()->addMinutes(5)]);
        User::factory()->create(); // not staff
        $this->invite('invitee@storeplix.com', 'read_only');

        $ro = $this->staffUser(PlatformRole::ReadOnly);
        $list = $this->admin('GET', '/api/v1/admin/team', as: $ro)->assertOk()
            ->assertJsonPath('meta.counts', ['all' => 6, 'active' => 4, 'invited' => 1, 'disabled' => 1])
            ->assertJsonPath('meta.matrix.roles', ['super_admin', 'billing', 'support', 'read_only'])
            ->assertJsonPath('meta.matrix.grants.billing', ['view_merchants', 'manage_billing'])
            ->assertJsonPath('meta.security', ['totp_required' => true, 'ip_allowlist_enabled' => false, 'session_idle_minutes' => 30, 'impersonation_minutes' => 15])
            ->assertJsonCount(6, 'data');
        $rows = collect($list->json('data'))->keyBy('email');
        $this->assertSame('invitation', $rows['invitee@storeplix.com']['kind']);
        $this->assertSame('invited', $rows['invitee@storeplix.com']['status']);
        $this->assertNotNull($rows['invitee@storeplix.com']['expires_at']);
        $this->assertSame(['disabled', 'locked'], collect($list->json('data'))->whereIn('name', ['Disabled Dan', 'Locked Lina'])->pluck('status')->sort()->values()->all());
        $this->assertArrayNotHasKey('totp_secret', $list->json('data.0'));

        $this->admin('GET', '/api/v1/admin/team?filter[status]=invited')->assertOk()->assertJsonCount(1, 'data');
        $this->admin('GET', '/api/v1/admin/team?filter[status]=disabled')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.name', 'Disabled Dan');
        $this->admin('GET', '/api/v1/admin/team?filter[role]=billing')->assertOk()->assertJsonCount(1, 'data');
        $this->admin('GET', '/api/v1/admin/team?filter[q]=BILAL')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.role', 'billing');
        $this->admin('GET', '/api/v1/admin/team?filter[status]=gone')->assertStatus(422);
    }

    public function test_invite_validates_domain_duplicates_and_existing_staff(): void
    {
        $this->invite('new@storeplix.com');
        Mail::assertQueued(PlatformInvitationMail::class, fn (PlatformInvitationMail $m) => str_starts_with($m->url(), 'http://localhost:5174/accept-invite#token='));
        $row = PlatformInvitation::query()->sole();
        $this->assertSame(64, strlen($row->token_hash));
        $this->assertTrue($row->expires_at->between(now()->addDays(7)->subMinute(), now()->addDays(7)->addMinute()));
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'admin.staff_invited')->sole();
        $this->assertSame('platform_user', $audit->actor_type);
        $this->assertNull($audit->tenant_id);

        $this->admin('POST', '/api/v1/admin/team/invitations', ['email' => 'NEW@storeplix.com', 'role' => 'billing'])
            ->assertStatus(422)->assertJsonPath('error.details.email.0', 'This person already has an open invitation.');
        $this->admin('POST', '/api/v1/admin/team/invitations', ['email' => $this->sa->email, 'role' => 'billing'])->assertStatus(422);
        $this->admin('POST', '/api/v1/admin/team/invitations', ['email' => 'x@storeplix.com', 'role' => 'engineering'])->assertStatus(422);

        config(['admin.email_domains' => ['storeplix.com']]);
        $this->admin('POST', '/api/v1/admin/team/invitations', ['email' => 'someone@gmail.com', 'role' => 'billing'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');

        // An expired invitation no longer blocks a new one.
        $this->travel(8)->days();
        $this->invite('new@storeplix.com', 'billing');
    }

    public function test_new_user_accepts_then_must_enrol_totp(): void
    {
        $token = $this->invite('fresh@storeplix.com', 'billing');
        $this->useSpaBrowser();
        $this->spaOrigin = self::ADMIN_ORIGIN;
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();

        $this->browser('GET', '/api/v1/admin/invitations/'.$token)->assertOk()
            ->assertJsonPath('data', ['email' => 'fresh@storeplix.com', 'role' => 'billing', 'existing_user' => false]);
        $this->browser('GET', '/api/v1/admin/invitations/not-a-token')->assertNotFound()->assertJsonPath('error.code', 'not_found');

        $this->browser('POST', "/api/v1/admin/invitations/{$token}/accept", ['password' => 'Passw0rd!x', 'password_confirmation' => 'Passw0rd!x'])
            ->assertStatus(422)->assertJsonPath('error.details.name.0', fn ($m) => is_string($m));
        $step = $this->browser('POST', "/api/v1/admin/invitations/{$token}/accept", ['name' => 'Fresh Face', 'password' => 'Passw0rd!x', 'password_confirmation' => 'Passw0rd!x'])
            ->assertOk()->assertJsonPath('data.step', 'enroll');
        $this->browser('GET', '/api/v1/admin/auth/me')->assertUnauthorized(); // no session until enrolment

        $user = User::query()->where('email', 'fresh@storeplix.com')->sole();
        $this->assertSame('billing', $user->platform_role);
        $this->assertSame($this->sa->id, $user->platform_invited_by);
        $this->assertNotNull(PlatformInvitation::query()->sole()->accepted_at);

        $loginToken = (string) $step->json('data.login_token');
        $secret = (string) $this->browser('GET', '/api/v1/admin/auth/enroll?login_token='.urlencode($loginToken))->assertOk()->json('data.secret');
        $this->browser('POST', '/api/v1/admin/auth/enroll', ['login_token' => $loginToken, 'code' => $this->totpCode($secret)])
            ->assertOk()->assertJsonPath('data.user.platform_role', 'billing');
        $this->browser('GET', '/api/v1/admin/auth/me')->assertOk();

        // Single use.
        $this->browser('GET', '/api/v1/admin/invitations/'.$token)->assertNotFound();
        $this->browser('POST', "/api/v1/admin/invitations/{$token}/accept", ['name' => 'Again', 'password' => 'Passw0rd!x', 'password_confirmation' => 'Passw0rd!x'])->assertNotFound();
    }

    public function test_existing_user_confirms_their_password_and_keeps_their_shop(): void
    {
        $merchant = User::factory()->create(['email' => 'owner@storeplix.com']);
        [, $tenant] = $this->merchant(tenant: Tenant::factory()->create());
        $this->platformTable('tenant_users')->where('tenant_id', $tenant->id)->update(['user_id' => $merchant->id]);
        $token = $this->invite('owner@storeplix.com', 'support');

        $this->useSpaBrowser();
        $this->spaOrigin = self::ADMIN_ORIGIN;
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();
        $this->browser('GET', '/api/v1/admin/invitations/'.$token)->assertOk()->assertJsonPath('data.existing_user', true);
        $this->browser('POST', "/api/v1/admin/invitations/{$token}/accept", ['password' => 'wrong-password'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->browser('POST', "/api/v1/admin/invitations/{$token}/accept", ['password' => 'password'])
            ->assertOk()->assertJsonPath('data.step', 'enroll');

        $merchant->refresh();
        $this->assertSame('support', $merchant->platform_role);
        // Password unchanged and the shop membership untouched: merchant sign-in still works.
        $this->spaOrigin = 'http://localhost:5173';
        $this->spaLogin($merchant);
        $this->browser('GET', '/api/v1/stores', headers: ['X-Tenant-Id' => $tenant->id])->assertOk();
    }

    public function test_revoked_or_expired_invitations_cannot_be_used(): void
    {
        $token = $this->invite('gone@storeplix.com');
        $id = PlatformInvitation::query()->value('id');
        $this->admin('DELETE', "/api/v1/admin/team/invitations/{$id}")->assertNoContent();
        $this->admin('DELETE', "/api/v1/admin/team/invitations/{$id}")->assertNotFound();
        $this->getJson('/api/v1/admin/invitations/'.$token)->assertNotFound();
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'admin.staff_invitation_revoked')->count());

        $token = $this->invite('late@storeplix.com');
        $this->travel(7)->days();
        $this->travel(2)->minutes();
        $this->getJson('/api/v1/admin/invitations/'.$token)->assertNotFound();
    }

    public function test_role_change_needs_a_reason_and_respects_self_and_last_super_admin_rules(): void
    {
        $target = $this->staffUser(PlatformRole::Support);
        $this->admin('PATCH', "/api/v1/admin/team/members/{$target->id}", ['role' => 'billing'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->admin('PATCH', "/api/v1/admin/team/members/{$target->id}", ['role' => 'billing', 'reason' => 'abc'])->assertStatus(422);
        $this->admin('PATCH', "/api/v1/admin/team/members/{$target->id}", ['role' => 'billing', 'reason' => 'Moves to finance'])
            ->assertOk()->assertJsonPath('data.role', 'billing')->assertJsonPath('data.kind', 'user');
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'admin.staff_role_changed')->sole();
        $this->assertSame(['from' => 'support', 'to' => 'billing', 'reason' => 'Moves to finance', 'platform_role' => 'super_admin'], $audit->meta);
        $this->assertSame($target->id, $audit->subject_id);

        // Self: demote, disable, reset 2FA → 409 staff_self_action.
        $this->admin('PATCH', "/api/v1/admin/team/members/{$this->sa->id}", ['role' => 'billing', 'reason' => 'Stepping down'])
            ->assertStatus(409)->assertJsonPath('error.code', 'staff_self_action');
        $this->admin('POST', "/api/v1/admin/team/members/{$this->sa->id}/disable", ['reason' => 'Leaving now'])->assertStatus(409)->assertJsonPath('error.code', 'staff_self_action');
        $this->admin('POST', "/api/v1/admin/team/members/{$this->sa->id}/reset-2fa", ['reason' => 'Lost phone'])->assertStatus(409)->assertJsonPath('error.code', 'staff_self_action');

        // A second SA can be demoted while another active SA remains.
        $other = $this->staffUser(PlatformRole::SuperAdmin);
        $this->admin('PATCH', "/api/v1/admin/team/members/{$other->id}", ['role' => 'read_only', 'reason' => 'Least privilege'])->assertOk();

        // The last active SA can never be demoted or disabled (break-glass callers included).
        $team = app(TeamManager::class);
        foreach ([fn () => $team->changeRole(null, $this->sa, PlatformRole::Billing, 'Demote last'), fn () => $team->disable(null, $this->sa, 'Disable last')] as $call) {
            try {
                $call();
                $this->fail('Expected last_super_admin');
            } catch (ApiException $e) {
                $this->assertSame(409, $e->getStatusCode());
                $this->assertSame('last_super_admin', $e->errorCode);
            }
        }
        $this->assertSame('super_admin', $this->sa->refresh()->platform_role);
        $this->assertNull($this->sa->platform_disabled_at);

        // Unknown or non-staff users → 404.
        $this->admin('PATCH', '/api/v1/admin/team/members/'.User::factory()->create()->id, ['role' => 'billing', 'reason' => 'Not staff'])->assertNotFound();
        $this->admin('PATCH', '/api/v1/admin/team/members/01J00000000000000000000000', ['role' => 'billing', 'reason' => 'Unknown id'])->assertNotFound();
    }

    public function test_non_super_admins_cannot_manage_the_team(): void
    {
        $billing = $this->staffUser(PlatformRole::Billing);
        $target = $this->staffUser(PlatformRole::Support);
        $this->admin('GET', '/api/v1/admin/team', as: $billing)->assertOk();
        $this->admin('PATCH', "/api/v1/admin/team/members/{$target->id}", ['role' => 'billing', 'reason' => 'Self escalation'], $billing)
            ->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->admin('POST', '/api/v1/admin/team/invitations', ['email' => 'pal@storeplix.com', 'role' => 'super_admin'], $billing)->assertForbidden();
        $this->assertSame('support', $target->refresh()->platform_role);
    }

    public function test_disable_kills_only_admin_sessions_and_ends_impersonations_then_enable_restores(): void
    {
        $this->useSpaBrowser();
        $target = $this->staffUser(PlatformRole::Support);
        [, $tenant] = $this->merchant();

        $this->spaOrigin = self::ADMIN_ORIGIN;
        $this->adminSignIn($target);
        $adminJar = $this->jar;
        $this->jar = [];
        $this->spaOrigin = 'http://localhost:5173';
        $this->spaLogin($target);
        $merchantJar = $this->jar;
        $this->assertSame(2, DB::table('sessions')->where('user_id', $target->id)->count());

        $active = PlatformImpersonation::query()->create([
            'staff_user_id' => $target->id, 'target_tenant_id' => $tenant->id, 'reason' => 'Checking an order', 'ticket_hash' => str_repeat('a', 64),
            'status' => PlatformImpersonation::ACTIVE, 'ticket_expires_at' => now(), 'started_at' => now(), 'expires_at' => now()->addMinutes(15),
        ]);

        $this->freshSession();
        $this->admin('POST', "/api/v1/admin/team/members/{$target->id}/disable", ['reason' => 'Left the company'])
            ->assertOk()->assertJsonPath('data.status', 'disabled');
        $this->assertSame(1, DB::table('sessions')->where('user_id', $target->id)->count());
        $this->assertSame(PlatformImpersonation::ENDED, $active->refresh()->status);
        $this->assertSame('revoked', $active->ended_by);
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'admin.staff_disabled')->sole();
        $this->assertSame(1, $audit->meta['sessions_ended']);
        $this->assertSame(1, $audit->meta['impersonations_ended']);

        $this->jar = $adminJar;
        $this->spaOrigin = self::ADMIN_ORIGIN;
        $this->browser('GET', '/api/v1/admin/auth/me')->assertUnauthorized();
        $this->jar = $merchantJar;
        $this->spaOrigin = 'http://localhost:5173';
        $this->browser('GET', '/api/v1/auth/me')->assertOk();

        // Disabled → can't sign in (same 422).
        $this->jar = [];
        $this->spaOrigin = self::ADMIN_ORIGIN;
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $target->email, 'password' => 'password'])->assertStatus(422);

        $this->freshSession();
        $this->admin('POST', "/api/v1/admin/team/members/{$target->id}/enable", ['reason' => 'Came back'])
            ->assertOk()->assertJsonPath('data.status', 'active');
        $this->travel(31)->seconds();
        $this->adminSignIn($target);
    }

    public function test_reset_2fa_forces_enrolment_on_next_sign_in(): void
    {
        $target = $this->staffUser(PlatformRole::Support);
        DB::table('platform_recovery_codes')->insert(['id' => strtolower((string) Str::ulid()), 'user_id' => $target->id, 'code_hash' => str_repeat('b', 64), 'created_at' => now()]);
        $this->admin('POST', "/api/v1/admin/team/members/{$target->id}/reset-2fa", ['reason' => 'Lost their phone'])
            ->assertOk()->assertJsonPath('data.totp_enrolled', false);
        $target->refresh();
        $this->assertNull($target->totp_secret);
        $this->assertSame(0, DB::table('platform_recovery_codes')->where('user_id', $target->id)->count());

        $this->useSpaBrowser();
        $this->spaOrigin = self::ADMIN_ORIGIN;
        $this->freshSession();
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $target->email, 'password' => 'password'])->assertOk()->assertJsonPath('data.step', 'enroll');
    }

    public function test_platform_commands_grant_revoke_and_reset_with_system_audit(): void
    {
        $user = User::factory()->create(['email' => 'ops@storeplix.com']);

        $this->artisan('platform:grant', ['email' => 'ops@storeplix.com', 'role' => 'support'])->assertFailed(); // reason required
        $this->artisan('platform:grant', ['email' => 'nobody@storeplix.com', 'role' => 'support', '--reason' => 'First staff'])->assertFailed();
        $this->artisan('platform:grant', ['email' => 'ops@storeplix.com', 'role' => 'wizard', '--reason' => 'First staff'])->assertFailed();
        $this->artisan('platform:grant', ['email' => 'OPS@storeplix.com', 'role' => 'support', '--reason' => 'First staff'])->assertSuccessful();
        $this->assertSame('support', $user->refresh()->platform_role);
        $granted = $this->platformQuery(AuditLog::class)->where('action', 'admin.staff_granted')->sole();
        $this->assertSame('system', $granted->actor_type);
        $this->assertNull($granted->actor_id);
        $this->assertSame('First staff', $granted->meta['reason']);

        $user->forceFill(['totp_secret' => self::STAFF_SECRET, 'totp_confirmed_at' => now()])->save();
        $this->artisan('platform:reset-2fa', ['email' => 'ops@storeplix.com', '--reason' => 'Lost phone'])->assertSuccessful();
        $this->assertNull($user->refresh()->totp_confirmed_at);
        $this->assertSame('system', $this->platformQuery(AuditLog::class)->where('action', 'admin.staff_2fa_reset')->sole()->actor_type);

        $this->artisan('platform:revoke', ['email' => 'ops@storeplix.com', '--reason' => 'Contract ended'])->assertSuccessful();
        $this->assertNull($user->refresh()->platform_role);
        $this->assertSame('system', $this->platformQuery(AuditLog::class)->where('action', 'admin.staff_revoked')->sole()->actor_type);
        $this->artisan('platform:reset-2fa', ['email' => 'ops@storeplix.com', '--reason' => 'Not staff'])->assertFailed();

        $this->app['env'] = 'production';
        $this->artisan('platform:grant', ['email' => 'ops@storeplix.com', 'role' => 'support', '--reason' => 'Prod grant'])->assertFailed();
        $this->artisan('platform:grant', ['email' => 'ops@storeplix.com', 'role' => 'support', '--reason' => 'Prod grant', '--force' => true])->assertSuccessful();
        $this->app['env'] = 'testing';
    }
}

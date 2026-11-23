<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Auth;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\PlatformStaffFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** PHASE-8-1 §3.1, P8-4, P8-5, P8-19; S69, S70, S82. */
#[Group('admin')]
#[Group('security')]
class AdminLoginTest extends TestCase
{
    use PlatformStaffFixtures, RefreshDatabase, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->useSpaBrowser();
        $this->spaOrigin = self::ADMIN_ORIGIN;
        config(['admin.email_domains' => [], 'admin.ip_allowlist' => []]);
    }

    private function passwordStep(User $user, string $password = 'password'): string
    {
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();

        return (string) $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => $password])
            ->assertOk()->json('data.login_token');
    }

    public function test_password_then_totp_creates_an_admin_session(): void
    {
        $user = $this->staffUser(PlatformRole::Billing);
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();
        $step = $this->browser('POST', '/api/v1/admin/auth/login', ['email' => strtoupper($user->email), 'password' => 'password'])
            ->assertOk()->assertJsonPath('data.step', 'totp')->assertJsonStructure(['data' => ['step', 'login_token', 'expires_at']]);

        // No session before the TOTP step (S69).
        $this->browser('GET', '/api/v1/admin/auth/me')->assertUnauthorized();

        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $step->json('data.login_token'), 'code' => $this->totpCode()])
            ->assertOk()
            ->assertJsonPath('data.user.id', $user->id)
            ->assertJsonPath('data.user.platform_role', 'billing')
            ->assertJsonPath('data.user.permissions', ['view_merchants', 'manage_billing'])
            ->assertJsonPath('data.user.totp_enrolled', true)
            ->assertJsonStructure(['data' => ['user' => ['id', 'name', 'email', 'platform_role', 'permissions', 'totp_enrolled', 'recovery_codes_left'], 'session_expires_at', 'idle_expires_at']]);

        $me = $this->browser('GET', '/api/v1/admin/auth/me')->assertOk()->assertJsonPath('data.user.id', $user->id);
        $this->assertEqualsWithDelta(now()->addHours(12)->getTimestamp(), strtotime((string) $me->json('data.session_expires_at')), 5);
        $this->assertEqualsWithDelta(now()->addMinutes(30)->getTimestamp(), strtotime((string) $me->json('data.idle_expires_at')), 5);

        $login = $this->platformQuery(AuditLog::class)->where('action', 'admin.login')->sole();
        $this->assertSame('platform_user', $login->actor_type);
        $this->assertSame($user->id, $login->actor_id);
        $this->assertNull($login->tenant_id);
        $this->assertSame('billing', $login->meta['platform_role']);
        $this->assertSame('totp', $login->meta['method']);

        // The token is single use.
        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $step->json('data.login_token'), 'code' => $this->totpCode()])
            ->assertNotFound()->assertJsonPath('error.code', 'not_found');

        $this->browser('POST', '/api/v1/admin/auth/logout')->assertNoContent();
        $this->browser('GET', '/api/v1/admin/auth/me')->assertUnauthorized();
    }

    public function test_enrolment_shows_the_secret_once_and_returns_ten_recovery_codes(): void
    {
        $user = $this->staffUser(PlatformRole::Support, ['totp_secret' => null, 'totp_confirmed_at' => null]);
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();
        $token = $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => 'password'])
            ->assertOk()->assertJsonPath('data.step', 'enroll')->json('data.login_token');

        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'code' => '123456'])->assertNotFound();

        $enrolment = $this->browser('GET', '/api/v1/admin/auth/enroll?login_token='.urlencode($token))->assertOk();
        $secret = (string) $enrolment->json('data.secret');
        $this->assertStringStartsWith('otpauth://totp/', (string) $enrolment->json('data.otpauth_uri'));
        $this->assertStringContainsString('secret='.$secret, (string) $enrolment->json('data.otpauth_uri'));
        $this->assertStringContainsString('<svg', (string) $enrolment->json('data.qr_svg'));
        $this->browser('GET', '/api/v1/admin/auth/enroll?login_token='.urlencode($token))->assertNotFound();

        $this->browser('POST', '/api/v1/admin/auth/enroll', ['login_token' => $token, 'code' => $this->totpCode($secret) === '000000' ? '111111' : '000000'])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_totp')->assertJsonPath('error.details.attempts_left', 4);

        $done = $this->browser('POST', '/api/v1/admin/auth/enroll', ['login_token' => $token, 'code' => $this->totpCode($secret)])
            ->assertOk()->assertJsonPath('data.user.totp_enrolled', true)->assertJsonPath('data.user.recovery_codes_left', 10)
            ->assertJsonCount(10, 'meta.recovery_codes');
        $this->assertSame(10, count(array_unique((array) $done->json('meta.recovery_codes'))));
        $this->browser('GET', '/api/v1/admin/auth/me')->assertOk();

        $user->refresh();
        $this->assertSame($secret, $user->totp_secret);
        $this->assertNotSame($secret, DB::table('users')->where('id', $user->id)->value('totp_secret')); // encrypted at rest
        $this->assertSame(0, DB::table('platform_recovery_codes')->whereIn('code_hash', (array) $done->json('meta.recovery_codes'))->count()); // hashed
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'admin.totp_enrolled')->count());
    }

    public function test_recovery_codes_are_single_use(): void
    {
        $user = $this->staffUser(PlatformRole::SuperAdmin, ['totp_secret' => null, 'totp_confirmed_at' => null]);
        $token = $this->passwordStep($user);
        $secret = (string) $this->browser('GET', '/api/v1/admin/auth/enroll?login_token='.urlencode($token))->json('data.secret');
        $codes = (array) $this->browser('POST', '/api/v1/admin/auth/enroll', ['login_token' => $token, 'code' => $this->totpCode($secret)])->json('meta.recovery_codes');
        $this->browser('POST', '/api/v1/admin/auth/logout')->assertNoContent();

        $token = $this->passwordStep($user);
        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'recovery_code' => strtoupper((string) $codes[0])])
            ->assertOk()->assertJsonPath('data.user.recovery_codes_left', 9);
        $this->assertSame('recovery_code', $this->platformQuery(AuditLog::class)->where('action', 'admin.login')->latest('id')->first()?->meta['method']);
        $this->browser('POST', '/api/v1/admin/auth/logout')->assertNoContent();

        $token = $this->passwordStep($user);
        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'recovery_code' => (string) $codes[0]])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_totp')->assertJsonPath('error.details.attempts_left', 4);
    }

    public function test_a_used_code_cannot_be_replayed(): void
    {
        $user = $this->staffUser();
        $this->startOfTotpStep();
        $code = $this->totpCode();

        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $this->passwordStep($user), 'code' => $code])->assertOk();
        $this->browser('POST', '/api/v1/admin/auth/logout')->assertNoContent();

        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $this->passwordStep($user), 'code' => $code])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_totp');
        $this->browser('GET', '/api/v1/admin/auth/me')->assertUnauthorized();

        $this->travel(30)->seconds();
        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $this->passwordStep($user), 'code' => $this->totpCode()])->assertOk();
    }

    public function test_five_wrong_codes_lock_the_account_for_fifteen_minutes(): void
    {
        $user = $this->staffUser();
        $token = $this->passwordStep($user);
        $wrong = $this->totpCode() === '000000' ? '111111' : '000000';

        foreach ([4, 3, 2, 1, 0] as $left) {
            $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'code' => $wrong])
                ->assertStatus(422)->assertJsonPath('error.code', 'invalid_totp')->assertJsonPath('error.details.attempts_left', $left);
        }
        // A sixth try with the same token within the minute is throttled (admin-login: 5/min per token + IP)…
        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'code' => $this->totpCode()])->assertStatus(429);
        // …and after that the token is gone.
        $this->travel(61)->seconds();
        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'code' => $this->totpCode()])->assertNotFound();
        $this->assertTrue($user->refresh()->platform_locked_until?->isFuture());
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'admin.locked')->where('actor_type', 'platform_user')->count());

        // Locked → the same 422 as a wrong password, even with the right password.
        $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => 'password'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');

        $this->travel(16)->minutes();
        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $this->passwordStep($user), 'code' => $this->totpCode()])->assertOk();
    }

    /** S70: wrong password, non-staff, disabled, locked, outside ADMIN_EMAIL_DOMAINS, unknown email → identical 422. */
    public function test_every_credential_failure_answers_the_same_body(): void
    {
        config(['admin.email_domains' => ['storeplix.com']]);
        $ok = $this->staffUser(PlatformRole::Support, ['email' => 'ok@storeplix.com']);
        $merchant = User::factory()->create(['email' => 'merchant@storeplix.com']);
        $disabled = $this->staffUser(PlatformRole::Support, ['email' => 'off@storeplix.com', 'platform_disabled_at' => now()]);
        $locked = $this->staffUser(PlatformRole::Support, ['email' => 'locked@storeplix.com', 'platform_locked_until' => now()->addMinutes(5)]);
        $outside = $this->staffUser(PlatformRole::SuperAdmin, ['email' => 'staff@gmail.com']);
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();

        $bodies = [];
        foreach ([[$ok->email, 'wrong-password'], [$merchant->email, 'password'], [$disabled->email, 'password'],
            [$locked->email, 'password'], [$outside->email, 'password'], ['nobody@storeplix.com', 'password']] as [$email, $password]) {
            $bodies[] = $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $email, 'password' => $password])
                ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')
                ->assertJsonPath('error.details.email.0', 'These credentials do not match our records.')->json();
        }
        $this->assertCount(1, array_unique(array_map('json_encode', $bodies)));

        $failed = $this->platformQuery(AuditLog::class)->where('action', 'admin.login_failed')->get();
        $this->assertCount(6, $failed);
        foreach ($failed as $row) {
            $this->assertSame(['email_hash', 'ip'], array_keys($row->meta)); // never the raw email
            $this->assertSame('system', $row->actor_type);
            $this->assertNull($row->tenant_id);
        }
        $this->assertSame(hash('sha256', 'nobody@storeplix.com'), $failed->last()->meta['email_hash']);

        $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $ok->email, 'password' => 'password'])->assertOk();
    }

    public function test_the_login_token_is_bound_to_the_client_ip(): void
    {
        $user = $this->staffUser();
        $token = $this->passwordStep($user);
        $this->withServerVariables(['REMOTE_ADDR' => '10.9.8.7'])
            ->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'code' => $this->totpCode()])->assertNotFound();
        $this->withServerVariables(['REMOTE_ADDR' => '127.0.0.1'])
            ->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'code' => $this->totpCode()])->assertOk();
    }

    public function test_the_login_token_expires_after_five_minutes(): void
    {
        $user = $this->staffUser();
        $token = $this->passwordStep($user);
        $this->travel(301)->seconds();
        $this->browser('POST', '/api/v1/admin/auth/totp', ['login_token' => $token, 'code' => $this->totpCode()])->assertNotFound();
    }

    public function test_idle_timeout_is_thirty_minutes(): void
    {
        $this->adminSignIn($this->staffUser());
        $this->travel(29)->minutes();
        $this->browser('GET', '/api/v1/admin/auth/me')->assertOk(); // refreshes the idle timer
        $this->travel(29)->minutes();
        $this->browser('GET', '/api/v1/admin/auth/me')->assertOk();
        $this->travel(31)->minutes();
        $this->browser('GET', '/api/v1/admin/auth/me')->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
    }

    public function test_absolute_lifetime_is_twelve_hours_however_active(): void
    {
        $this->adminSignIn($this->staffUser());
        for ($i = 0; $i < 28; $i++) { // 28 × 25 min = 11 h 40 min
            $this->travel(25)->minutes();
            $this->browser('GET', '/api/v1/admin/auth/me')->assertOk();
        }
        $this->travel(25)->minutes();
        $this->browser('GET', '/api/v1/admin/auth/me')->assertUnauthorized();
    }

    public function test_ip_allowlist_blocks_admin_routes_and_audits_once_per_hour(): void
    {
        config(['admin.ip_allowlist' => ['10.0.0.0/8']]);
        $user = $this->staffUser();
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();
        $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => 'password'])
            ->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => 'password'])->assertForbidden();
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'admin.ip_blocked')->count());

        $this->withServerVariables(['REMOTE_ADDR' => '10.1.2.3'])
            ->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => 'password'])->assertOk();
    }

    /** S82: CSRF on every admin POST incl. the pre-auth steps. */
    public function test_admin_login_without_csrf_token_is_419(): void
    {
        $user = $this->staffUser();
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();
        $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => 'password'], csrf: false)
            ->assertStatus(419)->assertJsonPath('error.code', 'csrf_token_mismatch');
    }

    public function test_sign_in_is_stateful_only(): void
    {
        $user = $this->staffUser();
        $this->flushHeaders()->withHeaders(['Origin' => 'https://script.test'])
            ->postJson('/api/v1/admin/auth/login', ['email' => $user->email, 'password' => 'password'])
            ->assertStatus(400)->assertJsonPath('error.code', 'stateful_required');
    }

    /** P8-1: account changes refuse the admin surface (no rotation into a 7-day merchant session). */
    public function test_account_writes_refuse_the_admin_surface(): void
    {
        $this->adminSignIn($this->staffUser());
        $this->browser('PATCH', '/api/v1/auth/me', ['name' => 'Renamed Staff'])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->browser('PUT', '/api/v1/auth/password', ['current_password' => 'password', 'password' => 'N3w-passw0rd!x', 'password_confirmation' => 'N3w-passw0rd!x'])
            ->assertForbidden();
        $this->browser('GET', '/api/v1/auth/me')->assertOk(); // /auth/me accepts every surface
    }

    private function startOfTotpStep(): void
    {
        // Start at the beginning of a 30 s step so the replay check can't straddle a step boundary.
        $this->travelTo(now()->setTimestamp(intdiv(now()->getTimestamp(), 30) * 30 + 1));
    }
}

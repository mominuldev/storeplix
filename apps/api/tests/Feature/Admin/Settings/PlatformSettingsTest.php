<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Settings;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Settings\Models\PlatformSetting;
use App\Domain\Admin\Settings\PlatformSettings;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\PlatformStaffFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/**
 * PHASE-8-1 amendment A1 §2: switchable staff two-step sign-in. Environment default (local off, testing on, env
 * override), stored value wins, password-only sign-in (`step: signed_in`) with session + audit, required path
 * unchanged, `GET|PATCH /admin/settings/security` (authz, current password, audit + risk flag) and the cache bust.
 */
#[Group('admin')]
#[Group('admin-settings')]
#[Group('security')]
class PlatformSettingsTest extends TestCase
{
    use PlatformStaffFixtures, RefreshDatabase, SpaBrowser;

    private const URI = '/api/v1/admin/settings/security';

    protected function setUp(): void
    {
        parent::setUp();
        config(['admin.email_domains' => [], 'admin.ip_allowlist' => []]);
    }

    private function settings(): PlatformSettings
    {
        return app(PlatformSettings::class);
    }

    /** Evaluates config/admin.php with the given env values (null = unset) and returns `two_factor_required_default`. */
    private function configDefault(?string $appEnv, ?string $flag): bool
    {
        $keys = ['APP_ENV' => $appEnv, 'ADMIN_TWO_FACTOR_REQUIRED' => $flag];
        $backup = [];
        foreach ($keys as $key => $value) {
            $backup[$key] = [$_SERVER[$key] ?? null, $_ENV[$key] ?? null, getenv($key)];
            unset($_SERVER[$key], $_ENV[$key]);
            putenv($key);
            if ($value !== null) {
                $_SERVER[$key] = $_ENV[$key] = $value;
                putenv("{$key}={$value}");
            }
        }
        try {
            return (require config_path('admin.php'))['two_factor_required_default'];
        } finally {
            foreach ($backup as $key => [$server, $env, $put]) {
                unset($_SERVER[$key], $_ENV[$key]);
                putenv($key);
                if ($server !== null) {
                    $_SERVER[$key] = $server;
                }
                if ($env !== null) {
                    $_ENV[$key] = $env;
                }
                if ($put !== false) {
                    putenv("{$key}={$put}");
                }
            }
        }
    }

    private function adminGet(User $user, string $uri = self::URI): TestResponse
    {
        return $this->asAdminSurface()->flushHeaders()->withHeaders($this->adminHeaders($user))->getJson($uri);
    }

    /** @param array<string, mixed> $body */
    private function adminPatch(User $user, array $body): TestResponse
    {
        return $this->asAdminSurface()->flushHeaders()->withHeaders($this->adminHeaders($user))->patchJson(self::URI, $body);
    }

    public function test_environment_default_is_off_only_on_local_and_the_env_var_overrides_it(): void
    {
        $this->assertFalse($this->configDefault('local', null));
        $this->assertFalse($this->configDefault('local', ''));
        $this->assertTrue($this->configDefault('testing', null));
        $this->assertTrue($this->configDefault('staging', null));
        $this->assertTrue($this->configDefault('production', null));
        $this->assertTrue($this->configDefault('local', 'true'));
        $this->assertFalse($this->configDefault('production', 'false'));
        $this->assertTrue($this->configDefault('local', 'not-a-bool')); // unreadable → fail safe

        // The suite itself runs as APP_ENV=testing: required, nothing stored.
        $this->assertTrue(config('admin.two_factor_required_default'));
        $this->assertTrue($this->settings()->staffTwoFactorRequired());
        $this->assertSame('default', $this->settings()->security()['source']);
    }

    public function test_a_stored_value_wins_over_the_environment_default(): void
    {
        $this->settings()->set(PlatformSettings::STAFF_TWO_FACTOR_REQUIRED, false, null);
        $this->assertFalse($this->settings()->staffTwoFactorRequired());

        config(['admin.two_factor_required_default' => false]);
        $this->settings()->set(PlatformSettings::STAFF_TWO_FACTOR_REQUIRED, true, null);
        $this->assertTrue($this->settings()->staffTwoFactorRequired());
        $this->assertSame('setting', $this->settings()->security()['source']);
        $this->assertFalse($this->settings()->security()['environment_default']);
    }

    public function test_password_alone_signs_in_while_the_setting_is_off(): void
    {
        $this->useSpaBrowser();
        $this->spaOrigin = self::ADMIN_ORIGIN;
        config(['admin.two_factor_required_default' => false]); // like APP_ENV=local with nothing stored
        $enrolled = $this->staffUser(PlatformRole::Billing);
        $notEnrolled = $this->staffUser(PlatformRole::Support, ['totp_secret' => null, 'totp_confirmed_at' => null]);

        foreach ([$enrolled, $notEnrolled] as $user) {
            $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();
            $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $user->email, 'password' => 'password'])
                ->assertOk()
                ->assertJsonPath('data.step', 'signed_in')
                ->assertJsonMissingPath('data.login_token')
                ->assertJsonPath('data.user.id', $user->id)
                ->assertJsonPath('data.environment', 'testing')
                ->assertJsonPath('data.security.staff_two_factor_required', false)
                ->assertJsonStructure(['data' => ['step', 'user' => ['id', 'name', 'email', 'platform_role', 'permissions', 'totp_enrolled', 'recovery_codes_left'],
                    'session_expires_at', 'idle_expires_at', 'environment', 'security' => ['staff_two_factor_required']]]);

            $this->browser('GET', '/api/v1/admin/auth/me')->assertOk()->assertJsonPath('data.user.id', $user->id)
                ->assertJsonPath('data.security.staff_two_factor_required', false);

            $login = $this->platformQuery(AuditLog::class)->where('action', 'admin.login')->where('actor_id', $user->id)->sole();
            $this->assertSame('password', $login->meta['method']);
            $this->assertSame('platform_user', $login->actor_type);
            $this->assertNull($login->tenant_id);

            $this->browser('POST', '/api/v1/admin/auth/logout')->assertNoContent();
        }

        // Every other rule is unchanged: a wrong password, a merchant or a locked account still get the same 422.
        $merchant = User::factory()->create();
        $locked = $this->staffUser(PlatformRole::SuperAdmin, ['platform_locked_until' => now()->addMinutes(5)]);
        foreach ([[$enrolled->email, 'wrong-password'], [$merchant->email, 'password'], [$locked->email, 'password']] as [$email, $password]) {
            $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $email, 'password' => $password])
                ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        }
        $this->browser('GET', '/api/v1/admin/auth/me')->assertUnauthorized();
    }

    public function test_the_required_path_is_unchanged_when_the_setting_is_on(): void
    {
        $this->useSpaBrowser();
        $this->spaOrigin = self::ADMIN_ORIGIN;
        config(['admin.two_factor_required_default' => false]);
        $this->settings()->set(PlatformSettings::STAFF_TWO_FACTOR_REQUIRED, true, null); // stored on beats the default
        $user = $this->staffUser();

        $this->adminSignIn($user)->assertJsonPath('data.security.staff_two_factor_required', true)->assertJsonMissingPath('data.step');
        $this->browser('POST', '/api/v1/admin/auth/logout')->assertNoContent();

        $this->browser('POST', '/api/v1/admin/auth/login', ['email' => $this->staffUser(PlatformRole::Support, ['totp_secret' => null, 'totp_confirmed_at' => null])->email, 'password' => 'password'])
            ->assertOk()->assertJsonPath('data.step', 'enroll');
        $this->assertSame('totp', $this->platformQuery(AuditLog::class)->where('action', 'admin.login')->sole()->meta['method']);
    }

    public function test_me_reports_environment_and_security(): void
    {
        $user = $this->staffUser(PlatformRole::ReadOnly);
        $this->adminGet($user, '/api/v1/admin/auth/me')->assertOk()
            ->assertJsonPath('data.environment', 'testing')
            ->assertJsonPath('data.security', ['staff_two_factor_required' => true]);
    }

    public function test_super_admin_reads_and_changes_the_setting(): void
    {
        $admin = $this->staffUser(PlatformRole::SuperAdmin, ['name' => 'Rahim Admin']);

        $this->adminGet($admin)->assertOk()->assertExactJson(['data' => [
            'staff_two_factor_required' => true, 'environment_default' => true, 'source' => 'default',
            'updated_at' => null, 'updated_by' => null,
        ]]);

        $this->freezeSecond();
        $this->adminPatch($admin, ['staff_two_factor_required' => false, 'current_password' => 'password'])->assertOk()
            ->assertJsonPath('data.staff_two_factor_required', false)
            ->assertJsonPath('data.environment_default', true)
            ->assertJsonPath('data.source', 'setting')
            ->assertJsonPath('data.updated_at', now()->toIso8601ZuluString())
            ->assertJsonPath('data.updated_by', ['id' => $admin->id, 'name' => 'Rahim Admin']);

        $this->adminGet($admin)->assertOk()->assertJsonPath('data.staff_two_factor_required', false)->assertJsonPath('data.source', 'setting');
        $row = $this->platformQuery(PlatformSetting::class)->findOrFail(PlatformSettings::STAFF_TWO_FACTOR_REQUIRED);
        $this->assertFalse($row->value);
        $this->assertSame($admin->id, $row->updated_by);
        $this->assertFalse($this->settings()->staffTwoFactorRequired());
    }

    public function test_audit_row_and_the_high_risk_flag_when_turning_it_off_outside_local(): void
    {
        $admin = $this->staffUser(PlatformRole::SuperAdmin);

        $this->adminPatch($admin, ['staff_two_factor_required' => false, 'current_password' => 'password'])->assertOk();
        $off = $this->platformQuery(AuditLog::class)->where('action', 'admin.settings_updated')->sole();
        $this->assertSame('platform_user', $off->actor_type);
        $this->assertSame($admin->id, $off->actor_id);
        $this->assertNull($off->tenant_id);
        $this->assertSame(['key' => 'staff_two_factor_required', 'from' => true, 'to' => false, 'risk' => 'high', 'platform_role' => 'super_admin'], $off->meta);
        $this->assertStringNotContainsString('password', (string) json_encode($off->meta));

        $this->adminPatch($admin, ['staff_two_factor_required' => true, 'current_password' => 'password'])->assertOk();
        $on = $this->platformQuery(AuditLog::class)->where('action', 'admin.settings_updated')->latest('id')->first();
        $this->assertSame(['key' => 'staff_two_factor_required', 'from' => false, 'to' => true, 'platform_role' => 'super_admin'], $on?->meta);

        // Turning it off on a local machine is not flagged.
        $this->app['env'] = 'local';
        $this->withoutMiddleware(ValidateCsrfToken::class); // CSRF is only skipped under `testing`
        $this->adminPatch($admin, ['staff_two_factor_required' => false, 'current_password' => 'password'])->assertOk();
        $local = $this->platformQuery(AuditLog::class)->where('action', 'admin.settings_updated')->orderByDesc('created_at')->orderByDesc('id')->first();
        $this->assertArrayNotHasKey('risk', (array) $local?->meta);
        $this->assertSame(3, $this->platformQuery(AuditLog::class)->where('action', 'admin.settings_updated')->count());
    }

    public function test_wrong_current_password_is_422_and_changes_nothing(): void
    {
        $admin = $this->staffUser(PlatformRole::SuperAdmin);

        $this->adminPatch($admin, ['staff_two_factor_required' => false, 'current_password' => 'not-my-password'])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_password');
        $this->assertTrue($this->settings()->staffTwoFactorRequired());
        $this->assertSame(0, $this->platformQuery(PlatformSetting::class)->count());
        $this->assertSame(0, $this->platformQuery(AuditLog::class)->where('action', 'admin.settings_updated')->count());
    }

    public function test_validation(): void
    {
        $admin = $this->staffUser(PlatformRole::SuperAdmin);

        $this->adminPatch($admin, [])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonValidationErrors(['staff_two_factor_required', 'current_password'], 'error.details');
        $this->adminPatch($admin, ['staff_two_factor_required' => 'maybe', 'current_password' => 'password'])
            ->assertStatus(422)->assertJsonValidationErrors(['staff_two_factor_required'], 'error.details');
        $this->assertSame(0, $this->platformQuery(PlatformSetting::class)->count());
    }

    public function test_only_super_admins_may_read_or_change_it(): void
    {
        foreach ([PlatformRole::Billing, PlatformRole::Support, PlatformRole::ReadOnly] as $role) {
            $user = $this->staffUser($role);
            $this->adminGet($user)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
            $this->adminPatch($user, ['staff_two_factor_required' => false, 'current_password' => 'password'])
                ->assertForbidden()->assertJsonPath('error.code', 'forbidden');
            $this->assertNotContains('manage_settings', $this->adminGet($user, '/api/v1/admin/auth/me')->json('data.user.permissions'));
        }
        $this->assertContains('manage_settings', $this->adminGet($this->staffUser(), '/api/v1/admin/auth/me')->json('data.user.permissions'));

        // Guest → 401; a merchant-surface session (even of a super admin) never reaches the admin surface.
        $this->flushHeaders()->withHeaders(['Referer' => self::ADMIN_ORIGIN.'/'])->getJson(self::URI)->assertUnauthorized();
        foreach ([User::factory()->create(), $this->staffUser()] as $user) {
            $this->asAdminSurface(SessionSurface::MERCHANT)->flushHeaders()->withHeaders($this->adminHeaders($user))->getJson(self::URI)->assertForbidden();
            $this->asAdminSurface(SessionSurface::MERCHANT)->flushHeaders()->withHeaders($this->adminHeaders($user))
                ->patchJson(self::URI, ['staff_two_factor_required' => false, 'current_password' => 'password'])->assertForbidden();
        }
        $this->assertTrue($this->settings()->staffTwoFactorRequired());
        $this->assertSame(0, $this->platformQuery(AuditLog::class)->where('action', 'admin.settings_updated')->count());
    }

    public function test_reads_are_cached_and_writes_bust_the_cache(): void
    {
        $admin = $this->staffUser(PlatformRole::SuperAdmin);
        $this->assertTrue($this->settings()->staffTwoFactorRequired());
        $this->assertTrue(Cache::has(PlatformSettings::CACHE_KEY));

        // A row written behind the service's back is not seen until the cache is busted (proves the read is cached)…
        $this->platformQuery(PlatformSetting::class)->create(['key' => PlatformSettings::STAFF_TWO_FACTOR_REQUIRED, 'value' => false]);
        $this->assertTrue($this->settings()->staffTwoFactorRequired());
        $this->settings()->flush();
        $this->assertFalse($this->settings()->staffTwoFactorRequired());

        // …while a PATCH takes effect at once, for the next sign-in too.
        $this->adminPatch($admin, ['staff_two_factor_required' => true, 'current_password' => 'password'])->assertOk();
        $this->assertTrue($this->settings()->staffTwoFactorRequired());
        $this->adminPatch($admin, ['staff_two_factor_required' => false, 'current_password' => 'password'])->assertOk();
        $this->assertFalse($this->settings()->staffTwoFactorRequired());
        $this->adminGet($admin, '/api/v1/admin/auth/me')->assertJsonPath('data.security.staff_two_factor_required', false);
        $this->adminGet($admin, '/api/v1/admin/team')->assertOk()->assertJsonPath('meta.security.totp_required', false);
    }
}

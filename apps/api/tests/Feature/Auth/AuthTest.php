<?php

namespace Tests\Feature\Auth;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase, SpaBrowser;

    private const USER_KEYS = ['id', 'name', 'email', 'phone', 'phone_verified_at', 'password_changed_at', 'created_at', 'tenants'];

    public function test_register_creates_user_tenant_and_owner_membership(): void
    {
        $response = $this->postJson('/api/v1/auth/register', [
            'name' => 'Rahim Uddin',
            'email' => 'Rahim@Example.com',
            'password' => 'secret-pass1',
            'password_confirmation' => 'secret-pass1',
            'phone' => '01711-111111',
        ]);

        $response->assertCreated()
            ->assertJsonStructure(['data' => ['expires_at', 'user' => self::USER_KEYS]])
            ->assertJsonPath('data.user.email', 'rahim@example.com')
            ->assertJsonPath('data.user.phone', '8801711111111')
            ->assertJsonPath('data.user.tenants.0.role', 'owner')
            ->assertJsonMissingPath('data.user.password');

        $this->assertTrue(Str::isUlid($response->json('data.user.id')));
        $this->assertTrue(Str::isUlid($response->json('data.user.tenants.0.id')));
        $this->assertSame(1, TenantUser::query()->count());
    }

    public function test_register_validation_uses_error_envelope(): void
    {
        User::factory()->create(['email' => 'taken@example.com']);

        $this->postJson('/api/v1/auth/register', [
            'name' => '',
            'email' => 'taken@example.com',
            'password' => 'short',
            'password_confirmation' => 'different',
        ])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['code', 'message', 'details' => ['name', 'email', 'password']]]);
    }

    public function test_login_me_logout_flow(): void
    {
        $this->useSpaBrowser();
        [$user, $tenant] = $this->merchant();

        $this->spaLogin($user)->assertJsonStructure(['data' => ['user' => self::USER_KEYS, 'expires_at']])->assertJsonMissingPath('data.token');

        $this->browser('GET', '/api/v1/auth/me')
            ->assertOk()
            ->assertJsonPath('data.id', $user->id)
            ->assertJsonPath('data.tenants.0.id', $tenant->id)
            ->assertJsonPath('data.tenants.0.name', $tenant->name)
            ->assertJsonPath('data.tenants.0.role', 'owner');

        $this->browser('POST', '/api/v1/auth/logout')->assertNoContent();

        $this->browser('GET', '/api/v1/auth/me')
            ->assertUnauthorized()
            ->assertJsonPath('error.code', 'unauthenticated');
    }

    public function test_login_rejects_bad_credentials(): void
    {
        [$user] = $this->merchant();

        $this->postJson('/api/v1/auth/login', ['email' => $user->email, 'password' => 'wrong'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['email']]]);
    }

    public function test_me_requires_authentication(): void
    {
        $this->getJson('/api/v1/auth/me')->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
    }

    public function test_login_is_rate_limited(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/v1/auth/login', ['email' => 'x@example.com', 'password' => 'nope'])->assertStatus(422);
        }

        $this->postJson('/api/v1/auth/login', ['email' => 'x@example.com', 'password' => 'nope'])
            ->assertStatus(429)
            ->assertJsonPath('error.code', 'rate_limited')
            ->assertHeader('Retry-After')
            ->assertJsonPath('error.retry_after', fn ($v) => is_int($v) && $v > 0 && $v <= 60)
            ->assertJsonMissingPath('error.details');
    }

    public function test_login_returns_expires_at_and_session_expires_after_sanctum_expiration(): void
    {
        $this->assertSame(10080, config('sanctum.expiration'));
        $this->useSpaBrowser();
        [$user] = $this->merchant();

        $this->freezeSecond();
        $this->spaLogin($user)->assertJsonPath('data.expires_at', now()->addMinutes(10080)->toIso8601ZuluString());

        $this->travel(10079)->minutes();
        $this->browser('GET', '/api/v1/auth/me')->assertOk();

        $this->travel(2)->minutes();
        $this->browser('GET', '/api/v1/auth/me')
            ->assertUnauthorized()
            ->assertJsonPath('error.code', 'unauthenticated');
    }

    public function test_forgot_password_always_returns_202_without_enumeration(): void
    {
        [$user] = $this->merchant();

        $known = $this->postJson('/api/v1/auth/forgot-password', ['email' => $user->email])->assertStatus(202);
        $unknown = $this->postJson('/api/v1/auth/forgot-password', ['email' => 'nobody@example.com'])->assertStatus(202);

        $this->assertSame($known->json(), $unknown->json());

        $this->postJson('/api/v1/auth/forgot-password', ['email' => 'not-an-email'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_prune_expired_tokens_is_scheduled_daily(): void
    {
        $event = collect(app(Schedule::class)->events())
            ->first(fn ($e) => str_contains($e->command ?? '', 'sanctum:prune-expired --hours=24'));

        $this->assertNotNull($event);
        $this->assertSame('0 0 * * *', $event->expression);
    }
}

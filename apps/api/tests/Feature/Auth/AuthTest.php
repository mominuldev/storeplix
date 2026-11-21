<?php

namespace Tests\Feature\Auth;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    private const USER_KEYS = ['id', 'name', 'email', 'phone', 'created_at', 'tenants'];

    public function test_register_creates_user_tenant_and_owner_membership(): void
    {
        $response = $this->postJson('/api/v1/auth/register', [
            'name' => 'Rahim Uddin',
            'email' => 'Rahim@Example.com',
            'password' => 'secret-pass',
            'password_confirmation' => 'secret-pass',
            'phone' => '+8801711111111',
        ]);

        $response->assertCreated()
            ->assertJsonStructure(['data' => ['token', 'expires_at', 'user' => self::USER_KEYS]])
            ->assertJsonPath('data.user.email', 'rahim@example.com')
            ->assertJsonPath('data.user.phone', '+8801711111111')
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
        [$user, $tenant] = $this->merchant();

        $token = $this->postJson('/api/v1/auth/login', ['email' => $user->email, 'password' => 'password'])
            ->assertOk()
            ->assertJsonStructure(['data' => ['token', 'user' => self::USER_KEYS]])
            ->json('data.token');

        $this->withToken($token)->getJson('/api/v1/auth/me')
            ->assertOk()
            ->assertJsonPath('data.id', $user->id)
            ->assertJsonPath('data.tenants.0.id', $tenant->id)
            ->assertJsonPath('data.tenants.0.name', $tenant->name)
            ->assertJsonPath('data.tenants.0.role', 'owner');

        $this->withToken($token)->postJson('/api/v1/auth/logout')->assertNoContent();

        $this->assertSame(0, $user->tokens()->count());
        $this->app['auth']->forgetGuards();

        $this->withToken($token)->getJson('/api/v1/auth/me')
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
            ->assertJsonPath('error.code', 'too_many_requests');
    }

    public function test_login_returns_expires_at_and_token_expires_after_sanctum_expiration(): void
    {
        $this->assertSame(10080, config('sanctum.expiration'));
        [$user] = $this->merchant();

        $this->freezeSecond();
        $response = $this->postJson('/api/v1/auth/login', ['email' => $user->email, 'password' => 'password'])
            ->assertOk()
            ->assertJsonPath('data.expires_at', now()->addMinutes(10080)->toIso8601ZuluString());
        $token = $response->json('data.token');

        $this->travel(10079)->minutes();
        $this->withToken($token)->getJson('/api/v1/auth/me')->assertOk();
        $this->app['auth']->forgetGuards();

        $this->travel(2)->minutes();
        $this->withToken($token)->getJson('/api/v1/auth/me')
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

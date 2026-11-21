<?php

namespace Tests\Feature\Auth;

use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class AccountTest extends TestCase
{
    use RefreshDatabase;

    public function test_update_profile_normalises_phone_and_resets_verification(): void
    {
        [$user] = $this->merchant();
        $user->forceFill(['phone' => '8801711111111', 'phone_verified_at' => now()])->save();

        $this->withToken($user->createToken('t')->plainTextToken)
            ->patchJson('/api/v1/auth/me', ['name' => '  New Name ', 'phone' => '+8801812345678'])
            ->assertOk()
            ->assertJsonPath('data.name', 'New Name')
            ->assertJsonPath('data.phone', '8801812345678')
            ->assertJsonPath('data.phone_verified_at', null);

        $log = AuditLog::query()->where('action', 'account.profile_updated')->sole();
        $this->assertNull($log->tenant_id);
        $this->assertEqualsCanonicalizing(['name', 'phone'], $log->meta['changes']);
    }

    public function test_email_change_requires_current_password(): void
    {
        [$user] = $this->merchant();
        [$other] = $this->merchant();
        $token = $user->createToken('t')->plainTextToken;

        $this->withToken($token)->patchJson('/api/v1/auth/me', ['email' => 'new@example.com'])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['current_password']]]);

        $this->withToken($token)->patchJson('/api/v1/auth/me', ['email' => 'new@example.com', 'current_password' => 'wrong'])
            ->assertStatus(422)->assertJsonPath('error.details.current_password.0', 'The current password is incorrect.');

        $this->withToken($token)->patchJson('/api/v1/auth/me', ['email' => $other->email, 'current_password' => 'password'])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['email']]]);

        $this->withToken($token)->patchJson('/api/v1/auth/me', ['email' => 'New@Example.com', 'current_password' => 'password'])
            ->assertOk()->assertJsonPath('data.email', 'new@example.com');
    }

    public function test_change_password_issues_new_token_and_revokes_all_others(): void
    {
        [$user] = $this->merchant();
        $current = $user->createToken('current')->plainTextToken;
        $user->createToken('other-device');

        $this->withToken($current)->putJson('/api/v1/auth/password', [
            'current_password' => 'wrong', 'password' => 'new-pass123', 'password_confirmation' => 'new-pass123',
        ])->assertStatus(422)->assertJsonPath('error.details.current_password.0', 'The current password is incorrect.');

        $new = $this->withToken($current)->putJson('/api/v1/auth/password', [
            'current_password' => 'password', 'password' => 'new-pass123', 'password_confirmation' => 'new-pass123',
        ])->assertOk()->assertJsonStructure(['data' => ['token', 'expires_at', 'user']])->json('data.token');

        $this->assertSame(1, $user->tokens()->count());
        $this->assertTrue(Hash::check('new-pass123', $user->refresh()->password));
        $this->assertNotNull($user->password_changed_at);

        $this->app['auth']->forgetGuards();
        $this->withToken($current)->getJson('/api/v1/auth/me')->assertUnauthorized();
        $this->app['auth']->forgetGuards();
        $this->withToken($new)->getJson('/api/v1/auth/me')->assertOk();
    }
}

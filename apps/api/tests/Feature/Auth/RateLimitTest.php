<?php

namespace Tests\Feature\Auth;

use App\Domain\Identity\Support\CredentialVerifier;
use App\Domain\Staff\Models\StaffInvitation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** QA M-1 (timing) and M-3 (per-identifier limits with a looser per-IP ceiling). */
#[Group('security')]
class RateLimitTest extends TestCase
{
    use RefreshDatabase;

    private function assertLimited($response): void
    {
        $response->assertStatus(429)
            ->assertJsonPath('error.code', 'rate_limited')
            ->assertJsonPath('error.retry_after', fn ($v) => is_int($v) && $v > 0 && $v <= 60)
            ->assertHeader('Retry-After');
    }

    public function test_unknown_email_still_runs_a_password_hash_check(): void
    {
        $dummy = CredentialVerifier::dummyHash();
        $this->assertStringStartsWith('$argon2id$', $dummy);

        Hash::partialMock()->shouldReceive('check')->once()->with('guess-123', $dummy)->andReturnFalse();

        $this->postJson('/api/v1/auth/login', ['email' => 'nobody@example.com', 'password' => 'guess-123'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_known_and_unknown_email_get_identical_errors(): void
    {
        [$user] = $this->merchant();

        $known = $this->postJson('/api/v1/auth/login', ['email' => $user->email, 'password' => 'wrong-1'])->assertStatus(422)->json();
        $unknown = $this->postJson('/api/v1/auth/login', ['email' => 'nobody@example.com', 'password' => 'wrong-1'])->assertStatus(422)->json();

        $this->assertSame($known, $unknown);
    }

    public function test_login_is_5_per_email_per_ip_but_other_users_on_the_same_ip_are_not_blocked(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/v1/auth/login', ['email' => 'a@example.com', 'password' => 'x'])->assertStatus(422);
        }
        $this->assertLimited($this->postJson('/api/v1/auth/login', ['email' => 'a@example.com', 'password' => 'x']));

        // Same (carrier-NAT) IP, different people: still allowed.
        for ($i = 0; $i < 20; $i++) {
            $this->postJson('/api/v1/auth/login', ['email' => "user{$i}@example.com", 'password' => 'x'])->assertStatus(422);
        }
    }

    public function test_login_per_ip_ceiling_is_60_per_minute(): void
    {
        for ($i = 0; $i < 60; $i++) { // distinct emails: only the per-IP ceiling applies
            $this->postJson('/api/v1/auth/login', ['email' => "u{$i}@example.com", 'password' => 'x'])->assertStatus(422);
        }
        $this->assertLimited($this->postJson('/api/v1/auth/login', ['email' => 'last@example.com', 'password' => 'x']));
    }

    public function test_register_is_10_per_minute_per_ip(): void
    {
        for ($i = 0; $i < 10; $i++) {
            $this->postJson('/api/v1/auth/register', [])->assertStatus(422);
        }
        $this->assertLimited($this->postJson('/api/v1/auth/register', []));
    }

    public function test_forgot_password_is_5_per_email_and_30_per_ip(): void
    {
        Mail::fake();

        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/v1/auth/forgot-password', ['email' => 'a@example.com'])->assertStatus(202);
        }
        $this->assertLimited($this->postJson('/api/v1/auth/forgot-password', ['email' => 'a@example.com']));

        for ($i = 0; $i < 25; $i++) { // 5 + 25 = 30 per IP
            $this->postJson('/api/v1/auth/forgot-password', ['email' => "u{$i}@example.com"])->assertStatus(202);
        }
        $this->assertLimited($this->postJson('/api/v1/auth/forgot-password', ['email' => 'other@example.com']));
    }

    public function test_invitation_routes_are_10_per_token_and_separate_from_login(): void
    {
        [$owner, $tenant] = $this->merchant();
        $token = StaffInvitation::newToken();
        $this->tenancy()->run($tenant, fn () => StaffInvitation::query()->create([
            'email' => 'x@example.com', 'role' => 'staff', 'token_hash' => StaffInvitation::hashToken($token),
            'invited_by' => $owner->id, 'expires_at' => now()->addDay(), 'last_sent_at' => now(),
        ]));

        // Exhaust the login limiter for this IP+email: invitations are unaffected.
        for ($i = 0; $i < 6; $i++) {
            $this->postJson('/api/v1/auth/login', ['email' => 'a@example.com', 'password' => 'x']);
        }

        for ($i = 0; $i < 10; $i++) {
            $this->getJson("/api/v1/invitations/{$token}")->assertOk();
        }
        $this->assertLimited($this->getJson("/api/v1/invitations/{$token}"));

        // A different token from the same IP still works.
        $this->getJson('/api/v1/invitations/'.StaffInvitation::newToken())->assertNotFound();
    }
}

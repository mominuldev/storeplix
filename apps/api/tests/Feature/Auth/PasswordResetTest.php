<?php

namespace Tests\Feature\Auth;

use App\Domain\Identity\Mail\ResetPasswordMail;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

#[Group('security')]
class PasswordResetTest extends TestCase
{
    use RefreshDatabase;

    private function requestToken(User $user): string
    {
        Mail::fake();
        $this->postJson('/api/v1/auth/forgot-password', ['email' => strtoupper($user->email)])->assertStatus(202);

        $token = null;
        Mail::assertQueued(ResetPasswordMail::class, function (ResetPasswordMail $mail) use ($user, &$token) {
            $token = $mail->token;

            return $mail->hasTo($user->email)
                && str_starts_with($mail->url(), 'http://localhost:5183/reset-password?token=')
                && str_contains($mail->url(), 'email='.rawurlencode($user->email));
        });

        return $token;
    }

    private function reset(User $user, string $token, string $password = 'new-pass123')
    {
        return $this->postJson('/api/v1/auth/reset-password', [
            'email' => $user->email,
            'token' => $token,
            'password' => $password,
            'password_confirmation' => $password,
        ]);
    }

    public function test_reset_flow_revokes_tokens_and_records_audit(): void
    {
        [$user] = $this->merchant();
        $token = $this->requestToken($user);

        $this->assertNotSame($token, \DB::table('password_reset_tokens')->value('token'), 'token must be stored hashed');

        $this->reset($user, $token)->assertOk()->assertJsonPath('data.message', 'Your password has been reset.');

        $user->refresh();
        $this->assertTrue(Hash::check('new-pass123', $user->password));
        $this->assertStringStartsWith('$argon2id$', $user->password);
        $this->assertNotNull($user->password_changed_at);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'auth.password_reset')->whereNull('tenant_id')->exists());
    }

    public function test_reset_token_is_single_use(): void
    {
        [$user] = $this->merchant();
        $token = $this->requestToken($user);

        $this->reset($user, $token)->assertOk();
        $this->reset($user, $token, 'another-pass9')
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_reset_token');
    }

    public function test_reset_token_expires_after_60_minutes(): void
    {
        [$user] = $this->merchant();
        $token = $this->requestToken($user);

        $this->travel(61)->minutes();

        $this->reset($user, $token)->assertStatus(422)->assertJsonPath('error.code', 'invalid_reset_token');
        $this->assertTrue(Hash::check('password', $user->refresh()->password));
    }

    public function test_wrong_email_or_token_gets_the_same_error(): void
    {
        [$user] = $this->merchant();
        [$other] = $this->merchant();
        $token = $this->requestToken($user);

        $this->reset($other, $token)->assertStatus(422)->assertJsonPath('error.code', 'invalid_reset_token');
        $this->reset($user, 'garbage')->assertStatus(422)->assertJsonPath('error.code', 'invalid_reset_token');
    }

    public function test_a_new_request_replaces_the_previous_token(): void
    {
        [$user] = $this->merchant();
        $first = $this->requestToken($user);
        $this->travel(61)->seconds(); // past the 60 s throttle
        $second = $this->requestToken($user);

        $this->reset($user, $first)->assertStatus(422);
        $this->reset($user, $second)->assertOk();
    }

    public function test_unknown_email_and_throttled_requests_are_silent(): void
    {
        Mail::fake();
        [$user] = $this->merchant();

        $unknown = $this->postJson('/api/v1/auth/forgot-password', ['email' => 'nobody@example.com'])->assertStatus(202)->json();
        $known = $this->postJson('/api/v1/auth/forgot-password', ['email' => $user->email])->assertStatus(202)->json();
        $throttled = $this->postJson('/api/v1/auth/forgot-password', ['email' => $user->email])->assertStatus(202)->json();

        $this->assertSame($unknown, $known);
        $this->assertSame($known, $throttled);
        Mail::assertQueued(ResetPasswordMail::class, 1);
    }

    public function test_password_rule_requires_letters_and_numbers(): void
    {
        [$user] = $this->merchant();
        $token = $this->requestToken($user);

        $this->reset($user, $token, 'onlyletters')
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['password']]]);
    }
}

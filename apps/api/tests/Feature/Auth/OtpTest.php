<?php

namespace Tests\Feature\Auth;

use App\Domain\Identity\Models\User;
use App\Domain\Identity\Otp\OtpCode;
use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

#[Group('security')]
class OtpTest extends TestCase
{
    use RefreshDatabase;

    private function sms(): FakeSmsGateway
    {
        return app(SmsGateway::class);
    }

    private function userWithPhone(string $phone = '8801711111111', bool $verified = true): User
    {
        [$user] = $this->merchant();
        $user->forceFill(['phone' => $phone, 'phone_verified_at' => $verified ? now() : null])->save();

        return $user;
    }

    private function send(string $phone, string $purpose)
    {
        return $this->postJson('/api/v1/auth/otp/send', ['phone' => $phone, 'purpose' => $purpose]);
    }

    public function test_login_with_otp(): void
    {
        $user = $this->userWithPhone();

        $this->send('01711111111', 'login')
            ->assertStatus(202)
            ->assertExactJson(['data' => ['expires_in' => 300, 'resend_in' => 60]]);

        $code = $this->sms()->lastCodeFor('8801711111111');
        $this->assertNotNull($code);
        $this->assertSame("Your Store Plix code is {$code}. Valid for 5 minutes. Do not share it.", $this->sms()->sent[0]['text']);

        // Never stored in plaintext.
        $this->assertNotSame($code, OtpCode::query()->value('code_hash'));
        $this->assertSame('sent', SmsMessage::query()->value('status'));
        $this->assertStringNotContainsString($code, json_encode(SmsMessage::query()->first()->toArray()));

        $this->postJson('/api/v1/auth/login/otp', ['phone' => '+8801711111111', 'code' => $code])
            ->assertOk()
            ->assertJsonStructure(['data' => ['expires_at', 'user']])
            ->assertJsonPath('data.user.id', $user->id);

        // Single use.
        $this->postJson('/api/v1/auth/login/otp', ['phone' => '01711111111', 'code' => $code])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_otp');
    }

    public function test_unknown_phone_gets_identical_response_and_no_sms(): void
    {
        $this->userWithPhone();

        $known = $this->send('01711111111', 'reset_password')->assertStatus(202)->json();
        $unknown = $this->send('01999999999', 'reset_password')->assertStatus(202)->json();

        $this->assertSame($known, $unknown);
        $this->assertCount(1, $this->sms()->sent);

        $this->postJson('/api/v1/auth/login/otp', ['phone' => '01999999999', 'code' => '123456'])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_otp');
    }

    public function test_code_expires_after_5_minutes_and_new_send_invalidates_old(): void
    {
        $this->userWithPhone();

        $this->send('01711111111', 'login')->assertStatus(202);
        $first = $this->sms()->lastCodeFor('8801711111111');

        $this->travel(61)->seconds();
        $this->send('01711111111', 'login')->assertStatus(202);
        $second = $this->sms()->lastCodeFor('8801711111111');

        if ($first !== $second) {
            $this->postJson('/api/v1/auth/login/otp', ['phone' => '01711111111', 'code' => $first])->assertStatus(422);
        }

        $this->travel(301)->seconds();
        $this->postJson('/api/v1/auth/login/otp', ['phone' => '01711111111', 'code' => $second])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_otp');
    }

    public function test_max_5_attempts_then_code_is_dead(): void
    {
        $this->userWithPhone();
        $this->send('01711111111', 'login');
        $code = $this->sms()->lastCodeFor('8801711111111');
        $wrong = $code === '000000' ? '111111' : '000000';

        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/v1/auth/login/otp', ['phone' => '01711111111', 'code' => $wrong])->assertStatus(422);
        }

        $this->postJson('/api/v1/auth/login/otp', ['phone' => '01711111111', 'code' => $code])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_otp');
    }

    public function test_resend_cooldown_and_hourly_phone_limit_return_429_with_retry_after(): void
    {
        $this->userWithPhone();

        $this->send('01711111111', 'login')->assertStatus(202);
        $this->send('01711111111', 'login')
            ->assertStatus(429)
            ->assertJsonPath('error.code', 'otp_rate_limited')
            ->assertJsonPath('error.retry_after', fn ($v) => is_int($v) && $v > 0 && $v <= 60)
            ->assertHeader('Retry-After');

        for ($i = 0; $i < 4; $i++) {
            $this->travel(61)->seconds();
            $this->send('01711111111', 'login')->assertStatus(202);
        }

        $this->travel(61)->seconds();
        $this->send('01711111111', 'login')->assertStatus(429)->assertJsonPath('error.code', 'otp_rate_limited');
        $this->assertCount(5, $this->sms()->sent);
    }

    public function test_ip_limit_applies_to_unknown_phones_too(): void
    {
        for ($i = 0; $i < 20; $i++) {
            $this->send(sprintf('0171%07d', $i), 'login')->assertStatus(202);
            $this->travel(2)->seconds(); // stay under the per-minute route throttle
        }

        $this->send('01799999999', 'login')->assertStatus(429)->assertJsonPath('error.code', 'otp_rate_limited');
        $this->assertCount(0, $this->sms()->sent);
    }

    public function test_verify_phone_flow(): void
    {
        $user = $this->userWithPhone('8801711111111', verified: false);
        $token = $user->id;

        $this->send('01711111111', 'verify_phone')->assertUnauthorized();

        // Unverified: a different number replaces it.
        $this->withHeaders(['X-Testing-User' => $token])->postJson('/api/v1/auth/otp/send', ['phone' => '01822222222', 'purpose' => 'verify_phone'])->assertStatus(202);
        $this->assertSame('8801822222222', $user->refresh()->phone);
        $code = $this->sms()->lastCodeFor('8801822222222');

        $this->withHeaders(['X-Testing-User' => $token])->postJson('/api/v1/auth/phone/verify', ['code' => $code === '000000' ? '111111' : '000000'])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_otp');
        $this->withHeaders(['X-Testing-User' => $token])->postJson('/api/v1/auth/phone/verify', ['code' => $code])
            ->assertOk()->assertJsonPath('data.phone', '8801822222222')
            ->assertJsonPath('data.phone_verified_at', fn ($v) => is_string($v));

        // Verified: another number is refused.
        $this->travel(61)->seconds();
        $this->withHeaders(['X-Testing-User' => $token])->postJson('/api/v1/auth/otp/send', ['phone' => '01933333333', 'purpose' => 'verify_phone'])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['phone']]]);
    }

    #[Group('tenancy')]
    public function test_verify_phone_cannot_claim_someone_elses_number_or_use_their_code(): void
    {
        $this->userWithPhone('8801711111111');
        [$attacker] = $this->merchant();
        $token = $attacker->id;

        $this->withHeaders(['X-Testing-User' => $token])->postJson('/api/v1/auth/otp/send', ['phone' => '01711111111', 'purpose' => 'verify_phone'])
            ->assertStatus(422)->assertJsonPath('error.details.phone.0', 'This phone number is already registered.');

        // A login code for the victim is not valid for any other purpose.
        $this->send('01711111111', 'login');
        $code = $this->sms()->lastCodeFor('8801711111111');
        $this->postJson('/api/v1/auth/reset-password/otp', [
            'phone' => '01711111111', 'code' => $code, 'password' => 'hacked123', 'password_confirmation' => 'hacked123',
        ])->assertStatus(422)->assertJsonPath('error.code', 'invalid_otp');
    }

    public function test_reset_password_with_otp_revokes_tokens(): void
    {
        $user = $this->userWithPhone();

        $this->send('01711111111', 'reset_password');
        $code = $this->sms()->lastCodeFor('8801711111111');

        $this->postJson('/api/v1/auth/reset-password/otp', [
            'phone' => '01711111111', 'code' => $code, 'password' => 'brand-new1', 'password_confirmation' => 'brand-new1',
        ])->assertOk()->assertJsonPath('data.message', 'Your password has been reset.');

        $this->assertTrue(Hash::check('brand-new1', $user->refresh()->password));
    }

    public function test_dev_otp_only_in_local_with_log_driver(): void
    {
        $this->userWithPhone();

        // phpunit: env=testing, driver=fake → absent
        $this->send('01711111111', 'login')->assertJsonMissingPath('data.dev_otp');

        // production + log driver → absent. Outside "testing" CSRF is enforced: act like the browser on the SPA origin.
        $this->withHeader('Sec-Fetch-Site', 'same-origin');
        $this->app['env'] = 'production';
        config(['sms.driver' => 'log']);
        $this->app->forgetInstance(SmsGateway::class);
        $this->travel(61)->seconds();
        $this->send('01711111111', 'login')->assertStatus(202)->assertJsonMissingPath('data.dev_otp');

        // local + revesms driver → absent
        $this->app['env'] = 'local';
        config(['sms.driver' => 'revesms', 'sms.revesms.api_key' => 'k', 'sms.revesms.secret_key' => 's', 'sms.revesms.caller_id' => 'c']);
        Http::fake(['*' => Http::response(['Status' => '0', 'Message_ID' => '1'])]);
        $this->app->forgetInstance(SmsGateway::class);
        $this->travel(61)->seconds();
        $this->send('01711111111', 'login')->assertStatus(202)->assertJsonMissingPath('data.dev_otp');

        // local + log driver → present, and it is the real code
        config(['sms.driver' => 'log']);
        $this->app->forgetInstance(SmsGateway::class);
        $this->travel(61)->seconds();
        $code = $this->send('01711111111', 'login')->assertStatus(202)->json('data.dev_otp');
        $this->assertMatchesRegularExpression('/^\d{6}$/', $code);
        $this->postJson('/api/v1/auth/login/otp', ['phone' => '01711111111', 'code' => $code])->assertOk();
    }

    public function test_register_requires_a_unique_bd_mobile(): void
    {
        $this->userWithPhone('8801711111111');
        $body = ['name' => 'A', 'email' => 'a@example.com', 'password' => 'secret123', 'password_confirmation' => 'secret123'];

        $this->postJson('/api/v1/auth/register', $body + ['name' => 'Abc'])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['phone']]]);
        $this->postJson('/api/v1/auth/register', $body + ['phone' => '+14155550123'])->assertStatus(422);
        $this->postJson('/api/v1/auth/register', $body + ['phone' => '01711111111'])
            ->assertStatus(422)->assertJsonPath('error.details.phone.0', 'This phone number is already registered.');
    }
}

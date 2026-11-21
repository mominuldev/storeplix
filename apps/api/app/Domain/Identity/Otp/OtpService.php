<?php

namespace App\Domain\Identity\Otp;

use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Jobs\SendSms;
use App\Domain\Sms\Models\SmsMessage;
use Illuminate\Cache\RateLimiter;
use Illuminate\Support\Facades\DB;

/**
 * Phone OTPs (Addendum A): 6 digits from random_int, stored as HMAC-SHA256, TTL 5 min,
 * max 5 verify attempts, resend cooldown 60 s, max 5 sends / phone / hour and 20 / IP / hour.
 * A new send invalidates earlier unconsumed codes for the same phone + purpose.
 *
 * Rate limits are applied identically whether or not an account exists, so responses and
 * timings don't reveal registered numbers.
 */
class OtpService
{
    public const TTL = 300;

    public const COOLDOWN = 60;

    public const MAX_ATTEMPTS = 5;

    public const PER_PHONE_PER_HOUR = 5;

    public const PER_IP_PER_HOUR = 20;

    public const TEXT = 'Your Store Plix code is %s. Valid for 5 minutes. Do not share it.';

    public function __construct(private readonly RateLimiter $limiter) {}

    /**
     * Applies rate limits. When $deliver is true a code is generated and an SMS queued
     * (after the response); returns the plaintext code (for dev_otp only) or null.
     *
     * @throws OtpRateLimited
     */
    public function send(string $msisdn, OtpPurpose $purpose, string $ip, bool $deliver, ?string $tenantId = null): ?string
    {
        $keys = [
            "otp:cooldown:{$purpose->value}:{$msisdn}" => [1, self::COOLDOWN],
            "otp:phone:{$msisdn}" => [self::PER_PHONE_PER_HOUR, 3600],
            "otp:ip:{$ip}" => [self::PER_IP_PER_HOUR, 3600],
        ];

        foreach ($keys as $key => [$max]) {
            if ($this->limiter->tooManyAttempts($key, $max)) {
                throw new OtpRateLimited($this->limiter->availableIn($key));
            }
        }
        foreach ($keys as $key => [, $decay]) {
            $this->limiter->hit($key, $decay);
        }

        if (! $deliver) {
            return null;
        }

        $code = str_pad((string) random_int(0, 999_999), 6, '0', STR_PAD_LEFT);

        DB::transaction(function () use ($msisdn, $purpose, $code) {
            OtpCode::query()
                ->where('phone', $msisdn)->where('purpose', $purpose->value)
                ->whereNull('consumed_at')->where('expires_at', '>', now())
                ->update(['expires_at' => now()]);

            OtpCode::query()->create([
                'phone' => $msisdn,
                'purpose' => $purpose->value,
                'code_hash' => $this->hash($msisdn, $purpose, $code),
                'expires_at' => now()->addSeconds(self::TTL),
            ]);
        });

        $message = SmsMessage::query()->create([
            'tenant_id' => $tenantId,
            'to' => $msisdn,
            'purpose' => 'otp_'.$purpose->value,
            'template' => 'otp_code',
            'status' => 'queued',
        ]);

        SendSms::dispatchAfterResponse($message->id, sprintf(self::TEXT, $code));

        return $code;
    }

    /** Constant-time check; consumes the code on success. Wrong/expired/exhausted → false. */
    public function verify(string $msisdn, OtpPurpose $purpose, string $code): bool
    {
        return DB::transaction(function () use ($msisdn, $purpose, $code) {
            $otp = OtpCode::query()
                ->where('phone', $msisdn)->where('purpose', $purpose->value)
                ->whereNull('consumed_at')->where('expires_at', '>', now())
                ->latest('created_at')->orderByDesc('id')
                ->lockForUpdate()
                ->first();

            if ($otp === null || $otp->attempts >= self::MAX_ATTEMPTS) {
                return false;
            }

            $otp->increment('attempts');

            if (! hash_equals($otp->code_hash, $this->hash($msisdn, $purpose, $code))) {
                return false;
            }

            $otp->update(['consumed_at' => now()]);

            return true;
        });
    }

    public static function normalize(?string $phone): ?string
    {
        return Phone::bdMsisdn($phone);
    }

    private function hash(string $msisdn, OtpPurpose $purpose, string $code): string
    {
        return hash_hmac('sha256', "{$purpose->value}|{$msisdn}|{$code}", (string) config('app.key'));
    }
}

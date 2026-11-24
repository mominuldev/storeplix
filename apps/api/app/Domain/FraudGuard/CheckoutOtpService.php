<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\FraudGuard\Jobs\SendCheckoutOtp;
use App\Domain\FraudGuard\Models\CheckoutOtp;
use App\Domain\Marketing\Sending\DevMessageSink;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * Shopper checkout OTP (PHASE-8-8 P88-13, S160): 6 digits from random_int, stored as HMAC-SHA256 (app key, bound to
 * store + phone), 5-minute TTL, 5 attempts per code, 60 s resend cooldown; the route limiter `checkout-otp` caps
 * 5 sends per phone and 20 per IP per hour and store. The SMS (template `checkout_otp`, counted against
 * `sms_per_month`) goes after the response; a provider failure marks the number "OTP unavailable" for a while and the
 * next checkout fails OPEN (order placed, held `call_first (otp_unavailable)`). Call inside the tenant context.
 */
class CheckoutOtpService
{
    public function __construct(
        private readonly GuardSettings $settings,
        private readonly TenantContext $context,
        private readonly TenantCache $cache,
    ) {}

    /**
     * POST /storefront/checkout/otp. The answer never depends on whether the number is blocked or known (no oracle):
     * `required` is false only when the store's OTP rule doesn't apply or SMS is unavailable for the shop.
     *
     * @return array{required: bool, expires_at: string|null, resend_after_seconds: int}
     */
    public function send(Store $store, string $phone, ?string $ip): array
    {
        $none = ['required' => false, 'expires_at' => null, 'resend_after_seconds' => 0];
        if (! $this->settings->guarded($store->id) || ! $this->settings->for($store->id)->otp_enabled) {
            return $none;
        }
        $phone = Phone::bdMsisdn($phone) ?? $phone;
        $resend = (int) config('fraud_guard.otp.resend_seconds', 60);
        $last = CheckoutOtp::query()->where('store_id', $store->id)->where('phone', $phone)->orderByDesc('sent_at')->orderByDesc('id')->first();
        if ($last !== null && $last->sent_at->gt(now()->subSeconds($resend))) {
            $wait = max(1, $resend - (int) $last->sent_at->diffInSeconds(now(), true));
            throw new ApiException(429, 'rate_limited', 'Wait a moment before asking for a new code.', null, $wait);
        }
        if ($this->allowanceUsed()) {
            return $none; // fail open (P88-13): the order is placed and held for a call
        }

        $code = str_pad((string) random_int(0, 999_999), 6, '0', STR_PAD_LEFT);
        $ttl = (int) config('fraud_guard.otp.ttl_seconds', 300);
        $otp = DB::transaction(function () use ($store, $phone, $code, $ip, $ttl) {
            CheckoutOtp::query()->where('store_id', $store->id)->where('phone', $phone)->whereNull('verified_at')
                ->where('expires_at', '>', now())->update(['expires_at' => now()]);
            $otp = new CheckoutOtp;
            $otp->store_id = $store->id;
            $otp->phone = $phone;
            $otp->code_hash = self::hash($store->id, $phone, $code);
            $otp->attempts = 0;
            $otp->sent_at = now();
            $otp->expires_at = now()->addSeconds($ttl);
            $otp->ip = $ip !== null ? mb_substr($ip, 0, 45) : null;
            $otp->save();

            return $otp;
        });

        $language = StoreSetting::query()->where('store_id', $store->id)->value('sms_language') === 'en' ? 'en' : 'bn';
        $message = SmsMessage::query()->create([
            'tenant_id' => $this->context->requireId(),
            'to' => $phone,
            'purpose' => SmsTemplates::CHECKOUT_OTP,
            'template' => SmsTemplates::CHECKOUT_OTP.'.'.$language,
            'status' => 'queued',
        ]);
        $text = SmsTemplates::render(SmsTemplates::CHECKOUT_OTP, $language, ['shop' => SmsTemplates::clean($store->name, 40), 'code' => $code]);
        dispatch((new SendCheckoutOtp($message->id, $store->id, $text))->forTenant($this->context->requireId()))->afterResponse();
        // Testing-only sink (never in production): e2e reads the code from here; no API response carries it.
        DevMessageSink::record($store->id, ['channel' => 'sms', 'to' => $phone, 'subject' => null, 'text' => $text,
            'unsubscribe_url' => '', 'campaign_id' => null, 'is_test' => false, 'kind' => SmsTemplates::CHECKOUT_OTP]);

        return ['required' => true, 'expires_at' => $otp->expires_at->toIso8601ZuluString(), 'resend_after_seconds' => $resend];
    }

    /**
     * Checkout: the code is required (a new number on COD of a guarded store with the rule on). A code verified in the
     * last 30 minutes keeps working (a re-submitted checkout); otherwise the latest live code is checked and burns
     * one attempt. Missing → 422 `otp_required`; wrong / expired / used up → 422 `otp_invalid` with `attempts_left`.
     */
    public function assertVerified(Store $store, string $phone, ?string $code): void
    {
        if ($code === null || $code === '') {
            throw new ApiException(422, 'otp_required', 'Enter the code we sent.', ['otp_code' => ['Enter the code we sent.']]);
        }
        $max = (int) config('fraud_guard.otp.max_attempts', 5);
        $ok = DB::transaction(function () use ($store, $phone, $code, $max) {
            /** @var CheckoutOtp|null $otp */
            $otp = CheckoutOtp::query()->where('store_id', $store->id)->where('phone', $phone)
                ->orderByDesc('sent_at')->orderByDesc('id')->lockForUpdate()->first();
            if ($otp === null) {
                return 0;
            }
            $hash = self::hash($store->id, $phone, $code);
            if ($otp->verified_at !== null) {
                $fresh = $otp->verified_at->gt(now()->subMinutes((int) config('fraud_guard.otp.verified_grace_minutes', 30)));

                return $fresh && hash_equals($otp->code_hash, $hash) ? true : 0;
            }
            if ($otp->expires_at->lte(now()) || $otp->attempts >= $max) {
                return 0;
            }
            $otp->attempts++;
            if (hash_equals($otp->code_hash, $hash)) {
                $otp->verified_at = now();
                $otp->save();

                return true;
            }
            $otp->save();

            return $max - $otp->attempts;
        });
        if ($ok !== true) {
            $left = (int) $ok;
            $message = $left > 0 ? "That code isn't right. {$left} ".($left === 1 ? 'try' : 'tries').' left.' : 'That code has expired. Ask for a new one.';
            throw new ApiException(422, 'otp_invalid', $message, ['attempts_left' => $left, 'otp_code' => [$message]]);
        }
    }

    /** Fail-open reasons (P88-13): the monthly SMS allowance is used up, or the last code for this number failed to send. */
    public function unavailableReason(Store $store, string $phone): ?string
    {
        if ($this->allowanceUsed()) {
            return 'sms_allowance';
        }

        return $this->cache->get(self::failureKey($store->id, $phone)) !== null ? 'sms_failed' : null;
    }

    public function markFailed(string $storeId, string $phone): void
    {
        $this->cache->put(self::failureKey($storeId, $phone), 1, now()->addMinutes((int) config('fraud_guard.otp.failure_minutes', 30)));
    }

    private function allowanceUsed(): bool
    {
        $tenant = $this->context->tenant();
        if ($tenant === null) {
            return true;
        }
        $limit = FeatureGate::limit($tenant, Limit::SmsPerMonth);

        return $limit !== null && FeatureGate::usage($tenant, Limit::SmsPerMonth) >= $limit;
    }

    public static function hash(string $storeId, string $phone, string $code): string
    {
        return hash_hmac('sha256', "checkout-otp|{$storeId}|{$phone}|{$code}", (string) config('app.key'));
    }

    private static function failureKey(string $storeId, string $phone): string
    {
        return 'checkout-otp-failed:'.$storeId.':'.$phone;
    }
}

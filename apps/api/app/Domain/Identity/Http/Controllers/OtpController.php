<?php

namespace App\Domain\Identity\Http\Controllers;

use App\Domain\Identity\Http\Resources\UserResource;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Otp\OtpPurpose;
use App\Domain\Identity\Otp\OtpService;
use App\Domain\Identity\Rules\PasswordRules;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\PhoneRule;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/** Phone OTP endpoints (Phase 2 Addendum A). */
class OtpController
{
    use IssuesTokens;

    public function __construct(
        private readonly OtpService $otp,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * 202 {expires_in, resend_in, dev_otp?}. For login/reset_password the response is identical
     * whether or not the phone is registered (a code is only sent when it is).
     */
    public function send(Request $request): JsonResponse
    {
        $data = $request->validate([
            'phone' => ['required', 'string', PhoneRule::bdMobile()],
            'purpose' => ['required', 'string', Rule::enum(OtpPurpose::class)],
        ]);
        $phone = OtpService::normalize($data['phone']);
        $purpose = OtpPurpose::from($data['purpose']);

        if ($purpose === OtpPurpose::VerifyPhone) {
            /** @var User|null $user */
            $user = Auth::guard('sanctum')->user();
            if ($user === null) {
                throw new ApiException(401, 'unauthenticated', 'Unauthenticated.');
            }
            $this->claimPhone($user, $phone);
            $deliver = true;
        } else {
            $deliver = User::query()->where('phone', $phone)->exists();
        }

        $code = $this->otp->send($phone, $purpose, (string) $request->ip(), $deliver);

        $body = ['expires_in' => OtpService::TTL, 'resend_in' => OtpService::COOLDOWN];
        if ($code !== null && self::devOtpEnabled()) {
            $body['dev_otp'] = $code; // local + SMS_DRIVER=log ONLY
        }

        return new JsonResponse(['data' => $body], 202);
    }

    public function verifyPhone(Request $request): UserResource
    {
        $data = $request->validate(['code' => ['required', 'string', 'digits:6']]);
        /** @var User $user */
        $user = $request->user();

        if ($user->phone === null || ! $this->otp->verify($user->phone, OtpPurpose::VerifyPhone, $data['code'])) {
            throw $this->invalid();
        }

        $user->forceFill(['phone_verified_at' => now()])->save();
        $this->audit->log('account.phone_verified', $user, tenantId: false);

        return new UserResource($user->load('tenants'));
    }

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'phone' => ['required', 'string', PhoneRule::bdMobile()],
            'code' => ['required', 'string', 'digits:6'],
        ]);
        $phone = OtpService::normalize($data['phone']);

        $user = User::query()->where('phone', $phone)->first();
        if ($user === null || ! $this->otp->verify($phone, OtpPurpose::Login, $data['code'])) {
            throw $this->invalid();
        }

        if ($user->phone_verified_at === null) {
            $user->forceFill(['phone_verified_at' => now()])->save(); // possession proven
        }
        $this->audit->log('auth.login', $user, ['method' => 'otp'], actor: $user, tenantId: false);

        return $this->tokenResponse($user);
    }

    public function resetPassword(Request $request): JsonResponse
    {
        $data = $request->validate([
            'phone' => ['required', 'string', PhoneRule::bdMobile()],
            'code' => ['required', 'string', 'digits:6'],
            'password' => PasswordRules::rules(),
        ]);
        $phone = OtpService::normalize($data['phone']);

        $user = User::query()->where('phone', $phone)->first();
        if ($user === null || ! $this->otp->verify($phone, OtpPurpose::ResetPassword, $data['code'])) {
            throw $this->invalid();
        }

        DB::transaction(function () use ($user, $data) {
            $user->forceFill([
                'password' => $data['password'],
                'password_changed_at' => now(),
                'phone_verified_at' => $user->phone_verified_at ?? now(),
            ])->save();
            $user->tokens()->delete();
        });

        $this->audit->log('auth.password_reset', $user, ['method' => 'otp'], actor: $user, tenantId: false);

        return new JsonResponse(['data' => ['message' => 'Your password has been reset.']]);
    }

    public static function devOtpEnabled(): bool
    {
        return app()->environment('local') && config('sms.driver') === 'log';
    }

    /** verify_phone: the phone must be the user's, or replaces it while still unverified. */
    private function claimPhone(User $user, string $phone): void
    {
        if ($user->phone === $phone) {
            return;
        }

        if ($user->phone_verified_at !== null) {
            throw ValidationException::withMessages(['phone' => ['This is not your verified phone number. Change it in your profile first.']]);
        }

        if (User::query()->where('phone', $phone)->whereKeyNot($user->getKey())->exists()) {
            throw ValidationException::withMessages(['phone' => ['This phone number is already registered.']]);
        }

        $user->forceFill(['phone' => $phone, 'phone_verified_at' => null])->save();
    }

    private function invalid(): ApiException
    {
        return new ApiException(422, 'invalid_otp', 'The code is incorrect or has expired.');
    }
}

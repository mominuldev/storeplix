<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\CredentialVerifier;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-1 §3.1 sign-in state machine: password → login token → TOTP / enrolment / recovery code. Every credential
 * failure answers the same 422 (S70); five wrong codes drop the token and lock the account for 15 minutes (S69).
 */
final class AdminLogin
{
    public const MAX_FAILURES = 5;

    public const LOCK_MINUTES = 15;

    public function __construct(
        private readonly LoginTokens $tokens,
        private readonly Totp $totp,
        private readonly RecoveryCodes $recoveryCodes,
        private readonly AuditLogger $audit,
    ) {}

    /** @return array{0: string, 1: PendingLogin} */
    public function attempt(string $email, string $password, string $ip): array
    {
        $user = User::query()->where('email', $email)->first();
        $passwordOk = CredentialVerifier::check($user, $password); // always hashes (constant work)

        if (! $passwordOk || $user === null || ! self::eligible($user) || ! AdminEmailDomains::allows($email)) {
            $this->audit->log('admin.login_failed', meta: ['email_hash' => hash('sha256', $email), 'ip' => $ip], tenantId: false, system: true); // never the browser's signed-in user

            throw ValidationException::withMessages(['email' => [__('auth.failed')]]);
        }

        return $this->tokens->issue($user, self::needsEnrolment($user) ? LoginTokens::STEP_ENROLL : LoginTokens::STEP_TOTP, $ip);
    }

    /**
     * A pending login at `$step` whose user is still eligible; anything else → 404 `not_found`.
     *
     * @return array{0: PendingLogin, 1: User}
     */
    public function pending(?string $token, string $ip, string $step): array
    {
        $pending = $this->tokens->find($token, $ip);
        $user = $pending !== null && $pending->step === $step ? User::query()->find($pending->userId) : null;
        if ($pending !== null && $user !== null && ! self::eligible($user)) {
            $this->tokens->forget($pending); // disabled or locked meanwhile: the pending sign-in is over
        }
        if ($pending === null || $user === null || ! self::eligible($user)) {
            throw self::notFound();
        }

        return [$pending, $user];
    }

    /** @return array{otpauth_uri: string, qr_svg: string, secret: string} once per login token */
    public function enrolment(PendingLogin $pending, User $user): array
    {
        if ($pending->enrollSecret !== null) {
            throw self::notFound();
        }
        $secret = $this->totp->generateSecret();
        $pending->enrollSecret = encrypt($secret);
        $this->tokens->save($pending);
        $uri = $this->totp->otpauthUri($user->email, $secret);

        return ['otpauth_uri' => $uri, 'qr_svg' => $this->totp->qrSvg($uri), 'secret' => $secret];
    }

    /** @return list<string> the new recovery codes */
    public function confirmEnrolment(PendingLogin $pending, User $user, string $code): array
    {
        if ($pending->enrollSecret === null) {
            throw self::notFound();
        }
        $secret = (string) decrypt($pending->enrollSecret);
        $step = $this->totp->verify($secret, $code, null);
        if ($step === null) {
            $this->fail($pending, $user);
        }

        $user->forceFill(['totp_secret' => $secret, 'totp_confirmed_at' => now(), 'totp_last_step' => $step])->save();
        $this->tokens->forget($pending);
        $this->audit->log('admin.totp_enrolled', $user, actor: $user, tenantId: false, platform: true);

        return $this->recoveryCodes->regenerate($user);
    }

    /** @return string `totp` | `recovery_code` (the method used) */
    public function verifySecondFactor(PendingLogin $pending, User $user, ?string $code, ?string $recoveryCode): string
    {
        if ($code !== null && $code !== '') {
            $step = $user->totp_secret ? $this->totp->verify((string) $user->totp_secret, $code, $user->totp_last_step) : null;
            if ($step === null) {
                $this->fail($pending, $user);
            }
            $user->forceFill(['totp_last_step' => $step])->save();
            $method = 'totp';
        } else {
            if (! $this->recoveryCodes->consume($user, (string) $recoveryCode)) {
                $this->fail($pending, $user);
            }
            $method = 'recovery_code';
        }
        $this->tokens->forget($pending);

        return $method;
    }

    public static function eligible(User $user): bool
    {
        return PlatformRole::tryFrom((string) $user->platform_role) !== null
            && $user->platform_disabled_at === null
            && ($user->platform_locked_until === null || ! $user->platform_locked_until->isFuture());
    }

    public static function needsEnrolment(User $user): bool
    {
        return $user->totp_secret === null || $user->totp_confirmed_at === null;
    }

    private function fail(PendingLogin $pending, User $user): never
    {
        $pending->failures++;
        $left = max(0, self::MAX_FAILURES - $pending->failures);
        if ($left === 0) {
            $this->tokens->forget($pending);
            $user->forceFill(['platform_locked_until' => now()->addMinutes(self::LOCK_MINUTES)])->save();
            $this->audit->log('admin.locked', $user, ['minutes' => self::LOCK_MINUTES], actor: $user, tenantId: false, platform: true);
        } else {
            $this->tokens->save($pending);
        }

        throw new ApiException(422, 'invalid_totp', 'That code is not valid. Try again.', ['attempts_left' => $left]);
    }

    private static function notFound(): ApiException
    {
        return new ApiException(404, 'not_found', 'This sign-in has expired. Please sign in again.');
    }
}

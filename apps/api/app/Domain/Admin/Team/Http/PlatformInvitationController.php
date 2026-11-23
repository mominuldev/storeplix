<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http;

use App\Domain\Admin\Auth\Http\AdminAuthController;
use App\Domain\Admin\Auth\LoginTokens;
use App\Domain\Admin\Auth\RecoveryCodes;
use App\Domain\Admin\Team\Http\Requests\AcceptPlatformInvitationRequest;
use App\Domain\Admin\Team\Models\PlatformInvitation;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Rules\PasswordRules;
use App\Domain\Identity\Support\CredentialVerifier;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * Guest staff-invitation endpoints (PHASE-8-1 §6.1, P8-16). Accepting never signs in: it answers `AdminLoginStep`
 * with `step: enroll`, so the new staff member enrols TOTP before their first admin session.
 */
class PlatformInvitationController
{
    public function __construct(
        private readonly LoginTokens $tokens,
        private readonly RecoveryCodes $recoveryCodes,
        private readonly AuditLogger $audit,
    ) {}

    public function show(string $token): JsonResponse
    {
        $invitation = self::find($token);

        return new JsonResponse(['data' => [
            'email' => $invitation->email,
            'role' => $invitation->role,
            'existing_user' => User::query()->where('email', $invitation->email)->exists(),
        ]]);
    }

    public function accept(AcceptPlatformInvitationRequest $request, string $token): JsonResponse
    {
        $invitation = self::find($token);
        $existing = User::query()->where('email', $invitation->email)->first();

        if ($existing !== null) {
            if (! CredentialVerifier::check($existing, (string) $request->validated('password'))) {
                throw ValidationException::withMessages(['password' => ['The password is incorrect.']]);
            }
        } else {
            Validator::make($request->all(), [
                'name' => ['required', 'string', 'min:2', 'max:255'],
                'password' => PasswordRules::rules(),
            ])->validate();
        }

        $user = DB::transaction(function () use ($invitation, $existing, $request): User {
            // Single use under concurrency: only one request flips accepted_at.
            $claimed = PlatformInvitation::query()->usable()->whereKey($invitation->id)->update(['accepted_at' => now()]);
            if ($claimed !== 1) {
                throw new ApiException(404, 'not_found', 'This invitation is no longer valid.');
            }

            $user = $existing ?? User::query()->create([
                'name' => trim((string) $request->input('name')),
                'email' => $invitation->email,
                'password' => (string) $request->input('password'),
                'password_changed_at' => now(),
                'email_verified_at' => now(), // the invitation link proved the address
            ]);
            $user->forceFill([
                'platform_role' => $invitation->role,
                'platform_invited_by' => $invitation->invited_by,
                'platform_disabled_at' => null,
                'platform_locked_until' => null,
                'totp_secret' => null,
                'totp_confirmed_at' => null,
                'totp_last_step' => null,
            ])->save();
            $this->recoveryCodes->clear($user);

            return $user;
        });

        $this->audit->log('admin.staff_joined', $user, ['role' => $invitation->role, 'existing_user' => $existing !== null], actor: $user, tenantId: false, platform: true);
        [$loginToken, $pending] = $this->tokens->issue($user, LoginTokens::STEP_ENROLL, (string) $request->ip());

        return AdminAuthController::stepResponse($loginToken, $pending);
    }

    private static function find(string $token): PlatformInvitation
    {
        return PlatformInvitation::query()->usable()->where('token_hash', PlatformInvitation::hashToken($token))->first()
            ?? throw new ApiException(404, 'not_found', 'This invitation is no longer valid.');
    }
}

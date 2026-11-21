<?php

namespace App\Domain\Identity\Http\Controllers;

use App\Domain\Identity\Http\Requests\ForgotPasswordRequest;
use App\Domain\Identity\Http\Requests\LoginRequest;
use App\Domain\Identity\Http\Requests\RegisterRequest;
use App\Domain\Identity\Http\Requests\ResetPasswordRequest;
use App\Domain\Identity\Http\Resources\UserResource;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\CredentialVerifier;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Password;
use Illuminate\Validation\ValidationException;

class AuthController
{
    use IssuesTokens;

    public const FORGOT_MESSAGE = 'If an account exists for that email, a reset link will be sent.';

    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * Creates the user AND their tenant (owner membership) in one transaction. TenantCreated
     * (sync, same transaction) starts the 14-day trial.
     */
    public function register(RegisterRequest $request): JsonResponse
    {
        $data = $request->validated();

        $user = DB::transaction(function () use ($data) {
            $user = User::query()->create([
                'name' => $data['name'],
                'email' => $data['email'],
                'phone' => $data['phone'],
                'password' => $data['password'],
                'password_changed_at' => now(),
            ]);

            $tenant = Tenant::query()->create(['name' => $data['name']]);

            TenantUser::query()->create([
                'tenant_id' => $tenant->id,
                'user_id' => $user->id,
                'role' => TenantUser::ROLE_OWNER,
                'joined_at' => now(),
            ]);

            $this->audit->log('auth.registered', $user, actor: $user, tenantId: $tenant->id);

            return $user;
        });

        return $this->tokenResponse($user, 201);
    }

    public function login(LoginRequest $request): JsonResponse
    {
        $data = $request->validated();

        $user = User::query()->where('email', $data['email'])->first();

        if (! CredentialVerifier::check($user, $data['password'])) {
            throw ValidationException::withMessages(['email' => [__('auth.failed')]]);
        }

        $this->audit->log('auth.login', $user, actor: $user, tenantId: false);

        return $this->tokenResponse($user);
    }

    /**
     * Always 202 with the same body (no enumeration). The broker stores a hashed token,
     * replaces any previous one, and silently throttles to one email per 60 s per address.
     */
    public function forgotPassword(ForgotPasswordRequest $request): JsonResponse
    {
        $email = $request->validated('email');
        $status = Password::broker()->sendResetLink(['email' => $email]);

        Log::info('auth.password_reset_requested', [
            'email_hash' => hash('sha256', $email),
            'status' => $status,
        ]);

        return new JsonResponse(['data' => ['message' => self::FORGOT_MESSAGE]], 202);
    }

    /** Single-use, 60-min token. Unknown/expired/used/mismatched → one code: invalid_reset_token. */
    public function resetPassword(ResetPasswordRequest $request): JsonResponse
    {
        $data = $request->validated();
        $resetUser = null;

        $status = Password::broker()->reset($data, function (User $user, string $password) use (&$resetUser) {
            $user->forceFill(['password' => $password, 'password_changed_at' => now()])->save();
            $user->tokens()->delete();
            $resetUser = $user;
        });

        if ($status !== Password::PASSWORD_RESET || $resetUser === null) {
            throw new ApiException(422, 'invalid_reset_token', 'This password reset link is invalid or has expired.');
        }

        $this->audit->log('auth.password_reset', $resetUser, actor: $resetUser, tenantId: false);

        return new JsonResponse(['data' => ['message' => 'Your password has been reset.']]);
    }

    public function logout(Request $request): Response
    {
        $request->user()->currentAccessToken()?->delete();

        return response()->noContent();
    }

    public function me(Request $request): UserResource
    {
        return new UserResource($request->user()->load('tenants'));
    }
}

<?php

namespace App\Domain\Identity\Http\Controllers;

use App\Domain\Identity\Http\Requests\ForgotPasswordRequest;
use App\Domain\Identity\Http\Requests\LoginRequest;
use App\Domain\Identity\Http\Requests\RegisterRequest;
use App\Domain\Identity\Http\Resources\UserResource;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

class AuthController
{
    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * Creates the user AND their tenant (owner membership) in one transaction, so the
     * merchant can immediately call POST /stores with X-Tenant-Id.
     */
    public function register(RegisterRequest $request): JsonResponse
    {
        $data = $request->validated();

        $user = DB::transaction(function () use ($data) {
            $user = User::query()->create([
                'name' => $data['name'],
                'email' => $data['email'],
                'phone' => $data['phone'] ?? null,
                'password' => $data['password'],
            ]);

            $tenant = Tenant::query()->create(['name' => $data['name']]);

            TenantUser::query()->create([
                'tenant_id' => $tenant->id,
                'user_id' => $user->id,
                'role' => TenantUser::ROLE_OWNER,
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

        if ($user === null || ! Hash::check($data['password'], $user->password)) {
            throw ValidationException::withMessages(['email' => [__('auth.failed')]]);
        }

        $this->audit->log('auth.login', $user, actor: $user);

        return $this->tokenResponse($user, 200);
    }

    /**
     * Phase 1.1 stub: always 202 with the same body, whether or not the account exists
     * (no enumeration). Logs the request; no mail is sent yet.
     */
    public function forgotPassword(ForgotPasswordRequest $request): JsonResponse
    {
        $email = $request->validated('email');
        $exists = User::query()->where('email', $email)->exists();

        Log::info('auth.password_reset_requested', [
            'email_hash' => hash('sha256', $email),
            'account_exists' => $exists,
            'ip' => $request->ip(),
        ]);

        return new JsonResponse([
            'data' => ['message' => 'If an account exists for that email, a reset link will be sent.'],
        ], 202);
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

    private function tokenResponse(User $user, int $status): JsonResponse
    {
        $expiresAt = now()->addMinutes((int) config('sanctum.expiration'));
        $token = $user->createToken('merchant-dashboard', ['*'], $expiresAt)->plainTextToken;

        return new JsonResponse([
            'data' => [
                'token' => $token,
                'expires_at' => $expiresAt->toIso8601ZuluString(),
                'user' => (new UserResource($user->load('tenants')))->resolve(),
            ],
        ], $status);
    }
}

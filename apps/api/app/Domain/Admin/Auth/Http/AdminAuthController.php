<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth\Http;

use App\Domain\Admin\Auth\AdminLogin;
use App\Domain\Admin\Auth\AdminSessions;
use App\Domain\Admin\Auth\Http\Requests\AdminEnrollRequest;
use App\Domain\Admin\Auth\Http\Requests\AdminLoginRequest;
use App\Domain\Admin\Auth\Http\Requests\AdminTotpRequest;
use App\Domain\Admin\Auth\LoginTokens;
use App\Domain\Admin\Auth\PendingLogin;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;

/**
 * PHASE-8-1 §3.1 / §6.1: admin sign-in with TOTP (switchable: amendment A1, `step: signed_in` when off),
 * `GET /admin/auth/me`, `POST /admin/auth/logout`.
 */
class AdminAuthController
{
    public function __construct(
        private readonly AdminLogin $login,
        private readonly AdminSessions $sessions,
        private readonly AuditLogger $audit,
    ) {}

    public function login(AdminLoginRequest $request): JsonResponse
    {
        $result = $this->login->attempt((string) $request->validated('email'), (string) $request->validated('password'), (string) $request->ip());
        if ($result instanceof User) { // amendment A1-3: staff two-step sign-in is off
            return new JsonResponse(['data' => ['step' => 'signed_in'] + $this->signIn($request, $result, 'password')]);
        }
        [$token, $pending] = $result;

        return self::step($token, $pending);
    }

    public function enrolment(Request $request): JsonResponse
    {
        /** @var PendingLogin $pending */
        [$pending, $user] = $this->login->pending(self::token($request->query('login_token')), (string) $request->ip(), LoginTokens::STEP_ENROLL);

        return new JsonResponse(['data' => $this->login->enrolment($pending, $user)]);
    }

    public function confirmEnrolment(AdminEnrollRequest $request): JsonResponse
    {
        [$pending, $user] = $this->login->pending((string) $request->validated('login_token'), (string) $request->ip(), LoginTokens::STEP_ENROLL);
        $codes = $this->login->confirmEnrolment($pending, $user, (string) $request->validated('code'));

        return new JsonResponse(['data' => $this->signIn($request, $user, 'enroll'), 'meta' => ['recovery_codes' => $codes]]);
    }

    public function totp(AdminTotpRequest $request): JsonResponse
    {
        [$pending, $user] = $this->login->pending((string) $request->validated('login_token'), (string) $request->ip(), LoginTokens::STEP_TOTP);
        $method = $this->login->verifySecondFactor($pending, $user, $request->validated('code'), $request->validated('recovery_code'));

        return new JsonResponse(['data' => $this->signIn($request, $user, $method)]);
    }

    public function me(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        return new JsonResponse(['data' => $this->sessions->payload($request, $user)]);
    }

    public function logout(Request $request): Response
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }

    /** @return array<string, mixed> */
    private function signIn(Request $request, User $user, string $method): array
    {
        $this->sessions->start($request, $user);
        $this->audit->log('admin.login', $user, ['method' => $method], actor: $user, tenantId: false, platform: true);

        return $this->sessions->payload($request, $user->refresh());
    }

    private static function step(string $token, PendingLogin $pending): JsonResponse
    {
        return new JsonResponse(['data' => [
            'step' => $pending->step,
            'login_token' => $token,
            'expires_at' => $pending->expiresAt->toIso8601ZuluString(),
        ]]);
    }

    private static function token(mixed $value): ?string
    {
        return is_string($value) ? $value : null;
    }

    /** Shared with the invitation accept endpoint (`step: enroll`). */
    public static function stepResponse(string $token, PendingLogin $pending): JsonResponse
    {
        return self::step($token, $pending);
    }
}

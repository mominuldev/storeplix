<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Http\Controllers;

use App\Domain\Admin\Impersonation\Http\Requests\ConsumeImpersonationRequest;
use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Admin\Impersonation\ImpersonationSession;
use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
use App\Domain\Identity\Http\Middleware\EnforceAbsoluteSessionExpiry;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\RateLimiter;

/**
 * Merchant origin (PHASE-8-1 §3.2, P8-9, S73): `POST /auth/impersonation {ticket}` exchanges a single-use ticket for a
 * fresh session as the staff user (`surface: impersonation`, absolute expiry = `expires_at`); `DELETE
 * /auth/impersonation` ends it (`ended_by: staff`) and signs out. The ticket is never logged.
 */
class ImpersonationSessionController
{
    public function __construct(
        private readonly ImpersonationService $service,
        private readonly ImpersonationSession $sessions,
    ) {}

    public function store(ConsumeImpersonationRequest $request): JsonResponse
    {
        // §3.2: 10/min per IP (whatever session the browser holds).
        $key = 'auth-impersonation:'.$request->ip();
        if (RateLimiter::tooManyAttempts($key, 10)) {
            $retry = RateLimiter::availableIn($key);
            throw new ApiException(429, 'rate_limited', 'Too many attempts. Please try again later.', retryAfter: $retry);
        }
        RateLimiter::hit($key, 60);

        // Unknown, used, expired or no-longer-allowed: one 404 for all, and the current session stays untouched.
        $row = $this->service->consume((string) $request->validated('ticket'))
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');

        /** @var User $staff */
        $staff = User::query()->findOrFail($row->staff_user_id);
        $expiresAt = $row->expires_at ?? throw new ApiException(404, 'not_found', 'Resource not found.');

        // Any current session on this origin (merchant, admin on a shared localhost jar, an older impersonation) is replaced.
        $guard = Auth::guard('web');
        if ($guard->check()) {
            $guard->logout();
        }
        $request->session()->invalidate();
        $request->session()->regenerateToken();
        $guard->login($staff);
        $request->session()->regenerate();
        SessionSurface::set($request, SessionSurface::IMPERSONATION);
        $request->session()->put(SessionSurface::IMPERSONATION_KEY, $row->id);
        $request->session()->put(EnforceAbsoluteSessionExpiry::KEY, $expiresAt->getTimestamp());

        return new JsonResponse(['data' => [
            'user' => $this->service->userShape($staff, $row),
            'impersonation' => $this->service->meShape($row),
            'session_expires_at' => $expiresAt->toIso8601ZuluString(),
        ]]);
    }

    public function destroy(Request $request): Response
    {
        if (! ImpersonationSession::isImpersonating($request)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        $row = $this->sessions->current($request);
        /** @var User $staff */
        $staff = $request->user();
        $this->service->end($row, PlatformImpersonation::ENDED_BY_STAFF, $staff);

        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }
}

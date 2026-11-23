<?php

namespace App\Domain\Identity\Http\Controllers;

use App\Domain\Identity\Http\Middleware\EnforceAbsoluteSessionExpiry;
use App\Domain\Identity\Http\Resources\UserResource;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

/**
 * Session sign-in (Phase 4.7c, §3.7): `Auth::guard('web')->login()`, `session()->regenerate()` (no fixation) and the
 * absolute 7-day expiry marker and `surface: merchant` (PHASE-8-1 P8-1); responds `{data: AuthSession}` = `{user, expires_at}`. No personal access tokens.
 */
trait IssuesTokens
{
    protected function sessionResponse(User $user, int $status = 200): JsonResponse
    {
        $request = request();
        if (! self::isStateful($request)) {
            throw new ApiException(400, 'stateful_required', 'Sign in from the Storeplix app.');
        }

        $expiresAt = now()->addMinutes((int) config('sanctum.expiration'));
        Auth::guard('web')->login($user);
        $request->session()->regenerate();
        $request->session()->put(EnforceAbsoluteSessionExpiry::KEY, $expiresAt->getTimestamp());
        // PHASE-8-1 P8-1: every merchant sign-in path (password, registration, OTP, invitation accept) lands here.
        SessionSurface::set($request, SessionSurface::MERCHANT);

        return new JsonResponse([
            'data' => [
                'user' => (new UserResource($user->load('tenants')))->resolve(),
                'expires_at' => $expiresAt->toIso8601ZuluString(),
            ],
        ], $status);
    }

    /** True when Sanctum treated the request as a first-party SPA request (session + CSRF middleware ran). */
    protected static function isStateful(Request $request): bool
    {
        return $request->attributes->get('sanctum') === true && $request->hasSession();
    }
}

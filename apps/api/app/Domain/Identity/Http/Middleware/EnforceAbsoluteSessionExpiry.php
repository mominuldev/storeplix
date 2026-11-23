<?php

namespace App\Domain\Identity\Http\Middleware;

use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Shared\Http\ApiException;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * D3 for cookie sessions (§7.2): a session login is valid until the absolute `auth_expires_at` written at sign-in, however
 * active it is (SESSION_LIFETIME is only the idle timeout). Past it → logout + invalidate → 401. A session-authenticated
 * user without the marker is treated as expired.
 *
 * PHASE-8-1 P8-5: the marker is per surface — merchant sign-in writes now + SANCTUM_EXPIRATION, admin sign-in writes now +
 * `admin.session_absolute_hours`, the impersonation consume writes `started_at + impersonation_minutes`. The `admin`
 * surface also has an idle limit (`admin.session_idle_minutes`, session key `last_seen`), refreshed on every request.
 */
class EnforceAbsoluteSessionExpiry
{
    public const KEY = 'auth_expires_at';

    /** Unix timestamp of the last admin-surface request (PHASE-8-1 P8-5 idle check). */
    public const LAST_SEEN_KEY = 'last_seen';

    public function handle(Request $request, Closure $next): Response
    {
        $guard = Auth::guard('web');
        if ($request->hasSession() && $request->attributes->get('sanctum') === true
            && $request->session()->has($guard->getName()) && $guard->check()) {
            $surface = SessionSurface::of($request);
            $now = now()->getTimestamp();
            $expiresAt = $request->session()->get(self::KEY);
            $expired = ! is_int($expiresAt) || $expiresAt <= $now;

            if (! $expired && $surface === SessionSurface::ADMIN) {
                $lastSeen = $request->session()->get(self::LAST_SEEN_KEY);
                $expired = ! is_int($lastSeen) || $lastSeen + self::adminIdleSeconds() <= $now;
            }

            if ($expired) {
                $guard->logout();
                $request->session()->invalidate();
                $request->session()->regenerateToken();

                // PHASE-8-1 §3.2: an expired impersonation answers `impersonation_ended`, so the SPA shows the ended screen.
                throw $surface === SessionSurface::IMPERSONATION
                    ? new ApiException(401, 'impersonation_ended', 'This support session has ended.')
                    : new ApiException(401, 'unauthenticated', 'Your session expired. Please sign in again.');
            }

            if ($surface === SessionSurface::ADMIN) {
                $request->session()->put(self::LAST_SEEN_KEY, $now);
            }
        }

        return $next($request);
    }

    public static function adminIdleSeconds(): int
    {
        return max(1, (int) config('admin.session_idle_minutes', 30)) * 60;
    }
}

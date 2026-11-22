<?php

namespace App\Domain\Identity\Http\Middleware;

use App\Domain\Shared\Http\ApiException;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * D3 for cookie sessions (§7.2): a session login is valid for SANCTUM_EXPIRATION minutes from login, however active it
 * is (SESSION_LIFETIME is only the idle timeout). Past `auth_expires_at` → logout + invalidate → 401. A session-authenticated
 * user without the marker is treated as expired. Bearer requests keep their PAT `expires_at` (4.7a only).
 */
class EnforceAbsoluteSessionExpiry
{
    public const KEY = 'auth_expires_at';

    public function handle(Request $request, Closure $next): Response
    {
        $guard = Auth::guard('web');
        if ($request->hasSession() && $request->attributes->get('sanctum') === true
            && $request->session()->has($guard->getName()) && $guard->check()) {
            $expiresAt = $request->session()->get(self::KEY);
            if (! is_int($expiresAt) || $expiresAt <= now()->getTimestamp()) {
                $guard->logout();
                $request->session()->invalidate();
                $request->session()->regenerateToken();

                throw new ApiException(401, 'unauthenticated', 'Your session expired. Please sign in again.');
            }
        }

        return $next($request);
    }
}

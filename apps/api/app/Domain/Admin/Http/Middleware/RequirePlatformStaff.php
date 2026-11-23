<?php

declare(strict_types=1);

namespace App\Domain\Admin\Http\Middleware;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Shared\Http\ApiException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware `platform` (PHASE-8-1 P8-3, S67): an authenticated user with an active platform role (re-read on
 * every request), not disabled, not locked. Runs after `auth:sanctum` and `surface:admin`. Owner: API-1.
 */
class RequirePlatformStaff
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if ($user === null) {
            throw new ApiException(401, 'unauthenticated', 'Unauthenticated.');
        }
        $role = PlatformRole::tryFrom((string) $user->platform_role);
        if ($role === null || $user->platform_disabled_at !== null
            || ($user->platform_locked_until !== null && $user->platform_locked_until->isFuture())) {
            throw new ApiException(403, 'forbidden', 'This action is not allowed.');
        }

        return $next($request);
    }
}

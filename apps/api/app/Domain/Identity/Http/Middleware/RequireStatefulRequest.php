<?php

namespace App\Domain\Identity\Http\Middleware;

use App\Domain\Shared\Http\ApiException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Phase 4.7c (§3.7): sign-in endpoints only work as first-party SPA requests (session + CSRF). Anything else — a script,
 * a storefront host, a Bearer client — gets 400 `stateful_required` before any side effect.
 */
class RequireStatefulRequest
{
    public function handle(Request $request, Closure $next): Response
    {
        if ($request->attributes->get('sanctum') !== true || ! $request->hasSession()) {
            throw new ApiException(400, 'stateful_required', 'Sign in from the Storeplix app.');
        }

        return $next($request);
    }
}

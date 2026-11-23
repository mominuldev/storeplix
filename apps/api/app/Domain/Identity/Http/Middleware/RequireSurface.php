<?php

declare(strict_types=1);

namespace App\Domain\Identity\Http\Middleware;

use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Shared\Http\ApiException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Route middleware `surface:<a>,<b>` (PHASE-8-1 P8-1, S67/S68). A mismatch → 403 `forbidden`, nothing else changes. */
class RequireSurface
{
    public function handle(Request $request, Closure $next, string ...$surfaces): Response
    {
        if ($request->user() !== null && ! in_array(SessionSurface::of($request), $surfaces, true)) {
            throw new ApiException(403, 'forbidden', 'This action is not available in this session.');
        }

        return $next($request);
    }
}

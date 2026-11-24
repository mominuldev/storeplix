<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Transfers\Http;

use App\Domain\Shared\Idempotency\IdempotencyGuard;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware `idempotent.optional:{scope}` for POST /stock-transfers (PHASE-8-8C §7): an `Idempotency-Key` is
 * optional: when sent it is honoured (IdempotencyGuard: one transfer per key, the answer replayed), which the client
 * does for create-and-send (`send: true`); without one the request just runs.
 */
final class IdempotentWhenKeyed
{
    public function __construct(private readonly IdempotencyGuard $guard) {}

    public function handle(Request $request, Closure $next, string $scope): Response
    {
        if ((string) $request->header(IdempotencyGuard::HEADER, '') !== '') {
            return $this->guard->handle($request, $next, $scope);
        }

        return $next($request);
    }
}

<?php

namespace App\Domain\Tenancy\Middleware;

use App\Domain\Tenancy\Database\RlsSession;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Global middleware, FIRST in the stack (PHASE-5B-CONTRACT §2.5.1): every request starts with empty
 * app.tenant_id / app.user_id on an already-open connection (Octane, a test's second request), even when the
 * previous request ended with an exception. A connection opened later starts empty anyway.
 */
class ResetDatabaseTenant
{
    public function __construct(private readonly RlsSession $rls) {}

    public function handle(Request $request, Closure $next): Response
    {
        $this->rls->reset();

        return $next($request);
    }
}

<?php

namespace App\Domain\Tenancy\Middleware;

use App\Domain\Tenancy\Database\RlsSession;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Runs right after auth:sanctum (priority list): app.user_id = the authenticated user (PHASE-5B-CONTRACT §2.4 B2,
 * §2.5.2), so the tenant_users policy shows the user's own memberships before a tenant is resolved. Never
 * authenticates by itself: it only reads a user an auth middleware already resolved.
 */
class SetDatabaseUser
{
    public function __construct(private readonly RlsSession $rls) {}

    public function handle(Request $request, Closure $next): Response
    {
        if ($this->rls->enabled()) {
            $guard = Auth::guard();
            $id = $guard->hasUser() ? $guard->id() : null;

            if ($id !== null && (string) $id !== $this->rls->userId()) {
                $this->rls->setUser((string) $id);
            }
        }

        return $next($request);
    }
}

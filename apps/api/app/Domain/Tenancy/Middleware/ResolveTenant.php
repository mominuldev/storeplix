<?php

namespace App\Domain\Tenancy\Middleware;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Database\RlsSession;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware "tenant": resolves X-Tenant-Id against the authenticated user's
 * tenant_users membership and sets the TenantContext. Must run after auth:sanctum.
 *
 * Non-member, unknown and malformed tenant ids all return the same 403 so tenant ids
 * cannot be enumerated.
 */
class ResolveTenant
{
    public const HEADER = 'X-Tenant-Id';

    public function __construct(
        private readonly TenantContext $context,
        private readonly RlsSession $rls,
    ) {}

    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if ($user === null) {
            throw new ApiException(401, 'unauthenticated', 'Unauthenticated.');
        }

        $tenantId = trim((string) $request->header(self::HEADER, ''));

        if ($tenantId === '') {
            throw new ApiException(400, 'tenant_required', 'The X-Tenant-Id header is required.');
        }

        $tenantId = strtolower($tenantId);

        // Phase 5b (B2): the membership lookup below runs before a tenant is set; under RLS it relies on
        // app.user_id (normally already set by SetDatabaseUser right after auth:sanctum).
        if ($this->rls->enabled() && $this->rls->userId() !== (string) $user->getAuthIdentifier()) {
            $this->rls->setUser((string) $user->getAuthIdentifier());
        }

        $membership = Str::isUlid($tenantId)
            ? TenantUser::query()->where('tenant_id', $tenantId)->where('user_id', $user->getAuthIdentifier())->first()
            : null;

        $tenant = $membership ? Tenant::query()->find($membership->tenant_id) : null;

        if ($membership === null || $tenant === null) {
            throw new ApiException(403, 'tenant_forbidden', 'You do not have access to this tenant.');
        }

        if (! $tenant->isActive()) {
            throw new ApiException(403, 'tenant_suspended', 'This tenant is suspended.');
        }

        $this->context->set($tenant, $membership->role);

        try {
            return $next($request);
        } finally {
            $this->context->clear();
        }
    }
}

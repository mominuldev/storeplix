<?php

namespace App\Domain\Tenancy\Middleware;

use App\Domain\Admin\Impersonation\Http\ReadOnlyImpersonation;
use App\Domain\Admin\Impersonation\ImpersonationSession;
use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
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
 *
 * Phase 8.1 (PHASE-8-1 P8-10, S72): in an `impersonation` session the tenant comes from the active
 * `platform_impersonations` row (platform table, app connection), not from `tenant_users`: X-Tenant-Id must equal
 * its target (any other id → 403 `forbidden`, even one the staff user is a member of), the effective role is
 * `owner`, and a suspended tenant stays viewable. Each such request bumps `request_count` / `last_request_at`
 * (one UPDATE). RLS GUCs: app.user_id = the staff user, app.tenant_id = the target (TenantContext), as for members.
 */
class ResolveTenant
{
    public const HEADER = 'X-Tenant-Id';

    public function __construct(
        private readonly TenantContext $context,
        private readonly RlsSession $rls,
        private readonly ImpersonationSession $impersonation,
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

        if ($request->hasSession() && ImpersonationSession::isImpersonating($request)) {
            [$tenant, $role] = $this->impersonated($request, $tenantId);
        } else {
            [$tenant, $role] = $this->member($user->getAuthIdentifier(), $tenantId);
        }

        $this->context->set($tenant, $role);

        try {
            return $next($request);
        } finally {
            $this->context->clear();
        }
    }

    /** @return array{0: Tenant, 1: string} */
    private function member(mixed $userId, string $tenantId): array
    {
        $membership = Str::isUlid($tenantId)
            ? TenantUser::query()->where('tenant_id', $tenantId)->where('user_id', $userId)->first()
            : null;

        $tenant = $membership ? Tenant::query()->find($membership->tenant_id) : null;

        if ($membership === null || $tenant === null) {
            throw new ApiException(403, 'tenant_forbidden', 'You do not have access to this tenant.');
        }

        if (! $tenant->isActive()) {
            throw new ApiException(403, 'tenant_suspended', 'This tenant is suspended.');
        }

        return [$tenant, $membership->role];
    }

    /** @return array{0: Tenant, 1: string} */
    private function impersonated(Request $request, string $tenantId): array
    {
        $row = $this->impersonation->current($request); // 401 impersonation_ended
        ReadOnlyImpersonation::assertReadOnly($request); // 403 impersonation_read_only, before bindings and the counter

        if ($tenantId !== $row->target_tenant_id) {
            throw new ApiException(403, 'forbidden', 'This action is not available in this session.');
        }

        $tenant = Tenant::query()->find($row->target_tenant_id)
            ?? throw new ApiException(403, 'forbidden', 'This action is not available in this session.');

        PlatformImpersonation::query()->whereKey($row->id)->toBase()
            ->increment('request_count', 1, ['last_request_at' => now()]);

        return [$tenant, TenantUser::ROLE_OWNER];
    }
}

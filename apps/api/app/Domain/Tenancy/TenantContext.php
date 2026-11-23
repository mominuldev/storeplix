<?php

namespace App\Domain\Tenancy;

use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Database\RlsSession;
use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use App\Domain\Tenancy\Models\Tenant;

/**
 * Holds the tenant for the current request / job / command.
 *
 * Registered as a *scoped* singleton: it is reset between requests (Octane)
 * and between queue jobs, so tenant state can never leak across units of work.
 *
 * Phase 5b (RLS): every change is mirrored into the Postgres GUC app.tenant_id (RlsSession), and switching to a
 * different tenant inside an open transaction throws TenantSwitchInTransaction.
 *
 * Phase 8.3 (P83-5): besides the role kind (owner|admin|staff|custom) it carries the member's resolved PermissionSet
 * and role id. Callers that pass only a system role kind (jobs, console, tests) get that system role's set.
 */
final class TenantContext
{
    private ?string $tenantId = null;

    private ?Tenant $tenant = null;

    private ?string $role = null;

    private ?PermissionSet $permissions = null;

    private ?string $roleId = null;

    public function set(Tenant|string $tenant, ?string $role = null, ?PermissionSet $permissions = null, ?string $roleId = null): void
    {
        $this->rls()->assertCanSwitch($this->tenantId, $tenant instanceof Tenant ? (string) $tenant->getKey() : $tenant);

        if ($tenant instanceof Tenant) {
            $this->tenant = $tenant;
            $this->tenantId = (string) $tenant->getKey();
        } else {
            $this->tenant = null;
            $this->tenantId = $tenant;
        }

        $this->role = $role;
        $this->permissions = $permissions ?? self::defaultPermissions($role);
        $this->roleId = $roleId;
        $this->rls()->applyTenant($this->tenantId);
    }

    public function clear(): void
    {
        $this->tenantId = null;
        $this->tenant = null;
        $this->role = null;
        $this->permissions = null;
        $this->roleId = null;
        $this->rls()->applyTenant(null);
    }

    public function has(): bool
    {
        return $this->tenantId !== null;
    }

    public function id(): ?string
    {
        return $this->tenantId;
    }

    /**
     * @throws MissingTenantContextException
     */
    public function requireId(): string
    {
        return $this->tenantId ?? throw new MissingTenantContextException;
    }

    public function tenant(): ?Tenant
    {
        if ($this->tenant === null && $this->tenantId !== null) {
            $this->tenant = Tenant::query()->find($this->tenantId);
        }

        return $this->tenant;
    }

    /** Role kind of the authenticated user inside the current tenant (owner|admin|staff|custom), if any. */
    public function role(): ?string
    {
        return $this->role;
    }

    /** The member's roles.id (null outside a member request, e.g. jobs or impersonation). */
    public function roleId(): ?string
    {
        return $this->roleId;
    }

    /** Resolved permissions of the acting member (empty when no member acts). */
    public function permissions(): PermissionSet
    {
        return $this->permissions ?? PermissionSet::none();
    }

    public function allows(Permission $permission): bool
    {
        return $this->permissions()->has($permission);
    }

    public function allowsAny(Permission ...$permissions): bool
    {
        return $this->permissions()->hasAny(...$permissions);
    }

    private static function defaultPermissions(?string $role): ?PermissionSet
    {
        return $role === null ? null : SystemRole::tryFrom($role)?->permissions();
    }

    /**
     * Run a callback inside the given tenant, restoring the previous context afterwards.
     *
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public function run(Tenant|string $tenant, callable $callback, ?string $role = null, ?PermissionSet $permissions = null): mixed
    {
        $previous = [$this->tenantId, $this->tenant, $this->role, $this->permissions, $this->roleId];

        $this->set($tenant, $role, $permissions);

        try {
            return $callback();
        } finally {
            $changed = $previous[0] !== $this->tenantId;
            [$this->tenantId, $this->tenant, $this->role, $this->permissions, $this->roleId] = $previous;
            if ($changed) {
                $this->rls()->applyTenant($this->tenantId);
            }
        }
    }

    private function rls(): RlsSession
    {
        return app(RlsSession::class);
    }
}

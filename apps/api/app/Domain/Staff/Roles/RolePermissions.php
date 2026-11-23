<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles;

use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * P83-5: the permission set of a role. System roles → SystemRole (code; `role_permissions` rows of a system role are
 * ignored, S95). Custom roles → their `role_permissions` keys, cached per tenant under
 * `roles:{role_id}:r{revision}:permissions` (1 h): every edit bumps the revision, so a change is visible on the
 * member's next request without a flush (S97). Unknown keys are dropped (S99).
 */
final class RolePermissions
{
    public const TTL = 3600;

    public static function for(Role $role): PermissionSet
    {
        if (($system = $role->systemRole()) !== null) {
            return $system->permissions();
        }

        $load = fn (): array => DB::table('role_permissions')
            ->where('tenant_id', $role->tenant_id)->where('role_id', $role->id)->pluck('permission')
            ->map(fn ($p) => (string) $p)->all();

        // The tenant-prefixed cache needs the role's tenant as the current context (request path). Elsewhere
        // (/auth/me lists every membership without a tenant) the rows are read directly (RLS: member read policy).
        $keys = app(TenantContext::class)->id() === $role->tenant_id
            ? app(TenantCache::class)->remember(self::cacheKey($role), self::TTL, $load)
            : $load();

        return PermissionSet::fromKeys($keys);
    }

    public static function cacheKey(Role $role): string
    {
        return "roles:{$role->id}:r{$role->revision}:permissions";
    }
}

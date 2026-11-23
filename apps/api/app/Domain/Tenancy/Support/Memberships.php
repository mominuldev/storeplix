<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Support;

use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Staff\Roles\RolePermissions;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Scopes\TenantScope;
use Illuminate\Support\Collection;

/**
 * TenantMembership (PHASE-8-3 §6.2): `{ id, name, role, role_id, role_name, permissions }` for /auth/me, token
 * responses and invitation acceptance. Lists memberships of several tenants without a tenant context: the role rows
 * are read across those tenants (explicit ids; RLS: the roles / role_permissions member-read policy).
 */
final class Memberships
{
    /**
     * @param  Collection<int, Tenant>  $tenants  loaded through User::tenants (pivot: role, role_id)
     * @return list<array<string, mixed>>
     */
    public static function list(Collection $tenants): array
    {
        $ids = $tenants->map(fn (Tenant $t) => $t->pivot?->role_id)->filter()->unique()->values()->all();
        $roles = $ids === [] ? collect() : Role::query()->withoutGlobalScope(TenantScope::class)->whereIn('id', $ids)
            ->get(['id', 'tenant_id', 'key', 'name', 'is_system', 'revision'])->keyBy('id');

        return $tenants->sortBy('pivot.created_at')->values()
            ->map(fn (Tenant $t) => self::shape($t, (string) $t->pivot->role, $roles->get($t->pivot->role_id)))
            ->all();
    }

    /** @return array<string, mixed> */
    public static function shape(Tenant $tenant, string $kind, ?Role $role): array
    {
        // A role from another tenant can never apply (defence in depth).
        $role = $role !== null && $role->tenant_id === $tenant->id ? $role : null;
        $permissions = $role !== null ? RolePermissions::for($role) : PermissionSet::none();

        return [
            'id' => $tenant->id,
            'name' => $tenant->name,
            'role' => $kind,
            'role_id' => $role?->id,
            'role_name' => $role?->name ?? SystemRole::tryFrom($kind)?->label() ?? 'Custom role',
            'permissions' => $permissions->keys(),
        ];
    }

    /** Impersonation (P8-10): the owner set, owner role of the target tenant. @return array<string, mixed> */
    public static function owner(Tenant $tenant, ?string $ownerRoleId): array
    {
        return [
            'id' => $tenant->id,
            'name' => $tenant->name,
            'role' => SystemRole::Owner->value,
            'role_id' => $ownerRoleId,
            'role_name' => SystemRole::Owner->label(),
            'permissions' => SystemRole::Owner->permissions()->keys(),
        ];
    }
}

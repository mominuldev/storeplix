<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Identity\Models\User;
use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Staff\Roles\RolePermissions;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;

/**
 * Members who may work the Inbox (PHASE-8-8E P88E-4, S245): the current tenant's members whose role grants
 * `inbox.manage` (system roles from code, custom roles from their keys). Inside the tenant context.
 */
final class InboxMembers
{
    public function __construct(private readonly TenantContext $context) {}

    /** @return list<array{user: User, role_name: string}> */
    public function all(): array
    {
        $tenantId = $this->context->requireId();
        $memberships = TenantUser::query()->where('tenant_id', $tenantId)->get(['user_id', 'role_id']);
        $roles = Role::query()->whereIn('id', $memberships->pluck('role_id')->filter()->unique()->values()->all())->get()->keyBy('id');
        $users = User::query()->whereIn('id', $memberships->pluck('user_id')->all())->get()->keyBy('id');
        $out = [];
        foreach ($memberships as $membership) {
            /** @var Role|null $role */
            $role = $roles[$membership->role_id] ?? null;
            $user = $users[$membership->user_id] ?? null;
            if ($role === null || $user === null || ! RolePermissions::for($role)->has(Permission::InboxManage)) {
                continue;
            }
            $out[] = ['user' => $user, 'role_name' => $role->systemRole()?->label() ?? $role->name];
        }

        return $out;
    }

    public function holds(string $userId): bool
    {
        $membership = TenantUser::query()->where('tenant_id', $this->context->requireId())->where('user_id', strtolower($userId))->first(['role_id']);
        $role = $membership?->role_id === null ? null : Role::query()->whereKey($membership->role_id)->first();

        return $role !== null && RolePermissions::for($role)->has(Permission::InboxManage);
    }
}

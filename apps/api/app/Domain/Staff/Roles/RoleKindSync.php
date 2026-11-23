<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles;

use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * P83-3: `tenant_users.role` / `staff_invitations.role` is the denormalised kind of `role_id`
 * (`roles.key ?? 'custom'`), written in the same statement. Model hooks call this on create and update:
 *  - role_id set or changed → role = that role's kind (the role must belong to the row's tenant);
 *  - only a system kind given (legacy writes, tests) → role_id = that tenant's system role.
 */
final class RoleKindSync
{
    public static function apply(Model $model): void
    {
        $tenantId = (string) ($model->getAttribute('tenant_id') ?? app(TenantContext::class)->requireId());
        $roleId = $model->getAttribute('role_id');

        if ($roleId !== null && (! $model->exists || $model->isDirty('role_id'))) {
            $row = DB::table('roles')->where('tenant_id', $tenantId)->where('id', $roleId)->first(['key']);
            if ($row === null) {
                throw new LogicException('role_id is not a role of this tenant.');
            }
            $model->setAttribute('role', $row->key ?? 'custom');

            return;
        }

        $kind = SystemRole::tryFrom((string) $model->getAttribute('role'));
        if ($kind !== null && ($roleId === null || $model->isDirty('role'))) {
            $model->setAttribute('role_id', SystemRoles::ensure($tenantId)[$kind->value]);

            return;
        }

        if ($roleId === null) {
            throw new LogicException('A membership or invitation needs a role_id (or a system role kind).');
        }
    }
}

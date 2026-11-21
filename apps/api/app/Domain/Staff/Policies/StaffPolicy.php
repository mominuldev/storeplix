<?php

namespace App\Domain\Staff\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\TenantUser;

/**
 * Staff management (ADR 0005): owner + admin; admins act on admins/staff but never the owner
 * (owner protection is a 409 `last_owner`, enforced in the controller after this check).
 * Leaving the shop (deleting your own membership) is allowed for every role.
 */
class StaffPolicy
{
    use Authorizes;

    public function viewAny(User $user): bool
    {
        return $this->can(Permission::ManageStaff);
    }

    public function invite(User $user): bool
    {
        return $this->can(Permission::ManageStaff);
    }

    public function manageInvitation(User $user, StaffInvitation $invitation): bool
    {
        return $this->inCurrentTenant($invitation) && $this->can(Permission::ManageStaff);
    }

    public function updateRole(User $user, TenantUser $member): bool
    {
        return $this->inCurrentTenant($member) && $this->can(Permission::ManageStaff);
    }

    public function remove(User $user, TenantUser $member): bool
    {
        if (! $this->inCurrentTenant($member)) {
            return false;
        }

        return $member->user_id === $user->getKey() || $this->can(Permission::ManageStaff);
    }
}

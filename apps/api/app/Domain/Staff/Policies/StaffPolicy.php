<?php

namespace App\Domain\Staff\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\TenantUser;

/**
 * Staff management (PHASE-8-3 §3, §4): staff.manage; nobody acts on the owner (409 `last_owner`) and the
 * non-delegation rules N5/N6 run in StaffService. Leaving the shop (deleting your own membership) is base access.
 */
class StaffPolicy
{
    use Authorizes;

    public function viewAny(User $user): bool
    {
        return $this->can(Permission::StaffManage);
    }

    public function invite(User $user): bool
    {
        return $this->can(Permission::StaffManage);
    }

    public function manageInvitation(User $user, StaffInvitation $invitation): bool
    {
        return $this->inCurrentTenant($invitation) && $this->can(Permission::StaffManage);
    }

    public function updateRole(User $user, TenantUser $member): bool
    {
        return $this->inCurrentTenant($member) && $this->can(Permission::StaffManage);
    }

    public function remove(User $user, TenantUser $member): bool
    {
        if (! $this->inCurrentTenant($member)) {
            return false;
        }

        return $member->user_id === $user->getKey() || $this->can(Permission::StaffManage);
    }
}

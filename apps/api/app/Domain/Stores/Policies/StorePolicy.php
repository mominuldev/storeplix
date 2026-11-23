<?php

namespace App\Domain\Stores\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;

/**
 * Authorization on top of tenant scoping (defence in depth): even if a Store from another
 * tenant were loaded, the policy denies access unless it belongs to the current tenant.
 */
class StorePolicy
{
    use Authorizes;

    /** Base access (PHASE-8-3 §3.1): every member; route keys (`perm:`) guard the rest. */
    public function viewAny(User $user): bool
    {
        return $this->member();
    }

    public function view(User $user, Store $store): bool
    {
        return $this->inCurrentTenant($store);
    }

    public function create(User $user): bool
    {
        return $this->can(Permission::SettingsManage);
    }

    public function update(User $user, Store $store): bool
    {
        return $this->inCurrentTenant($store) && $this->can(Permission::SettingsManage);
    }

    /** Any member of the owning tenant may preview its (draft) storefront. */
    public function preview(User $user, Store $store): bool
    {
        return $this->view($user, $store);
    }
}

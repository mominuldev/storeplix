<?php

namespace App\Domain\Customers\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;
use Illuminate\Database\Eloquent\Model;

/** Customers (P4-14, P4-15): every role views, creates, edits and adds notes; owner/admin delete. */
class CustomerPolicy
{
    use Authorizes;

    public function view(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model) && $this->can(Permission::Operate);
    }

    public function update(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model) && $this->can(Permission::Operate);
    }

    public function delete(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model) && $this->can(Permission::ManageCatalog);
    }
}

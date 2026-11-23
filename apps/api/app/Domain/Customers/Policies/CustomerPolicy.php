<?php

namespace App\Domain\Customers\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;
use Illuminate\Database\Eloquent\Model;

/** Customers (PHASE-8-3 §3.2): customers.view reads, customers.edit creates/edits/adds notes, customers.delete deletes. */
class CustomerPolicy
{
    use Authorizes;

    public function view(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model) && $this->can(Permission::CustomersView);
    }

    public function update(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model) && $this->can(Permission::CustomersEdit);
    }

    public function delete(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model) && $this->can(Permission::CustomersDelete);
    }
}

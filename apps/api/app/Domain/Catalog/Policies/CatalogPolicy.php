<?php

namespace App\Domain\Catalog\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;
use Illuminate\Database\Eloquent\Model;

/**
 * Products and categories: reading is base access, writing needs products.edit, deleting products.delete (PHASE-8-3 §3).
 * Tenant check is defence in depth on top of BelongsToTenant + scoped route bindings.
 */
class CatalogPolicy
{
    use Authorizes;

    public function view(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model);
    }

    public function update(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model) && $this->can(Permission::ProductsEdit);
    }

    public function delete(User $user, Model $model): bool
    {
        return $this->inCurrentTenant($model) && $this->can(Permission::ProductsDelete);
    }
}

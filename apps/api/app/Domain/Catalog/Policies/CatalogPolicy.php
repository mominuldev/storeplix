<?php

namespace App\Domain\Catalog\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;
use Illuminate\Database\Eloquent\Model;

/**
 * Products and categories (P4-14): any role operates; only owner/admin delete (ManageCatalog).
 * Tenant check is defence in depth on top of BelongsToTenant + scoped route bindings.
 */
class CatalogPolicy
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

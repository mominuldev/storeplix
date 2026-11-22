<?php

declare(strict_types=1);

namespace App\Domain\Domains\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;

/** PHASE-6 §4.1: reads O A S (`Operate`), writes O A (`ManageDomains`), always inside the current tenant. */
class StoreDomainPolicy
{
    use Authorizes;

    public function viewAny(User $user): bool
    {
        return $this->can(Permission::Operate);
    }

    public function view(User $user, StoreDomain $domain): bool
    {
        return $this->inCurrentTenant($domain) && $this->can(Permission::Operate);
    }

    public function create(User $user): bool
    {
        return $this->can(Permission::ManageDomains);
    }

    public function update(User $user, StoreDomain $domain): bool
    {
        return $this->inCurrentTenant($domain) && $this->can(Permission::ManageDomains);
    }

    public function delete(User $user, StoreDomain $domain): bool
    {
        return $this->update($user, $domain);
    }
}

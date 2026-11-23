<?php

declare(strict_types=1);

namespace App\Domain\Domains\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;

/** PHASE-6 §4.1 / PHASE-8-3 §3: reads are base access, writes need domains.manage, always inside the current tenant. */
class StoreDomainPolicy
{
    use Authorizes;

    public function viewAny(User $user): bool
    {
        return $this->member();
    }

    public function view(User $user, StoreDomain $domain): bool
    {
        return $this->inCurrentTenant($domain);
    }

    public function create(User $user): bool
    {
        return $this->can(Permission::DomainsManage);
    }

    public function update(User $user, StoreDomain $domain): bool
    {
        return $this->inCurrentTenant($domain) && $this->can(Permission::DomainsManage);
    }

    public function delete(User $user, StoreDomain $domain): bool
    {
        return $this->update($user, $domain);
    }
}

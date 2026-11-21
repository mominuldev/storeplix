<?php

namespace App\Domain\Stores\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;

/**
 * Authorization on top of tenant scoping (defence in depth): even if a Store from another
 * tenant were loaded, the policy denies access unless it belongs to the current tenant.
 */
class StorePolicy
{
    public function __construct(private readonly TenantContext $context) {}

    public function viewAny(User $user): bool
    {
        return $this->context->role() !== null;
    }

    public function view(User $user, Store $store): bool
    {
        return $this->inCurrentTenant($store) && $this->context->role() !== null;
    }

    public function create(User $user): bool
    {
        return in_array($this->context->role(), [TenantUser::ROLE_OWNER, TenantUser::ROLE_ADMIN], true);
    }

    public function update(User $user, Store $store): bool
    {
        return $this->inCurrentTenant($store)
            && in_array($this->context->role(), [TenantUser::ROLE_OWNER, TenantUser::ROLE_ADMIN], true);
    }

    private function inCurrentTenant(Store $store): bool
    {
        return $this->context->has() && $store->tenant_id === $this->context->id();
    }
}

<?php

namespace App\Domain\Tenancy;

use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use App\Domain\Tenancy\Models\Tenant;

/**
 * Holds the tenant for the current request / job / command.
 *
 * Registered as a *scoped* singleton: it is reset between requests (Octane)
 * and between queue jobs, so tenant state can never leak across units of work.
 */
final class TenantContext
{
    private ?string $tenantId = null;

    private ?Tenant $tenant = null;

    private ?string $role = null;

    public function set(Tenant|string $tenant, ?string $role = null): void
    {
        if ($tenant instanceof Tenant) {
            $this->tenant = $tenant;
            $this->tenantId = (string) $tenant->getKey();
        } else {
            $this->tenant = null;
            $this->tenantId = $tenant;
        }

        $this->role = $role;
    }

    public function clear(): void
    {
        $this->tenantId = null;
        $this->tenant = null;
        $this->role = null;
    }

    public function has(): bool
    {
        return $this->tenantId !== null;
    }

    public function id(): ?string
    {
        return $this->tenantId;
    }

    /**
     * @throws MissingTenantContextException
     */
    public function requireId(): string
    {
        return $this->tenantId ?? throw new MissingTenantContextException;
    }

    public function tenant(): ?Tenant
    {
        if ($this->tenant === null && $this->tenantId !== null) {
            $this->tenant = Tenant::query()->find($this->tenantId);
        }

        return $this->tenant;
    }

    /** Role of the authenticated user inside the current tenant (owner|admin|staff), if any. */
    public function role(): ?string
    {
        return $this->role;
    }

    /**
     * Run a callback inside the given tenant, restoring the previous context afterwards.
     *
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public function run(Tenant|string $tenant, callable $callback, ?string $role = null): mixed
    {
        $previous = [$this->tenantId, $this->tenant, $this->role];

        $this->set($tenant, $role);

        try {
            return $callback();
        } finally {
            [$this->tenantId, $this->tenant, $this->role] = $previous;
        }
    }
}

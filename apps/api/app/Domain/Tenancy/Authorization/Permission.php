<?php

namespace App\Domain\Tenancy\Authorization;

use App\Domain\Tenancy\Models\TenantUser;

/**
 * ADR 0005 permission matrix (code-defined; Phase 8 replaces it with custom roles).
 *
 * | Permission                                   | owner | admin | staff |
 * |----------------------------------------------|-------|-------|-------|
 * | catalog/orders/customers, media upload       |   ✓   |   ✓   |   ✓   |
 * | refunds, cancel paid orders                  |   ✓   |   ✓   |   –   |
 * | store settings, themes, pages, shipping      |   ✓   |   ✓   |   –   |
 * | domains, credentials, staff management       |   ✓   | ✓ (not the owner) | – |
 * | billing view (Phase 2 contract: O A)         |   ✓   |   ✓   |   –   |
 * | billing manage, delete tenant, transfer      |   ✓   |   –   |   –   |
 * | audit log                                    |   ✓   |   ✓   |   –   |
 */
enum Permission: string
{
    case Operate = 'operate';
    case ManageRefunds = 'manage_refunds';
    case ManageSettings = 'manage_settings';
    case ManageStaff = 'manage_staff';
    case ManageDomains = 'manage_domains';
    case ViewBilling = 'view_billing';
    case ManageBilling = 'manage_billing';
    case ViewAudit = 'view_audit';

    /** @return list<string> */
    public function roles(): array
    {
        return match ($this) {
            self::Operate => [TenantUser::ROLE_OWNER, TenantUser::ROLE_ADMIN, TenantUser::ROLE_STAFF],
            self::ManageBilling => [TenantUser::ROLE_OWNER],
            default => [TenantUser::ROLE_OWNER, TenantUser::ROLE_ADMIN],
        };
    }

    public function grantedTo(?string $role): bool
    {
        return $role !== null && in_array($role, $this->roles(), true);
    }
}

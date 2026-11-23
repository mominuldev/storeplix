<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Authorization;

/**
 * PHASE-8-3 §2.2 (P83-2): the three system roles every tenant has as `roles` rows (`key`, `is_system`). Their
 * permission sets live here, in code, never in `role_permissions`, so they can't drift per tenant and pick up new
 * keys automatically. Never editable.
 */
enum SystemRole: string
{
    case Owner = 'owner';
    case Admin = 'admin';
    case Staff = 'staff';

    public function permissions(): PermissionSet
    {
        return match ($this) {
            self::Owner => PermissionSet::all(),
            self::Admin => new PermissionSet(Permission::grantableCases()),
            self::Staff => new PermissionSet([
                Permission::OrdersView, Permission::OrdersProcess, Permission::ShipmentsManage, Permission::ShipmentsCancel,
                Permission::ProductsEdit, Permission::InventoryAdjust, Permission::CustomersView, Permission::CustomersEdit,
                Permission::ReportsView,
            ]),
        };
    }

    /** Display name (UI label "Manager" for admin). */
    public function label(): string
    {
        return match ($this) {
            self::Owner => 'Owner',
            self::Admin => 'Manager',
            self::Staff => 'Staff',
        };
    }

    public function description(): string
    {
        return match ($this) {
            self::Owner => 'Full access, billing & staff',
            self::Admin => 'Everything except billing & ownership',
            self::Staff => 'Products, inventory, orders & customers',
        };
    }

    /** List order: owner, admin, staff. */
    public function position(): int
    {
        return match ($this) {
            self::Owner => 0,
            self::Admin => 1,
            self::Staff => 2,
        };
    }
}

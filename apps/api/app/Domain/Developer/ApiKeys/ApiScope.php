<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys;

use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;

/**
 * PHASE-8-4 §2.2 (Q128): the 7 API key scopes. Case order = UI order. Each scope has a backing permission (P84-5):
 * the creator may grant a scope only when their PermissionSet holds it (`null` = base access, every member). At use
 * time a key acts with exactly the backing permissions of its scopes (plus `costs.view` when `include_costs`).
 */
enum ApiScope: string
{
    case OrdersRead = 'orders:read';
    case OrdersWrite = 'orders:write';
    case ProductsRead = 'products:read';
    case ProductsWrite = 'products:write';
    case InventoryRead = 'inventory:read';
    case InventoryWrite = 'inventory:write';
    case CustomersRead = 'customers:read';

    /** Figma tag text. */
    public function label(): string
    {
        return match ($this) {
            self::OrdersRead => 'Orders · read',
            self::OrdersWrite => 'Orders · write',
            self::ProductsRead => 'Products',
            self::ProductsWrite => 'Products · write',
            self::InventoryRead => 'Stock',
            self::InventoryWrite => 'Stock · write',
            self::CustomersRead => 'Customers · read',
        };
    }

    /** Resource group (orders|products|inventory|customers). */
    public function group(): string
    {
        return explode(':', $this->value)[0];
    }

    /** Backing permission (P84-5); null = base access. */
    public function backingPermission(): ?Permission
    {
        return match ($this) {
            self::OrdersRead => Permission::OrdersView,
            self::OrdersWrite => Permission::OrdersProcess,
            self::ProductsWrite => Permission::ProductsEdit,
            self::InventoryWrite => Permission::InventoryAdjust,
            self::CustomersRead => Permission::CustomersView,
            self::ProductsRead, self::InventoryRead => null,
        };
    }

    /** @return list<self> scopes a write scope implies (its read) */
    public function implies(): array
    {
        return match ($this) {
            self::OrdersWrite => [self::OrdersRead],
            self::ProductsWrite => [self::ProductsRead],
            self::InventoryWrite => [self::InventoryRead],
            default => [],
        };
    }

    /** May a member holding $held grant this scope (non-delegation)? */
    public function grantableBy(PermissionSet $held): bool
    {
        $backing = $this->backingPermission();

        return $backing === null || $held->has($backing);
    }

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $s) => $s->value, self::cases());
    }

    /**
     * Normalise a valid scope list: implied reads added, de-duplicated, catalogue order.
     *
     * @param  iterable<self>  $scopes
     * @return list<self>
     */
    public static function normalize(iterable $scopes): array
    {
        $set = [];
        foreach ($scopes as $scope) {
            $set[$scope->value] = true;
            foreach ($scope->implies() as $implied) {
                $set[$implied->value] = true;
            }
        }

        return array_values(array_filter(self::cases(), fn (self $s) => isset($set[$s->value])));
    }

    /**
     * Stored keys → scopes (unknown strings dropped: a stray value never grants anything).
     *
     * @param  iterable<mixed>  $values
     * @return list<self>
     */
    public static function fromStored(iterable $values): array
    {
        $out = [];
        foreach ($values as $value) {
            if (is_string($value) && ($scope = self::tryFrom($value)) !== null) {
                $out[] = $scope;
            }
        }

        return self::normalize($out);
    }

    /**
     * The PermissionSet a key acts with: backing permissions of its scopes (+ costs.view when the creator could see
     * costs, `include_costs`).
     *
     * @param  list<self>  $scopes
     */
    public static function permissionsFor(array $scopes, bool $includeCosts): PermissionSet
    {
        $permissions = array_values(array_filter(array_map(fn (self $s) => $s->backingPermission(), $scopes)));
        if ($includeCosts) {
            $permissions[] = Permission::CostsView;
        }

        return new PermissionSet($permissions);
    }
}

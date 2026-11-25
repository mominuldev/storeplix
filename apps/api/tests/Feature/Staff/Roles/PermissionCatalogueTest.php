<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Authorization\SystemRole;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-3 §10 PermissionCatalogueTest: §2.1 keys / groups / prerequisites, §2.2 system sets, types mirror. */
#[Group('roles')]
class PermissionCatalogueTest extends TestCase
{
    private const KEYS = [
        'orders.view', 'orders.process', 'orders.refund', 'pos.sell', 'fraud.manage', 'shipments.manage', 'shipments.cancel',
        'products.edit', 'products.delete', 'inventory.adjust', 'purchasing.manage', 'customers.view', 'customers.edit', 'customers.delete',
        'costs.view', 'reports.view', 'expenses.manage', 'data.export', 'data.import', 'marketing.manage', 'settings.manage',
        'integrations.manage', 'domains.manage', 'developers.manage', 'staff.manage', 'audit.view', 'billing.view', 'billing.manage',
    ];

    public function test_28_keys_in_catalogue_order_with_only_billing_manage_not_grantable(): void
    {
        $this->assertSame(self::KEYS, Permission::values());
        $this->assertCount(27, Permission::grantableCases()); // PHASE-8-7 §2.1: + expenses.manage; PHASE-8-8 §2.1: + fraud.manage; PHASE-8-8B §2.1: + purchasing.manage; PHASE-8-8D §2.1: + pos.sell
        $this->assertSame([Permission::BillingManage], array_values(array_filter(Permission::cases(), fn (Permission $p) => ! $p->grantable())));
        foreach (Permission::cases() as $p) {
            $this->assertMatchesRegularExpression('/^[a-z]+\.[a-z_]+$/', $p->value); // the DB CHECK
            $this->assertArrayHasKey($p->group(), Permission::GROUPS);
            $this->assertNotSame('', $p->label());
        }
        $this->assertSame(['orders', 'shipping', 'products', 'customers', 'money', 'store', 'team'], array_keys(Permission::GROUPS));
        $this->assertSame(
            ['orders.refund', 'fraud.manage', 'purchasing.manage', 'costs.view', 'expenses.manage', 'data.export', 'marketing.manage', 'integrations.manage', 'developers.manage', 'staff.manage', 'billing.manage'], // PHASE-8-5 §2.1: marketing.manage sensitive
            array_values(array_map(fn (Permission $p) => $p->value, array_filter(Permission::cases(), fn (Permission $p) => $p->sensitive()))),
        );
    }

    public function test_prerequisites_are_closed_acyclic_and_as_specified(): void
    {
        $expected = [
            'orders.process' => ['orders.view'], 'orders.refund' => ['orders.process'], 'fraud.manage' => ['orders.view'], 'shipments.cancel' => ['shipments.manage'],
            'products.delete' => ['products.edit'], 'purchasing.manage' => ['costs.view'], 'customers.edit' => ['customers.view'], 'customers.delete' => ['customers.edit'],
            'billing.manage' => ['billing.view'],
        ];
        foreach (Permission::cases() as $p) {
            $this->assertSame($expected[$p->value] ?? [], array_map(fn (Permission $r) => $r->value, $p->requires()), $p->value);
            // walk the chain: no cycles, and a grantable key never needs a non-grantable one
            $seen = [$p->value => true];
            $queue = $p->requires();
            while (($next = array_shift($queue)) !== null) {
                $this->assertArrayNotHasKey($next->value, $seen, "cycle at {$p->value}");
                $seen[$next->value] = true;
                if ($p->grantable()) {
                    $this->assertTrue($next->grantable());
                }
                array_push($queue, ...$next->requires());
            }
        }
    }

    public function test_system_role_sets(): void
    {
        $this->assertSame(self::KEYS, SystemRole::Owner->permissions()->keys());
        $this->assertSame(array_values(array_diff(self::KEYS, ['billing.manage'])), SystemRole::Admin->permissions()->keys());
        $this->assertSame([
            'orders.view', 'orders.process', 'pos.sell', 'shipments.manage', 'shipments.cancel', 'products.edit', 'inventory.adjust',
            'customers.view', 'customers.edit', 'reports.view', // PHASE-8-8D P88D-18: + pos.sell
        ], SystemRole::Staff->permissions()->keys());
        $this->assertSame(['Owner', 'Manager', 'Staff'], array_map(fn (SystemRole $r) => $r->label(), SystemRole::cases()));
        // every system set is closed under prerequisites
        foreach (SystemRole::cases() as $role) {
            foreach ($role->permissions()->toArray() as $p) {
                foreach ($p->requires() as $r) {
                    $this->assertTrue($role->permissions()->has($r), "{$role->value}: {$p->value} needs {$r->value}");
                }
            }
        }
    }

    public function test_permission_set_ignores_unknown_keys_and_orders_by_catalogue(): void
    {
        $set = PermissionSet::fromKeys(['staff.manage', 'orders.delete', 'orders.view', 42, 'ORDERS.VIEW']);
        $this->assertSame(['orders.view', 'staff.manage'], $set->keys());
        $this->assertSame([Permission::StaffManage], PermissionSet::fromKeys(['staff.manage'])->missingFrom(PermissionSet::fromKeys(['orders.view'])));
        $this->assertTrue(SystemRole::Owner->permissions()->contains(SystemRole::Admin->permissions()));
        $this->assertFalse(SystemRole::Admin->permissions()->contains(SystemRole::Owner->permissions()));
    }

    public function test_packages_types_mirror_the_enum(): void
    {
        $path = base_path('../../packages/types/src/index.ts');
        if (! is_file($path)) {
            $this->markTestSkipped('packages/types is not next to apps/api');
        }
        $ts = (string) file_get_contents($path);
        $this->assertSame(1, preg_match('/export const PERMISSION_KEYS[^=]*=\s*\[(.*?)\];/s', $ts, $m));
        preg_match_all("/'([a-z_.]+)'/", $m[1], $keys);
        $this->assertSame(Permission::values(), $keys[1]);

        $this->assertSame(1, preg_match('/staff:\s*\[(.*?)\]/s', substr($ts, (int) strpos($ts, 'SYSTEM_ROLE_PERMISSIONS')), $s));
        preg_match_all("/'([a-z_.]+)'/", $s[1], $staff);
        // Same keys in catalogue order (PHASE-8-8D: `pos.sell` right after `orders.process`, as in the enum).
        $this->assertSame(SystemRole::Staff->permissions()->keys(), $staff[1]);
    }
}

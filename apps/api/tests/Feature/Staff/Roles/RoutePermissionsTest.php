<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\RequirePermission;
use App\Domain\Tenancy\Middleware\ResolveTenant;
use Illuminate\Routing\Middleware\SubstituteBindings;
use Illuminate\Routing\Route;
use Illuminate\Routing\Router;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-3 §10 RoutePermissionsTest (S91): every route behind the `tenant` middleware carries exactly one `perm:`
 * and it equals the §3 table below (kept here, independently of routes/api.php); both directions; routes outside
 * `tenant` never carry one. A new tenant route fails this test until it is mapped.
 */
#[Group('roles')]
#[Group('security')]
class RoutePermissionsTest extends TestCase
{
    /** PHASE-8-3 §3 by route name (`a|b` = any of; base = every member). */
    private const MAP = [
        'audit.view' => [
            'audit-logs.index',
        ],
        'billing.view' => [
            'billing.invoices.index',
            'billing.invoices.pdf',
            'billing.invoices.show',
            'billing.payments.show',
            'billing.quote',
            'subscription.show',
        ],
        'billing.manage' => [
            'billing.change-plan',
            'billing.invoices.pay',
            'billing.scheduled-change.destroy',
            'dev.billing.clock',
        ],
        'base' => [
            'features.index',
            'media.index',
            'media.show',
            'page-templates.index',
            'staff.destroy',
            'stores.categories.index',
            'stores.categories.show',
            'stores.coupons.index',
            'stores.coupons.show',
            'stores.couriers.areas',
            'stores.couriers.index',
            'stores.couriers.pickup-stores',
            'stores.dashboard',
            'stores.document-templates.index',
            'stores.domains.index',
            'stores.domains.show',
            'stores.index',
            'stores.inventory.index',
            'stores.inventory.movements',
            'stores.launch-checklist',
            'stores.locations.index',
            'stores.navigation.index',
            'stores.pages.index',
            'stores.pages.show',
            'stores.payment-gateways.index',
            'stores.preview-token',
            'stores.products.index',
            'stores.products.show',
            'stores.settings.show',
            'stores.shipping.show',
            'stores.show',
            'stores.themes.index',
            'stores.themes.show',
            'themes.index',
        ],
        'products.edit|settings.manage' => [
            'media.destroy',
            'media.store',
        ],
        'staff.manage' => [
            'permissions.index',
            'roles.destroy',
            'roles.index',
            'roles.show',
            'roles.store',
            'roles.update',
            'staff.index',
            'staff.invitations.destroy',
            'staff.invitations.resend',
            'staff.invitations.store',
            'staff.update',
        ],
        'settings.manage' => [
            'stores.document-templates.update',
            'stores.locations.archive',
            'stores.locations.make-default',
            'stores.locations.store',
            'stores.locations.unarchive',
            'stores.locations.update',
            'stores.navigation.update',
            'stores.pages.destroy',
            'stores.pages.store',
            'stores.pages.update',
            'stores.pickup-locations.destroy',
            'stores.pickup-locations.store',
            'stores.pickup-locations.update',
            'stores.publish',
            'stores.settings.update',
            'stores.shipping.update',
            'stores.store',
            'stores.themes.apply',
            'stores.themes.discard',
            'stores.themes.draft',
            'stores.themes.publish',
        ],
        'products.edit' => [
            'stores.categories.reorder',
            'stores.categories.store',
            'stores.categories.update',
            'stores.products.bulk',
            'stores.products.duplicate',
            'stores.products.store',
            'stores.products.update',
        ],
        'products.delete' => [
            'stores.categories.destroy',
            'stores.products.destroy',
        ],
        'marketing.manage' => [
            'dev.message-sink',
            // PHASE-8-6 §2.1 / §9.1: every automation route is marketing.manage.
            'stores.automation-runs.index',
            'stores.automation-runs.show',
            'stores.automations.destroy',
            'stores.automations.disable',
            'stores.automations.dry-run',
            'stores.automations.enable',
            'stores.automations.index',
            'stores.automations.show',
            'stores.automations.stats',
            'stores.automations.store',
            'stores.automations.test-message',
            'stores.automations.update',
            'stores.campaigns.audience-preview',
            'stores.campaigns.cancel',
            'stores.campaigns.destroy',
            'stores.campaigns.duplicate',
            'stores.campaigns.estimate',
            'stores.campaigns.index',
            'stores.campaigns.schedule',
            'stores.campaigns.send',
            'stores.campaigns.show',
            'stores.campaigns.store',
            'stores.campaigns.test',
            'stores.campaigns.unschedule',
            'stores.campaigns.update',
            'stores.coupons.destroy',
            'stores.coupons.store',
            'stores.coupons.update',
            'stores.marketing.overview',
        ],
        // PHASE-8-5 §2.1: recipient lists need both keys (comma = all of).
        'marketing.manage,customers.view' => [
            'stores.campaigns.recipients',
        ],
        'integrations.manage' => [
            'stores.couriers.connect',
            'stores.couriers.disconnect',
            'stores.couriers.test',
            'stores.couriers.update',
            'stores.couriers.webhook-secret',
            'stores.payment-gateways.connect',
            'stores.payment-gateways.disconnect',
            'stores.payment-gateways.test-payment',
            'stores.payment-gateways.update',
        ],
        'customers.view' => [
            'stores.customers.index',
            'stores.customers.show',
        ],
        'customers.edit' => [
            'stores.customers.marketing-opt-out.destroy',
            'stores.customers.marketing-opt-out.store',
            'stores.customers.notes.destroy',
            'stores.customers.notes.store',
            'stores.customers.store',
            'stores.customers.update',
        ],
        'customers.delete' => [
            'stores.customers.destroy',
        ],
        'orders.view|shipments.manage' => [
            'stores.documents.preview',
            'stores.documents.show',
            'stores.documents.store',
            'stores.orders.index',
            'stores.orders.show',
        ],
        // PHASE-8-4 §6.1
        'developers.manage' => [
            'api-keys.destroy',
            'api-keys.index',
            'api-keys.store',
            'api-keys.update',
            'api-scopes.index',
            'dev.webhook-sink',
            'stores.webhook-deliveries.index',
            'stores.webhook-deliveries.resend',
            'stores.webhook-deliveries.resend-failed',
            'stores.webhook-deliveries.show',
            'stores.webhook-endpoints.destroy',
            'stores.webhook-endpoints.index',
            'stores.webhook-endpoints.store',
            'stores.webhook-endpoints.test',
            'stores.webhook-endpoints.update',
            'stores.webhook-secret.reveal',
            'stores.webhook-secret.rotate',
            'stores.webhook-secret.show',
            'webhook-event-types.index',
        ],
        'domains.manage' => [
            'stores.domains.destroy',
            'stores.domains.primary',
            'stores.domains.store',
            'stores.domains.verify',
        ],
        'data.export' => [
            'stores.exports.show',
            'stores.exports.store',
        ],
        'data.import' => [
            'stores.imports.destroy',
            'stores.imports.error-report',
            'stores.imports.rows',
            'stores.imports.run',
            'stores.imports.show',
            'stores.imports.store',
            'stores.imports.template',
            'stores.imports.validate',
        ],
        'inventory.adjust' => [
            'stores.inventory.adjust',
            'stores.inventory.update',
        ],
        'orders.view' => [
            'stores.orders.notes.store',
            'stores.orders.payment-links.index',
            'stores.orders.quote',
            'stores.orders.store',
            'stores.returns.index',
            'stores.returns.notes.store',
            'stores.returns.show',
        ],
        'orders.process' => [
            'stores.orders.bulk',
            'stores.orders.cancel',
            'stores.orders.confirm',
            'stores.orders.deliver',
            'stores.orders.guard.release',
            'stores.orders.items.quote',
            'stores.orders.items.update',
            'stores.orders.payment-links.destroy',
            'stores.orders.payment-links.resend',
            'stores.orders.payment-links.store',
            'stores.orders.ready',
            'stores.orders.restock',
            'stores.orders.return',
            'stores.orders.returns.store',
            'stores.orders.ship',
            'stores.orders.update',
            'stores.returns.approve',
            'stores.returns.close',
            'stores.returns.exchange-order',
            'stores.returns.receive',
            'stores.returns.reject',
        ],
        'orders.refund' => [
            'stores.orders.refunds.store',
        ],
        'shipments.manage' => [
            'stores.orders.shipments.store',
            'stores.shipments.bulk',
            'stores.shipments.refresh',
            'stores.shipments.sync',
        ],
        'shipments.cancel' => [
            'stores.shipments.cancel',
            'stores.shipments.mark-cancelled',
        ],
        'shipments.manage|orders.view' => [
            'stores.shipment-batches.show',
            'stores.shipments.index',
            'stores.shipments.show',
        ],
        'reports.view' => [
            'stores.reports.delivery',
            'stores.reports.profit',
            'stores.reports.sales',
        ],
        // PHASE-8-7 §2.1 / §8.1: every expense route (incl. receipts and export) is expenses.manage.
        'expenses.manage' => [
            'stores.expenses.destroy',
            'stores.expenses.export',
            'stores.expenses.index',
            'stores.expenses.receipt',
            'stores.expenses.receipts.store',
            'stores.expenses.show',
            'stores.expenses.store',
            'stores.expenses.summary',
            'stores.expenses.update',
        ],
        // PHASE-8-8 §2.1 / §8.1: the guard settings, blocklist, number check and decision log are fraud.manage.
        'fraud.manage' => [
            'stores.fraud-guard.blocked-numbers.destroy',
            'stores.fraud-guard.blocked-numbers.index',
            'stores.fraud-guard.blocked-numbers.store',
            'stores.fraud-guard.check',
            'stores.fraud-guard.events',
            'stores.fraud-guard.overview',
            'stores.fraud-guard.settings.reset',
            'stores.fraud-guard.settings.show',
            'stores.fraud-guard.settings.update',
        ],
        // PHASE-8-8B §8.1: suppliers, PO money routes, payments, PDF, suggestions are purchasing.manage.
        'purchasing.manage' => [
            'stores.purchase-orders.cancel',
            'stores.purchase-orders.close',
            'stores.purchase-orders.destroy',
            'stores.purchase-orders.mark-ordered',
            'stores.purchase-orders.pdf',
            'stores.purchase-orders.quick',
            'stores.purchase-orders.send',
            'stores.purchase-orders.store',
            'stores.purchase-orders.summary',
            'stores.purchase-orders.update',
            'stores.purchasing.reorder-suggestions',
            'stores.supplier-payments.destroy',
            'stores.suppliers.archive',
            'stores.suppliers.destroy',
            'stores.suppliers.index',
            'stores.suppliers.payments.index',
            'stores.suppliers.payments.store',
            'stores.suppliers.show',
            'stores.suppliers.store',
            'stores.suppliers.summary',
            'stores.suppliers.unarchive',
            'stores.suppliers.update',
        ],
        // P88B-11: listing, viewing and receiving (+ invoice upload) also with inventory.adjust (quantities only).
        'purchasing.manage|inventory.adjust' => [
            'stores.purchase-orders.index',
            'stores.purchase-orders.receipts.store',
            'stores.purchase-orders.show',
            'stores.purchasing.invoices.store',
        ],
    ];

    /** @return array<string, string> route name → perm spec */
    private static function expected(): array
    {
        $out = [];
        foreach (self::MAP as $spec => $names) {
            foreach ($names as $name) {
                $out[$name] = $spec;
            }
        }
        ksort($out);

        return $out;
    }

    /** @return list<string> */
    private function permMiddleware(Route $route): array
    {
        return array_values(array_filter($route->gatherMiddleware(), fn ($m) => is_string($m) && str_starts_with($m, RequirePermission::ALIAS.':')));
    }

    public function test_every_tenant_route_has_exactly_the_mapped_permission(): void
    {
        $actual = [];
        $problems = [];
        /** @var Route $route */
        foreach (app(Router::class)->getRoutes() as $route) {
            $perm = $this->permMiddleware($route);
            if (! in_array('tenant', $route->gatherMiddleware(), true)) {
                if ($perm !== []) {
                    $problems[] = "{$route->uri()} has perm: without the tenant middleware";
                }

                continue;
            }
            if (count($perm) !== 1) {
                $problems[] = "{$route->uri()} ({$route->getName()}) has ".count($perm).' perm: middleware';

                continue;
            }
            $actual[(string) $route->getName()] = substr($perm[0], strlen(RequirePermission::ALIAS) + 1);
        }
        ksort($actual);

        $this->assertSame([], $problems);
        $this->assertSame([], array_values(array_diff(array_keys($actual), array_keys(self::expected()))), 'tenant routes missing from the §3 table');
        $this->assertSame([], array_values(array_diff(array_keys(self::expected()), array_keys($actual))), '§3 rows without a route');
        $this->assertSame(self::expected(), $actual);
    }

    public function test_every_spec_names_known_keys(): void
    {
        foreach (array_keys(self::MAP) as $spec) {
            foreach (RequirePermission::parse($spec) as $permission) {
                $this->assertInstanceOf(Permission::class, $permission);
            }
        }
        $this->expectException(\InvalidArgumentException::class);
        RequirePermission::parse('orders.delete');
    }

    public function test_the_permission_check_runs_after_the_tenant_and_route_model_binding(): void
    {
        $priority = app(Router::class)->middlewarePriority;
        $bindings = array_search(SubstituteBindings::class, $priority, true);
        $tenant = array_search(ResolveTenant::class, $priority, true);
        $perm = array_search(RequirePermission::class, $priority, true);

        $this->assertIsInt($perm);
        $this->assertLessThan($bindings, $tenant);
        $this->assertGreaterThan($bindings, $perm);
    }
}

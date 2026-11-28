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
            'billing.sms-credits.ledger', // PHASE-8-9A §10.1
            'billing.invoices.pdf',
            'billing.invoices.show',
            'billing.payments.show',
            'billing.quote',
            'subscription.show',
        ],
        'billing.manage' => [
            'billing.change-plan',
            'billing.sms-credits.purchase', // PHASE-8-9A P89A-9: owner only
            'billing.invoices.pay',
            'billing.scheduled-change.destroy',
            'dev.billing.clock',
        ],
        'base' => [
            'features.index',
            // PHASE-8-9C §2.1: guides are readable (and votable) by every member.
            'help.articles.feedback.destroy',
            'help.articles.feedback.update',
            'help.articles.index',
            'help.articles.show',
            'help.categories.index',
            'help.categories.show',
            'help.home',
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
            // PHASE-8-8C part B (§9): transfer and count reads for every member.
            'stores.stock-counts.index',
            'stores.stock-counts.lines.index',
            'stores.stock-counts.show',
            'stores.stock-transfers.index',
            'stores.stock-transfers.show',
            'stores.stock-transfers.summary',
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
            'stores.inbox.settings.rotate', // PHASE-8-8E §4
            'stores.inbox.settings.update',
            'stores.document-templates.update',
            // PHASE-8-9A §10.1: template writes.
            'stores.sms.templates.destroy',
            'stores.sms.templates.preview',
            'stores.sms.templates.update',
            // PHASE-8-8D P88D-18: register writes.
            'stores.pos.registers.archive',
            'stores.pos.registers.store',
            'stores.pos.registers.unarchive',
            'stores.pos.registers.update',
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
            // PHASE-8-9D §13.1 (P89D-41): AI writer / photos, history, apply / undo.
            'stores.ai.generations.index',
            'stores.ai.generations.show',
            'stores.ai.photo-edits',
            'stores.ai.photo-edits.apply',
            'stores.ai.photo-edits.undo',
            'stores.ai.product-descriptions',
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
        // PHASE-8-9A §10.1 (P89A-25): SMS reads, test SMS, sender IDs, log and credits.
        'settings.manage|integrations.manage|billing.view' => [
            'stores.sms.show',
            'stores.sms.templates.index',
        ],
        'settings.manage|integrations.manage' => [
            'stores.sms.messages.index',
            'stores.sms.sender-ids.index',
            'stores.sms.test',
        ],
        'billing.view|settings.manage|integrations.manage' => [
            'billing.sms-credits.show',
        ],
        'billing.manage|settings.manage' => [
            'billing.sms-credits.update',
        ],
        'integrations.manage' => [
            'stores.sms.sender-ids.cancel',
            'stores.sms.sender-ids.store',
            'stores.couriers.connect',
            'stores.couriers.disconnect',
            'stores.couriers.test',
            'stores.couriers.update',
            'stores.couriers.webhook-secret',
            'stores.payment-gateways.connect',
            'stores.payment-gateways.disconnect',
            'stores.payment-gateways.test-payment',
            'stores.payment-gateways.update',
            // PHASE-8-9D §13.1 (P89D-41): writes, OAuth, accounts, test, sync-now, claim, disconnect.
            'stores.integrations.account',
            'stores.integrations.accounts',
            'stores.integrations.claim-website',
            'stores.integrations.disconnect',
            'stores.integrations.oauth.start',
            'stores.integrations.patch',
            'stores.integrations.sync',
            'stores.integrations.test-event',
            'stores.integrations.test-mode',
            'stores.integrations.update',
        ],
        // PHASE-8-9D §13.1 (P89D-41): integration reads; the list also for products.edit (AI rows only).
        'integrations.manage|marketing.manage' => [
            'stores.integrations.events',
            'stores.integrations.feed',
            'stores.integrations.items',
            'stores.integrations.show',
            'stores.integrations.stats',
            'stores.integrations.sync-runs',
            'stores.integrations.verify',
        ],
        'integrations.manage|marketing.manage|products.edit' => [
            'stores.integrations.index',
        ],
        // PHASE-8-9D §10 (P89D-41): AI credits summary and ledger.
        'products.edit|integrations.manage|billing.view' => [
            'billing.ai-credits.show',
        ],
        'billing.view|integrations.manage' => [
            'billing.ai-credits.ledger',
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
        // PHASE-8-9C §2.1 (P89C-13): tickets, replies, ratings and attachments.
        'support.manage' => [
            'help.attachments.link',
            'help.attachments.store',
            'help.tickets.index',
            'help.tickets.messages.index',
            'help.tickets.messages.store',
            'help.tickets.rating',
            'help.tickets.resolve',
            'help.tickets.show',
            'help.tickets.store',
        ],
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
            // PHASE-8-8C part B (P88C-14): transfer and count writes.
            'stores.stock-counts.cancel',
            'stores.stock-counts.finish',
            'stores.stock-counts.lines.update',
            'stores.stock-counts.scan',
            'stores.stock-counts.store',
            'stores.stock-transfers.cancel',
            'stores.stock-transfers.destroy',
            'stores.stock-transfers.receive',
            'stores.stock-transfers.send',
            'stores.stock-transfers.store',
            'stores.stock-transfers.update',
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
        // PHASE-8-8E §13.1 (P88E-3): every Inbox route is inbox.manage; delete + customers.delete, order link + orders.view,
        // channel settings read inbox.manage|settings.manage and write settings.manage.
        'inbox.manage' => [
            'stores.inbox.assignees',
            'stores.inbox.attachments.link',
            'stores.inbox.attachments.store',
            'stores.inbox.conversations.assign',
            'stores.inbox.conversations.block',
            'stores.inbox.conversations.index',
            'stores.inbox.conversations.messages.index',
            'stores.inbox.conversations.messages.store',
            'stores.inbox.conversations.read',
            'stores.inbox.conversations.saved-replies.render',
            'stores.inbox.conversations.show',
            'stores.inbox.conversations.status',
            'stores.inbox.conversations.unblock',
            'stores.inbox.saved-replies.destroy',
            'stores.inbox.saved-replies.index',
            'stores.inbox.saved-replies.reorder',
            'stores.inbox.saved-replies.store',
            'stores.inbox.saved-replies.update',
            'stores.inbox.summary',
        ],
        'inbox.manage,customers.delete' => ['stores.inbox.conversations.destroy'],
        'inbox.manage,orders.view' => ['stores.inbox.conversations.order'],
        'inbox.manage|settings.manage' => ['stores.inbox.settings.show'],
        // PHASE-8-8D §10 (P88D-18): every other POS route.
        'pos.sell' => [
            'stores.pos.catalog',
            'stores.pos.customers.lookup',
            'stores.pos.held-sales.destroy',
            'stores.pos.held-sales.index',
            'stores.pos.held-sales.show',
            'stores.pos.held-sales.store',
            'stores.pos.lookup',
            'stores.pos.quote',
            'stores.pos.registers.index',
            'stores.pos.registers.open',
            'stores.pos.sales.index',
            'stores.pos.sales.returns.store', // + orders.refund in the Form Request (PHASE-8-8D P88D-17)
            'stores.pos.sales.show',
            'stores.pos.sales.sms-receipt',
            'stores.pos.sales.store',
            'stores.pos.sessions.close',
            'stores.pos.sessions.show',
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

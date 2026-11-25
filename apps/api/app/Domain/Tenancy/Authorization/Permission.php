<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Authorization;

/**
 * PHASE-8-3 §2.1 / ADR 0017: the code-defined permission catalogue (replaces the ADR 0005 role matrix).
 *
 * 27 grantable keys plus the owner-only `billing.manage` (PHASE-8-4 §2.1 added `developers.manage`, PHASE-8-7 §2.1
 * `expenses.manage`, PHASE-8-8 §2.1 `fraud.manage`, PHASE-8-8B §2.1 `purchasing.manage`, PHASE-8-8D §2.1 `pos.sell`). Case order = UI order = catalogue order of
 * `TenantMembership.permissions`. Roles store these keys; unknown keys in the database are ignored on read and
 * rejected on write. Adding a key = a code change, a route mapping (RoutePermissionsTest) and a SystemRole decision.
 */
enum Permission: string
{
    case OrdersView = 'orders.view';
    case OrdersProcess = 'orders.process';
    case OrdersRefund = 'orders.refund';
    case PosSell = 'pos.sell'; // PHASE-8-8D §2.1
    case FraudManage = 'fraud.manage'; // PHASE-8-8 §2.1
    case ShipmentsManage = 'shipments.manage';
    case ShipmentsCancel = 'shipments.cancel';
    case ProductsEdit = 'products.edit';
    case ProductsDelete = 'products.delete';
    case InventoryAdjust = 'inventory.adjust';
    case PurchasingManage = 'purchasing.manage'; // PHASE-8-8B §2.1
    case CustomersView = 'customers.view';
    case CustomersEdit = 'customers.edit';
    case CustomersDelete = 'customers.delete';
    case CostsView = 'costs.view';
    case ReportsView = 'reports.view';
    case ExpensesManage = 'expenses.manage'; // PHASE-8-7 §2.1
    case DataExport = 'data.export';
    case DataImport = 'data.import';
    case MarketingManage = 'marketing.manage';
    case SettingsManage = 'settings.manage';
    case IntegrationsManage = 'integrations.manage';
    case DomainsManage = 'domains.manage';
    case DevelopersManage = 'developers.manage'; // PHASE-8-4 §2.1
    case StaffManage = 'staff.manage';
    case AuditView = 'audit.view';
    case BillingView = 'billing.view';
    case BillingManage = 'billing.manage';

    /** Group keys in UI order with their English labels (PermissionGroup). */
    public const GROUPS = [
        'orders' => 'Orders',
        'shipping' => 'Shipping',
        'products' => 'Products & stock',
        'customers' => 'Customers',
        'money' => 'Money & data',
        'store' => 'Store & settings',
        'team' => 'Team & billing',
    ];

    public function group(): string
    {
        return match ($this) {
            self::OrdersView, self::OrdersProcess, self::OrdersRefund, self::PosSell, self::FraudManage => 'orders',
            self::ShipmentsManage, self::ShipmentsCancel => 'shipping',
            self::ProductsEdit, self::ProductsDelete, self::InventoryAdjust, self::PurchasingManage => 'products',
            self::CustomersView, self::CustomersEdit, self::CustomersDelete => 'customers',
            self::CostsView, self::ReportsView, self::ExpensesManage, self::DataExport, self::DataImport => 'money',
            self::MarketingManage, self::SettingsManage, self::IntegrationsManage, self::DomainsManage, self::DevelopersManage => 'store',
            self::StaffManage, self::AuditView, self::BillingView, self::BillingManage => 'team',
        };
    }

    /** Direct prerequisites (P83-11): a role holding this key must also hold these. @return list<self> */
    public function requires(): array
    {
        return match ($this) {
            self::OrdersProcess => [self::OrdersView],
            self::OrdersRefund => [self::OrdersProcess],
            self::FraudManage => [self::OrdersView],
            self::ShipmentsCancel => [self::ShipmentsManage],
            self::ProductsDelete => [self::ProductsEdit],
            self::PurchasingManage => [self::CostsView],
            self::CustomersEdit => [self::CustomersView],
            self::CustomersDelete => [self::CustomersEdit],
            self::BillingManage => [self::BillingView],
            default => [],
        };
    }

    public function sensitive(): bool
    {
        return in_array($this, [
            self::OrdersRefund, self::FraudManage, self::PurchasingManage, self::CostsView, self::ExpensesManage, self::DataExport, self::MarketingManage, self::IntegrationsManage, self::DevelopersManage, self::StaffManage, self::BillingManage,
        ], true);
    }

    /** Only `billing.manage` is never grantable (owner only, Q123). */
    public function grantable(): bool
    {
        return $this !== self::BillingManage;
    }

    public function label(): string
    {
        return match ($this) {
            self::OrdersView => 'View & create orders',
            self::OrdersProcess => 'Confirm & cancel orders',
            self::OrdersRefund => 'Refunds & paid cancellations',
            self::PosSell => 'Sell at the till (POS)',
            self::FraudManage => 'Fake order guard',
            self::ShipmentsManage => 'Book courier & print labels',
            self::ShipmentsCancel => 'Change courier after booking',
            self::ProductsEdit => 'Edit products & prices',
            self::ProductsDelete => 'Delete products & categories',
            self::InventoryAdjust => 'Adjust stock',
            self::PurchasingManage => 'Suppliers & purchase orders',
            self::CustomersView => 'View customers',
            self::CustomersEdit => 'Add & edit customers',
            self::CustomersDelete => "Delete customers and others' notes",
            self::CostsView => 'See product cost & profit',
            self::ReportsView => 'Reports, payouts & COD settlements',
            self::ExpensesManage => 'Record & see expenses',
            self::DataExport => 'Export customer phone numbers',
            self::DataImport => 'Import products & customers (CSV)',
            self::MarketingManage => 'Coupons, campaigns & automations', // PHASE-8-6 §2.1 (sensitive; amends 8.5)
            self::SettingsManage => 'Change shop settings',
            self::IntegrationsManage => 'Connect payments & couriers',
            self::DomainsManage => 'Manage domains',
            self::DevelopersManage => 'Manage API keys & webhooks',
            self::StaffManage => 'Manage staff & roles',
            self::AuditView => 'View activity log',
            self::BillingView => 'View plan & invoices',
            self::BillingManage => 'Change plan & pay',
        };
    }

    public function description(): ?string
    {
        return match ($this) {
            self::OrdersView => 'Orders, unfinished orders, returns',
            self::OrdersProcess => 'Status changes, edit items, returns, payment links',
            self::OrdersRefund => 'Refund money, cancel paid orders, change COD amount',
            self::PosSell => 'Open and close registers, sell, hold sales, sales history',
            self::FraudManage => 'Guard rules, blocked numbers and number checks',
            self::ShipmentsManage => 'Steadfast, Pathao, RedX',
            self::ShipmentsCancel => 'Cancel a booked parcel',
            self::ProductsEdit => 'Products, categories, images',
            self::InventoryAdjust => 'Receive and count stock',
            self::PurchasingManage => 'Suppliers, purchase orders, supplier payments and purchase prices',
            self::CustomersView => 'Names, phones, order history',
            self::CustomersEdit => 'Details and notes',
            self::CostsView => 'Cost price, margin, profit report',
            self::ReportsView => 'Sales and delivery reports',
            self::ExpensesManage => 'Expenses, receipts and export',
            self::DataExport => 'CSV export of products and customers',
            self::SettingsManage => 'Delivery charges, checkout, themes, pages, publish',
            self::IntegrationsManage => 'API keys and credentials',
            self::StaffManage => 'Invite, remove, change roles',
            self::BillingManage => 'Owner only',
            default => null,
        };
    }

    /** @return list<self> every grantable key, catalogue order */
    public static function grantableCases(): array
    {
        return array_values(array_filter(self::cases(), fn (self $p) => $p->grantable()));
    }

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $p) => $p->value, self::cases());
    }
}

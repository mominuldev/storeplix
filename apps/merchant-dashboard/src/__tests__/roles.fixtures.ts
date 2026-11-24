import { SYSTEM_ROLE_PERMISSIONS, type PermissionDefinition, type PermissionGroup, type PermissionKey, type Role, type RoleDetail } from '@storeplix/types';
import { jsonResponse, SYSTEM_ROLE_IDS } from '../test/utils';

const def = (key: PermissionKey, label: string, requires: PermissionKey[] = [], sensitive = false, description: string | null = null, grantable = true): PermissionDefinition => ({
  key,
  label,
  description,
  requires,
  sensitive,
  grantable,
});

/** PHASE-8-3 §2.1 catalogue as GET /permissions returns it. */
export const catalogue: PermissionGroup[] = [
  {
    key: 'orders',
    label: 'Orders',
    permissions: [
      def('orders.view', 'View & create orders', [], false, 'Orders, unfinished orders, returns'),
      def('orders.process', 'Confirm & cancel orders', ['orders.view']),
      def('orders.refund', 'Refunds & paid cancellations', ['orders.process'], true),
      // PHASE-8-8 §2.1
      def('fraud.manage', 'Fake order guard', ['orders.view'], true, 'Guard rules, blocked numbers and number checks'),
    ],
  },
  { key: 'shipping', label: 'Shipping', permissions: [def('shipments.manage', 'Book courier & print labels', [], false, 'Steadfast, Pathao, RedX'), def('shipments.cancel', 'Change courier after booking', ['shipments.manage'])] },
  {
    key: 'products',
    label: 'Products & stock',
    permissions: [def('products.edit', 'Edit products & prices'), def('products.delete', 'Delete products & categories', ['products.edit']), def('inventory.adjust', 'Adjust stock')],
  },
  {
    key: 'customers',
    label: 'Customers',
    permissions: [def('customers.view', 'View customers'), def('customers.edit', 'Add & edit customers', ['customers.view']), def('customers.delete', 'Delete customers and others’ notes', ['customers.edit'])],
  },
  {
    key: 'money',
    label: 'Money & data',
    permissions: [
      def('costs.view', 'See product cost & profit', [], true, 'Cost price, margin, profit report'),
      def('reports.view', 'Reports, payouts & COD settlements'),
      // PHASE-8-7 §2.1
      def('expenses.manage', 'Record & see expenses', [], true, 'Expenses, receipts and export'),
      def('data.export', 'Export customer phone numbers', [], true),
      def('data.import', 'Import products & customers (CSV)'),
    ],
  },
  {
    key: 'store',
    label: 'Store & settings',
    permissions: [def('marketing.manage', 'Create & edit coupons'), def('settings.manage', 'Change shop settings'), def('integrations.manage', 'Connect payments & couriers', [], true), def('domains.manage', 'Manage domains')],
  },
  {
    key: 'team',
    label: 'Team & billing',
    permissions: [
      def('staff.manage', 'Manage staff & roles', [], true),
      def('audit.view', 'View activity log'),
      def('billing.view', 'View plan & invoices'),
      def('billing.manage', 'Change plan & pay', ['billing.view'], true, 'Owner only', false),
    ],
  },
];

const base = { members_count: 1, invitations_count: 0, members_preview: [], revision: 1, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-17T00:00:00Z', updated_by: null };

export function role(over: Partial<Role> = {}): Role {
  return { id: 'R_CUSTOM', key: null, name: 'Order staff', description: 'Take, confirm and ship orders', is_system: false, permissions: ['orders.view', 'orders.process', 'shipments.manage'], editable: true, ...base, ...over };
}

export const systemRoles: Role[] = [
  role({ id: SYSTEM_ROLE_IDS.owner, key: 'owner', name: 'Owner', description: 'Full access, billing & staff', is_system: true, editable: false, permissions: [...SYSTEM_ROLE_PERMISSIONS.owner], members_preview: [{ id: 'O', name: 'Rafiqul Alam' }] }),
  role({ id: SYSTEM_ROLE_IDS.admin, key: 'admin', name: 'Manager', description: 'Everything except billing & ownership', is_system: true, editable: false, permissions: [...SYSTEM_ROLE_PERMISSIONS.admin] }),
  role({ id: SYSTEM_ROLE_IDS.staff, key: 'staff', name: 'Staff', description: 'Products, inventory, orders & customers', is_system: true, editable: false, permissions: [...SYSTEM_ROLE_PERMISSIONS.staff] }),
];

export const orderStaff = role({ id: 'R_ORDER', name: 'Order staff', revision: 4, members_count: 2, updated_by: { id: 'U1', name: 'Rafiqul Alam' } });
export const packer = role({ id: 'R_PACK', name: 'Packer', description: 'Packing, labels & stock', permissions: ['shipments.manage', 'inventory.adjust'], revision: 2, members_count: 0 });

export function rolesResponse(roles: Role[] = [...systemRoles, orderStaff, packer], enabled = true) {
  return jsonResponse(200, { data: roles, meta: { custom_roles_used: roles.filter((r) => !r.is_system).length, custom_roles_limit: 20, custom_roles_enabled: enabled } });
}

export const catalogueResponse = () => jsonResponse(200, { data: catalogue });

export function detail(r: Role, members: RoleDetail['members'] = []): RoleDetail {
  return { ...r, members };
}

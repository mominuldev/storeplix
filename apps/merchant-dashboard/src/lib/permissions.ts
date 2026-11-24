import { PERMISSION_KEYS, SYSTEM_ROLE_PERMISSIONS, type PermissionKey, type Role, type StaffMember, type TenantRole } from '@storeplix/types';

// PHASE-8-3 §7.1: the UI reads the membership's resolved `permissions` (the API stays the source of truth and
// enforces every key); hidden actions are removed, never faked.

/** Anything that carries a resolved permission set: a `TenantMembership`, or a role. */
export type PermissionHolder = { role?: TenantRole; permissions?: readonly PermissionKey[] | null } | null | undefined;

/**
 * The holder's permission keys. A membership from an API that predates 8.3 (no `permissions` field) falls back to the
 * code-defined system set for its role kind, so a mixed deploy never shows more than that role could do.
 */
export function permissionsOf(m: PermissionHolder): readonly PermissionKey[] {
  if (!m) return [];
  if (Array.isArray(m.permissions)) return m.permissions;
  return m.role && m.role !== 'custom' ? SYSTEM_ROLE_PERMISSIONS[m.role] : [];
}

export const hasPermission = (m: PermissionHolder, key: PermissionKey) => permissionsOf(m).includes(key);
const any = (m: PermissionHolder, ...keys: PermissionKey[]) => keys.some((k) => hasPermission(m, k));

/** `P(target) ⊆ P(actor)` (N1/N2/N5/N6). */
export function holdsAll(actor: PermissionHolder, keys: readonly PermissionKey[]): boolean {
  const mine = permissionsOf(actor);
  return keys.every((k) => mine.includes(k));
}

/** Keys from `keys` the actor lacks, in catalogue order. */
export function missingPermissions(actor: PermissionHolder, keys: readonly PermissionKey[]): PermissionKey[] {
  const mine = permissionsOf(actor);
  return PERMISSION_KEYS.filter((k) => keys.includes(k) && !mine.includes(k));
}

/** System labels (fallback when an API row has no `role_name`). */
export const roleLabel: Record<TenantRole, string> = { owner: 'Owner', admin: 'Manager', staff: 'Staff', custom: 'Custom role' };

export const roleDescription: Record<Exclude<TenantRole, 'custom'>, string> = {
  owner: 'Full access, billing & staff',
  admin: 'Everything except billing & ownership',
  staff: 'Products, inventory, orders & customers',
};

/** The display name of a member/membership: `role_name` from the API, else the system label. */
export const roleNameOf = (m: { role: TenantRole; role_name?: string | null }) => m.role_name || roleLabel[m.role];

/** Permissions of the role a member or invitation holds, from `GET /roles` data (system set as a fallback). */
export function memberRolePermissions(m: Pick<StaffMember, 'role' | 'role_id'>, roles: readonly Role[] | undefined): readonly PermissionKey[] | null {
  const role = roles?.find((r) => r.id === m.role_id);
  if (role) return role.permissions;
  if (m.role !== 'custom') return SYSTEM_ROLE_PERMISSIONS[m.role];
  return null; // custom role not loaded yet: unknown → treat as not held
}

const coversMember = (me: PermissionHolder, m: StaffMember, roles: readonly Role[] | undefined) => {
  const target = memberRolePermissions(m, roles);
  return target !== null && holdsAll(me, target);
};

export const can = {
  has: hasPermission,
  // §7.1 mapping of the pre-8.3 helpers.
  /** `costs.view`: cost, profit, margin and stock value at cost. */
  viewCosts: (m: PermissionHolder) => hasPermission(m, 'costs.view'),
  /** `products.delete`: delete products and categories. */
  manageCatalog: (m: PermissionHolder) => hasPermission(m, 'products.delete'),
  /** `customers.delete`: delete customers and others' notes. */
  deleteCustomers: (m: PermissionHolder) => hasPermission(m, 'customers.delete'),
  /** `data.import` (import page and links). */
  bulkData: (m: PermissionHolder) => hasPermission(m, 'data.import'),
  importData: (m: PermissionHolder) => hasPermission(m, 'data.import'),
  /** `data.export` (export buttons). */
  exportData: (m: PermissionHolder) => hasPermission(m, 'data.export'),
  manageMarketing: (m: PermissionHolder) => hasPermission(m, 'marketing.manage'),
  manageRefunds: (m: PermissionHolder) => hasPermission(m, 'orders.refund'),
  manageSettings: (m: PermissionHolder) => hasPermission(m, 'settings.manage'),
  editSettings: (m: PermissionHolder) => hasPermission(m, 'settings.manage'),
  createStore: (m: PermissionHolder) => hasPermission(m, 'settings.manage'),
  manageIntegrations: (m: PermissionHolder) => hasPermission(m, 'integrations.manage'),
  manageDomains: (m: PermissionHolder) => hasPermission(m, 'domains.manage'),
  /** PHASE-8-4 §2.1 `developers.manage`: API keys, webhooks and the signing secret (Developer page). */
  manageDevelopers: (m: PermissionHolder) => hasPermission(m, 'developers.manage'),
  manageStaff: (m: PermissionHolder) => hasPermission(m, 'staff.manage'),
  viewAuditLog: (m: PermissionHolder) => hasPermission(m, 'audit.view'),
  viewBilling: (m: PermissionHolder) => hasPermission(m, 'billing.view'),
  manageBilling: (m: PermissionHolder) => hasPermission(m, 'billing.manage'),
  // One helper per remaining §2.1 key.
  viewOrders: (m: PermissionHolder) => hasPermission(m, 'orders.view'),
  /** Orders list/detail are also open to `shipments.manage` (§3.2). */
  seeOrders: (m: PermissionHolder) => any(m, 'orders.view', 'shipments.manage'),
  processOrders: (m: PermissionHolder) => hasPermission(m, 'orders.process'),
  manageShipments: (m: PermissionHolder) => hasPermission(m, 'shipments.manage'),
  /** Shipments list/detail and printing: `shipments.manage|orders.view`. */
  seeShipments: (m: PermissionHolder) => any(m, 'shipments.manage', 'orders.view'),
  cancelShipments: (m: PermissionHolder) => hasPermission(m, 'shipments.cancel'),
  editProducts: (m: PermissionHolder) => hasPermission(m, 'products.edit'),
  adjustInventory: (m: PermissionHolder) => hasPermission(m, 'inventory.adjust'),
  viewCustomers: (m: PermissionHolder) => hasPermission(m, 'customers.view'),
  editCustomers: (m: PermissionHolder) => hasPermission(m, 'customers.edit'),
  viewReports: (m: PermissionHolder) => hasPermission(m, 'reports.view'),
  /** Upload media: `products.edit|settings.manage`. */
  uploadMedia: (m: PermissionHolder) => any(m, 'products.edit', 'settings.manage'),

  /** N5: a role the actor may assign (never the owner role; every key held). */
  assignRole: (me: PermissionHolder, role: Pick<Role, 'key' | 'permissions'>) =>
    can.manageStaff(me) && role.key !== 'owner' && holdsAll(me, role.permissions),
  /** Change someone's role: `staff.manage`, never the owner, never yourself, and their current role ⊆ mine (N6/N7). */
  changeRole: (me: PermissionHolder, m: StaffMember, roles?: readonly Role[]) =>
    can.manageStaff(me) && m.kind === 'member' && m.role !== 'owner' && !m.is_you && coversMember(me, m, roles),
  /** Remove a member (or leave, for yourself). The owner can never be removed. */
  removeMember: (me: PermissionHolder, m: StaffMember, roles?: readonly Role[]) =>
    m.kind === 'member' && m.role !== 'owner' && (m.is_you || (can.manageStaff(me) && coversMember(me, m, roles))),
  manageInvitation: (me: PermissionHolder, m: StaffMember, roles?: readonly Role[]) =>
    m.kind === 'invitation' && can.manageStaff(me) && coversMember(me, m, roles),
};

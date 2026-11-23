import { ROLE_CAN, type StaffMember, type TenantRole } from '@storeplix/types';

// ADR 0005 role map (UI mirror; the API enforces the same rules).
export const roleLabel: Record<TenantRole, string> = { owner: 'Owner', admin: 'Manager', staff: 'Staff' };

export const roleDescription: Record<TenantRole, string> = {
  owner: 'Full access, billing & staff',
  admin: 'Everything except billing & ownership',
  staff: 'Products, inventory, orders & customers',
};

const has = (list: readonly TenantRole[], role: TenantRole | undefined) => !!role && list.includes(role);

export const can = {
  /** Phase 4 P4-5: cost, profit, margin and stock value at cost (O A). */
  viewCosts: (role: TenantRole | undefined) => has(ROLE_CAN.view_costs, role),
  /** Phase 4 P4-14: delete products, categories and customers (O A). */
  manageCatalog: (role: TenantRole | undefined) => has(ROLE_CAN.manage_catalog, role),
  /** Phase 4 P4-14/15: CSV imports and exports (O A). */
  bulkData: (role: TenantRole | undefined) => has(ROLE_CAN.bulk_data, role),
  /** Phase 5a P5-21: coupons write (O A). */
  manageMarketing: (role: TenantRole | undefined) => has(ROLE_CAN.manage_marketing, role),
  /** Phase 5a P5-21: refunds and cancelling paid orders (O A). */
  manageRefunds: (role: TenantRole | undefined) => has(ROLE_CAN.manage_refunds, role),
  /** Phase 5a P5-21: shipping, checkout, notifications, publish (O A). */
  manageSettings: (role: TenantRole | undefined) => has(ROLE_CAN.manage_settings, role),
  /** Phase 5b P5B-10: connect/disconnect gateways and couriers (O A). */
  manageIntegrations: (role: TenantRole | undefined) => has(ROLE_CAN.manage_integrations, role),
  /** Phase 6 §8: connect, check, make primary and remove domains (O A); staff read only. */
  manageDomains: (role: TenantRole | undefined) => has(ROLE_CAN.manage_domains, role),
  manageStaff: (role: TenantRole | undefined) => role === 'owner' || role === 'admin',
  editSettings: (role: TenantRole | undefined) => role === 'owner' || role === 'admin',
  /** Phase 7: plan, invoices and payments (O A). */
  viewBilling: (role: TenantRole | undefined) => has(ROLE_CAN.view_billing, role),
  /** Phase 7 Q88: change plan, cancel a scheduled change, pay (owner only). */
  manageBilling: (role: TenantRole | undefined) => has(ROLE_CAN.manage_billing, role),
  viewAuditLog: (role: TenantRole | undefined) => role === 'owner' || role === 'admin',
  createStore: (role: TenantRole | undefined) => role === 'owner' || role === 'admin',
  /** Change someone's role: managers only, never the owner, never yourself. */
  changeRole: (role: TenantRole | undefined, m: StaffMember) =>
    can.manageStaff(role) && m.kind === 'member' && m.role !== 'owner' && !m.is_you,
  /** Remove a member (or leave, for yourself). The owner can never be removed. */
  removeMember: (role: TenantRole | undefined, m: StaffMember) =>
    m.kind === 'member' && m.role !== 'owner' && (m.is_you || can.manageStaff(role)),
  manageInvitation: (role: TenantRole | undefined, m: StaffMember) => m.kind === 'invitation' && can.manageStaff(role),
};

/** ADR 0005 permission matrix, shown read-only (custom roles are Phase 8). */
export const permissionMatrix: { label: string; hint?: string; owner: boolean; admin: boolean; staff: boolean }[] = [
  { label: 'Products, inventory, orders & customers', hint: 'Create, edit and manage', owner: true, admin: true, staff: true },
  { label: 'Refunds & cancelling paid orders', owner: true, admin: true, staff: false },
  { label: 'Store settings, themes, pages & shipping', owner: true, admin: true, staff: false },
  { label: 'Domains, payment & courier credentials', owner: true, admin: true, staff: false },
  { label: 'Staff management', hint: 'Managers can’t change the owner', owner: true, admin: true, staff: false },
  { label: 'Billing, plan & ownership', owner: true, admin: false, staff: false },
];

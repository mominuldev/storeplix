import type { StaffMember, TenantRole } from '@storeplix/types';

// ADR 0005 role map (UI mirror; the API enforces the same rules).
export const roleLabel: Record<TenantRole, string> = { owner: 'Owner', admin: 'Manager', staff: 'Staff' };

export const roleDescription: Record<TenantRole, string> = {
  owner: 'Full access, billing & staff',
  admin: 'Everything except billing & ownership',
  staff: 'Products, inventory, orders & customers',
};

export const can = {
  manageStaff: (role: TenantRole | undefined) => role === 'owner' || role === 'admin',
  editSettings: (role: TenantRole | undefined) => role === 'owner' || role === 'admin',
  viewBilling: (role: TenantRole | undefined) => role === 'owner' || role === 'admin',
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

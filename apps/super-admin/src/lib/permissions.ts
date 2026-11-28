import type { PlatformPermission, PlatformRole } from '@storeplix/types';
import { useAuth } from '../auth/AuthProvider';

/** §2.1: the UI hides every action the signed-in staff member's `permissions` don't include (the API answers 403). */
export function useCan(): (permission: PlatformPermission) => boolean {
  const { user } = useAuth();
  return (permission) => !!user?.permissions.includes(permission);
}

export const roleLabel: Record<PlatformRole, string> = {
  super_admin: 'Super admin',
  billing: 'Billing',
  support: 'Support',
  read_only: 'Read-only',
};

export const permissionMeta: Record<PlatformPermission, { label: string; hint: string }> = {
  view_merchants: {
    label: 'View merchants',
    hint: 'Shops, owners, invoices, domains, audit log',
  },
  impersonate: {
    label: 'Impersonate shop',
    hint: 'Read-only, 15 minutes, with a reason',
  },
  manage_billing: {
    label: 'Manage billing',
    hint: 'Change plan, extend, mark paid, void, resend',
  },
  manage_domains: {
    label: 'Re-check domains',
    hint: 'Run DNS and SSL checks again',
  },
  suspend: {
    label: 'Suspend',
    hint: 'Shops and domains; revoke impersonations',
  },
  manage_team: {
    label: 'Manage team',
    hint: 'Invite, change roles, disable, reset 2FA',
  },
  view_analytics: {
    label: 'View analytics',
    hint: 'Platform MRR, GMV, churn and revenue reports',
  },
  manage_settings: {
    label: 'Platform settings',
    hint: 'Staff two-step sign-in and other platform-wide settings',
  },
  // PHASE-8-9C §2.2 (P89C-12); labels only, added with the contract so the app keeps type-checking.
  manage_help_content: {
    label: 'Help articles',
    hint: 'Write, publish and archive help guides and categories',
  },
  manage_support: {
    label: 'Support tickets',
    hint: 'Answer, assign and close merchant support tickets',
  },
};

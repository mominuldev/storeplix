import type { PlatformPermission } from '@storeplix/types';
import { BarChart3, Building, Clock, CreditCard, Eye, Globe, LayoutDashboard, Users, type LucideIcon } from 'lucide-react';

export interface NavEntry {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Hidden unless the signed-in staff member has this permission (Revenue reports: `view_analytics`, PHASE-8-2 §2.1). */
  permission?: PlatformPermission;
}

// Figma Platform Admin – Desktop · PlatformSidebar 15:2 (groups, order and icons as designed). Phase 8.1 §7.1: items
// not built yet (Integration health, Risk network, Support tickets, Announcements, Plans & features,
// Themes & templates, Platform settings) are removed, not shown as placeholders. Domains (from Platform settings →
// Domains & SSL 45:8156) and Impersonations are their own items under Operations. Phase 8.2 adds Revenue reports.
export const navGroups: { heading: string; items: NavEntry[] }[] = [
  {
    heading: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard },
      { label: 'Merchants', to: '/merchants', icon: Building },
      { label: 'Billing', to: '/billing', icon: CreditCard },
      { label: 'Revenue reports', to: '/revenue', icon: BarChart3, permission: 'view_analytics' },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { label: 'Domains', to: '/domains', icon: Globe },
      { label: 'Impersonations', to: '/impersonations', icon: Eye },
    ],
  },
  {
    heading: 'Configuration',
    items: [
      { label: 'Team & roles', to: '/team', icon: Users },
      { label: 'Audit log', to: '/audit-log', icon: Clock },
    ],
  },
];

export const allNav = navGroups.flatMap((g) => g.items);

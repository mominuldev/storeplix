import type { PlatformPermission } from '@storeplix/types';
import { BarChart3, Building, Clock, CreditCard, Eye, Globe, LayoutDashboard, LifeBuoy, PanelLeft, Settings, Shield, Users, type LucideIcon } from 'lucide-react';

export interface NavEntry {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Hidden unless the signed-in staff member has this permission (Revenue reports: `view_analytics`, PHASE-8-2 §2.1). */
  permission?: PlatformPermission;
  /** Count pill next to the label (Figma 2087:8230): which live count to show. */
  badge?: 'sender_ids_pending' | 'support_waiting';
}

// Figma Platform Admin – Desktop · PlatformSidebar 15:2 (groups, order and icons as designed). Phase 8.1 §7.1: items
// not built yet (Integration health, Risk network, Support tickets, Announcements, Plans & features,
// Themes & templates, Platform settings) are removed, not shown as placeholders. Domains (from Platform settings →
// Domains & SSL 45:8156) and Impersonations are their own items under Operations. Phase 8.2 adds Revenue reports.
// Amendment A1-6: Platform settings comes back (Configuration group, as in 15:2) for `manage_settings` only, with just
// its Security tab.
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
      // PHASE-8-9A §13.1 (2087:8227): pending count badge; `manage_domains` only.
      { label: 'Sender ID requests', to: '/sender-ids', icon: Shield, permission: 'manage_domains', badge: 'sender_ids_pending' },
      // PHASE-8-9C §2.2 (2134:10410 sidebar): Support tickets (badge = open + awaiting_support) and Help articles after it.
      { label: 'Support tickets', to: '/support', icon: LifeBuoy, permission: 'manage_support', badge: 'support_waiting' },
      { label: 'Help articles', to: '/help-articles', icon: PanelLeft, permission: 'manage_help_content' },
      { label: 'Impersonations', to: '/impersonations', icon: Eye },
    ],
  },
  {
    heading: 'Configuration',
    items: [
      { label: 'Team & roles', to: '/team', icon: Users },
      { label: 'Audit log', to: '/audit-log', icon: Clock },
      { label: 'Platform settings', to: '/settings', icon: Settings, permission: 'manage_settings' },
    ],
  },
];

export const allNav = navGroups.flatMap((g) => g.items);

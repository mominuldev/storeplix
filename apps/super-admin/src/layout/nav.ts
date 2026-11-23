import { Building, Clock, CreditCard, Eye, Globe, LayoutDashboard, Users, type LucideIcon } from 'lucide-react';

export interface NavEntry {
  label: string;
  to: string;
  icon: LucideIcon;
}

// Figma Platform Admin – Desktop · PlatformSidebar 15:2 (groups, order and icons as designed). Phase 8.1 §7.1: items
// not built yet (Revenue reports, Integration health, Risk network, Support tickets, Announcements, Plans & features,
// Themes & templates, Platform settings) are removed, not shown as placeholders. Domains (from Platform settings →
// Domains & SSL 45:8156) and Impersonations are their own items under Operations.
export const navGroups: { heading: string; items: NavEntry[] }[] = [
  {
    heading: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard },
      { label: 'Merchants', to: '/merchants', icon: Building },
      { label: 'Billing', to: '/billing', icon: CreditCard },
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

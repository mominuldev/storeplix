import {
  BarChart3,
  Building2,
  Clock,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  Plug,
  Settings,
  Shield,
  Store,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavEntry {
  label: string;
  to: string;
  icon: LucideIcon;
}

// Figma Platform Admin – Desktop · PlatformSidebar 15:2 (groups, order and icons as designed).
export const navGroups: { heading: string; items: NavEntry[] }[] = [
  {
    heading: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard },
      { label: 'Merchants', to: '/merchants', icon: Building2 },
      { label: 'Billing', to: '/billing', icon: CreditCard },
      { label: 'Revenue reports', to: '/revenue', icon: BarChart3 },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { label: 'Integration health', to: '/integrations', icon: Plug },
      { label: 'Risk network', to: '/risk', icon: Shield },
      { label: 'Support tickets', to: '/support', icon: LifeBuoy },
      { label: 'Announcements', to: '/announcements', icon: Megaphone },
    ],
  },
  {
    heading: 'Configuration',
    items: [
      { label: 'Plans & features', to: '/plans', icon: Store },
      { label: 'Themes & templates', to: '/themes', icon: Store },
      { label: 'Team & roles', to: '/team', icon: Users },
      { label: 'Audit log', to: '/audit-log', icon: Clock },
      { label: 'Platform settings', to: '/settings', icon: Settings },
    ],
  },
];

export const allNav = navGroups.flatMap((g) => g.items);

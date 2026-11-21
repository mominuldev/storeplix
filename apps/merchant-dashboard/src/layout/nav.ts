import {
  BarChart3,
  LayoutDashboard,
  MessageCircle,
  Monitor,
  Package,
  Megaphone,
  Plug,
  Settings,
  ShoppingBag,
  Store,
  UserCheck,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';

export interface NavChild {
  label: string;
  to: string;
}

export interface NavEntry {
  label: string;
  to: string;
  icon: LucideIcon;
  children?: NavChild[];
}

// Figma Merchant Admin – Desktop · Dashboard 10:600 · Sidebar 10:601 (order and labels as designed).
// Counts are live data; they are omitted until the order/inbox APIs exist.
export const mainNav: NavEntry[] = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  {
    label: 'Orders',
    to: '/orders',
    icon: ShoppingBag,
    children: [
      { label: 'All orders', to: '/orders' },
      { label: 'Create order', to: '/orders/new' },
      { label: 'Unfinished orders', to: '/orders/unfinished' },
      { label: 'Returns', to: '/orders/returns' },
      { label: 'Shipments', to: '/orders/shipments' },
      { label: 'Invoices & labels', to: '/orders/invoices' },
      { label: 'Fake order guard', to: '/orders/fake-order-guard' },
    ],
  },
  { label: 'Inbox', to: '/inbox', icon: MessageCircle },
  { label: 'POS', to: '/pos', icon: Monitor },
  { label: 'Products', to: '/products', icon: Package },
  { label: 'Inventory', to: '/inventory', icon: Warehouse },
  { label: 'Customers', to: '/customers', icon: Users },
  { label: 'Marketing', to: '/marketing', icon: Megaphone },
  { label: 'Reports', to: '/reports', icon: BarChart3 },
  { label: 'Online store', to: '/online-store', icon: Store },
  { label: 'Integrations', to: '/integrations', icon: Plug },
  { label: 'Staff', to: '/staff', icon: UserCheck },
  { label: 'Settings', to: '/settings', icon: Settings },
];

// Figma Merchant Admin – Mobile · More 32:6541 grouping.
export const mobileMoreGroups: { heading: string; items: string[] }[] = [
  { heading: 'Sales', items: ['/orders', '/pos', '/customers'] },
  { heading: 'Catalog', items: ['/products', '/inventory'] },
  { heading: 'Grow', items: ['/marketing', '/reports'] },
  { heading: 'Setup', items: ['/online-store', '/integrations', '/settings'] },
];

export const allRoutes = mainNav.flatMap((n) => [n, ...(n.children ?? []).filter((c) => c.to !== n.to)]);

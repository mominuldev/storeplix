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
  /** Hide the link unless the role passes this check (the page gates itself too). */
  requires?: 'bulkData';
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
    // 5b §10: Returns, Shipments (5b-3) and Invoices & labels (Figma sidebar order 39:10347). Unfinished orders and
    // Fake order guard stay hidden.
    children: [
      { label: 'All orders', to: '/orders' },
      { label: 'Create order', to: '/orders/new' },
      { label: 'Returns', to: '/returns' },
      { label: 'Shipments', to: '/shipments' },
      { label: 'Invoices & labels', to: '/orders/print' },
    ],
  },
  { label: 'Inbox', to: '/inbox', icon: MessageCircle },
  { label: 'POS', to: '/pos', icon: Monitor },
  {
    label: 'Products',
    to: '/products',
    icon: Package,
    // Phase 4 P4-28: same child-nav pattern as Orders.
    children: [
      { label: 'All products', to: '/products' },
      { label: 'Categories', to: '/products/categories' },
      { label: 'Import', to: '/products/import', requires: 'bulkData' },
    ],
  },
  { label: 'Inventory', to: '/inventory', icon: Warehouse },
  { label: 'Customers', to: '/customers', icon: Users },
  // Phase 5a §9: Marketing → Coupons only (overview, campaigns, abandoned cart are Phase 8).
  { label: 'Marketing', to: '/marketing', icon: Megaphone, children: [{ label: 'Coupons', to: '/marketing/coupons' }] },
  { label: 'Reports', to: '/reports', icon: BarChart3 },
  {
    label: 'Online store',
    to: '/online-store',
    icon: Store,
    // Phase 3 §6: SEO is live; Phase 6: Domains is live; Media and Shop settings stay placeholders.
    children: [
      { label: 'Overview', to: '/online-store' },
      { label: 'Media', to: '/online-store/media' },
      { label: 'Domains', to: '/online-store/domains' },
      { label: 'SEO', to: '/online-store/seo' },
      { label: 'Shop settings', to: '/online-store/shop-settings' },
    ],
  },
  // 5b §10: top-level Integrations (payments live in 5b-2, couriers in 5b-3).
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

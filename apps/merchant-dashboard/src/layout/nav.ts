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
import { can, type PermissionHolder } from '../lib/permissions';

/** PHASE-8-3 §7.1: hide the entry unless the membership passes (the route gates itself too). */
export type NavRequirement = (m: PermissionHolder) => boolean;

export interface NavChild {
  label: string;
  to: string;
  /** Hide the link unless the membership passes this check (the page gates itself too). */
  requires?: NavRequirement;
}

export interface NavEntry {
  label: string;
  to: string;
  icon: LucideIcon;
  requires?: NavRequirement;
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
    requires: (m) => can.seeOrders(m) || can.seeShipments(m),
    // 5b §10: Returns, Shipments (5b-3) and Invoices & labels (Figma sidebar order 39:10347). Unfinished orders and
    // Fake order guard stay hidden.
    children: [
      { label: 'All orders', to: '/orders', requires: can.seeOrders },
      { label: 'Create order', to: '/orders/new', requires: can.viewOrders },
      { label: 'Returns', to: '/returns', requires: can.viewOrders },
      { label: 'Shipments', to: '/shipments', requires: can.seeShipments },
      { label: 'Invoices & labels', to: '/orders/print', requires: can.seeShipments },
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
      { label: 'Import', to: '/products/import', requires: can.importData },
    ],
  },
  { label: 'Inventory', to: '/inventory', icon: Warehouse },
  { label: 'Customers', to: '/customers', icon: Users, requires: can.viewCustomers },
  // PHASE-8-5 §8 (amends Phase 5a): Overview, Coupons, Campaigns; PHASE-8-6 §10: + Automations (after Campaigns).
  // Overview, Campaigns and Automations need `marketing.manage`.
  {
    label: 'Marketing',
    to: '/marketing',
    icon: Megaphone,
    children: [
      { label: 'Overview', to: '/marketing', requires: can.manageMarketing },
      { label: 'Coupons', to: '/marketing/coupons' },
      { label: 'Campaigns', to: '/marketing/campaigns', requires: can.manageMarketing },
      { label: 'Automations', to: '/marketing/automations', requires: can.manageMarketing },
    ],
  },
  // PHASE-8-7 P87-16: also shown to expenses-only members (they land on the Expenses tab).
  { label: 'Reports', to: '/reports', icon: BarChart3, requires: can.seeReports },
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
  { label: 'Staff', to: '/staff', icon: UserCheck, requires: can.manageStaff },
  { label: 'Settings', to: '/settings', icon: Settings },
];

// Figma Merchant Admin – Mobile · More 32:6541 grouping.
export const mobileMoreGroups: { heading: string; items: string[] }[] = [
  { heading: 'Sales', items: ['/orders', '/pos', '/customers'] },
  { heading: 'Catalog', items: ['/products', '/inventory'] },
  { heading: 'Grow', items: ['/marketing', '/reports'] },
  { heading: 'Setup', items: ['/online-store', '/integrations', '/settings'] },
];

/** Entries (and children) the membership may see; hidden items are removed, not disabled (§7.1). */
export function visibleNav(m: PermissionHolder, nav: NavEntry[] = mainNav): NavEntry[] {
  return nav
    .filter((n) => !n.requires || n.requires(m))
    .map((n) => (n.children ? { ...n, children: n.children.filter((c) => !c.requires || c.requires(m)) } : n));
}

export const allRoutes = mainNav.flatMap((n) => [n, ...(n.children ?? []).filter((c) => c.to !== n.to)]);

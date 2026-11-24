import { expect, type Locator, type Page } from '@playwright/test';
import { api, createTenant, mailMark, unique, urls, type Session, type ThrowawayTenant } from './api';
import { setPlan } from './commerce';

/**
 * Phase 8.3 helpers (PHASE-8-3-CONTRACT §6, §7). Real API + merchant dashboard; every shop is a throwaway tenant,
 * so nothing here touches the demo shop. Plans are switched with the test-only `setPlan` (subscription row).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type PermissionKey =
  | 'orders.view' | 'orders.process' | 'orders.refund' | 'fraud.manage' | 'shipments.manage' | 'shipments.cancel'
  | 'products.edit' | 'products.delete' | 'inventory.adjust' | 'customers.view' | 'customers.edit' | 'customers.delete'
  | 'costs.view' | 'reports.view' | 'data.export' | 'data.import' | 'marketing.manage' | 'settings.manage'
  | 'integrations.manage' | 'domains.manage' | 'staff.manage' | 'audit.view' | 'billing.view' | 'billing.manage';

/** §2.1 labels, used as toggle / checkbox names in the UI. */
export const LABEL: Record<PermissionKey, string> = {
  'orders.view': 'View & create orders',
  'orders.process': 'Confirm & cancel orders',
  'orders.refund': 'Refunds & paid cancellations',
  'fraud.manage': 'Fake order guard', // PHASE-8-8 §2.1 (sensitive, requires orders.view)
  'shipments.manage': 'Book courier & print labels',
  'shipments.cancel': 'Change courier after booking',
  'products.edit': 'Edit products & prices',
  'products.delete': 'Delete products & categories',
  'inventory.adjust': 'Adjust stock',
  'customers.view': 'View customers',
  'customers.edit': 'Add & edit customers',
  'customers.delete': 'Delete customers and others’ notes',
  'costs.view': 'See product cost & profit',
  'reports.view': 'Reports, payouts & COD settlements',
  'data.export': 'Export customer phone numbers',
  'data.import': 'Import products & customers (CSV)',
  'marketing.manage': 'Coupons & campaigns', // PHASE-8-5 §2.1 (was "Create & edit coupons")
  'settings.manage': 'Change shop settings',
  'integrations.manage': 'Connect payments & couriers',
  'domains.manage': 'Manage domains',
  'staff.manage': 'Manage staff & roles',
  'audit.view': 'View activity log',
  'billing.view': 'View plan & invoices',
  'billing.manage': 'Change plan & pay',
};

export interface Shop extends ThrowawayTenant {
  s: Session;
}

/** A throwaway tenant (own owner + store) on `plan`. Always `cleanup()` in afterAll. */
export async function shopOn(plan: 'free' | 'starter' | 'growth', label: string): Promise<Shop> {
  const t = await createTenant(label);
  setPlan(t.session, plan);
  return { ...t, s: t.session };
}

export async function listRoles(s: Session): Promise<{ data: Json[]; meta: Json }> {
  const r = await api(s, 'GET', '/roles');
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { data: r.json.data as Json[], meta: r.json.meta as Json };
}

export async function systemRole(s: Session, key: 'owner' | 'admin' | 'staff'): Promise<Json> {
  const role = (await listRoles(s)).data.find((r) => r.key === key);
  expect(role, `system role ${key}`).toBeTruthy();
  return role!;
}

export async function roleByName(s: Session, name: string): Promise<Json | undefined> {
  return (await listRoles(s)).data.find((r) => r.name === name);
}

export async function createRole(s: Session, name: string, permissions: PermissionKey[], description: string | null = null): Promise<Json> {
  const r = await api(s, 'POST', '/roles', { name, description, permissions });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.data as Json;
}

export async function getRole(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', `/roles/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

/** The membership row (`/auth/me` → tenants[]) of `s` in its tenant. */
export async function myMembership(s: Session): Promise<Json> {
  const me = await api(s, 'GET', '/auth/me');
  expect(me.status).toBe(200);
  const m = (me.json.data.tenants as Json[]).find((t) => t.id === s.tenantId);
  expect(m, 'membership in tenant').toBeTruthy();
  return m!;
}

/** Staff list row (member or invitation) for `email`. */
export async function staffRow(owner: Session, email: string): Promise<Json | undefined> {
  const r = await api(owner, 'GET', '/staff');
  expect(r.status).toBe(200);
  return (r.json.data as Json[]).find((m) => m.email === email);
}

/** Sends an invitation through the API with `role_id`; returns the mail mark for `acceptInvitation`. */
export async function inviteWithRole(owner: Session, roleId: string, label = 'member'): Promise<{ email: string; mark: number; invitation: Json }> {
  const email = `${unique(`r83-${label}-`)}@e2e.storeplix.test`;
  const mark = mailMark();
  const r = await api(owner, 'POST', '/staff/invitations', { email, name: `E2E ${label}`, role_id: roleId });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { email, mark, invitation: r.json.data as Json };
}

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

/** The desktop sidebar (≥ lg) — the one navigation landmark that holds the Dashboard link. */
export function sidebar(page: Page): Locator {
  return page.getByRole('navigation').filter({ has: page.getByRole('link', { name: /^Dashboard$/ }) }).first();
}

/** Visible top-level + child link names of the sidebar. */
export async function navLabels(page: Page): Promise<string[]> {
  const nav = sidebar(page);
  await expect(nav.getByRole('link', { name: /^Dashboard$/ })).toBeVisible();
  // Group parents (Orders, Products, …) render as toggle buttons; leaves as links.
  return (await nav.locator('a, button').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
}

export const noAccess = (page: Page) => page.getByText(/You don.t have access to this page/);

/** Collects console errors + page errors; 4xx/5xx resource lines are kept apart (asserted by the caller). */
export function watchConsole(page: Page): { errors: string[]; network: string[] } {
  const errors: string[] = [];
  const network: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().startsWith('Failed to load resource')) network.push(`${page.url()}: ${m.text()}`);
    else errors.push(`${page.url()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  return { errors, network };
}

/** Records every /api/v1 response ≥ 400 (method, path, status) the page receives. */
export function watchApiErrors(page: Page): string[] {
  const out: string[] = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/v1') && r.status() >= 400) out.push(`${r.request().method()} ${u.pathname}${u.search} → ${r.status()}`);
  });
  return out;
}

/** No horizontal page scroll at the current viewport. */
export async function pageOverflow(page: Page): Promise<string | null> {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  return m.sw > m.iw ? `scrollWidth ${m.sw} > innerWidth ${m.iw}` : null;
}

export const staffUrl = (path = '') => `${urls.merchant}/staff${path}`;

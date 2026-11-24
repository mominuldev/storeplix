import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { api, apiCall, urls, type ApiResult, type Session } from './api';
import { dhakaToday } from './analytics';
import { binaryGet } from './billing';
import { GEO, setPlan, setupShop, transition, type CommerceShop } from './commerce';

/**
 * Phase 8.8b helpers (PHASE-8-8B-CONTRACT §3–§10, §13 QA): suppliers, purchase orders, receipts, supplier payments,
 * quick purchase, PO PDF, reorder suggestions and the supplier CSV import (§8.1), the cost maths of §5.4 / P88B-5 / P88B-6
 * recomputed in TS, and the purchasing UI selectors (one helper per label, so a renamed label is fixed in one place).
 *
 * Shapes follow `packages/types` (PurchaseOrderDetail, PurchaseReceipt, Supplier, ReorderSuggestionGroup, … — the ARCH
 * types written first, §11). ASSUMPTIONS on not-yet-built pieces (the builders must match them or tell QA):
 *  - Create PO body = `CreatePurchaseOrderInput` (`lines[{variant_id, unit_cost_amount, quantity}]`, `shipping_amount`,
 *    `discount_amount`); quick purchase = `QuickPurchaseInput`; send = `{sent_via, revision}`; receipts =
 *    `{lines[{item_id, received, damaged}]}` with an `Idempotency-Key` header; a replayed key answers with the same
 *    receipt (201 or 200, same PO detail) and records nothing new.
 *  - `GET …/{po}/pdf` → 200 inline `PO-n.pdf` (the e2e stack's DOCUMENTS_DRIVER=html may serve `PO-n.html`).
 *  - Pages (§10): Inventory H1 stays "Inventory" (tabs `aria-label="Inventory"`: Stock levels · Stock movements ·
 *    Purchase orders · Suppliers); New PO H1 "New purchase order"; PO detail H1 = the PO number; buttons
 *    "+ New purchase order", "Quick purchase", "+ Add supplier", "Import", "+ Add product", "Save draft",
 *    "Send to supplier" (menu items "WhatsApp" / "PDF"), "Receive all remaining", "Receive n units", "Record payment";
 *    receive table spinbuttons labelled "Receiving now" / "Damaged" per line; KPI tiles as Figma (§10.2, §10.4).
 *  - Free plan note: "… on Starter and Growth." + "See plans" (same pattern as 8.8a).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const PO_LIST = '/inventory/purchase-orders';
export const NEW_PO = '/inventory/purchase-orders/new';
export const SUPPLIERS = '/inventory/suppliers';
export const MOVEMENTS = '/inventory?tab=movements';
export const poPage = (id: string) => `${PO_LIST}/${id}`;
export const mUrl = (path = '') => `${urls.merchant}${path}`;

/**
 * Figma items that must never render in 8.8b (§Out of scope, P88B-7, Q211, 10.1–10.4). Phase 8.8c-A amends this: the
 * Inventory **Warehouses** tab now shows on every store (PHASE-8-8C §10, one location + upgrade note), so it left the
 * list; "Receive at" stays hidden on these one-location shops (built only when > 1 location, §10.3). Phase 8.8c-B: the
 * **Stock count** tab shows on every store (counts need no plan, §10), so it left the list; "Transfer stock" stays
 * hidden on these one-location shops (location UI is built only when > 1 location / `multi_warehouse`, §10).
 */
export const OMITTED = [
  /Receive at/i,
  /Transfer stock/i,
  /need owner approval/i,
  /Approved by/i,
  /vs last month/i,
];
export const PLAN_NOTE = /on Starter and Growth/;
export const EMPTY_POS = /No purchase orders yet/;
export const EMPTY_SUPPLIERS = /No suppliers yet/;

// ---------------------------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------------------------

/**
 * Throwaway shop (guard off, published) on `plan` with stock `stock` per variant. Fixture (commerce.ts `setupShop`):
 * simple "QA Muslin Wrap" (cost ৳ 200) and variable "QA Cotton Kurta" M (cost ৳ 700) / L (cost ৳ 800). Always `cleanup()`.
 */
export async function purchasingShop(label: string, plan: 'free' | 'starter' | 'growth' = 'growth', stock = 10): Promise<CommerceShop> {
  const shop = await setupShop(label, { stock });
  try {
    setPlan(shop.s, plan);
    return shop;
  } catch (e) {
    shop.cleanup();
    throw e;
  }
}

export const today = () => dhakaToday();

// ---------------------------------------------------------------------------------------------
// Cost maths (P88B-5, P88B-6, §5.4), integer minor units, round half up
// ---------------------------------------------------------------------------------------------

/** round_half_up(num / den) for num ≥ 0, den > 0 (integers). */
export const divHalfUp = (num: number, den: number) => Math.floor((2 * num + den) / (2 * den));

export interface PlanLine {
  unit: number;
  qty: number;
}

/**
 * Landed unit cost per line (P88B-6): share = (shipping − discount) × line value ÷ subtotal (integer division, toward
 * zero), remainder to the largest line; landed = round_half_up((unit × qty + share) ÷ qty), minimum 0.
 */
export function landedUnitCosts(lines: PlanLine[], shipping: number, discount: number): number[] {
  const net = shipping - discount;
  const values = lines.map((l) => l.unit * l.qty);
  const subtotal = values.reduce((a, b) => a + b, 0);
  if (subtotal === 0) return lines.map((l) => l.unit);
  const shares = values.map((v) => Math.trunc((net * v) / subtotal));
  const rest = net - shares.reduce((a, b) => a + b, 0);
  const largest = values.indexOf(Math.max(...values));
  shares[largest] += rest;
  return lines.map((l, i) => Math.max(0, divHalfUp(Math.max(0, l.unit * l.qty + shares[i]), l.qty)));
}

/** Weighted-average cost after receiving `qty` at `landed` (P88B-5). */
export function weightedCost(onHandBefore: number, oldCost: number | null, qty: number, landed: number): number {
  if (oldCost === null || onHandBefore <= 0) return landed;
  return divHalfUp(onHandBefore * oldCost + qty * landed, onHandBefore + qty);
}

// ---------------------------------------------------------------------------------------------
// API (§8.1)
// ---------------------------------------------------------------------------------------------

export const spath = (s: Session, rest = '') => `/stores/${s.storeId}${rest}`;

/** Local sqlite only: a "database is locked" 500 under the workers' writes → retry (nothing committed). */
export async function retryLocked(fn: () => Promise<ApiResult>): Promise<ApiResult> {
  let r = await fn();
  for (let i = 0; i < 3 && r.status === 500 && /database is locked/.test(r.text); i++) {
    await new Promise((res) => setTimeout(res, 700));
    r = await fn();
  }
  return r;
}

const call = (as: Session, method: string, path: string, json?: unknown, headers?: Record<string, string>) =>
  retryLocked(() => apiCall(as, method, path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers } : {}) }));

async function ok(r: ApiResult, status: number, what: string): Promise<Json> {
  expect(r.status, `${what}: ${r.text.slice(0, 400)}`).toBe(status);
  return r.json.data as Json;
}

// ----- Suppliers -----
export const createSupplierRaw = (s: Session, body: Json, as: Session = s) => call(as, 'POST', spath(s, '/suppliers'), body);

export async function createSupplier(s: Session, over: Json = {}): Promise<Json> {
  const body = { name: `QA Supplier ${randomUUID().slice(0, 6)}`, contact_name: 'Rafiq Hasan', phone: '01711000001', city: 'Dhaka', supplies: 'Cotton fabric', lead_time_days: 5, payment_terms_days: 15, ...over };
  return ok(await createSupplierRaw(s, body), 201, 'create supplier');
}

export const supplierRaw = (s: Session, id: string, as: Session = s) => call(as, 'GET', spath(s, `/suppliers/${id}`));
export const supplier = async (s: Session, id: string) => ok(await supplierRaw(s, id), 200, 'supplier detail');

export async function suppliers(s: Session, q = ''): Promise<{ data: Json[]; meta: Json }> {
  const r = await call(s, 'GET', spath(s, `/suppliers${q ? `?q=${encodeURIComponent(q)}` : ''}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return { data: r.json.data as Json[], meta: r.json.meta as Json };
}

/** Active suppliers whose name equals `name` (search by `q`, then exact match). */
export async function allSuppliersByName(s: Session, name: string): Promise<Json[]> {
  return (await suppliers(s, name)).data.filter((x) => x.name === name);
}

export const suppliersSummary = async (s: Session) => ok(await call(s, 'GET', spath(s, '/suppliers/summary')), 200, 'suppliers summary');

// ----- Purchase orders -----
export interface PoLineIn {
  variant_id: string;
  unit_cost_amount: number;
  quantity: number;
}

export const createPoRaw = (s: Session, body: Json, as: Session = s) => call(as, 'POST', spath(s, '/purchase-orders'), body);

export async function createPo(s: Session, supplierId: string, lines: PoLineIn[], extra: Json = {}): Promise<Json> {
  return ok(await createPoRaw(s, { supplier_id: supplierId, lines, ...extra }), 201, 'create PO');
}

export const poRaw = (s: Session, id: string, as: Session = s) => call(as, 'GET', spath(s, `/purchase-orders/${id}`));
export const po = async (s: Session, id: string, as: Session = s) => ok(await poRaw(s, id, as), 200, `PO ${id}`);

export async function poList(s: Session, query = '', as: Session = s): Promise<{ data: Json[]; meta: Json }> {
  const r = await call(as, 'GET', spath(s, `/purchase-orders${query ? `?${query}` : ''}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return { data: r.json.data as Json[], meta: r.json.meta as Json };
}

export const poSummary = async (s: Session) => ok(await call(s, 'GET', spath(s, '/purchase-orders/summary')), 200, 'PO summary');

export const patchPoRaw = (s: Session, id: string, change: Json, as: Session = s) => call(as, 'PATCH', spath(s, `/purchase-orders/${id}`), change);

export type Transition = 'send' | 'mark-ordered' | 'close' | 'cancel';
export const transitionPoRaw = (s: Session, id: string, action: Transition, body: Json = {}, as: Session = s) =>
  call(as, 'POST', spath(s, `/purchase-orders/${id}/${action}`), body);

export async function sendPo(s: Session, id: string, via: 'pdf' | 'whatsapp' | 'manual', revision?: number): Promise<Json> {
  return ok(await transitionPoRaw(s, id, 'send', { sent_via: via, ...(revision === undefined ? {} : { revision }) }), 200, `send ${id} via ${via}`);
}

export const deletePoRaw = (s: Session, id: string, as: Session = s) => call(as, 'DELETE', spath(s, `/purchase-orders/${id}`));

export interface ReceiveLine {
  item_id: string;
  received: number;
  damaged?: number;
}

export const receiveRaw = (s: Session, id: string, lines: ReceiveLine[], key: string | null = randomUUID(), extra: Json = {}, as: Session = s) =>
  call(as, 'POST', spath(s, `/purchase-orders/${id}/receipts`), { lines: lines.map((l) => ({ damaged: 0, ...l })), ...extra }, key ? { 'Idempotency-Key': key } : undefined);

export async function receive(s: Session, id: string, lines: ReceiveLine[], key: string = randomUUID(), extra: Json = {}): Promise<Json> {
  return ok(await receiveRaw(s, id, lines, key, extra), 201, `receive on ${id}`);
}

export const quickRaw = (s: Session, body: Json, key: string | null = randomUUID(), as: Session = s) =>
  call(as, 'POST', spath(s, '/purchase-orders/quick'), body, key ? { 'Idempotency-Key': key } : undefined);

export const pdf = (s: Session, id: string) => binaryGet(s, spath(s, `/purchase-orders/${id}/pdf`));

// ----- Payments -----
export const payRaw = (s: Session, supplierId: string, body: Json, as: Session = s) => call(as, 'POST', spath(s, `/suppliers/${supplierId}/payments`), body);

export async function pay(s: Session, supplierId: string, amount: number, extra: Json = {}): Promise<Json> {
  return ok(await payRaw(s, supplierId, { amount, method: 'bkash', paid_on: today(), ...extra }), 201, 'supplier payment');
}

export const deletePaymentRaw = (s: Session, paymentId: string, as: Session = s) => call(as, 'DELETE', spath(s, `/supplier-payments/${paymentId}`));

// ----- Reorder suggestions, invoices -----
export async function reorderSuggestions(s: Session): Promise<Json[]> {
  return (await ok(await call(s, 'GET', spath(s, '/purchasing/reorder-suggestions')), 200, 'reorder suggestions')) as unknown as Json[];
}

// ----- Supplier CSV import (P88B-15): same upload → validate → run flow as products -----
export const uploadSupplierCsv = (s: Session, csv: Buffer, filename = `e2e-suppliers-${Date.now()}.csv`, as: Session = s) =>
  apiCall(as, 'POST', spath(s, '/imports'), { multipart: { type: 'suppliers', file: { name: filename, mimeType: 'text/csv', buffer: csv } } });

// ---------------------------------------------------------------------------------------------
// Catalog / inventory reads
// ---------------------------------------------------------------------------------------------

/** The variant row of a product (cost_amount, inventory{on_hand, committed, available}). */
export async function variantOf(s: Session, productId: string, variantId: string): Promise<Json> {
  const r = await call(s, 'GET', spath(s, `/products/${productId}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  const v = (r.json.data.variants as Json[]).find((x) => x.id === variantId);
  expect(v, `variant ${variantId}`).toBeTruthy();
  return v!;
}

/** The Stock levels row of a variant (`incoming` since 8.8b). */
export async function inventoryRow(s: Session, variantId: string, as: Session = s): Promise<Json> {
  const r = await call(as, 'GET', spath(s, '/inventory?per_page=100'));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  const row = (r.json.data as Json[]).find((x) => x.variant_id === variantId);
  expect(row, `inventory row ${variantId}`).toBeTruthy();
  return row!;
}

/** Ledger rows referencing a PO (`filter[reference_type]=purchase_order`, §8.1). */
export async function poMovements(s: Session, poId: string): Promise<Json[]> {
  const r = await call(s, 'GET', spath(s, '/inventory/movements?filter[reference_type]=purchase_order&per_page=100'));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return (r.json.data as Json[]).filter((m) => m.reference?.type === 'purchase_order' && m.reference?.id === poId);
}

export const lineFor = (detail: Json, variantId: string): Json => {
  const l = (detail.lines as Json[]).find((x) => x.variant_id === variantId);
  expect(l, `PO line for ${variantId}`).toBeTruthy();
  return l!;
};

/** Every key named `*_amount` (and `amount`) with a non-null value anywhere in a payload (adjust-only checks, S168). */
export function moneyLeaks(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => moneyLeaks(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Json).flatMap(([k, v]) => {
      const here = (k === 'amount' || k.endsWith('_amount')) && v !== null && v !== undefined ? [`${path}.${k}=${JSON.stringify(v)}`] : [];
      return [...here, ...moneyLeaks(v, `${path}.${k}`)];
    });
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Orders: manual order of `qty` → shipped (order_shipped movements feed reorder suggestions, §7)
// ---------------------------------------------------------------------------------------------

export async function manualOrderQty(shop: CommerceShop, variantId: string, qty: number, phone = '01711000999'): Promise<Json> {
  const body = {
    items: [{ variant_id: variantId, quantity: qty }],
    channel: 'phone',
    contact: { name: 'Karim Mia', phone },
    shipping_address: { ...GEO.dhanmondi, address_line: 'House 3, Road 9' },
    notify_customer: false,
  };
  return ok(await call(shop.s, 'POST', spath(shop.s, '/orders'), body, { 'Idempotency-Key': randomUUID() }), 201, 'manual order');
}

export async function shipOrder(s: Session, id: string): Promise<void> {
  for (const [action, body] of [
    ['confirm', {}],
    ['ready', {}],
    ['ship', { carrier_name: 'Steadfast', tracking_code: `QA-${id.slice(-8)}` }],
  ] as const) {
    let r = await transition(s, id, action, body);
    for (let i = 0; i < 3 && r.status === 500 && /database is locked/.test(JSON.stringify(r.json)); i++) {
      await new Promise((res) => setTimeout(res, 700));
      r = await transition(s, id, action, body);
    }
    expect(r.status, `${action}: ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
  }
}

export async function audit(s: Session): Promise<Json[]> {
  const r = await api(s, 'GET', '/audit-logs?per_page=100');
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  return r.json.data as Json[];
}

// ---------------------------------------------------------------------------------------------
// UI (§10)
// ---------------------------------------------------------------------------------------------

export const inventoryTabs = (page: Page): Locator => page.getByRole('tablist', { name: 'Inventory' }).or(page.getByRole('navigation', { name: 'Inventory' })).first();
export const inventoryTab = (page: Page, name: 'Stock levels' | 'Stock movements' | 'Purchase orders' | 'Suppliers'): Locator =>
  inventoryTabs(page).getByRole('tab', { name, exact: true }).or(inventoryTabs(page).getByRole('link', { name, exact: true })).or(inventoryTabs(page).getByRole('button', { name, exact: true })).first();

async function openTab(page: Page, path: string, tab: 'Purchase orders' | 'Suppliers'): Promise<void> {
  await page.goto(mUrl(path));
  await expect(inventoryTab(page, tab)).toBeVisible({ timeout: 20_000 });
}

export const openPoList = (page: Page) => openTab(page, PO_LIST, 'Purchase orders');
export const openSuppliers = (page: Page) => openTab(page, SUPPLIERS, 'Suppliers');

export async function openPo(page: Page, id: string, number: string): Promise<void> {
  await page.goto(mUrl(poPage(id)));
  await expect(page.getByRole('heading', { name: new RegExp(number), level: 1 })).toBeVisible({ timeout: 20_000 });
}

export const button = (scope: Page | Locator, name: RegExp): Locator => scope.getByRole('button', { name }).or(scope.getByRole('link', { name })).first();
export const newPoButton = (page: Page) => button(page, /New purchase order/);
export const quickPurchaseButton = (page: Page) => button(page, /^Quick purchase$/);
export const addSupplierButton = (page: Page) => button(page, /Add supplier/);
export const importButton = (page: Page) => button(page, /^Import$/);
export const sendToSupplier = (page: Page) => button(page, /^Send to supplier$/);
export const receiveAllRemaining = (page: Page) => button(page, /^Receive all remaining$/);
export const receiveUnits = (page: Page) => page.getByRole('button', { name: /^Receive \d+ units?$/ }).first();
export const recordPayment = (page: Page) => button(page, /^Record payment$/);
export const dialog = (page: Page): Locator => page.getByRole('dialog').last();
export const statusPill = (page: Page, label: RegExp): Locator => page.getByText(label).first();

/** The receive-table row (desktop table row or stacked card below md) of a product line. */
export function receiveRow(page: Page, product: string | RegExp): Locator {
  return page
    .getByRole('row')
    .filter({ hasText: product })
    .or(page.getByRole('group').filter({ hasText: product }))
    .or(page.getByRole('listitem').filter({ hasText: product }))
    .first();
}

/** RECEIVING NOW / DAMAGED inputs of a line (spinbuttons labelled per line, else the first/second number input). */
export function receiveInputs(page: Page, product: string | RegExp): { now: Locator; damaged: Locator } {
  const row = receiveRow(page, product);
  const all = row.getByRole('spinbutton');
  // The receive inputs are `inputMode="numeric"` text boxes ("Receiving now of {name}" / "Damaged of {name}").
  return {
    now: row.getByRole('textbox', { name: /Receiving now/i }).or(row.getByRole('spinbutton', { name: /Receiving now/i })).or(all.nth(0)).first(),
    damaged: row.getByRole('textbox', { name: /Damaged/i }).or(row.getByRole('spinbutton', { name: /Damaged/i })).or(all.nth(1)).first(),
  };
}

/** Waits for one API response by method + path regex. */
export const waitApi = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((r) => r.request().method() === method && path.test(new URL(r.url()).pathname));

/** Opens a picker dialog from `trigger`, searches `text` and picks the first matching option/row. */
export async function pickInDialog(page: Page, trigger: Locator, text: string, choose: RegExp = new RegExp(text)): Promise<void> {
  await trigger.click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  const search = d.getByRole('searchbox').or(d.getByRole('textbox')).first();
  if (await search.isVisible().catch(() => false)) await search.fill(text);
  const option = d
    .getByRole('option', { name: choose })
    .or(d.getByRole('checkbox', { name: choose }))
    .or(d.getByRole('radio', { name: choose }))
    .or(d.getByRole('button', { name: choose }))
    .or(d.getByRole('row', { name: choose }))
    .first();
  await option.click();
  const confirm = d.getByRole('button', { name: /^(Add|Done|Select|Choose|Add \d+.*)$/ }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

/** "৳" or a money figure anywhere in `scope` (adjust-only receivers never see prices, P88B-11). */
export async function moneyOnScreen(scope: Locator): Promise<string[]> {
  const text = await scope.innerText();
  return text.split('\n').filter((l) => /৳|BDT\s?\d/.test(l));
}

/** Waits for the page's first `PO-…` number when a new PO was created from the UI. */
export const PO_NUMBER = /PO-\d+/;

import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { apiCall, type ApiResult, type Session } from './api';
import { retryLocked, spath } from './purchasing';
import { mUrl } from './locations';

/**
 * Phase 8.8c part B helpers (PHASE-8-8C-CONTRACT §7, §8, §9, §10.4, §10.5, §13 QA): stock transfers `TR-{n}` and stock
 * counts, API + UI selectors.
 *
 * Shapes follow `packages/types` (openapi 1.19.0): `StockTransferDetail` `{id, number "TR-001", status, from_location,
 * to_location, items_count, units_sent, units_received, units_short, created_by, lines[{id, variant: StockVariantRef
 * {id, sku, …}, quantity, quantity_received, source_on_hand, source_available, …}], events, revision}` is the body of
 * create (201), PATCH, send, receive and cancel; `StockCountDetail` (header + `summary`) is the body of start (201),
 * GET, finish and cancel; lines come from `GET …/stock-counts/{count}/lines` (`filter[state]`, `q`, 100 per page);
 * scan / set-line return `{line, summary, count}`. Send, receive and finish carry an `Idempotency-Key`.
 * UI ASSUMPTIONS (WEB must match them or tell QA): Inventory tabs "Transfers" (`/inventory/transfers`) and "Stock count"
 * (`/inventory/counts`), Inventory "Transfer stock" (Growth, > 1 location), side panel / sheet with From / To selects,
 * "+ Add product", quantity inputs, "Save draft" / "Send" / "Receive" (+ "Receive all") / "Cancel transfer"; count
 * screen with the SKU box "Type or scan a SKU", chips All / Not counted / Differences / Matched, click-to-edit COUNTED,
 * "Set uncounted items to 0", "Finish & adjust stock" + confirm dialog, "Cancel count".
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const TRANSFERS = '/inventory/transfers';
export const COUNTS = '/inventory/counts';
export const TR_NUMBER = /^TR-\d{3,}$/;
/** Transfer plan note on Free/Starter (P88C-13); wording is WEB's — accept the obvious variants. */
export const TRANSFER_PLAN_NOTE = /(Transfers?|Moving stock|More than one location|Multiple (warehouses|locations)).{0,80}(Growth|upgrade)/i;
export const SKU_BOX = /Type or scan a SKU/i;

const call = (as: Session, method: string, path: string, json?: unknown, headers?: Record<string, string>) =>
  retryLocked(() => apiCall(as, method, path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers } : {}) }));

async function ok(r: ApiResult, status: number, what: string): Promise<Json> {
  expect(r.status, `${what}: ${r.text.slice(0, 400)}`).toBe(status);
  return r.json.data as Json;
}

export const idemKey = () => ({ 'Idempotency-Key': randomUUID() });

// ---------------------------------------------------------------------------------------------
// Transfers API (§7, §9)
// ---------------------------------------------------------------------------------------------

export interface TransferLineIn {
  variant_id: string;
  quantity: number;
}

export const createTransferRaw = (s: Session, body: Json, as: Session = s, headers?: Record<string, string>) =>
  call(as, 'POST', spath(s, '/stock-transfers'), body, headers ?? (body.send ? idemKey() : undefined));

export async function createTransfer(s: Session, from: string, to: string, lines: TransferLineIn[], over: Json = {}): Promise<Json> {
  return ok(await createTransferRaw(s, { from_location_id: from, to_location_id: to, lines, ...over }), 201, 'create transfer');
}

export const transferRaw = (s: Session, id: string, as: Session = s) => call(as, 'GET', spath(s, `/stock-transfers/${id}`));

export async function transfer(s: Session, id: string): Promise<Json> {
  return ok(await transferRaw(s, id), 200, `transfer ${id}`);
}

export const transfersRaw = (s: Session, query = '', as: Session = s) => call(as, 'GET', spath(s, `/stock-transfers${query ? `?${query}` : ''}`));
export const transferSummaryRaw = (s: Session, as: Session = s) => call(as, 'GET', spath(s, '/stock-transfers/summary'));

export type TransferAction = 'send' | 'receive' | 'cancel';
export const transferActionRaw = (s: Session, id: string, action: TransferAction, body: Json = {}, as: Session = s, headers?: Record<string, string>) =>
  call(as, 'POST', spath(s, `/stock-transfers/${id}/${action}`), body, headers ?? (action === 'cancel' ? undefined : idemKey()));

export async function sendTransfer(s: Session, id: string): Promise<Json> {
  return ok(await transferActionRaw(s, id, 'send'), 200, `send ${id}`);
}

/** `received` maps item id → received units; lines left out receive their full quantity. */
export async function receiveTransfer(s: Session, t: Json, received: Record<string, number> = {}): Promise<Json> {
  const lines = (t.lines as Json[]).map((l) => ({ item_id: l.id, received: received[l.id] ?? l.quantity }));
  // receive is `in_transit` only and idempotent (Idempotency-Key added by transferActionRaw)
  return ok(await transferActionRaw(s, t.id, 'receive', { lines }), 200, `receive ${t.id}`);
}

export async function cancelTransfer(s: Session, id: string): Promise<Json> {
  return ok(await transferActionRaw(s, id, 'cancel'), 200, `cancel ${id}`);
}

/** The transfer line of a variant (`variant.id`). */
export function lineOf(t: Json, variantId: string): Json {
  const l = (t.lines as Json[]).find((x) => x.variant?.id === variantId);
  expect(l, `transfer line for ${variantId}`).toBeTruthy();
  return l!;
}

// ---------------------------------------------------------------------------------------------
// Stock counts API (§8, §9)
// ---------------------------------------------------------------------------------------------

export const startCountRaw = (s: Session, body: Json, as: Session = s) => call(as, 'POST', spath(s, '/stock-counts'), body);

export async function startCount(s: Session, locationId: string, over: Json = {}): Promise<Json> {
  return ok(await startCountRaw(s, { location_id: locationId, ...over }), 201, 'start count');
}

export const countRaw = (s: Session, id: string, query = '', as: Session = s) => call(as, 'GET', spath(s, `/stock-counts/${id}${query ? `?${query}` : ''}`));

export async function count(s: Session, id: string, query = ''): Promise<Json> {
  return ok(await countRaw(s, id, query), 200, `count ${id}`);
}

export const countsRaw = (s: Session, as: Session = s) => call(as, 'GET', spath(s, '/stock-counts'));

export const scanRaw = (s: Session, id: string, code: string, as: Session = s) => call(as, 'POST', spath(s, `/stock-counts/${id}/scan`), { code });
export const setCountedRaw = (s: Session, id: string, lineId: string, counted: number | null, as: Session = s) =>
  call(as, 'PUT', spath(s, `/stock-counts/${id}/lines/${lineId}`), { counted });

export type CountAction = 'finish' | 'cancel';
export const countActionRaw = (s: Session, id: string, action: CountAction, body: Json = {}, as: Session = s, headers?: Record<string, string>) =>
  call(as, 'POST', spath(s, `/stock-counts/${id}/${action}`), body, headers ?? (action === 'finish' ? idemKey() : undefined));

export async function finishCount(s: Session, id: string, zeroUncounted = false): Promise<Json> {
  return ok(await countActionRaw(s, id, 'finish', { zero_uncounted: zeroUncounted }), 200, `finish count ${id}`);
}

export const countLinesRaw = (s: Session, id: string, query = '', as: Session = s) =>
  call(as, 'GET', spath(s, `/stock-counts/${id}/lines${query ? `?${query}` : ''}`));

/** Lines of a count (all pages of 100). */
export async function countLines(s: Session, id: string, query = ''): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 1; page < 60; page++) {
    const r = await countLinesRaw(s, id, `per_page=100&page=${page}${query ? `&${query}` : ''}`);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    out.push(...(r.json.data as Json[]));
    const last = r.json.meta?.last_page as number | undefined;
    if (!last || page >= last) break;
  }
  return out;
}

export async function countLineOf(s: Session, id: string, variantId: string): Promise<Json> {
  const l = (await countLines(s, id)).find((x) => x.variant?.id === variantId);
  expect(l, `count line for ${variantId}`).toBeTruthy();
  return l!;
}

// ---------------------------------------------------------------------------------------------
// UI (§10.4, §10.5)
// ---------------------------------------------------------------------------------------------

const tabs = (page: Page): Locator => page.getByRole('tablist', { name: 'Inventory' }).or(page.getByRole('navigation', { name: 'Inventory' })).first();
export const inventoryTab = (page: Page, name: string): Locator =>
  tabs(page).getByRole('tab', { name, exact: true }).or(tabs(page).getByRole('link', { name, exact: true })).first();

export async function openTransfers(page: Page, path = TRANSFERS): Promise<void> {
  await page.goto(mUrl(path));
  await expect(inventoryTab(page, 'Transfers')).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

export async function openCounts(page: Page, path = COUNTS): Promise<void> {
  await page.goto(mUrl(path));
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

/** A transfer row / card in the list (by number). */
export function transferRow(page: Page, number: string): Locator {
  return page.getByRole('row').filter({ hasText: number }).or(page.getByRole('listitem').filter({ hasText: number })).or(page.getByRole('link').filter({ hasText: number })).first();
}

/** Opens a transfer from the list (the number link in its row / card). */
export async function openTransfer(page: Page, number: string): Promise<void> {
  await page.getByRole('link', { name: number, exact: true }).first().click();
  await expect(panel(page).getByRole('heading', { name: new RegExp(`^${number}`) }).first()).toBeVisible({ timeout: 15_000 });
}

/** The open transfer panel: the "Transfer" aside (≥ lg) or the full-screen drawer below it. */
export const panel = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Transfer' }).or(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /^(TR-\d+|New transfer)/ }) })).first();

export const transferStockButton = (page: Page): Locator => page.getByRole('button', { name: /Transfer stock/i }).or(page.getByRole('link', { name: /Transfer stock/i })).first();
export const newTransferButton = (page: Page): Locator => page.getByRole('button', { name: /New transfer/i }).or(page.getByRole('link', { name: /New transfer/i })).first();
export const startCountButton = (page: Page): Locator => page.getByRole('button', { name: /Start (a )?count/i }).or(page.getByRole('link', { name: /Start (a )?count/i })).first();

/** Status pill text inside a scope (exact pill wording from §10.4). */
export const pill = (scope: Locator | Page, text: string | RegExp): Locator => scope.getByText(text).first();

/** "+ Add product" in the transfer panel: search the product, click the picker row "Add {product}[ {variant}]". */
export async function addTransferProduct(page: Page, p: Locator, search: string, rowName: string): Promise<void> {
  await p.getByRole('button', { name: '+ Add product' }).click();
  const picker = page.getByRole('dialog', { name: 'Add product' });
  await expect(picker).toBeVisible();
  await picker.getByRole('searchbox', { name: 'Search products' }).or(picker.getByLabel('Search products')).first().fill(search);
  const opt = picker.getByRole('button', { name: rowName, exact: true });
  await expect(opt).toBeEnabled({ timeout: 10_000 });
  await opt.click();
  await expect(picker).toBeHidden();
}

/** The count-table row of a product / variant label. */
export function countRow(page: Page, label: string | RegExp): Locator {
  return page.getByRole('row').filter({ hasText: label }).or(page.getByRole('listitem').filter({ hasText: label })).first();
}

/** Types `code` in the SKU box and presses Enter; waits for the scan call. */
export async function typeSku(page: Page, code: string): Promise<number> {
  const box = page.getByRole('textbox', { name: SKU_BOX }).or(page.getByPlaceholder(SKU_BOX)).or(page.getByLabel(SKU_BOX)).first();
  await expect(box).toBeVisible();
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && /\/stock-counts\/[0-9A-Za-z]{26}\/scan$/.test(new URL(r.url()).pathname));
  await box.fill(code);
  await box.press('Enter');
  const status = (await res).status();
  await expect(box, 'SKU box keeps focus (§10.5)').toBeFocused();
  return status;
}

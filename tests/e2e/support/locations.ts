import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { apiCall, urls, type ApiResult, type Session } from './api';
import { cartAdd, sf, type CommerceShop } from './commerce';
import { retryLocked, spath } from './purchasing';

/**
 * Phase 8.8c part A helpers (PHASE-8-8C-CONTRACT §4–§6, §9, §10.1–§10.3, §13 QA): locations, per-location stock,
 * the online (= default) location, "Receive at" on POs, and the Warehouses tab selectors.
 *
 * Shapes follow the contract + `packages/types` (`Location`, `InventoryItem.locations[]`, `InventoryLevel` +
 * `location_id` / `total_on_hand` / `other_locations_on_hand`, `StockMovement.location`). ASSUMPTIONS (the builders
 * must match them or tell QA):
 *  - `GET …/locations` → `data: Location[]` sorted default first; `Location` = `{id, name, type, address, is_default,
 *    archived_at, units_on_hand, stock_value_amount, variants_count, pickup_location}`; archived ones included
 *    (or behind `filter[archived]`) — helpers only rely on the active ones.
 *  - `POST …/locations` `{name, type, address?}` → 201; `POST …/{id}/make-default|archive|unarchive` → 200 + Location.
 *  - `POST …/inventory/adjustments` items accept `location_id`; the response `items[]` are that location's numbers.
 *  - `GET …/inventory?filter[location_id]=…` → one row per variant with that location's `on_hand/committed/available`;
 *    without the filter → totals + `locations: [{id, name, on_hand, committed, available}]`.
 *  - Storefront `GET /products/{slug}/availability` → `variants[{id, available, low_stock}]` from the online location.
 *  - UI: Inventory tab "Warehouses" (`/inventory/warehouses`), "+ Add location" dialog (Name, Type, Address), row menu
 *    Edit / Make default / Archive, "Default" + "Online orders ship from here"; location selector (combobox or button
 *    named "Location"/"All locations") only when > 1 location; adjust dialog "Location" select (> 1 location).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const WAREHOUSES = '/inventory/warehouses';
export const DEFAULT_NAME = 'Main warehouse';
export const DHANMONDI = 'Dhanmondi shop';
export const ONLINE_NOTE = /Online orders ship from here/i;
/** Free/Starter upgrade note on the Warehouses tab (P88C-13, §10.2). */
export const UPGRADE_NOTE = /More than one location is on Growth/;

const call = (as: Session, method: string, path: string, json?: unknown, headers?: Record<string, string>) =>
  retryLocked(() => apiCall(as, method, path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers } : {}) }));

async function ok(r: ApiResult, status: number, what: string): Promise<Json> {
  expect(r.status, `${what}: ${r.text.slice(0, 400)}`).toBe(status);
  return r.json.data as Json;
}

// ---------------------------------------------------------------------------------------------
// Locations API (§4, §9)
// ---------------------------------------------------------------------------------------------

export const locationsRaw = (s: Session, query = '', as: Session = s) => call(as, 'GET', spath(s, `/locations${query ? `?${query}` : ''}`));

/** Non-archived locations, default first. */
export async function locations(s: Session, as: Session = s): Promise<Json[]> {
  const data = (await ok(await locationsRaw(s, '', as), 200, 'list locations')) as unknown as Json[];
  return data.filter((l) => !l.archived_at);
}

export async function defaultLocation(s: Session): Promise<Json> {
  const d = (await locations(s)).filter((l) => l.is_default);
  expect(d, 'exactly one default location').toHaveLength(1);
  return d[0];
}

export async function locationByName(s: Session, name: string): Promise<Json> {
  const l = (await locations(s)).find((x) => x.name === name);
  expect(l, `location ${name}`).toBeTruthy();
  return l!;
}

export const createLocationRaw = (s: Session, body: Json, as: Session = s) => call(as, 'POST', spath(s, '/locations'), body);

export async function createLocation(s: Session, name = DHANMONDI, over: Json = {}): Promise<Json> {
  return ok(await createLocationRaw(s, { name, type: 'shop', address: 'Road 27, Dhanmondi, Dhaka', ...over }), 201, `create location ${name}`);
}

export const patchLocationRaw = (s: Session, id: string, body: Json, as: Session = s) => call(as, 'PATCH', spath(s, `/locations/${id}`), body);

export type LocationAction = 'make-default' | 'archive' | 'unarchive';
export const locationActionRaw = (s: Session, id: string, action: LocationAction, as: Session = s) => call(as, 'POST', spath(s, `/locations/${id}/${action}`), {});

export async function makeDefault(s: Session, id: string): Promise<Json> {
  return ok(await locationActionRaw(s, id, 'make-default'), 200, `make-default ${id}`);
}

// ---------------------------------------------------------------------------------------------
// Per-location stock (§5.4)
// ---------------------------------------------------------------------------------------------

export interface AdjustLine {
  variant_id: string;
  quantity: number;
  mode?: 'delta' | 'set';
  location_id?: string;
  expected_on_hand?: number;
}

export const adjustRaw = (s: Session, items: AdjustLine[], reason = 'received', as: Session = s) =>
  call(as, 'POST', spath(s, '/inventory/adjustments'), { reason, items: items.map((i) => ({ mode: 'delta', ...i })) });

export async function adjust(s: Session, items: AdjustLine[], reason = 'received'): Promise<Json> {
  return ok(await adjustRaw(s, items, reason), 200, 'adjust stock');
}

/** The Stock levels row of a variant; `locationId` → that location's numbers, else totals + `locations[]`. */
export async function stockRow(s: Session, variantId: string, locationId?: string): Promise<Json | undefined> {
  const q = `per_page=100${locationId ? `&filter[location_id]=${locationId}` : ''}`;
  const r = await call(s, 'GET', spath(s, `/inventory?${q}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return (r.json.data as Json[]).find((x) => x.variant_id === variantId);
}

/** `{on_hand, committed, available}` of a variant at one location (a missing row reads as 0, P88C-3). */
export async function stockAt(s: Session, variantId: string, locationId: string): Promise<{ on_hand: number; committed: number; available: number }> {
  const row = await stockRow(s, variantId, locationId);
  return { on_hand: row?.on_hand ?? 0, committed: row?.committed ?? 0, available: row?.available ?? 0 };
}

/** Ledger rows of the store, optionally filtered (`reason`, `location_id`, `reference_type`). */
export async function movementsWhere(s: Session, filter: Record<string, string> = {}): Promise<Json[]> {
  const q = Object.entries(filter).map(([k, v]) => `filter[${k}]=${encodeURIComponent(v)}`);
  const r = await call(s, 'GET', spath(s, `/inventory/movements?${[...q, 'per_page=100'].join('&')}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.json.data as Json[];
}

// ---------------------------------------------------------------------------------------------
// Storefront (online location only, P88C-4, S183)
// ---------------------------------------------------------------------------------------------

/** Storefront availability of one variant: `{available, low_stock}` (low_stock = exact count when ≤ threshold). */
export async function sfAvailability(shop: CommerceShop, slug: string, variantId: string): Promise<{ available: boolean; low_stock: number | null }> {
  const r = await sf(shop.apiHost, 'GET', `/products/${slug}/availability`);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  const v = (r.json.data.variants as Json[]).find((x) => x.id === variantId);
  expect(v, `storefront variant ${variantId}`).toBeTruthy();
  return { available: v!.available, low_stock: v!.low_stock };
}

/** Can a shopper put `qty` of the variant in a fresh cart? (422 `out_of_stock` above the online available). */
export async function sfCanAdd(shop: CommerceShop, variantId: string, qty: number): Promise<{ ok: boolean; code: string | null }> {
  const { r } = await cartAdd(shop.apiHost, variantId, qty);
  if (r.status === 201 || r.status === 200) return { ok: true, code: null };
  expect(r.status, r.text.slice(0, 300)).toBe(422);
  return { ok: false, code: r.json.error?.code ?? null };
}

// ---------------------------------------------------------------------------------------------
// UI (§10.1–§10.3)
// ---------------------------------------------------------------------------------------------

export const mUrl = (path = '') => `${urls.merchant}${path}`;

const tabs = (page: Page): Locator => page.getByRole('tablist', { name: 'Inventory' }).or(page.getByRole('navigation', { name: 'Inventory' })).first();
export const warehousesTab = (page: Page): Locator =>
  tabs(page).getByRole('tab', { name: 'Warehouses', exact: true }).or(tabs(page).getByRole('link', { name: 'Warehouses', exact: true })).first();

export async function openWarehouses(page: Page): Promise<void> {
  await page.goto(mUrl(WAREHOUSES));
  await expect(warehousesTab(page)).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

/** A location card / table row on the Warehouses tab. */
export function locationCard(page: Page, name: string): Locator {
  return page
    .getByRole('row')
    .filter({ hasText: name })
    .or(page.getByRole('listitem').filter({ hasText: name }))
    .or(page.getByRole('article').filter({ hasText: name }))
    .or(page.getByRole('group').filter({ hasText: name }))
    .first();
}

export const addLocationButton = (page: Page): Locator => page.getByRole('button', { name: /Add location/ }).first();

/** The Inventory location selector (§10.1 `11:842`): hidden with one location. */
export const locationSelector = (page: Page): Locator =>
  page
    .getByRole('combobox', { name: /Location/i })
    .or(page.getByRole('button', { name: /All locations/ }))
    .or(page.getByLabel(/^Location$/))
    .first();

/** Picks `name` in a select/combobox/listbox labelled `label` inside `scope`. */
export async function chooseOption(scope: Page | Locator, page: Page, label: RegExp, name: string): Promise<void> {
  const field = scope.getByLabel(label).or(scope.getByRole('combobox', { name: label })).first();
  await expect(field).toBeVisible();
  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    // selectOption waits for a missing option until the test times out: pick the label from the rendered options.
    const opts = (await field.locator('option').allTextContents()).map((o) => o.trim());
    const match = opts.find((o) => o === name) ?? opts.find((o) => o.includes(name));
    expect(match, `option ${name} in ${opts.join(' | ')}`).toBeTruthy();
    await field.selectOption({ label: match! });
    return;
  }
  await field.click();
  await page.getByRole('option', { name: new RegExp(name) }).first().click();
}

/** Opens the row menu of a location card and clicks `item` (Edit / Make default / Archive). */
export async function locationMenu(page: Page, name: string, item: RegExp): Promise<void> {
  const card = locationCard(page, name);
  const direct = card.getByRole('button', { name: item });
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  await card.getByRole('button', { name: /More|Actions|Options|menu|⋯|…/i }).or(card.getByRole('button').last()).first().click();
  await page.getByRole('menuitem', { name: item }).or(page.getByRole('button', { name: item })).first().click();
}

export const idem = () => ({ 'Idempotency-Key': randomUUID() });

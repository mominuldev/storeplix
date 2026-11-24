import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { api, createMember, E2E_ROOT, signInDashboard, type ThrowawayMember } from '../support/api';
import { customerOf } from '../support/automations';
import { bookShipment, connectFakeCourier, merchantOrder, randomPhone, type CommerceShop } from '../support/commerce';
import {
  buildRecord,
  deliveryRecord,
  guardEvents,
  guardShop,
  heldBanner,
  holdTag,
  mUrl,
  overview,
  patchGuard,
  placeCod,
  releaseAndConfirm,
  releaseRaw,
  waitGuard,
} from '../support/fraud-guard';
import { pageOverflow, watchConsole } from '../support/roles';

/**
 * PHASE-8-8 §13 QA "held order" + "duplicate" (P88-2, P88-4, P88-5, P88-12, §5.3, §5.5; S156, S157; AC 1, AC 2):
 *  - a phone with 2 delivered / 3 returned at this shop (40 %, risky) places a storefront COD order → after the check it
 *    waits in Pending with hold `call_first`, reasons incl. `rate_below_hold`, record from this shop only, one `guard`
 *    timeline event; the customer's tier is the same `risky` (one risk everywhere, P88-3);
 *  - confirm, bulk confirm and courier booking answer 409 `order_held`;
 *  - the owner releases it from the order page ("Release and confirm", 390 px screenshot) → confirmed → booking works;
 *  - staff (orders.process, no fraud.manage) can release by API; a second release → 409 `order_not_held`;
 *  - a known good number ordering the same variant twice within 24 h → the second order is held as `duplicate`, listed by
 *    `filter[guard_hold]=1`, counted in `meta.counts.held`, the decision log and the overview.
 * Fixture rule: `block_after_returns` is raised to 5 first, or the third return would auto-block the risky phone (P88-10)
 * and its COD checkout would be refused instead of held.
 */
test.describe.configure({ mode: 'serial' });

const OUT = resolve(E2E_ROOT, 'test-results/phase8-8-visual/390');
let shop: CommerceShop;
let staff: ThrowawayMember | undefined;
const risky = randomPhone();
const known = randomPhone();
let heldId = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  shop = await guardShop('fgh', 'growth');
  await patchGuard(shop.s, { block_after_returns: 5 });
  await connectFakeCourier(shop.s, 'steadfast');
  staff = await createMember(shop.s, 'staff');
  await buildRecord(shop, risky, 2, 3);
  await buildRecord(shop, known, 1, 0);
});
test.afterAll(async () => {
  await staff?.cleanup();
  shop?.cleanup();
});

test('risky record (2 delivered / 3 returned) → COD order held "call_first" with reasons, own-shop record, one guard event (AC 1, S157)', async () => {
  test.setTimeout(120_000);
  const placed = await placeCod(shop, risky);
  const o = await waitGuard(shop.s, placed.id);
  expect(o.status, 'a hold is a flag, not a status (P88-2)').toBe('pending');
  expect(o.guard).toMatchObject({ hold: 'call_first', decision: 'hold', tier: 'risky', rate: 40 });
  expect(o.guard.reasons as string[]).toContain('rate_below_hold');
  expect(o.guard.record).toMatchObject({ total: 5, delivered: 2 });
  expect(o.guard.record.sources, 'only the own-shop source (P88-1, P88-7)').toEqual([{ key: 'shop', delivered: 2, total: 5 }]);
  const guardRows = ((o.events ?? []) as Array<{ type: string }>).filter((e) => e.type === 'guard');
  expect(guardRows.length, 'exactly one guard timeline event').toBe(1);

  const c = await customerOf(shop.s, risky);
  expect(c?.risk, 'customer tier = order tier (P88-3)').toMatchObject({ tier: 'risky', delivered: 2, total: 5 });
  expect((await guardEvents(shop.s, 'held')).some((e) => e.order?.id === placed.id)).toBe(true);
  heldId = placed.id;
});

test('held order: confirm, bulk confirm and courier booking → 409 order_held (S156, AC 2)', async () => {
  const confirm = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/orders/${heldId}/confirm`, {});
  expect([confirm.status, confirm.json.error?.code]).toEqual([409, 'order_held']);
  const bulk = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/orders/bulk`, { action: 'confirm', ids: [heldId] });
  expect(bulk.status, JSON.stringify(bulk.json)).toBe(200);
  expect(bulk.json.data.updated).toBe(0);
  expect(bulk.json.data.skipped).toEqual([{ id: heldId, reason: 'order_held' }]);
  const book = await bookShipment(shop.s, heldId);
  expect([book.status, book.json.error?.code], book.text.slice(0, 300)).toEqual([409, 'order_held']);
  const staffConfirm = await api(staff!.session, 'POST', `/stores/${shop.s.storeId}/orders/${heldId}/confirm`, {});
  expect([staffConfirm.status, staffConfirm.json.error?.code]).toEqual([409, 'order_held']);
  expect((await merchantOrder(shop.s, heldId)).status).toBe('pending');
});

test('UI 390 px: Pending + "Call first" tag, hold banner, Delivery record (Your shop only) → Release and confirm → booking works', async ({ page, context }) => {
  test.setTimeout(150_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(`/orders/${heldId}`));
  await expect(holdTag(page, 'Call first')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^Pending$/).first()).toBeVisible();
  await expect(heldBanner(page)).toBeVisible();
  const record = deliveryRecord(page);
  await expect(record).toBeVisible();
  await expect(record.getByText(/Your shop/).first()).toBeVisible();
  await expect(record.getByText(/Steadfast|Pathao|RedX/), 'no courier bars (P88-7)').toHaveCount(0);
  await expect(page.getByText(/Buyer: \d+ of \d+ delivered/), 'courier choice record hidden').toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(await pageOverflow(page), 'no horizontal page scroll at 390 px').toBeNull();
  await page.screenshot({ path: `${OUT}/order-held-risky.png`, fullPage: true });

  const released = page.waitForResponse((r) => /\/orders\/[0-9a-z]{26}\/guard\/release$/i.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  const confirmed = page.waitForResponse((r) => /\/orders\/[0-9a-z]{26}\/confirm$/i.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  await releaseAndConfirm(page).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: /Release|Confirm/ }).last().click();
  expect((await released).status()).toBe(200);
  expect((await confirmed).status()).toBe(200);
  await expect(page.getByText(/^Confirmed$/).first()).toBeVisible({ timeout: 15_000 });
  await expect(holdTag(page, 'Call first')).toHaveCount(0);

  const o = await merchantOrder(shop.s, heldId);
  expect([o.status, o.guard?.hold ?? null]).toEqual(['confirmed', null]);
  const book = await bookShipment(shop.s, heldId);
  expect(book.status, book.text.slice(0, 300)).toBe(201);
  expect((await guardEvents(shop.s, 'released')).some((e) => e.order?.id === heldId)).toBe(true);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('staff (orders.process) releases a hold by API; a second release → 409 order_not_held (P88-14)', async () => {
  test.setTimeout(90_000);
  const second = await placeCod(shop, risky, shop.variable.variants[0].id as string);
  expect((await waitGuard(shop.s, second.id)).guard.hold).toBe('call_first');
  const r = await releaseRaw(shop.s, second.id, staff!.session);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect((await merchantOrder(shop.s, second.id)).guard?.hold ?? null).toBeNull();
  const again = await releaseRaw(shop.s, second.id, staff!.session);
  expect([again.status, again.json.error?.code]).toEqual([409, 'order_not_held']);
  const confirm = await api(staff!.session, 'POST', `/stores/${shop.s.storeId}/orders/${second.id}/confirm`, {});
  expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
});

test('duplicate: same phone + same variant within 24 h → second order held as duplicate; list filter, counts, log, overview (P88-12)', async () => {
  test.setTimeout(120_000);
  const first = await placeCod(shop, known);
  const a = await waitGuard(shop.s, first.id);
  expect(a.guard).toMatchObject({ hold: null, decision: 'none', tier: 'good' });
  const dup = await placeCod(shop, known);
  const b = await waitGuard(shop.s, dup.id);
  expect(b.guard).toMatchObject({ hold: 'call_first', decision: 'hold' });
  expect(b.guard.reasons as string[]).toContain('duplicate');
  expect(b.status).toBe('pending');
  expect((await merchantOrder(shop.s, first.id)).guard?.hold ?? null, 'the first order is never touched').toBeNull();

  const list = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?filter[guard_hold]=1`);
  expect(list.status).toBe(200);
  const ids = (list.json.data as Array<{ id: string }>).map((o) => o.id);
  expect(ids).toContain(dup.id);
  expect(ids).not.toContain(first.id);
  expect(list.json.meta?.counts?.held).toBeGreaterThanOrEqual(1);
  const risk = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?filter[risk]=risky`);
  expect(risk.status).toBe(200);
  for (const o of risk.json.data as Array<{ guard: { tier: string } | null; customer?: { risk?: { tier: string } } }>) {
    expect(o.guard?.tier ?? o.customer?.risk?.tier).toBe('risky');
  }

  expect((await guardEvents(shop.s, 'duplicate')).some((e) => e.order?.id === dup.id)).toBe(true);
  const ov = await overview(shop.s);
  expect(ov.rules_total).toBe(6);
  expect(ov.stopped.duplicates).toBeGreaterThanOrEqual(1);
  expect(ov.stopped.held).toBeGreaterThanOrEqual(1);
  expect(ov.orders_checked, 'every new order gets a check (AC 1)').toBeGreaterThanOrEqual(4);
});

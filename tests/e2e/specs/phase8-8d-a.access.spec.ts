import { expect, test } from '@playwright/test';
import { createMember, signInDashboard, type Session, type ThrowawayMember } from '../support/api';
import { setPlan } from '../support/commerce';
import { mUrl } from '../support/locations';
import { createRole, navLabels, noAccess, watchConsole } from '../support/roles';
import {
  catalogRaw,
  closeRaw,
  createRegisterRaw,
  customerLookupRaw,
  gotoPos,
  idem,
  lookupRaw,
  MIRPUR,
  openRaw,
  openSession,
  patchRegisterRaw,
  PLAN_NOTE,
  posShop,
  quoteRaw,
  registerActionRaw,
  registersRaw,
  saleGetRaw,
  saleRaw,
  session,
  sessionRaw,
  smsReceiptRaw,
  cashSale,
  clearCounts,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D part A access (§2, §10, §11.9; S195, S196, S197, S202):
 *  - S196: a custom role without `pos.sell` (orders.view only) has no POS in the sidebar, `/pos` shows the no-access
 *    page and every POS route answers 403 `forbidden`; a cashier-only custom role (`pos.sell`) sells but can't write
 *    registers (`settings.manage`); system Staff has POS.
 *  - S197: a Starter shop sees the plan note (no Open register form); register create / open / quote / sale → 402
 *    `feature_not_in_plan`; reads stay 200. After a Growth → Starter downgrade with an open session: sale 402, close 200,
 *    the UI offers "Close register" under the plan note.
 *  - S195: A's register / session / sale through B's path or session → 404; B's ids in A's bodies and queries → 422.
 *  - Register rules: `register_in_use` (409) on archive / location change of an open register.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let a: PosShop;
let b: PosShop;
let starter: PosShop;
let viewer: ThrowawayMember | undefined;
let cashier: ThrowawayMember | undefined;
let staff: ThrowawayMember | undefined;
let aSession: Json;
let aSale: Json;
let bSession: Json;
const as = (m: ThrowawayMember | undefined): Session => ({ ...m!.session, storeId: a.s.storeId });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  a = await posShop('paa', 'growth');
  b = await posShop('pab', 'growth');
  starter = await posShop('pas', 'starter');
  const ro = await createRole(a.s, 'QA Orders only', ['orders.view']);
  viewer = await createMember(a.s, { role_id: ro.id as string });
  const cr = await createRole(a.s, 'QA Cashier', ['pos.sell']);
  cashier = await createMember(a.s, { role_id: cr.id as string });
  staff = await createMember(a.s, 'staff');
  aSession = await openSession(a.s, a.register.id, { opening_cash_amount: 100000 });
  aSale = await cashSale(a.s, aSession.id, [{ variant_id: a.wrap, quantity: 1 }]);
  bSession = await openSession(b.s, b.register.id, { opening_cash_amount: 0 });
});
test.afterAll(async () => {
  // Tenants first: the cashier's till sale references the user (pos_sales.cashier_id), so the user row can only go
  // once the tenant's data is gone.
  a?.cleanup();
  b?.cleanup();
  starter?.cleanup();
  for (const m of [viewer, cashier, staff]) await m?.cleanup().catch(() => undefined);
});

test('S196: no pos.sell → no POS in the sidebar, /pos no-access page, 403 on every route', async ({ page, context }) => {
  const v = as(viewer);
  const routes: Array<[string, Promise<{ status: number; json: Json }>]> = [
    ['GET registers', registersRaw(a.s, v)],
    ['GET session', sessionRaw(a.s, aSession.id, v)],
    ['GET catalog', catalogRaw(a.s, `register_id=${a.register.id}`, v)],
    ['GET lookup', lookupRaw(a.s, a.register.id, 'X', v)],
    ['GET customer lookup', customerLookupRaw(a.s, '01711552211', v)],
    ['POST quote', quoteRaw(a.s, { session_id: aSession.id, lines: [{ variant_id: a.wrap, quantity: 1 }] }, v)],
    ['POST sale', saleRaw(a.s, { session_id: aSession.id, lines: [{ variant_id: a.wrap, quantity: 1 }], expected_total_amount: 50000, payments: [{ method: 'cash', amount: 50000 }], tendered_cash_amount: 50000, sms_receipt: false }, v)],
    ['GET sale', saleGetRaw(a.s, aSale.id, v)],
    ['POST sms', smsReceiptRaw(a.s, aSale.id, v)],
    ['POST open', openRaw(a.s, a.register.id, { opening_cash_amount: 0 }, v)],
    ['POST close', closeRaw(a.s, aSession.id, { counted_cash_amount: 0, left_in_drawer_amount: 0, revision: aSession.revision }, v)],
    ['POST register', createRegisterRaw(a.s, { name: 'Nope', location_id: a.shop.id }, v)],
  ];
  for (const [what, p] of routes) {
    const r = await p;
    expect([what, r.status, r.json.error?.code]).toEqual([what, 403, 'forbidden']);
  }
  expect((await session(a.s, aSession.id)).status, 'nothing closed').toBe('open');

  const c = watchConsole(page);
  await signInDashboard(context, v);
  await page.goto(mUrl('/orders'));
  await page.setViewportSize({ width: 1440, height: 900 });
  const labels = await navLabels(page);
  expect(labels, 'no POS link without pos.sell').not.toContain('POS');
  await page.goto(mUrl('/pos'));
  await expect(noAccess(page)).toBeVisible({ timeout: 20_000 });
  await page.goto(mUrl(`/pos/${aSession.id}`));
  await expect(noAccess(page)).toBeVisible({ timeout: 20_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('S196: cashier-only role sells, can’t write registers; system Staff has POS', async ({ page, context }) => {
  const cs = as(cashier);
  expect((await registersRaw(a.s, cs)).status).toBe(200);
  const sale = await cashSale(cs, aSession.id, [{ variant_id: a.wrap, quantity: 1 }]);
  expect(sale.cashier_name, 'the cashier is the actor, not a body field (S202)').toBe('E2E custom');
  for (const [what, r] of [
    ['create', await createRegisterRaw(a.s, { name: 'Till 9', location_id: a.shop.id }, cs)],
    ['patch', await patchRegisterRaw(a.s, a.register.id, { name: 'Renamed' }, cs)],
    ['archive', await registerActionRaw(a.s, a.register.id, 'archive', cs)],
  ] as const)
    expect([what, r.status, r.json.error?.code]).toEqual([what, 403, 'forbidden']);

  await signInDashboard(context, as(staff));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(mUrl('/orders'));
  expect(await navLabels(page), 'Staff has pos.sell (P88D-18)').toContain('POS');
  await gotoPos(page);
  await expect(page.getByTestId('pos-register-list')).toContainText(`Register 1 · ${MIRPUR}`);
  await expect(page.getByTestId('pos-register-list')).toContainText(/Open · .+ · since/);
  await expect(page.getByRole('button', { name: 'Add register' }), 'Add register needs settings.manage').toHaveCount(0);
});

test('S197: Starter sees the plan note; writes 402, reads 200', async ({ page, context }) => {
  const s = starter.s;
  expect((await registersRaw(s)).status).toBe(200);
  const checks: Array<[string, Promise<{ status: number; json: Json }>]> = [
    ['create register', createRegisterRaw(s, { name: 'Register 2', location_id: starter.shop.id })],
    ['open', openRaw(s, starter.register.id, { opening_cash_amount: 0 })],
    ['unarchive', registerActionRaw(s, starter.register.id, 'unarchive')],
  ];
  for (const [what, p] of checks) {
    const r = await p;
    expect([what, r.status, r.json.error?.code], JSON.stringify(r.json).slice(0, 200)).toEqual([what, 402, 'feature_not_in_plan']);
  }

  const c = watchConsole(page);
  await signInDashboard(context, s);
  await gotoPos(page);
  await expect(page.getByTestId('pos-plan-note')).toContainText(PLAN_NOTE);
  await expect(page.getByTestId('pos-plan-note').getByRole('link', { name: 'See plans' })).toBeVisible();
  await expect(page.getByTestId('pos-open-submit'), 'no Open register on Starter').toHaveCount(0);
  await expect(page.getByTestId('pos-denominations')).toHaveCount(0);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('S197: downgrade with an open session → sale/quote 402, close 200; UI offers Close register', async ({ page, context }) => {
  test.setTimeout(120_000);
  const before = await session(b.s, bSession.id);
  setPlan(b.s, 'starter');
  try {
    const q = await quoteRaw(b.s, { session_id: bSession.id, lines: [{ variant_id: b.wrap, quantity: 1 }] });
    expect([q.status, q.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    const sale = await saleRaw(b.s, { session_id: bSession.id, lines: [{ variant_id: b.wrap, quantity: 1 }], expected_total_amount: 50000, payments: [{ method: 'card', amount: 50000 }], sms_receipt: false });
    expect([sale.status, sale.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    expect((await sessionRaw(b.s, bSession.id)).status, 'reads stay').toBe(200);

    await signInDashboard(context, b.s);
    await gotoPos(page);
    await expect(page.getByTestId('pos-plan-note')).toContainText(PLAN_NOTE);
    await expect(page.getByText('Registers still open')).toBeVisible();
    await page.getByRole('button', { name: 'Close register' }).click();
    await page.waitForURL(new RegExp(`/pos/${bSession.id}/close$`));
    await expect(page.getByRole('heading', { name: 'Close register' })).toBeVisible();
    await expect(page.getByTestId('pos-expected')).toHaveText('৳ 0');
    await page.getByTestId('pos-leave-in-drawer').fill('0');
    // Counted ৳ 10 against ৳ 0 expected → over by ৳ 10, within tolerance; close works after the downgrade (P88D-19).
    await page.getByLabel('Count of ৳ 10', { exact: true }).fill('1');
    await expect(page.getByTestId('pos-variance')).toContainText('Over by ৳ 10');
    await page.getByTestId('pos-close-submit').click();
    await page.getByTestId('pos-close-confirm').click();
    await page.waitForURL(/\/pos$/);
    const after = await session(b.s, bSession.id);
    expect(after).toMatchObject({ status: 'closed', counted_cash_amount: 1000, variance_amount: 1000, banked_amount: 1000 });
    expect(after.revision).toBeGreaterThan(before.revision);
    // Re-opening is a plan write again.
    const reopen = await openRaw(b.s, b.register.id, { opening_cash_amount: 0 });
    expect([reopen.status, reopen.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
  } finally {
    setPlan(b.s, 'growth');
  }
});

test('S195: another tenant’s / store’s registers, sessions and sales → 404; foreign ids in bodies → 422', async () => {
  // A's ids on A's path with B's session (tenant mismatch) and A's ids on B's path → 404.
  const viaB: Array<[string, Promise<{ status: number }>]> = [
    ['session A as B', sessionRaw(a.s, aSession.id, b.s)],
    ['session A on B path', sessionRaw(b.s, aSession.id)],
    ['sale A on B path', saleGetRaw(b.s, aSale.id)],
    ['sms A on B path', smsReceiptRaw(b.s, aSale.id)],
    ['close A on B path', closeRaw(b.s, aSession.id, { counted_cash_amount: 0, left_in_drawer_amount: 0, revision: 1 })],
    ['open A register on B path', openRaw(b.s, a.register.id, { opening_cash_amount: 0 })],
    ['patch A register on B path', patchRegisterRaw(b.s, a.register.id, { name: 'X' })],
    ['archive A register on B path', registerActionRaw(b.s, a.register.id, 'archive')],
    ['registers A as B', registersRaw(a.s, b.s)],
  ];
  for (const [what, p] of viaB) expect([what, (await p).status]).toEqual([what, 404]);

  // B's ids inside A's bodies / queries → 422 on that field (§5.4).
  const bodies: Array<[string, Promise<{ status: number; json: Json }>, string]> = [
    ['catalog register_id of B', catalogRaw(a.s, `register_id=${b.register.id}`), 'register_id'],
    ['lookup register_id of B', lookupRaw(a.s, b.register.id, 'X'), 'register_id'],
    ['quote session of B', quoteRaw(a.s, { session_id: bSession.id, lines: [{ variant_id: a.wrap, quantity: 1 }] }), 'session_id'],
    ['quote variant of B', quoteRaw(a.s, { session_id: aSession.id, lines: [{ variant_id: b.wrap, quantity: 1 }] }), 'lines.0.variant_id'],
    ['sale session of B', saleRaw(a.s, { session_id: bSession.id, lines: [{ variant_id: a.wrap, quantity: 1 }], expected_total_amount: 50000, payments: [{ method: 'card', amount: 50000 }], sms_receipt: false }), 'session_id'],
    ['register at B location', createRegisterRaw(a.s, { name: 'Foreign', location_id: b.shop.id }), 'location_id'],
  ];
  for (const [what, p, field] of bodies) {
    const r = await p;
    expect([what, r.status, r.json.error?.code], JSON.stringify(r.json).slice(0, 300)).toEqual([what, 422, 'validation_failed']);
    expect(Object.keys(r.json.error?.details ?? {}), what).toContain(field);
  }
  // Nothing was written to A or B by the refused calls.
  expect((await session(a.s, aSession.id)).totals.receipts_count).toBe(2);
});

test('registers: archive / move an open register → 409 register_in_use; held_sale_id refused in part A', async () => {
  const arch = await registerActionRaw(a.s, a.register.id, 'archive');
  expect([arch.status, arch.json.error?.code]).toEqual([409, 'register_in_use']);
  const move = await patchRegisterRaw(a.s, a.register.id, { location_id: a.main.id });
  expect([move.status, move.json.error?.code]).toEqual([409, 'register_in_use']);
  const rename = await patchRegisterRaw(a.s, a.register.id, { name: 'Front till' });
  expect(rename.status, 'renaming an open register is fine').toBe(200);
  const dup = await createRegisterRaw(a.s, { name: 'front TILL', location_id: a.shop.id });
  expect([dup.status, dup.json.error?.code]).toEqual([422, 'register_name_taken']);
  const held = await saleRaw(a.s, { session_id: aSession.id, lines: [{ variant_id: a.wrap, quantity: 1 }], expected_total_amount: 50000, payments: [{ method: 'card', amount: 50000 }], sms_receipt: false, held_sale_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, a.s, idem());
  expect([held.status, held.json.error?.code]).toEqual([422, 'validation_failed']);
});

// Regression for P88DA-QA-1 (fixed in 6659714): `counts: {}` = ৳ 0.
test('an empty drawer (৳ 0) opens and closes from the count table', async ({ page, context }) => {
  test.setTimeout(120_000);
  // Shop B is back on Growth; Register 1 is closed. Open with every count blank (= ৳ 0 float), then close at ৳ 0.
  await signInDashboard(context, b.s);
  await gotoPos(page);
  await clearCounts(page);
  await expect(page.getByTestId('pos-opening-total')).toHaveText('৳ 0');
  const opened = page.waitForResponse((r) => r.request().method() === 'POST' && /\/open$/.test(new URL(r.url()).pathname));
  await page.getByTestId('pos-open-submit').click();
  const or = await opened;
  expect(or.status(), `open ৳ 0 sends ${or.request().postData()} → ${(await or.text()).slice(0, 200)}`).toBe(201);
  await page.waitForURL(/\/pos\/[0-9A-Za-z]{26}$/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await page.getByTestId('pos-close-register').click();
  await page.getByTestId('pos-leave-in-drawer').fill('0');
  await page.getByLabel('Count of ৳ 1,000', { exact: true }).fill('0');
  await expect(page.getByTestId('pos-variance')).toContainText('Drawer matches');
  await page.getByTestId('pos-close-submit').click();
  const closing = page.waitForResponse((r) => r.request().method() === 'POST' && /\/close$/.test(new URL(r.url()).pathname));
  await page.getByTestId('pos-close-confirm').click();
  const cr = await closing;
  expect(cr.status(), `close ৳ 0 sends ${cr.request().postData()} → ${(await cr.text()).slice(0, 200)}`).toBe(200);
  await page.waitForURL(/\/pos$/);
  expect(await session(b.s, id)).toMatchObject({ status: 'closed', opening_cash_amount: 0, counted_cash_amount: 0, variance_amount: 0 });
});

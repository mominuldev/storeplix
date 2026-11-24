import { expect, test } from '@playwright/test';
import { cartAdd, randomPhone, sf } from '../support/commerce';
import { atLocal, unsubApi, unsubPost } from '../support/campaigns';
import {
  ageContactCarts,
  autoSink,
  automationShop,
  deliveredOrder,
  detectAbandoned,
  elapseWait,
  messageSteps,
  runsOf,
  startRecipe,
  waitRun,
  waitRuns,
  type AutomationShop,
} from '../support/automations';

/**
 * PHASE-8-6 §13 QA `phase8-6.rules` — AC 3: customer messages from automations respect opt-out at send time (S127),
 * the frequency cap (P86-10, S134) and quiet hours (P86-9, S134); every outcome is in the run log with its reason.
 *  - Opt-out: recovery step 1 sent → the shopper opts out through the message's `/u/{code}` → the step-2 wait ends
 *    (`resume-due`) → no second message; run `stopped/opted_out` (a step-2 row, if written, is `skipped/opted_out`).
 *  - Frequency cap: three delivered orders by one phone within minutes with Thank-you on → messages 1 and 2 `done`,
 *    the third run's step `skipped/frequency_cap`, the sink holds exactly two messages for that phone.
 *  - Quiet hours: a night shop (~02:00 store time) → the thank-you run `waiting` until 09:00 local, nothing sent; a
 *    forced resume inside quiet hours waits again (server-side check, not the scheduler's).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe('day shop', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: AutomationShop;
  let recovery: Json;
  let thanks: Json;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await automationShop('aru', 'starter', 13);
    recovery = await startRecipe(shop.s, 'checkout_recovery', { delay_minutes: 15 });
    thanks = await startRecipe(shop.s, 'thank_you', { delay_hours: 0 });
  });
  test.afterAll(() => shop?.cleanup());

  test('opt-out after step 1 → no step-2 message, run stopped/opted_out (S127, P86-14)', async () => {
    test.setTimeout(180_000);
    const phone = randomPhone();
    const { r, cart } = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const put = await sf(shop.apiHost, 'PUT', '/cart/contact', { json: { phone, name: 'Opt Out' }, cart });
    expect(put.status, put.text).toBe(204);
    ageContactCarts(shop.s.storeId, 20);
    detectAbandoned();

    const first = await waitRun(shop.s, recovery.id, (x) => x.status === 'waiting' && messageSteps(x).some((m) => m.status === 'done'), 90_000);
    await expect.poll(async () => (await autoSink(shop.s, recovery.id, phone)).length, { timeout: 20_000 }).toBe(1);
    const msg = (await autoSink(shop.s, recovery.id, phone))[0];
    expect(msg.code, `unsubscribe link in: ${msg.text}`).toMatch(/^[A-Za-z0-9]{10}$/);

    // The automation code resolves through the 8.5 unsubscribe API (§8): campaign recipients → automation steps → tests.
    const before = await unsubApi(shop.apiHost, msg.code!);
    expect(before.status, before.text).toBe(200);
    expect(before.json.data).toMatchObject({ channel: 'sms', status: 'subscribed', is_test: false });
    const out = await unsubPost(shop.apiHost, msg.code!, 'unsubscribe');
    expect(out.status, out.text).toBe(200);

    elapseWait(first.id);
    const done = await waitRun(shop.s, recovery.id, (x) => x.id === first.id && x.status === 'stopped', 60_000);
    expect(done.outcome_reason).toBe('opted_out');
    const later = messageSteps(done).filter((m) => m.index !== messageSteps(first)[0].index);
    for (const m of later) expect([m.status, m.reason]).toEqual(['skipped', 'opted_out']);
    await new Promise((res) => setTimeout(res, 2_000));
    expect(await autoSink(shop.s, recovery.id, phone), 'nothing after the opt-out').toHaveLength(1);
  });

  test('frequency cap: ≤ 2 automation messages per phone per 24 h; the third is skipped/frequency_cap (P86-10)', async () => {
    test.setTimeout(240_000);
    const phone = randomPhone();
    const orders: { id: string; number: string }[] = [];
    for (let i = 0; i < 3; i++) orders.push(await deliveredOrder(shop, phone, 'Frequent Buyer'));
    const ofOrders = (x: Json) => orders.some((o) => x.subject?.id === o.id || x.subject?.label === o.number);
    const mine = await waitRuns(shop.s, thanks.id, (x) => ofOrders(x) && !['running', 'waiting'].includes(x.status), 3, 120_000);
    expect(mine).toHaveLength(3);
    const outcomes = mine.map((x) => messageSteps(x)[0]).map((m) => `${m?.status}/${m?.reason ?? ''}`).sort();
    expect(outcomes).toEqual(['done/', 'done/', 'skipped/frequency_cap']);
    await expect.poll(async () => (await autoSink(shop.s, thanks.id, phone)).length, { timeout: 20_000 }).toBe(2);
  });
});

test.describe('night shop (quiet hours)', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: AutomationShop;
  let thanks: Json;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await automationShop('arn', 'starter', 2);
    thanks = await startRecipe(shop.s, 'thank_you', { delay_hours: 0 });
  });
  test.afterAll(() => shop?.cleanup());

  test('a message step at ~02:00 local waits until 09:00 store time; nothing is sent (P86-9, S134)', async () => {
    test.setTimeout(180_000);
    const phone = randomPhone();
    const order = await deliveredOrder(shop, phone, 'Night Owl');
    const run = await waitRun(shop.s, thanks.id, (x) => x.subject?.id === order.id || x.subject?.label === order.number, 90_000);
    expect(run.status, JSON.stringify(run)).toBe('waiting');
    const nine = atLocal(shop.offset, '09:00', Date.parse(atLocal(shop.offset, '09:00')) < Date.now() ? 1 : 0);
    expect(Math.abs(Date.parse(run.resume_at) - Date.parse(nine)), `resume_at ${run.resume_at} ≈ ${nine}`).toBeLessThanOrEqual(60_000);
    expect(messageSteps(run).filter((m) => m.status === 'done')).toHaveLength(0);
    expect(await autoSink(shop.s, thanks.id, phone)).toHaveLength(0);

    // Forced resume while still inside quiet hours: the server re-checks and waits again.
    elapseWait(run.id);
    await new Promise((res) => setTimeout(res, 4_000));
    const again = (await runsOf(shop.s, thanks.id)).find((x) => x.id === run.id)!;
    expect(again.status).toBe('waiting');
    expect(Date.parse(again.resume_at)).toBeGreaterThan(Date.now());
    expect(await autoSink(shop.s, thanks.id, phone), 'still nothing sent').toHaveLength(0);
  });
});

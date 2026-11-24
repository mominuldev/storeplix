import { expect, test } from '@playwright/test';
import { api, mailMark, signInDashboard } from '../support/api';
import { inventoryOf, randomPhone } from '../support/commerce';
import { digits } from '../support/campaigns';
import {
  RECIPES,
  RUN_LOG,
  adjustStock,
  autoSink,
  automationShop,
  customerOf,
  deliveredOrder,
  getAutomation,
  listAutomations,
  loggedMail,
  messageSteps,
  mUrl,
  openAutomations,
  patchSettings,
  receivedReturn,
  runs,
  startRecipe,
  stepAt,
  storedOutcomeDetail,
  waitRun,
  type AutomationShop,
} from '../support/automations';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-6 §13 QA `phase8-6.recipes` — AC 1 "Trigger → action runs logged" for the four non-recovery recipes (AC 2),
 * all on one Starter shop (store tz → ~13:00 local), fake drivers, workers on `automations` + `notifications`:
 *  - Thank-you (`order.delivered`): delivered order → run `completed`, one `send_message` step `done` (sms, parts),
 *    message in the sink to the buyer's phone with the opt-out footer; a condition that fails
 *    (`order.total_amount gt` huge) → run `skipped/conditions_not_met` with per-condition detail, no step, no message.
 *  - Tag VIP buyers (`min_delivered` 2, message off): 1st delivery → `skipped/conditions_not_met`; 2nd → `add_tag`
 *    `done` and the customer has the tag.
 *  - Handle returns (`return.received`): received return → `add_tag` `done` ("Returned" on the customer).
 *  - Low stock alert (`stock.low`): stock crosses the threshold → `notify_team` `done` (`detail.recipients` ≥ 1), the
 *    owner gets the email (MAIL_MAILER=log), no customer PII in it (S138).
 *  - Dry run (P86-21, S137): returns condition/step results and creates no run, no message.
 *  - UI: Automations page lists the 5 recipes' automations with runs, hidden recipes absent; Recent runs and the run
 *    log show the runs with their outcomes.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: AutomationShop;
const auto: Record<string, Json> = {};
const buyer = randomPhone();
let delivered: { id: string; number: string; phone: string };

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await automationShop('arp', 'starter', 13);
  auto.thank_you = await startRecipe(shop.s, 'thank_you', { delay_hours: 0 });
  auto.vip_tag = await startRecipe(shop.s, 'vip_tag', { min_delivered: 2, tag: 'VIP', message: { enabled: false } });
  auto.return_flag = await startRecipe(shop.s, 'return_flag', { tag: 'Returned' });
  auto.low_stock = await startRecipe(shop.s, 'low_stock');
});
test.afterAll(() => shop?.cleanup());

test('catalogue: 5 recipes, one automation each, duplicates 409, hidden recipes absent (P86-1, P86-2)', async () => {
  const { data, meta } = await listAutomations(shop.s);
  expect((meta.recipes as Json[]).map((r) => r.recipe).sort()).toEqual([...RECIPES].sort());
  expect(data.filter((a) => a.status === 'on')).toHaveLength(4);
  const dup = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/automations`, { recipe: 'thank_you' });
  expect([dup.status, dup.json.error?.code]).toEqual([409, 'automation_exists']);
  for (const hidden of ['order_received_sms', 'hold_risky_cod', 'auto_book_courier', 'ask_for_review']) {
    const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/automations`, { recipe: hidden });
    expect(r.status, hidden).toBe(422);
  }
});

test('Thank-you: delivered → run completed, send_message done, SMS in the sink (AC 1)', async () => {
  test.setTimeout(150_000);
  delivered = await deliveredOrder(shop, buyer, 'Thankful Buyer');
  const run = await waitRun(shop.s, auto.thank_you.id, (x) => (x.subject?.id === delivered.id || x.subject?.label === delivered.number) && x.status === 'completed', 90_000);
  expect(run.trigger).toBe('order.delivered');
  expect(run.subject.type).toBe('order');
  const [step] = messageSteps(run);
  expect([step.status, step.channel, step.reason ?? null]).toEqual(['done', 'sms', null]);
  expect(step.parts).toBeGreaterThanOrEqual(1);
  expect(String(step.masked_address)).not.toContain(digits(buyer));
  await expect.poll(async () => (await autoSink(shop.s, auto.thank_you.id, buyer)).length, { timeout: 20_000 }).toBe(1);
  const msg = (await autoSink(shop.s, auto.thank_you.id, buyer))[0];
  expect(msg.text.startsWith(`${shop.name}: `)).toBe(true);
  expect(msg.text).toMatch(/\/u\/[A-Za-z0-9]{10}/);
  expect(msg.text).not.toMatch(/\{(name|order_no|shop_link)\}/);
});

test('Tag VIP buyers: 1st delivery skipped/conditions_not_met, 2nd tags the customer (AC 1, §5)', async () => {
  test.setTimeout(150_000);
  const first = await waitRun(shop.s, auto.vip_tag.id, (x) => x.subject?.id === delivered.id || x.subject?.label === delivered.number || x.status === 'skipped', 60_000);
  expect([first.status, first.outcome_reason]).toEqual(['skipped', 'conditions_not_met']);
  // Per-condition results are stored (§4.3) but not part of the §9.2 response (finding P86-QA-2).
  expect(JSON.stringify(storedOutcomeDetail(first.id)), 'per-condition results stored').toMatch(/deliver/i);
  expect(first.steps ?? []).toHaveLength(0);

  await deliveredOrder(shop, buyer, 'Thankful Buyer');
  const tagged = await waitRun(shop.s, auto.vip_tag.id, (x) => x.status === 'completed', 90_000);
  expect(stepAt(tagged, (tagged.steps as Json[])[0].index)).toMatchObject({ action: 'add_tag', status: 'done' });
  const c = await customerOf(shop.s, buyer);
  expect(((c?.tags ?? []) as string[]).map((t) => t.toLowerCase())).toContain('vip'); // customer tags are stored lower-case (P4)
});

test('Handle returns: received return → add_tag done, customer tagged "Returned" (AC 1)', async () => {
  test.setTimeout(150_000);
  await receivedReturn(shop.s, delivered.id);
  const run = await waitRun(shop.s, auto.return_flag.id, (x) => !['running', 'waiting'].includes(x.status), 90_000);
  expect([run.trigger, run.status, run.subject?.type]).toEqual(['return.received', 'completed', 'return']);
  expect((run.steps as Json[])[0]).toMatchObject({ action: 'add_tag', status: 'done' });
  expect((((await customerOf(shop.s, buyer))?.tags ?? []) as string[]).map((t) => t.toLowerCase())).toContain('returned');
});

test('Low stock alert: stock crosses the threshold → notify_team done, owner emailed without customer PII (AC 1, S138)', async () => {
  test.setTimeout(150_000);
  const inv = await inventoryOf(shop.s, shop.simple.id, shop.simple.variantId);
  const mark = mailMark();
  // threshold 5 (setupShop): raise well above it, then drop to it → one crossing.
  const up = Math.max(0, 8 - Number(inv.on_hand));
  if (up) await adjustStock(shop.s, shop.simple.variantId, up);
  await adjustStock(shop.s, shop.simple.variantId, -(Number(inv.on_hand) + up - 4));
  const run = await waitRun(shop.s, auto.low_stock.id, (x) => !['running', 'waiting'].includes(x.status), 90_000);
  expect([run.trigger, run.status, run.subject?.type]).toEqual(['stock.low', 'completed', 'inventory']);
  const step = (run.steps as Json[])[0];
  expect([step.action, step.status]).toEqual(['notify_team', 'done']);
  expect(Number(step.detail?.recipients)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => loggedMail(shop.t.email, mark, /Low stock/i) !== null, { timeout: 45_000, message: 'low-stock mail to the owner (notifications worker?)' }).toBe(true);
  expect(loggedMail(shop.t.email, mark, /Low stock/i)!, 'no shopper phone in the team mail').not.toContain(digits(buyer));
});

test('conditions not met: Thank-you with order.total_amount > ৳ 1 00 000 → skipped/conditions_not_met, no message (§5)', async () => {
  test.setTimeout(150_000);
  await patchSettings(shop.s, auto.thank_you.id, { conditions: [{ field: 'order.total_amount', op: 'gt', value: 10_000_000 }] });
  const phone = randomPhone();
  const order = await deliveredOrder(shop, phone, 'Small Order');
  const run = await waitRun(shop.s, auto.thank_you.id, (x) => x.subject?.id === order.id || x.subject?.label === order.number, 90_000);
  expect([run.status, run.outcome_reason]).toEqual(['skipped', 'conditions_not_met']);
  expect(JSON.stringify(storedOutcomeDetail(run.id))).toMatch(/total/i);
  await new Promise((r) => setTimeout(r, 2_000));
  expect(await autoSink(shop.s, auto.thank_you.id, phone)).toHaveLength(0);
});

test('dry run: results for the latest order, zero runs and zero messages (P86-21, S137)', async () => {
  const before = (await runs(shop.s)).length;
  const sinkBefore = (await autoSink(shop.s, auto.thank_you.id)).length;
  const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/automations/${auto.thank_you.id}/dry-run`, { order_id: delivered.id });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(Array.isArray(r.json.data.conditions)).toBe(true);
  expect(r.json.data.conditions[0]).toMatchObject({ passed: false });
  expect((r.json.data.steps as Json[]).length).toBeGreaterThanOrEqual(1);
  expect((await runs(shop.s)).length).toBe(before);
  expect((await autoSink(shop.s, auto.thank_you.id)).length).toBe(sinkBefore);
  expect((await getAutomation(shop.s, auto.thank_you.id)).stats_7d).toBeTruthy();
});

test('UI: Automations page (table, Recent runs) and the run log show the logged runs (AC 1, §10.1, §10.4)', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openAutomations(page);
  for (const name of ['Thank-you message', 'Tag VIP buyers', 'Handle returns', 'Low stock alert']) {
    await expect(page.getByRole('row').filter({ hasText: name }).first(), name).toBeVisible({ timeout: 20_000 });
  }
  for (const hidden of [/Order received SMS/, /Hold risky COD/, /Auto-book courier/, /Ask for a review/, /WhatsApp/, /Time saved/, /Risky orders held/]) {
    await expect(page.getByText(hidden), `hidden: ${hidden}`).toHaveCount(0);
  }
  await expect(page.getByText(/Recent runs/).first()).toBeVisible();
  await expect(page.getByText(/Tagged VIP/i).first()).toBeVisible();

  await page.goto(mUrl(RUN_LOG));
  await expect(page.getByText(/· Thank-you message/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Skipped · Conditions not met/i).first()).toBeVisible();
  const chip = (name: RegExp) => page.getByRole('button', { name }).or(page.getByRole('tab', { name })).or(page.getByRole('radio', { name })).first();
  await chip(/^Skipped/).click();
  await expect(page.getByText(/· Low stock alert/)).toHaveCount(0);
  await expect(page.getByText(/· Tag VIP buyers/).first()).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

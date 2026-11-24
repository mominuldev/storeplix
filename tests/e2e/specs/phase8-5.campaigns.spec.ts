import { expect, test } from '@playwright/test';
import { api, signInDashboard, unique } from '../support/api';
import { randomPhone } from '../support/commerce';
import {
  ALL,
  CAMPAIGNS,
  addCustomer,
  audiencePreview,
  campaignShop,
  createCampaign,
  customerByPhone,
  dialog,
  digits,
  fillComposer,
  getCampaign,
  getCustomer,
  mUrl,
  openComposer,
  optOut,
  orderAs,
  primaryAction,
  recipients,
  removeOptOut,
  sendNow,
  sinkFor,
  unsubApi,
  unsubPage,
  waitCampaign,
  willGet,
  type CampaignShop,
  type SinkMessage,
} from '../support/campaigns';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-5 §11 QA `phase8-5.campaigns` — the roadmap AC **"Opt-out respected"** (§14.1, S113–S115, S118) end to end,
 * SMS through `SMS_DRIVER=log` + the campaign dev sink (`CAMPAIGNS_DEV_SINK=true`):
 *  1. Starter shop (store tz chosen so it is mid-day locally, P85-15) with customers:
 *     A, B `accepts_marketing` + phone; C a storefront order only (P85-3 "existing customer"); D no consent and no order
 *     (not eligible); E consent but merchant toggle "Stop marketing messages" (suppression `merchant`); F email only.
 *  2. Audience preview (All) → 3 recipients (A, B, C); opted-out / not-eligible / no-address counted apart.
 *  3. Composer UI: SMS, English, All, "Send now" → confirm → campaign `sent`; the sink holds exactly one SMS per
 *     A/B/C, each `"{shop}: "`-prefixed with the `STOP: {host}/u/{code}` footer, a distinct code per recipient.
 *  4. A opens `/u/{code}` on the storefront host: GET changes nothing (S116); Unsubscribe → "You're unsubscribed".
 *  5. The suppression is the address's, not the row's (S114, S118): A deleted + re-created with the same phone and
 *     consent → still unsubscribed; merchant DELETE → 409 `suppression_customer_owned`; PATCH consent → still out.
 *     E's merchant suppression is removed by the merchant (allowed).
 *  6. Campaign 2 (API) → B, C, E messaged; A never (sink has nothing for A's number); the recipients list / detail
 *     shows A as `skipped/opted_out` when the snapshot keeps opted-out rows.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: CampaignShop;
const phones = { A: randomPhone(), B: randomPhone(), C: randomPhone(), D: randomPhone(), E: randomPhone() };
const ids: Record<string, string> = {};
const marker1 = unique('m1x').replace(/[^a-z0-9]/gi, '');
const marker2 = unique('m2x').replace(/[^a-z0-9]/gi, '');
let campaign1 = '';
let sent1: SinkMessage[] = [];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await campaignShop('cmp', 'starter', 13);
  const s = shop.s;
  ids.A = (await addCustomer(s, { name: 'Ayesha Akter', phone: phones.A, accepts_marketing: true })).id;
  ids.B = (await addCustomer(s, { name: 'Babul Mia', phone: phones.B, accepts_marketing: true })).id;
  await orderAs(shop, 'Chumki Rahman', phones.C);
  const c = await customerByPhone(s, phones.C);
  expect(c, 'order customer C exists').toBeTruthy();
  ids.C = c!.id;
  ids.D = (await addCustomer(s, { name: 'Dipu No-consent', phone: phones.D, accepts_marketing: false })).id;
  ids.E = (await addCustomer(s, { name: 'Esha Merchant-stopped', phone: phones.E, accepts_marketing: true })).id;
  ids.F = (await addCustomer(s, { name: 'Faruk Email-only', email: `${unique('f-')}@example.com`, accepts_marketing: true })).id;
  const stop = await optOut(s, ids.E, 'sms');
  expect([200, 201], JSON.stringify(stop.json)).toContain(stop.status);
});
test.afterAll(() => shop?.cleanup());

test('customer marketing block + audience preview follow P85-3 eligibility (§3.3, §4.1)', async () => {
  const s = shop.s;
  const m = async (id: string) => ((await getCustomer(s, id)).marketing ?? {}) as Json;
  expect((await m(ids.A)).sms).toBe('subscribed');
  expect((await m(ids.C)).sms, 'order customer = existing-customer soft opt-in').toBe('subscribed');
  expect((await m(ids.D)).sms).toBe('not_eligible');
  const e = await m(ids.E);
  expect([e.sms, e.unsubscribed_source?.sms]).toEqual(['unsubscribed', 'merchant']);
  expect((await m(ids.F)).sms).toBe('no_address');

  const p = await audiencePreview(s, 'sms', ALL);
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const d = p.json.data as Json;
  expect(d.recipients, JSON.stringify(d)).toBe(3);
  expect(d.excluded.opted_out).toBeGreaterThanOrEqual(1);
  expect(d.excluded.not_eligible).toBeGreaterThanOrEqual(1);
  expect(d.excluded.no_address).toBeGreaterThanOrEqual(1);
});

test('composer UI: SMS to All, Send now → one message per eligible customer with prefix + opt-out footer', async ({ page, context }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openComposer(page);
  await fillComposer(page, { name: `Eid sale ${marker1}`, channel: 'sms', body: `Hi {name}, Eid offer ${marker1} at {shop_link}`, skipRecent: false });
  await expect(willGet(page)).toContainText(/\b3 customers? will get this message/i, { timeout: 15_000 });
  await primaryAction(page).click();
  const dlg = dialog(page);
  // A 5xx keeps the dialog open for a retry with the same Idempotency-Key (§6.1); local sqlite can answer
  // "database is locked", so retry the confirm up to 3 times.
  for (let i = 0; i < 3; i++) {
    await dlg.getByRole('button', { name: /^Send/ }).click();
    if (await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true, () => false)) break;
  }
  // The detail page (P85-QA-3, fixed: no longer stranded on `/:id/edit`).
  await expect(page).toHaveURL(new RegExp(`${CAMPAIGNS}/[0-9A-Za-z]{26}$`), { timeout: 15_000 });
  campaign1 = page.url().match(/campaigns\/([0-9A-Za-z]{26})/)![1];

  const done = await waitCampaign(shop.s, campaign1, ['sent']);
  expect([done.stats.recipients, done.stats.sent, done.stats.failed]).toEqual([3, 3, 0]);

  await expect.poll(async () => (await sinkFor(shop.s, campaign1, marker1)).length, { timeout: 20_000 }).toBe(3);
  sent1 = await sinkFor(shop.s, campaign1, marker1);
  expect(sent1.map((x) => digits(x.to)).sort()).toEqual([phones.A, phones.B, phones.C].map(digits).sort());
  for (const msg of sent1) {
    expect(msg.channel).toBe('sms');
    expect(msg.text.startsWith(`${shop.name}: `), `prefix (P85-18): ${msg.text}`).toBe(true);
    expect(msg.text, 'merge field {name} rendered').not.toContain('{name}');
    expect(msg.text, 'en footer (P85-6) is the last line').toMatch(/\nSTOP: \S+\/u\/[A-Za-z0-9]{10}$/);
    expect(msg.code, 'unsubscribe code').toMatch(/^[A-Za-z0-9]{10}$/);
  }
  expect(new Set(sent1.map((x) => x.code)).size, 'one code per recipient').toBe(3);
  const toA = sent1.find((x) => digits(x.to) === digits(phones.A))!;
  expect(toA.text).toContain('Hi Ayesha,');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('A unsubscribes on the storefront /u/{code}: GET is read-only, the button opts out (S116)', async ({ page }) => {
  test.setTimeout(90_000);
  const code = sent1.find((x) => digits(x.to) === digits(phones.A))!.code!;
  const before = await unsubApi(shop.apiHost, code);
  expect(before.status, before.text).toBe(200);
  expect(before.json.data).toMatchObject({ channel: 'sms', status: 'subscribed', is_test: false });
  expect(String(before.json.data.masked_address)).not.toContain(digits(phones.A));

  const res = await page.goto(unsubPage(shop, code));
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control'] ?? '').toMatch(/no-store/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.getByText(/You get SMS from/)).toBeVisible();
  // Rendering the page never unsubscribes (link scanners, SMS previewers).
  expect((await unsubApi(shop.apiHost, code)).json.data.status).toBe('subscribed');

  await page.getByRole('button', { name: /^Unsubscribe$/ }).click();
  await expect.poll(async () => (await unsubApi(shop.apiHost, code)).json.data?.status, { timeout: 15_000 }).toBe('unsubscribed');
  // The in-place confirmation after the server action is checked in the last test (QA P85-QA-2); a fresh load shows it.
  await page.goto(unsubPage(shop, code));
  await expect(page.getByText(/You.re unsubscribed/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Subscribe again/ })).toBeVisible();

  const a = (await getCustomer(shop.s, ids.A)).marketing as Json;
  expect([a.sms, a.unsubscribed_source?.sms]).toEqual(['unsubscribed', 'link']);
  expect((await getCampaign(shop.s, campaign1)).stats.unsubscribed).toBe(1);
});

test('the opt-out belongs to the address: delete + re-create, merchant DELETE 409, PATCH consent (S114, S118)', async () => {
  const s = shop.s;
  const del = await api(s, 'DELETE', `/stores/${s.storeId}/customers/${ids.A}`);
  expect([200, 204], JSON.stringify(del.json)).toContain(del.status);
  const again = await addCustomer(s, { name: 'Ayesha Again', phone: phones.A, accepts_marketing: true });
  ids.A = again.id;
  expect((await getCustomer(s, ids.A)).marketing.sms).toBe('unsubscribed');

  const rm = await removeOptOut(s, ids.A, 'sms');
  expect([rm.status, rm.json.error?.code]).toEqual([409, 'suppression_customer_owned']);
  const cur = await getCustomer(s, ids.A);
  const patch = await api(s, 'PATCH', `/stores/${s.storeId}/customers/${ids.A}`, { accepts_marketing: true, revision: cur.revision });
  expect(patch.status, JSON.stringify(patch.json)).toBe(200);
  expect((await getCustomer(s, ids.A)).marketing.sms).toBe('unsubscribed');

  // A merchant-added suppression is the merchant's to remove (P85-5).
  const allow = await removeOptOut(s, ids.E, 'sms');
  expect([200, 204], JSON.stringify(allow.json)).toContain(allow.status);
  expect((await getCustomer(s, ids.E)).marketing.sms).toBe('subscribed');
});

test('campaign 2 skips the opted-out address; everyone else is messaged once (AC "Opt-out respected")', async ({ page, context }) => {
  test.setTimeout(150_000);
  const s = shop.s;
  const p = await audiencePreview(s, 'sms', ALL);
  expect(p.json.data.recipients, JSON.stringify(p.json)).toBe(3); // B, C, E
  expect(p.json.data.excluded.opted_out).toBeGreaterThanOrEqual(1); // A

  const c2 = await createCampaign(s, { name: `Second ${marker2}`, body: `Hello {name}, ${marker2}` });
  const r = await sendNow(s, c2.id);
  expect(r.status, r.text).toBe(202);
  const done = await waitCampaign(s, c2.id, ['sent']);
  expect(done.stats.sent).toBe(3);

  await expect.poll(async () => (await sinkFor(s, c2.id, marker2)).length, { timeout: 20_000 }).toBe(3);
  const sent2 = await sinkFor(s, c2.id, marker2);
  expect(sent2.map((x) => digits(x.to)).sort()).toEqual([phones.B, phones.C, phones.E].map(digits).sort());
  expect(sent2.map((x) => digits(x.to)), 'A never messaged again').not.toContain(digits(phones.A));

  const rows = await recipients(s, c2.id);
  expect(rows.filter((x) => x.status === 'sent')).toHaveLength(3);
  const rowA = rows.find((x) => x.customer?.id === ids.A);
  if (rowA) expect([rowA.status, rowA.skip_reason]).toEqual(['skipped', 'opted_out']);
  test.info().annotations.push({ type: 'snapshot', description: rowA ? 'opted-out customer kept as skipped/opted_out row' : 'opted-out customer excluded from the snapshot (no row)' });
  for (const x of rows) expect(String(x.masked_address)).not.toMatch(/\d{6,}/); // masked (P85-23)

  // Detail page (§8.4): recipients table shows the opt-out reason when the row exists.
  await signInDashboard(context, s);
  await page.goto(mUrl(`${CAMPAIGNS}/${c2.id}`));
  await expect(page.getByRole('heading', { name: new RegExp(`Second ${marker2}`) })).toBeVisible({ timeout: 15_000 });
  if (rowA) await expect(page.getByRole('row').filter({ hasText: /Ayesha/ })).toContainText(/Opted.out/i);
});

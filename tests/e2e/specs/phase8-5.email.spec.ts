import { expect, test } from '@playwright/test';
import { unique } from '../support/api';
import {
  addCustomer,
  audiencePreview,
  campaignShop,
  createCampaign,
  getCampaign,
  getCustomer,
  oneClick,
  sendNow,
  sink,
  sinkFor,
  testSend,
  unsubApi,
  unsubPage,
  unsubPost,
  waitCampaign,
  type CampaignShop,
  type SinkMessage,
} from '../support/campaigns';
import { randomIp, sf } from '../support/commerce';

/**
 * PHASE-8-5 §11 QA `phase8-5.email` (P85-6, P85-19, P85-26, §4.2, §8.6, S115–S117):
 *  - Email campaign to All (2 consenting customers with an email) → `sent`; each sink copy has the subject, the escaped
 *    body, an unsubscribe link on the shop host, one code per recipient.
 *  - RFC 8058 one-click POST to the storefront `/u/{code}/one-click` → 200, address unsubscribed (email only: the SMS
 *    channel of the same customer is untouched and still messaged, P85-4 per channel); repeat POST idempotent;
 *    "Subscribe again" restores it (customer-owned).
 *  - Unknown and malformed codes → identical 404 `unsubscribe_link_invalid`; the page says "This link isn't valid".
 *  - A code from shop 1 presented on shop 2's host → 404 (S117).
 *  - "Send test to me": email to the owner, page for its code says "This was a test message. Nothing changed."
 *  - Merchant HTML in the body is escaped in the email (S123).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: CampaignShop;
let other: CampaignShop;
const emails = { G: `${unique('g-')}@example.com`, H: `${unique('h-')}@example.com` };
const ids: Record<string, string> = {};
const marker = unique('em').replace(/[^a-z0-9]/gi, '');
let campaignId = '';
let sent: SinkMessage[] = [];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await campaignShop('cme', 'starter', 13);
  other = await campaignShop('cmo', 'starter', 13);
  ids.G = (await addCustomer(shop.s, { name: 'Gulshan Ara', email: emails.G, phone: '01711000001', accepts_marketing: true })).id;
  ids.H = (await addCustomer(shop.s, { name: 'Habib Khan', email: emails.H, accepts_marketing: true })).id;
});
test.afterAll(() => {
  shop?.cleanup();
  other?.cleanup();
});

test('email campaign: send now → one email per customer, escaped body, unsubscribe link on the shop host', async () => {
  test.setTimeout(120_000);
  const s = shop.s;
  const p = await audiencePreview(s, 'email');
  expect(p.json.data?.recipients, JSON.stringify(p.json)).toBe(2);
  const c = await createCampaign(s, {
    channel: 'email',
    name: `Email ${marker}`,
    subject: `New arrivals ${marker}`,
    body: `Hi {name},\n\nFresh kurtas ${marker} <script>alert(1)</script> <b>bold</b>\n\nShop: {shop_link}`,
  });
  campaignId = c.id;
  const r = await sendNow(s, c.id);
  expect(r.status, r.text).toBe(202);
  const done = await waitCampaign(s, c.id, ['sent']);
  expect([done.stats.recipients, done.stats.sent]).toEqual([2, 2]);

  await expect.poll(async () => (await sinkFor(s, c.id, marker)).length, { timeout: 20_000 }).toBe(2);
  sent = await sinkFor(s, c.id, marker);
  expect(sent.map((m) => m.to.toLowerCase()).sort()).toEqual([emails.G, emails.H].sort());
  for (const m of sent) {
    expect(m.channel).toBe('email');
    expect(m.subject).toBe(`New arrivals ${marker}`);
    expect(m.code, `unsubscribe link in ${JSON.stringify(m.raw).slice(0, 300)}`).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(m.unsubscribeUrl).toMatch(/^https:\/\/[^/]+\/u\/[A-Za-z0-9]{10}$/);
    const html = String(m.raw.html ?? '');
    if (html) {
      expect(html, 'merchant <script> escaped (S123)').not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<b>bold</b>');
    }
  }
  expect(new Set(sent.map((m) => m.code)).size).toBe(2);
});

test('one-click POST unsubscribes the email channel only; idempotent; Subscribe again restores (RFC 8058, P85-5)', async ({ page }) => {
  test.setTimeout(90_000);
  const code = sent.find((m) => m.to.toLowerCase() === emails.G)!.code!;
  const first = await oneClick(shop, code);
  expect(first.status, first.text).toBe(200);
  expect((await unsubApi(shop.apiHost, code)).json.data).toMatchObject({ channel: 'email', status: 'unsubscribed' });
  expect((await oneClick(shop, code)).status, 'idempotent').toBe(200);

  const g = (await getCustomer(shop.s, ids.G)).marketing as Json;
  // P85-4 as amended (PO, per channel only): only the email suppression is written; accepts_marketing is untouched, so
  // the SMS channel stays deliverable.
  expect([g.email, g.sms, g.unsubscribed_source?.email, g.unsubscribed_source?.sms]).toEqual(['unsubscribed', 'subscribed', 'link', null]);
  expect((await getCustomer(shop.s, ids.G)).accepts_marketing).toBe(true);
  const smsMarker = unique('sx').replace(/[^a-z0-9]/gi, '');
  const sms = await createCampaign(shop.s, { channel: 'sms', name: `SMS ${smsMarker}`, body: `Hi {name} ${smsMarker}` });
  expect((await sendNow(shop.s, sms.id)).status).toBe(202);
  await waitCampaign(shop.s, sms.id, ['sent']);
  await expect.poll(async () => (await sinkFor(shop.s, sms.id, smsMarker)).map((m) => m.to.replace(/\D/g, '').slice(-10)), { timeout: 20_000 })
    .toContain('1711000001'); // G still gets SMS after the email opt-out
  await expect.poll(async () => (await getCampaign(shop.s, campaignId)).stats.unsubscribed).toBe(1);

  // The page now shows the unsubscribed state with "Subscribe again" (customer-owned suppression).
  await page.goto(unsubPage(shop, code));
  await expect(page.getByText(/You.re unsubscribed/)).toBeVisible();
  await page.getByRole('button', { name: /Subscribe again/ }).click();
  await expect.poll(async () => (await unsubApi(shop.apiHost, code)).json.data?.status, { timeout: 15_000 }).toBe('subscribed');
  await page.goto(unsubPage(shop, code)); // in-place re-render is P85-QA-2 (phase8-5.campaigns)
  await expect(page.getByRole('button', { name: /^Unsubscribe$/ })).toBeVisible({ timeout: 15_000 });
  // "Subscribe again" lifts the email suppression; with consent untouched the channel is deliverable again.
  expect((await getCustomer(shop.s, ids.G)).marketing.email).toBe('subscribed');

  // API idempotency (S116): unsubscribe twice → 200 both, same body.
  const a = await unsubPost(shop.apiHost, code, 'unsubscribe');
  const b = await unsubPost(shop.apiHost, code, 'unsubscribe');
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(b.json).toEqual(a.json);
});

test('invalid, malformed and cross-store codes → identical 404; page says the link is not valid (S116, S117)', async ({ page }) => {
  const code = sent.find((m) => m.to.toLowerCase() === emails.H)!.code!;
  const unknown = await unsubApi(shop.apiHost, 'Zz9Zz9Zz9Z');
  const malformed = await unsubApi(shop.apiHost, 'bad!');
  const foreign = await unsubApi(other.apiHost, code);
  for (const r of [unknown, malformed, foreign]) expect([r.status, r.json.error?.code], r.text).toEqual([404, 'unsubscribe_link_invalid']);
  expect(malformed.json).toEqual(unknown.json);
  expect(foreign.json).toEqual(unknown.json);
  // Foreign POST changes nothing either.
  expect((await unsubPost(other.apiHost, code, 'unsubscribe')).status).toBe(404);
  expect((await unsubApi(shop.apiHost, code)).json.data.status).toBe('subscribed');

  await page.goto(unsubPage(shop, 'Zz9Zz9Zz9Z'));
  await expect(page.getByText(/This link isn.t valid/)).toBeVisible();
  await page.goto(unsubPage(other, code));
  await expect(page.getByText(/This link isn.t valid/)).toBeVisible();
});

test('Send test to me: owner gets the test email; its unsubscribe page changes nothing (P85-26)', async ({ page }) => {
  const s = shop.s;
  const tmarker = unique('tt').replace(/[^a-z0-9]/gi, '');
  const c = await createCampaign(s, { channel: 'email', name: `Test ${tmarker}`, subject: `Test ${tmarker}`, body: `Preview ${tmarker} for {name}` });
  const r = await testSend(s, c.id);
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect(String(r.json.data.to_masked)).not.toBe(shop.t.email);
  await expect.poll(async () => (await sink(s)).filter((m) => m.text.includes(tmarker) || (m.subject ?? '').includes(tmarker)).length, { timeout: 20_000 }).toBe(1);
  const msg = (await sink(s)).find((m) => m.text.includes(tmarker) || (m.subject ?? '').includes(tmarker))!;
  expect(msg.to.toLowerCase()).toBe(shop.t.email.toLowerCase());
  expect(msg.isTest).toBe(true);
  expect(msg.code).toMatch(/^[A-Za-z0-9]{10}$/);
  const st = await unsubApi(shop.apiHost, msg.code!);
  expect(st.json.data?.is_test, st.text).toBe(true);
  const post = await unsubPost(shop.apiHost, msg.code!, 'unsubscribe');
  expect([post.status, post.json.data?.is_test]).toEqual([200, true]);

  await page.goto(unsubPage(shop, msg.code!));
  await expect(page.getByText(/This was a test message/)).toBeVisible();
  // The campaign itself is still a draft (a test send is not a send).
  expect((await getCampaign(s, c.id)).status).toBe('draft');
});

test('storefront unsubscribe limiter: 21st request in a minute from one shopper IP → 429 (S116)', async () => {
  const ip = randomIp();
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) statuses.push((await sf(shop.apiHost, 'GET', '/unsubscribe/Zz9Zz9Zz9Z', { ip, headers: { 'X-Shopper-Ip': ip } })).status);
  expect(statuses.slice(0, 20).every((x) => x === 404), statuses.join(',')).toBe(true);
  expect(statuses[20]).toBe(429);
});

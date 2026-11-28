import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { placeOrder, randomPhone, type CommerceShop } from '../support/commerce';
import {
  chatPanel,
  chatThread,
  cleanupInboxShop,
  conversation,
  findConversation,
  inboxShop,
  launcher,
  magicLinkRaw,
  messages,
  openThread,
  orderAccess,
  orderAccessViewRaw,
  orderCard,
  orderMessagesRaw,
  orderSendRaw,
  readReplySms,
  reply,
  sendFromComposer,
  setChannels,
  smsMark,
  thread,
  trackRaw,
  verifiedChat,
  waitInOrderCard,
} from '../support/inbox';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-8E §10, §9.3 (`/m/{code}`), P88E-12, P88E-21 (Q304), P88E-22, S237, AC 2 + AC 4:
 *  - `/track` result: Messages card ("Replies in a few minutes", empty state, Send) → the message lands in the Inbox as an
 *    `order` conversation with the order linked (identity `order_access`); the shop reply shows in the card (10 s poll);
 *  - `/checkout/thank-you` (sp_order cookie): the same card;
 *  - the reply SMS goes to the ORDER phone with `/m/{code}` → opening it sets `sp_order_access` and lands on
 *    `/track?view=messages` with the reply; a chat magic link lands on `/?chat=open` with the panel open;
 *  - a bad / used-up code → `/` with no cookie; order messages off → `inbox_unavailable`.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let order: { number: string; phone: string; token: string };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await inboxShop('ibxom', { web_chat: true, order_messages: true });
  const phone = randomPhone();
  const placed = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { name: 'Rahim Uddin', phone } } });
  order = { number: placed.order.number as string, phone, token: placed.token };
});
test.afterAll(() => cleanupInboxShop(shop));

test('API: track → access token → first message creates the order conversation (order linked)', async () => {
  const access = await orderAccess(shop.apiHost, order.number, order.phone);
  const view = await orderAccessViewRaw(shop.apiHost, access);
  expect(view.status, view.text.slice(0, 300)).toBe(200);
  expect(view.json.data.number).toBe(order.number);
  const empty = await orderMessagesRaw(shop.apiHost, access);
  expect([empty.status, (empty.json.data as unknown[]).length]).toEqual([200, 0]);

  const sent = await orderSendRaw(shop.apiHost, access, 'Can you deliver after 6 pm?');
  expect(sent.status, sent.text.slice(0, 300)).toBe(201);
  const conv = await findConversation(shop.s, (x) => x.channel === 'order' && x.order?.number === order.number, 'order conversation');
  expect(conv.identity).toBe('order_access');
  const detail = await conversation(shop.s, conv.id);
  expect(detail.customer.linked_order?.number).toBe(order.number);
  expect(detail.can.link_order, 'order channel: linked order is fixed').toBe(false);

  // A bogus / tampered token → 404 order_access_invalid.
  const bad = await orderMessagesRaw(shop.apiHost, `${access.slice(0, -4)}AAAA`);
  expect([bad.status, bad.json.error?.code]).toEqual([404, 'order_access_invalid']);
});

test('/track: Messages card → send → shop reply appears; thank-you shows the card too', async ({ page, context, browser }) => {
  test.setTimeout(180_000);
  const c = watchConsole(page);
  await page.goto(`${shop.storefront}/track`);
  await page.getByLabel('Order number').fill(order.number);
  await page.getByLabel('Phone number').fill(order.phone);
  await page.getByRole('button', { name: 'Track order' }).click();
  const card = orderCard(page);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole('heading', { name: 'Messages' })).toBeVisible();
  await expect(card).toContainText('Replies in a few minutes');
  await expect(card).toContainText('We also text you when the shop replies. Messages stay with this order.');
  await expect(card).toContainText('Can you deliver after 6 pm?'); // from the API test (same order thread)
  const text = `Please call before coming ${Date.now().toString(36)}`;
  await card.getByLabel('Message', { exact: true }).fill(text);
  await card.getByRole('button', { name: 'Send' }).click();
  await expect(card.locator('[data-sp-chat-from="customer"]').filter({ hasText: text })).toBeVisible({ timeout: 20_000 });
  expect((await context.cookies(shop.storefront)).find((k) => k.name === 'sp_order_access')?.httpOnly).toBe(true);

  const conv = await findConversation(shop.s, (x) => x.channel === 'order' && x.order?.number === order.number, 'order conversation');
  const merchant = await browser.newContext();
  const mp = await merchant.newPage();
  await signInDashboard(merchant, shop.s);
  await openThread(mp, conv.id);
  await expect(thread(mp)).toContainText(text);
  await expect(mp.getByText('Sends to the order page')).toBeVisible();
  const answer = `Sure, our rider will call you. ${Date.now().toString(36)}`;
  await sendFromComposer(mp, answer);
  await merchant.close();
  await waitInOrderCard(page, orderCard(page).locator('[data-sp-chat-from="shop"]').filter({ hasText: answer }));

  // Thank-you page (sp_order = confirmation token) carries the same card.
  await context.addCookies([{ name: 'sp_order', value: order.token, domain: shop.localHost, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto(`${shop.storefront}/checkout/thank-you`);
  const ty = orderCard(page);
  await expect(ty).toBeVisible({ timeout: 20_000 });
  await expect(ty).toContainText(answer, { timeout: 20_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('/m/{code}: the order reply SMS goes to the order phone; the link opens /track?view=messages', async ({ page, context }) => {
  test.setTimeout(300_000);
  const conv = await findConversation(shop.s, (x) => x.channel === 'order' && x.order?.number === order.number, 'order conversation');
  // The thank-you page of the previous test posts its last /seen as it closes; timestamps are second-precise and
  // `customer_seen_at >= reply.created_at` counts as seen, so leave a clear gap before replying.
  await new Promise((r) => setTimeout(r, 2_500));
  const mark = smsMark();
  const text = `Your parcel leaves today ${Date.now().toString(36)}`;
  await reply(shop.s, conv.id, text);
  const { code } = await readReplySms(mark, order.phone).catch(async (e) => {
    const rows = (await messages(shop.s, conv.id)).filter((m) => m.kind === 'reply').map((m) => `${m.body} → ${m.sms_status}`);
    throw new Error(`${(e as Error).message}\nreplies: ${rows.join(' | ')}\nconversation: ${JSON.stringify(await conversation(shop.s, conv.id)).slice(0, 400)}`);
  });

  await page.goto(`${shop.storefront}/m/${code}`);
  await expect(page).toHaveURL(/\/track\?view=messages$/, { timeout: 20_000 });
  const card = orderCard(page);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText(text, { timeout: 20_000 });
  const cookie = (await context.cookies(shop.storefront)).find((k) => k.name === 'sp_order_access');
  expect(cookie?.httpOnly).toBe(true);

  // Bad code → home, no cookie.
  await context.clearCookies();
  await page.goto(`${shop.storefront}/m/${'x'.repeat(24)}`);
  await expect(page).toHaveURL(new RegExp(`^${shop.storefront.replace(/[.:/]/g, '\\$&')}/?$`));
  expect((await context.cookies(shop.storefront)).some((k) => k.name === 'sp_order_access' || k.name === 'sp_chat')).toBe(false);
  const api = await magicLinkRaw(shop.apiHost, 'x'.repeat(24));
  expect([api.status, api.json.error?.code]).toEqual([404, 'inbox_link_invalid']);
});

test('/m/{code}: a chat reply link opens the shop with the chat panel and the reply', async ({ page }) => {
  test.setTimeout(300_000);
  const { phone } = await verifiedChat(shop, { message: 'Is COD available?' });
  const conv = await findConversation(shop.s, (x) => x.channel === 'web_chat' && x.preview.includes('Is COD available?'), 'chat');
  const mark = smsMark();
  await reply(shop.s, conv.id, 'Yes, cash on delivery everywhere.');
  const { code } = await readReplySms(mark, phone);
  await page.goto(`${shop.storefront}/m/${code}`);
  await expect(launcher(page)).toBeVisible({ timeout: 20_000 });
  await expect(chatPanel(page)).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/chat=open/); // cleaned from the address bar
  await expect(chatThread(page)).toContainText('Yes, cash on delivery everywhere.', { timeout: 20_000 });
});

test('order messages off: tracking has no messages; existing tokens get inbox_unavailable', async () => {
  const access = await orderAccess(shop.apiHost, order.number, order.phone);
  await setChannels(shop.s, { order_messages: false });
  try {
    const tr = await trackRaw(shop.apiHost, order.number, order.phone);
    expect(tr.json.data.messages ?? null).toBeNull();
    const r = await orderSendRaw(shop.apiHost, access, 'still there?');
    expect([r.status, r.json.error?.code]).toEqual([404, 'inbox_unavailable']);
  } finally {
    await setChannels(shop.s, { order_messages: true });
  }
});

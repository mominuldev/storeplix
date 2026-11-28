import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { randomIp, randomPhone, type CommerceShop } from '../support/commerce';
import {
  allConversations,
  attachmentLinkRaw,
  bigPdf,
  chatPanel,
  chatThread,
  cleanupInboxShop,
  conversation,
  exhaustSmsAllowance,
  fakePng,
  fillGuestForm,
  findConversation,
  gotoWithWidget,
  hurryInboxJobs,
  inboxShop,
  launcher,
  messages,
  MAGIC,
  openThread,
  pdf,
  photo,
  readCode,
  readRaw,
  readReplySms,
  reply,
  resendRaw,
  sendFromComposer,
  shopperAttachmentRaw,
  shopperMessagesRaw,
  shopperSendRaw,
  smsMark,
  smsTo,
  startChatRaw,
  thread,
  useChatSession,
  verifiedChat,
  verifyRaw,
  waitInChat,
  widgetSessionRaw,
} from '../support/inbox';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-8E §9 (P88E-10 … P88E-14, S237–S241), §16 QA flow, AC 2 + AC 4:
 *  - PDP → launcher → guest form (name, mobile, message) → code step "Check your phone" (code from the SMS log driver)
 *    → Confirm and send → sent state ("Thanks, {name}! …") → the message is in /inbox with the product context card;
 *  - the shop replies in the dashboard → the open widget shows the reply; the shopper's bubble shows "Seen" once the
 *    shop read it; the reply SMS is skipped (`seen`) because the shopper had it open;
 *  - reply SMS (closed widget): one SMS with a `/m/{code}` link after the delay; a second reply within 30 min → `throttled`
 *    and no second SMS (S239);
 *  - unverified fallback (P88E-14): no allowance and no credits → `unverified`, message delivered, "Number not
 *    verified", no SMS ever (`not_applicable`);
 *  - attachments: photo / PDF from the widget reach the thread; sniffed type + 5 MB refused (S241); a shopper reads only
 *    their own attachment;
 *  - protection: wrong code (attempts left), resend cooldown 429, honeypot (202-like success, nothing stored), start
 *    limiter per store+IP (S238, S240).
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let poor: CommerceShop;
const NAME = 'Nusrat Jahan';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await inboxShop('ibxwg', { web_chat: true });
  poor = await inboxShop('ibxwp', { web_chat: true });
  await exhaustSmsAllowance(poor.s);
});
test.afterAll(() => {
  cleanupInboxShop(shop);
  cleanupInboxShop(poor);
});

test('PDP guest chat: code step → verified → in the Inbox with the product card; reply + Seen in the widget', async ({ page, context, browser }) => {
  test.setTimeout(240_000);
  const c = watchConsole(page);
  const phone = randomPhone();
  const text = `Is the muslin wrap in stock? ${Date.now().toString(36)}`;
  await gotoWithWidget(page, shop, `/products/${shop.simple.slug}`);
  await launcher(page).click();
  const panel = chatPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-sp-chat-context]')).toContainText('QA Muslin Wrap');

  const mark = smsMark();
  await fillGuestForm(page, { name: NAME, phone, message: text });
  await expect(panel.getByText('Check your phone')).toBeVisible({ timeout: 20_000 });
  await expect(panel).toContainText(/Enter the 6-digit code we sent to 01\d•+\d{4}\./);
  await expect(panel.locator('[data-sp-chat-resend]')).toBeDisabled(); // 60 s cooldown
  const code = await readCode(mark, phone);
  // Body never stored, but the log driver shows the text the shopper receives (§9.5 en/bn template).
  expect(smsTo(mark, phone).at(-1)!.text).toMatch(new RegExp(`${code}`));

  await panel.getByLabel('6-digit code').fill(code);
  await panel.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(panel.getByText(`Thanks, Nusrat!`, { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(chatThread(page)).toContainText(text);
  // httpOnly session cookie only; the token never reaches page JS.
  const cookies = await context.cookies(shop.storefront);
  expect(cookies.find((k) => k.name === 'sp_chat')?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain('sp_chat=');

  // Merchant side: one web_chat conversation, verified phone, product context, customer linked rules (P88E-22).
  const conv = await findConversation(shop.s, (x) => x.channel === 'web_chat' && x.preview.includes(text), 'verified web chat');
  expect(conv.identity).toBe('verified_phone');
  const detail = await conversation(shop.s, conv.id);
  expect(detail.context?.name).toBe('QA Muslin Wrap');
  expect(detail.source_path).toBe(`/products/${shop.simple.slug}`);

  const merchant = await browser.newContext();
  const mp = await merchant.newPage();
  await signInDashboard(merchant, shop.s);
  await openThread(mp, conv.id);
  await expect(thread(mp)).toContainText(text);
  await expect(thread(mp)).toContainText('Asked from this product');
  const answer = `Yes, 4 left. Shall I keep one for you? ${Date.now().toString(36)}`;
  await sendFromComposer(mp, answer);
  await expect(thread(mp)).toContainText(answer);

  // The open widget polls every 5 s: the reply arrives, the shopper's bubble shows Seen (the shop read it).
  await waitInChat(page, chatThread(page).locator('[data-sp-chat-from="shop"]').filter({ hasText: answer }));
  // The shopper saw it → the merchant reply row says Seen live (QA 8.8e WEB-3 fixed: the header refetches on a new
  // ETag and `customer_seen_at` marks older replies), and the reply SMS is skipped as seen.
  await expect.poll(async () => (await messages(shop.s, conv.id)).find((m) => m.body === answer)?.seen, { timeout: 20_000 }).toBe(true);
  await expect(thread(mp).getByText('Seen').first()).toBeVisible({ timeout: 30_000 });
  hurryInboxJobs();
  await expect
    .poll(async () => (await messages(shop.s, conv.id)).find((m) => m.body === answer)?.sms_status, { timeout: 200_000, intervals: [3_000, 5_000] })
    .toBe('seen');
  expect(smsTo(mark, phone).filter((m) => MAGIC.test(m.text)), 'no reply SMS when the shopper already saw it').toEqual([]);
  await merchant.close();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('open widget keeps polling every 5 s (§12)', async ({ page, context }) => {
  // QA 8.8e SF-1 (fixed): in `next dev` the strict-mode unmount's schedule() used to clear the live loop's timer.
  const v = await verifiedChat(shop, { message: 'poll probe' });
  await useChatSession(context, shop, v.session);
  const hits: number[] = [];
  page.on('request', (r) => void (r.url().includes('/api/chat/messages') && hits.push(Date.now())));
  await gotoWithWidget(page, shop, '/');
  await launcher(page).click();
  await expect(chatThread(page)).toContainText('poll probe');
  await page.waitForTimeout(16_000);
  expect(hits.length, 'GET /api/chat/messages while open for 16 s').toBeGreaterThanOrEqual(3);
});

test('shopper sees "Seen" under their message once the shop read it (Figma 2126:10642)', async ({ page, context }) => {
  // QA 8.8e SF/API-2 (fixed): customer rows carry `seen` once a member has read up to them.
  const v = await verifiedChat(shop, { message: 'seen probe' });
  const conv = await findConversation(shop.s, (x) => x.preview.includes('seen probe'), 'seen probe chat');
  const last = (await messages(shop.s, conv.id)).filter((m) => m.kind === 'customer').at(-1)!;
  expect((await readRaw(shop.s, conv.id, last.id)).status).toBe(204);
  await useChatSession(context, shop, v.session);
  await gotoWithWidget(page, shop, '/');
  await launcher(page).click();
  await expect(chatThread(page)).toContainText('seen probe');
  await expect(chatThread(page).locator('[data-sp-chat-seen]')).toBeVisible({ timeout: 10_000 });
});

test('reply SMS: one SMS with a magic link after the delay; a second reply within 30 min is throttled', async () => {
  test.setTimeout(480_000);
  const { session, phone } = await verifiedChat(shop, { message: 'Do you deliver to Sylhet?' });
  const conv = await findConversation(shop.s, (x) => x.contact?.phone?.replace(/\D/g, '').endsWith(phone.slice(-10)) ?? false, 'chat by phone');
  const mark = smsMark();
  const r1 = await reply(shop.s, conv.id, 'Yes, 3–4 days to Sylhet.');
  expect(r1.sms_status).toBe('pending');
  const { sms } = await readReplySms(mark, phone);
  expect(sms.text).toMatch(/We replied to your message\. Read it here: |আপনার মেসেজের উত্তর দেওয়া হয়েছে।/);
  await expect.poll(async () => (await messages(shop.s, conv.id)).find((m) => m.id === r1.id)?.sms_status, { timeout: 30_000 }).toBe('sent');

  const r2 = await reply(shop.s, conv.id, 'Delivery is ৳120.');
  expect(r2.sms_status).toBe('pending');
  hurryInboxJobs();
  await expect
    .poll(
      async () => {
        hurryInboxJobs();
        return (await messages(shop.s, conv.id)).find((m) => m.id === r2.id)?.sms_status;
      },
      { timeout: 200_000, intervals: [3_000, 5_000] },
    )
    .toBe('throttled');
  expect(smsTo(mark, phone).filter((m) => MAGIC.test(m.text))).toHaveLength(1);

  // The shopper still reads both replies in the widget session.
  const list = await shopperMessagesRaw(shop.apiHost, session);
  expect(list.status).toBe(200);
  expect((list.json.data as Array<{ body: string }>).map((m) => m.body)).toEqual(expect.arrayContaining(['Yes, 3–4 days to Sylhet.', 'Delivery is ৳120.']));
});

test('unverified fallback: no SMS can be paid → message delivered, "Number not verified", never texted', async ({ page, context }) => {
  test.setTimeout(240_000);
  const phone = randomPhone();
  const mark = smsMark();
  await gotoWithWidget(page, poor, '/');
  await launcher(page).click();
  await fillGuestForm(page, { name: 'Karim Hossain', phone, message: 'Can I pay with bKash?' });
  await expect(chatPanel(page)).toContainText("We couldn't text you a code right now. Your message is with the shop", { timeout: 20_000 });
  await expect(chatThread(page)).toContainText('Can I pay with bKash?');
  expect(smsTo(mark, phone), 'no SMS was sent').toEqual([]);

  const conv = await findConversation(poor.s, (x) => x.channel === 'web_chat' && x.preview.includes('bKash'), 'unverified chat');
  expect(conv.identity).toBe('unverified');
  const detail = await conversation(poor.s, conv.id);
  expect(detail.customer.customer ?? null, 'never linked to a customer (S244)').toBeNull();
  const r = await reply(poor.s, conv.id, 'Yes, bKash works.');
  expect(r.sms_status).toBe('not_applicable');

  await signInDashboard(context, poor.s);
  await openThread(page, conv.id);
  await expect(page.getByText(/Number not verified — Karim sees your reply only in the chat window/)).toBeVisible();

  // The shopper reads the reply in the same browser (cookie session).
  await gotoWithWidget(page, poor, '/');
  await launcher(page).click();
  await expect(chatThread(page)).toContainText('Yes, bKash works.', { timeout: 20_000 });
  hurryInboxJobs();
  expect(smsTo(mark, phone)).toEqual([]);
});

test('attachments: photo from the widget form reaches the thread; sniffing and 5 MB enforced; own attachments only', async ({ page }) => {
  test.setTimeout(180_000);
  const phone = randomPhone();
  const mark = smsMark();
  await gotoWithWidget(page, shop, '/');
  await launcher(page).click();
  await fillGuestForm(page, { name: 'Shila Akter', phone, message: 'Here is the size chart I meant', file: { name: 'chart.png', mimeType: 'image/png', buffer: photo().buffer } });
  const code = await readCode(mark, phone);
  await chatPanel(page).getByLabel('6-digit code').fill(code);
  await chatPanel(page).getByRole('button', { name: 'Confirm and send' }).click();
  // "Processing…" first (images are re-encoded on the media queue), then the image (reopen: bug SF-1).
  await expect(chatThread(page)).toContainText('Here is the size chart I meant', { timeout: 20_000 });
  await waitInChat(page, chatThread(page).locator('[data-sp-chat-attachment="image"]').first());

  const conv = await findConversation(shop.s, (x) => x.preview.includes('size chart I meant'), 'chat with a photo');
  const rows = await messages(shop.s, conv.id);
  const att = rows.find((m) => m.kind === 'customer')!.attachments[0];
  expect(att).toMatchObject({ mime: 'image/png', kind: 'image' });
  // Member link: signed, 5 minutes, served inline with nosniff + sandbox CSP.
  let link = await attachmentLinkRaw(shop.s, att.id);
  if (link.status === 409) {
    await expect.poll(async () => (link = await attachmentLinkRaw(shop.s, att.id)).status, { timeout: 30_000 }).toBe(200);
  }
  expect(link.status, link.text.slice(0, 300)).toBe(200);
  const file = await fetch(link.json.data.url as string);
  expect(file.status).toBe(200);
  expect(file.headers.get('x-content-type-options')).toBe('nosniff');
  expect(file.headers.get('content-security-policy') ?? '').toContain('sandbox');

  // A second verified shopper: PDF via the messages endpoint; sniffing + size; cannot read the first shopper's file.
  const other = await verifiedChat(shop, { message: 'Invoice question' });
  const okPdf = await shopperSendRaw(shop.apiHost, other.session, 'Invoice attached', pdf());
  expect(okPdf.status, okPdf.text.slice(0, 300)).toBe(201);
  const bad = await shopperSendRaw(shop.apiHost, other.session, 'Not really a PNG', fakePng());
  expect([bad.status, bad.json.error?.code]).toEqual([422, 'validation_failed']);
  const big = await shopperSendRaw(shop.apiHost, other.session, 'Too big', bigPdf());
  expect([413, 422], big.text.slice(0, 200)).toContain(big.status);
  const foreign = await shopperAttachmentRaw(shop.apiHost, other.session, att.id);
  expect(foreign.status, 'another shopper’s attachment').toBe(404);
});

test('protection: wrong code, resend cooldown, honeypot, start limiter per store + IP', async () => {
  test.setTimeout(180_000);
  // Wrong code → 422 inbox_code_invalid with attempts_left; resend inside 60 s → 429 retry_after.
  const phone = randomPhone();
  const mark = smsMark();
  const start = await startChatRaw(shop.apiHost, { phone, message: 'Wrong code test' });
  expect(start.status, start.text.slice(0, 300)).toBe(201);
  const session = start.json.data.session_token as string;
  expect(start.json.data.phone_masked).toMatch(/^01\d•+\d{4}$/);
  expect(JSON.stringify(start.json)).not.toContain(phone.slice(3)); // never the full number back (S238)
  const code = await readCode(mark, phone);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  const bad = await verifyRaw(shop.apiHost, session, wrong);
  expect([bad.status, bad.json.error?.code, bad.json.error?.details?.attempts_left]).toEqual([422, 'inbox_code_invalid', 4]);
  const resend = await resendRaw(shop.apiHost, session);
  expect([resend.status, resend.json.error?.code]).toEqual([429, 'rate_limited']);
  // Pending session: messages refused until verified.
  const early = await shopperSendRaw(shop.apiHost, session, 'before verify');
  expect([early.status, early.json.error?.code]).toEqual([409, 'inbox_session_unverified']);
  const pending = await widgetSessionRaw(shop.apiHost, session);
  expect(pending.json.data?.status).toBe('pending');
  const good = await verifyRaw(shop.apiHost, session, code);
  expect(good.status, good.text.slice(0, 300)).toBe(200);

  // Honeypot filled → looks like success, nothing stored, no SMS.
  const hpPhone = randomPhone();
  const hpMark = smsMark();
  const hp = await startChatRaw(shop.apiHost, { phone: hpPhone, message: 'HONEYPOT-QA buy cheap', honeypot: 'https://spam.example' });
  expect([201, 202]).toContain(hp.status);
  await new Promise((r) => setTimeout(r, 3_000));
  expect(smsTo(hpMark, hpPhone)).toEqual([]);
  expect((await allConversations(shop.s)).filter((x) => String(x.preview).includes('HONEYPOT-QA'))).toEqual([]);

  // inbox-widget-start: 5/h per store + IP → the 6th start from one IP is 429 (different phones).
  const ipAddr = randomIp();
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await startChatRaw(shop.apiHost, { phone: randomPhone(), message: `limiter ${i}`, ip: ipAddr })).status);
  expect(codes.slice(0, 5).every((s) => s === 201), codes.join(',')).toBe(true);
  expect(codes[5]).toBe(429);
});

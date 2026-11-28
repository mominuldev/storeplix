import { expect, test } from '@playwright/test';
import { createMember, signInDashboard, type ThrowawayMember } from '../support/api';
import { placeOrder, type CommerceShop } from '../support/commerce';
import {
  actionsMenu,
  assignButton,
  chatThread,
  cleanupInboxShop,
  conversation,
  conversations,
  createSavedReply,
  findConversation,
  gotoWithWidget,
  inboundEmailRaw,
  inboxShop,
  launcher,
  listRegion,
  mailMark,
  mailsTo,
  messages,
  modeButton,
  openInbox,
  openThread,
  replyBox,
  row,
  sendButton,
  sendFromComposer,
  shopperMessagesRaw,
  shopperSendRaw,
  statusChip,
  statusRaw,
  storeAddress,
  thread,
  useChatSession,
  verifiedChat,
  waitMail,
} from '../support/inbox';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-8E §5–§8 (P88E-4 … P88E-9, P88E-22), AC 3 + AC 5, dashboard at 1440 px (list + thread + side panel):
 *  - filters: status chips with counts, assignee scope, channel select, search by phone digits;
 *  - assign from the popover → system row, the assignee is emailed (never on self-assign);
 *  - Mark pending → Close (toast + Undo restores the previous status) → Close again → Reopen; a shopper message on a
 *    closed conversation reopens it and keeps the assignee;
 *  - internal note (Internal note mode) never reaches the shopper (widget API and UI);
 *  - saved replies with `/` (server-rendered merge tags); an unresolved tag blocks Send until edited;
 *  - link an order from the side panel → linked-order card + system row; `{order_number}` now resolves;
 *  - Block customer → banner, the shopper's next message is swallowed; Unblock.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let staff: ThrowawayMember | undefined;
let chatA: { session: string; phone: string; id: string };
let chatB: { session: string; phone: string; id: string };
let mailConv: string;
let orderNumber: string;

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  shop = await inboxShop('ibxui', { web_chat: true, order_messages: true, email: true }, 'growth');
  staff = await createMember(shop.s, 'staff');
  const a = await verifiedChat(shop, { name: 'Nusrat Jahan', message: 'Does the kurta come in L?' });
  chatA = { ...a, id: (await findConversation(shop.s, (x) => x.preview.includes('kurta come in L'), 'chat A')).id as string };
  const b = await verifiedChat(shop, { name: 'Tanvir Ahmed', message: 'What is the return policy?' });
  chatB = { ...b, id: (await findConversation(shop.s, (x) => x.preview.includes('return policy'), 'chat B')).id as string };
  const r = await inboundEmailRaw({ to: await storeAddress(shop.s), from: 'farzana@mail.e2e.storeplix.test', fromName: 'Farzana Akter', subject: 'Gift wrap?', text: 'Can you gift wrap my order?' });
  expect(r.status, r.text.slice(0, 300)).toBe(202);
  mailConv = (await findConversation(shop.s, (x) => x.channel === 'email', 'email conversation')).id as string;
  orderNumber = (await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { name: 'Nusrat Jahan', phone: a.phone } } })).order.number as string;
});
test.afterAll(async () => {
  await staff?.cleanup().catch(() => undefined);
  cleanupInboxShop(shop);
});

test('list: counts, channel filter, scope, search by phone digits', async ({ page, context }) => {
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openInbox(page);
  await expect(statusChip(page, 'Open')).toHaveText(/Open · 3/);
  await expect(listRegion(page).getByRole('listitem')).toHaveCount(3);
  await expect(row(page, 'Farzana Akter').getByRole('img', { name: 'Email' })).toBeVisible();
  await expect(row(page, 'Nusrat Jahan').getByRole('img', { name: 'Website chat' })).toBeVisible();
  // Unread for me: each row has a badge before it is opened.
  await expect(row(page, 'Tanvir Ahmed')).toContainText('unread');

  await page.getByLabel('Channel').selectOption('email');
  await expect(page).toHaveURL(/channel=email/);
  await expect(listRegion(page).getByRole('listitem')).toHaveCount(1);
  await expect(row(page, 'Farzana Akter')).toBeVisible();
  await page.getByLabel('Channel').selectOption('');

  await page.getByLabel('Search conversations').fill(chatB.phone.slice(-6));
  await expect(page).toHaveURL(/q=/);
  await expect(listRegion(page).getByRole('listitem')).toHaveCount(1);
  await expect(row(page, 'Tanvir Ahmed')).toBeVisible();
  await page.getByLabel('Search conversations').fill('zzzz-nobody');
  await expect(page.getByText('No conversations match')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(listRegion(page).getByRole('listitem')).toHaveCount(3);

  await page.getByLabel('Assignee').selectOption('mine');
  await expect(page.getByText('All caught up')).toBeVisible();
  await page.getByLabel('Assignee').selectOption('mine_unassigned');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('assign to a teammate (emailed), self-assign not emailed; system rows', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await openThread(page, chatA.id);
  await expect(thread(page)).toContainText('Does the kurta come in L?');
  const mark = mailMark();
  await assignButton(page).click();
  const pop = page.getByRole('dialog', { name: 'Assign conversation' });
  await expect(pop.getByRole('button', { name: /Unassigned/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(pop).toContainText('Only staff with the Inbox permission are listed.');
  await pop.getByRole('button', { name: /E2E staff/ }).click();
  await expect(assignButton(page)).toHaveAccessibleName(/Assignee: E2E staff/);
  await expect(thread(page)).toContainText(/You assigned this to E2E/);
  await waitMail(mark, staff!.email, (e) => /Subject: .*(assigned|Inbox)/i.test(e) && e.includes('/inbox'), 'assignment email to the teammate');
  const conv = await conversation(shop.s, chatA.id);
  expect(conv.assignee?.name).toBe('E2E staff');

  // Self-assign is never emailed.
  const selfMark = mailMark();
  await assignButton(page).click();
  await page.getByRole('dialog', { name: 'Assign conversation' }).getByRole('button', { name: /\(you\)/ }).click();
  await expect(thread(page)).toContainText(/You assigned this to yourself/);
  await new Promise((r) => setTimeout(r, 3_000));
  expect(mailsTo(selfMark, shop.t.email).filter((e) => /assigned/i.test(e))).toEqual([]);
  // Back to the teammate for the reopen test below.
  await assignButton(page).click();
  await page.getByRole('dialog', { name: 'Assign conversation' }).getByRole('button', { name: /E2E staff/ }).click();
  await expect(assignButton(page)).toHaveAccessibleName(/Assignee: E2E staff/);
});

test('pending → close with Undo → close → Reopen; a shopper message reopens for the assignee', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await openThread(page, chatA.id);
  await page.getByRole('button', { name: 'Mark pending' }).click();
  await expect(page.getByRole('button', { name: 'Mark open' }).first()).toBeVisible();
  await expect.poll(async () => (await conversation(shop.s, chatA.id)).status).toBe('pending');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Conversation closed.' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await conversation(shop.s, chatA.id)).status).toBe('pending');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(async () => (await conversation(shop.s, chatA.id)).status).toBe('closed');
  await openThread(page, chatA.id, 'status=closed');
  await expect(page.getByText(/Closed\. If Nusrat writes again it reopens and goes back to E2E/)).toBeVisible();
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect.poll(async () => (await conversation(shop.s, chatA.id)).status).toBe('open');
  await expect(thread(page)).toContainText(/You reopened this conversation/);

  // Close again; the shopper writes → open, still the teammate's (P88E-5).
  expect((await statusRaw(shop.s, chatA.id, 'closed')).status).toBe(200);
  const w = await shopperSendRaw(shop.apiHost, chatA.session, 'Hello? Any update on the size?');
  expect(w.status, w.text.slice(0, 300)).toBe(201);
  const after = await conversation(shop.s, chatA.id);
  expect([after.status, after.assignee?.name]).toEqual(['open', 'E2E staff']);
  expect((await messages(shop.s, chatA.id)).some((m) => m.kind === 'system' && m.system?.event === 'reopened' && m.system?.actor === null)).toBe(true);
});

test('internal note: shown only to the team, never to the shopper', async ({ page, context, browser }) => {
  await signInDashboard(context, shop.s);
  await openThread(page, chatB.id);
  await expect(page.getByText('Sends to website chat')).toBeVisible();
  const secret = `NOTE-QA risky buyer, check COD ${Date.now().toString(36)}`;
  await sendFromComposer(page, secret, 'Internal note');
  await expect(page.getByText('Only your team sees this', { exact: true })).toBeVisible();
  await expect(thread(page).getByText('Internal note · only your team sees this').last()).toBeVisible();
  await expect(thread(page)).toContainText(secret);
  await modeButton(page, 'Reply').click();
  await sendFromComposer(page, 'We accept returns within 7 days.');

  const shopper = await shopperMessagesRaw(shop.apiHost, chatB.session);
  expect(shopper.status).toBe(200);
  expect(shopper.text).not.toContain('NOTE-QA');
  expect((shopper.json.data as Array<{ from: string }>).every((m) => m.from === 'customer' || m.from === 'shop')).toBe(true);
  expect(shopper.text).toContain('We accept returns within 7 days.');
  const list = await conversations(shop.s, { scope: 'all' });
  expect(JSON.stringify(list.data)).not.toContain('NOTE-QA'); // previews exclude notes

  // The shopper's widget (same session cookie) shows the reply, never the note.
  const sh = await browser.newContext();
  const sp = await sh.newPage();
  await useChatSession(sh, shop, chatB.session);
  await gotoWithWidget(sp, shop, '/');
  await launcher(sp).click();
  await expect(chatThread(sp)).toContainText('We accept returns within 7 days.', { timeout: 20_000 });
  await expect(chatThread(sp)).not.toContainText('NOTE-QA');
  await sh.close();
});

test('saved replies with `/`: merge tags rendered; unresolved tag blocks Send; link an order resolves it', async ({ page, context }) => {
  await createSavedReply(shop.s, { title: 'Thanks for asking', shortcut: 'thanks', body: 'Hi {customer_name}, thanks for asking! — {shop_name}', show_as_chip: true });
  await createSavedReply(shop.s, { title: 'Order status', shortcut: 'status', body: 'Your order {order_number} is on its way.' });
  await signInDashboard(context, shop.s);
  await openThread(page, chatA.id);

  const box = replyBox(page);
  await box.fill('/than');
  const lb = page.getByRole('listbox', { name: 'Saved replies' });
  await expect(lb.getByRole('option')).toHaveCount(1);
  await expect(lb).toContainText('/thanks');
  await box.press('Enter');
  await expect(box).toHaveValue(/^Hi Nusrat, thanks for asking! — QA ibxui shop/);
  // Chip (show_as_chip) is there too.
  await expect(page.getByLabel('Saved replies').getByRole('button', { name: 'Thanks for asking' })).toBeVisible();
  await box.fill('');

  // {order_number} without a linked order stays and blocks Send.
  await box.fill('/status');
  await box.press('Enter');
  await expect(box).toHaveValue(/\{order_number\}/);
  await expect(page.getByRole('alert').filter({ hasText: 'Replace {order_number} before sending' })).toBeVisible();
  await expect(sendButton(page)).toBeDisabled();
  await box.fill('');

  // Link the order from the side panel → card + system row.
  const panel = page.getByRole('complementary', { name: 'Customer' });
  await panel.getByRole('button', { name: 'Link an order' }).click();
  const dlg = page.getByRole('dialog', { name: 'Link an order' });
  await dlg.getByLabel('Search orders').fill(orderNumber);
  await dlg.getByRole('button', { name: new RegExp(orderNumber) }).click();
  await expect(panel.getByRole('region', { name: 'Linked order' })).toContainText(orderNumber);
  await expect(thread(page)).toContainText(new RegExp(`You linked order ${orderNumber}`));

  await box.fill('/status');
  await box.press('Enter');
  await expect(box).toHaveValue(`Your order ${orderNumber} is on its way.`);
  await expect(sendButton(page)).toBeEnabled();
  await sendButton(page).click();
  await expect(thread(page)).toContainText(`Your order ${orderNumber} is on its way.`);
  // The thread shows the optimistic row first: wait for the stored reply.
  await expect.poll(async () => (await messages(shop.s, chatA.id)).filter((m) => m.kind === 'reply').at(-1)?.body, { timeout: 15_000 }).toBe(`Your order ${orderNumber} is on its way.`);
});

test('block: banner, shopper messages swallowed; unblock', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await openThread(page, chatB.id);
  await actionsMenu(page).click();
  await page.getByRole('menuitem', { name: /Block customer/ }).click();
  await expect(page.getByText(/Blocked\. New messages from Tanvir are dropped\./)).toBeVisible();
  const shopperRows = async () => (await messages(shop.s, chatB.id)).filter((m) => m.kind === 'customer').length;
  const before = await shopperRows();
  const w = await shopperSendRaw(shop.apiHost, chatB.session, 'BLOCKED-QA spam spam');
  expect([200, 201, 202], w.text.slice(0, 200)).toContain(w.status); // the shopper sees success
  expect(await shopperRows(), 'blocked: the message is swallowed').toBe(before);
  expect((await messages(shop.s, chatB.id)).some((m) => String(m.body ?? '').includes('BLOCKED-QA'))).toBe(false);
  expect((await conversation(shop.s, chatB.id)).blocked).toBe(true);

  await openInbox(page, 'scope=all');
  await expect(row(page, 'Tanvir Ahmed')).toContainText('Blocked');
  await openThread(page, chatB.id);
  await actionsMenu(page).click();
  await page.getByRole('menuitem', { name: 'Unblock customer' }).click();
  await expect(page.getByText(/Blocked\. New messages/)).toHaveCount(0);
  const ok = await shopperSendRaw(shop.apiHost, chatB.session, 'Thanks for unblocking');
  expect(ok.status).toBe(201);
  await expect(thread(page)).toContainText('Thanks for unblocking', { timeout: 20_000 });
});

test('email conversation: the composer says "Sends by email"; the header shows the subject', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await openThread(page, mailConv);
  await expect(page.getByText('Sends by email')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Farzana Akter' }).first()).toBeVisible();
  await expect(page.getByText('Email · Gift wrap?')).toBeVisible();
});

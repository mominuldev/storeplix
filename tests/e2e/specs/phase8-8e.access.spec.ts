import { expect, test, type Page } from '@playwright/test';
import { api, createMember, signInDashboard, tinker, urls, type Session, type ThrowawayMember } from '../support/api';
import { REASON, adminApi, adminLogin, findTenant, reseedSuperAdmin, type AdminSession } from '../support/admin';
import { placeOrder, randomPhone, type CommerceShop } from '../support/commerce';
import {
  assignRaw,
  assigneesRaw,
  attachmentLinkRaw,
  blockRaw,
  cleanupInboxShop,
  conversationRaw,
  conversationsRaw,
  createSavedReplyRaw,
  deleteRaw,
  findConversation,
  inboxShop,
  linkOrderRaw,
  messages,
  messagesRaw,
  openInbox,
  orderAccess,
  orderMessagesRaw,
  orderSendRaw,
  patchSettingsRaw,
  readRaw,
  replyBox,
  rotateRaw,
  savedRepliesRaw,
  sendRaw,
  setChannels,
  settingsRaw,
  shopperAttachmentRaw,
  shopperMessagesRaw,
  shopperSendRaw,
  sfConfigRaw,
  startChatRaw,
  statusRaw,
  summaryRaw,
  uploadRaw,
  photo,
  verifiedChat,
  widgetSessionRaw,
} from '../support/inbox';
import { createRole, navLabels, noAccess, sidebar } from '../support/roles';

/**
 * PHASE-8-8E §2, §13, S234–S237, S245 (P88E-3), AC 5:
 *  - a custom role without `inbox.manage` (orders.view only): no Inbox in the nav, the page shows "no access", every
 *    inbox route 403; a role with `inbox.manage` only: reads + replies, no channel writes (settings.manage), no order
 *    link (orders.view), no delete (customers.delete), side panel without customer/order;
 *  - the Staff system role has the Inbox; assigning to a member without the key → 422 `inbox_assignee_invalid`;
 *  - another tenant's store → 404 on every route; a conversation of another store under our store path → 404;
 *  - support session (impersonation): Inbox reads fine; composer disabled; writes 403 `impersonation_read_only`;
 *    attachment links 403 `impersonation_attachment_hidden`;
 *  - storefront host isolation: a chat session / order token / attachment of shop A is 404 on shop B's host; a draft
 *    store has no widget config and refuses a chat start.
 */
test.describe.configure({ mode: 'serial' });

let a: CommerceShop;
let b: CommerceShop;
let none: ThrowawayMember | undefined;
let agent: ThrowawayMember | undefined;
let staff: ThrowawayMember | undefined;
let convA: string;
let convB: string;
let chatA: { session: string; phone: string };
let attachmentA: string;
const as = (m: ThrowawayMember | undefined): Session => ({ ...m!.session, storeId: a.s.storeId });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  a = await inboxShop('ibxaca', { web_chat: true, order_messages: true }, 'growth'); // custom roles are on Growth
  b = await inboxShop('ibxacb', { web_chat: true, order_messages: true });
  none = await createMember(a.s, { role_id: (await createRole(a.s, 'QA Inbox none', ['orders.view'])).id as string });
  agent = await createMember(a.s, { role_id: (await createRole(a.s, 'QA Inbox agent', ['inbox.manage'])).id as string });
  staff = await createMember(a.s, 'staff');
  chatA = await verifiedChat(a, { message: 'Access test A' });
  convA = (await findConversation(a.s, (x) => x.preview.includes('Access test A'), 'A chat')).id as string;
  await verifiedChat(b, { message: 'Access test B' });
  convB = (await findConversation(b.s, (x) => x.preview.includes('Access test B'), 'B chat')).id as string;
  const up = await shopperSendRaw(a.apiHost, chatA.session, 'photo', { name: 'p.png', type: 'image/png', buffer: photo().buffer });
  expect(up.status, up.text.slice(0, 300)).toBe(201);
  attachmentA = ((await messages(a.s, convA)).find((m) => m.attachments.length > 0)!.attachments[0] as { id: string }).id;
});
test.afterAll(async () => {
  for (const m of [none, agent, staff]) await m?.cleanup().catch(() => undefined);
  cleanupInboxShop(a);
  cleanupInboxShop(b);
});

function inboxRoutes(s: Session, conv: string, as: Session) {
  return [
    ['summary', summaryRaw(s, as)],
    ['list', conversationsRaw(s, '', as)],
    ['thread', conversationRaw(s, conv, as)],
    ['messages', messagesRaw(s, conv, '', as)],
    ['send', sendRaw(s, conv, { kind: 'reply', body: 'x' }, as)],
    ['status', statusRaw(s, conv, 'pending', as)],
    ['assign', assignRaw(s, conv, null, as)],
    ['block', blockRaw(s, conv, true, as)],
    ['read', readRaw(s, conv, conv, as)],
    ['assignees', assigneesRaw(s, as)],
    ['saved replies', savedRepliesRaw(s, '', as)],
    ['create saved reply', createSavedReplyRaw(s, { title: 'x', shortcut: 'xx', body: 'x' }, as)],
    ['upload', uploadRaw(s, photo(), as)],
    ['settings', settingsRaw(s, as)],
  ] as const;
}

test('no inbox.manage: no nav item, no-access page, 403 on every route', async ({ page, context }) => {
  for (const [what, p] of inboxRoutes(a.s, convA, as(none))) {
    const r = await p;
    expect([what, r.status]).toEqual([what, 403]);
  }
  await signInDashboard(context, as(none));
  await page.goto(`${urls.merchant}/orders`);
  await expect(sidebar(page)).toBeVisible({ timeout: 20_000 });
  expect((await navLabels(page)).some((l) => l.startsWith('Inbox'))).toBe(false);
  await page.goto(`${urls.merchant}/inbox`);
  await expect(noAccess(page)).toBeVisible({ timeout: 20_000 });
});

test('inbox.manage only: reads and replies; no channel writes, no order link, no delete, no customer panel', async ({ page, context }) => {
  const s = as(agent);
  expect((await conversationRaw(a.s, convA, s)).status).toBe(200);
  const sent = await sendRaw(a.s, convA, { kind: 'reply', body: 'Agent reply' }, s);
  expect(sent.status, sent.text.slice(0, 300)).toBe(201);
  expect((await settingsRaw(a.s, s)).status).toBe(200); // read: inbox.manage | settings.manage
  expect((await settingsRaw(a.s, s)).json.data.can.edit).toBe(false);
  expect((await patchSettingsRaw(a.s, { revision: 1, web_chat_enabled: false }, s)).status).toBe(403);
  expect((await rotateRaw(a.s, s)).status).toBe(403);
  const placed = await placeOrder(a, a.simple.variantId, 1, { body: { contact: { phone: randomPhone() } } });
  const link = await linkOrderRaw(a.s, convA, (placed.order.id as string | undefined) ?? 'x'.repeat(26), s);
  expect(link.status).toBe(403);
  expect((await deleteRaw(a.s, convA, s)).status).toBe(403);
  const detail = (await conversationRaw(a.s, convA, s)).json.data;
  expect(detail.can).toMatchObject({ reply: true, link_order: false, delete: false, view_customer: false, view_order: false });
  expect(detail.customer.customer).toBeNull();
  expect(detail.customer.linked_order).toBeNull();
  expect(detail.customer.past_orders).toEqual([]);

  await signInDashboard(context, s);
  await openInbox(page);
  expect(await navLabels(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^Inbox/)])); // "Inbox\n1" with the unread badge
  await page.getByRole('button', { name: 'Connect a channel' }).click();
  await expect(page.getByText('Only members who can change shop settings can switch channels.')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Website chat' })).toBeDisabled();
});

test('staff system role has the Inbox; assignee must hold inbox.manage', async ({ page, context }) => {
  const s = as(staff);
  expect((await summaryRaw(a.s, s)).status).toBe(200);
  const people = (await assigneesRaw(a.s)).json.data as Array<{ user: { id: string; name: string } }>;
  const ids = people.map((p) => p.user.id);
  expect(people.map((p) => p.user.name)).toEqual(expect.arrayContaining(['E2E staff']));
  // owner + the inbox.manage custom role + staff; the orders.view-only member is never offered
  expect(people).toHaveLength(3);
  const me = await api(as(none), 'GET', '/auth/me');
  const noneId = me.json.data?.id as string;
  expect(noneId, JSON.stringify(me.json).slice(0, 200)).toBeTruthy();
  expect(ids).not.toContain(noneId);
  const bad = await assignRaw(a.s, convA, noneId);
  expect([bad.status, bad.json.error?.code]).toEqual([422, 'inbox_assignee_invalid']);
  await signInDashboard(context, s);
  await page.goto(`${urls.merchant}/orders`);
  await expect(sidebar(page)).toBeVisible({ timeout: 20_000 });
  expect(await navLabels(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^Inbox/)]));
});

test('S234: another tenant’s store → 404 on every route; B’s conversation under A’s store → 404', async () => {
  const foreign = { ...a.s, storeId: b.s.storeId };
  for (const [what, p] of inboxRoutes(foreign, convB, a.s)) {
    const r = await p;
    expect([what, r.status]).toEqual([what, 404]);
  }
  for (const [what, p] of [
    ['thread', conversationRaw(a.s, convB)],
    ['messages', messagesRaw(a.s, convB)],
    ['send', sendRaw(a.s, convB, { kind: 'reply', body: 'x' })],
    ['assign', assignRaw(a.s, convB, null)],
    ['status', statusRaw(a.s, convB, 'closed')],
    ['delete', deleteRaw(a.s, convB)],
    ['attachment link (A’s from B)', attachmentLinkRaw(b.s, attachmentA)],
  ] as const) {
    const r = await p;
    expect([what, r.status]).toEqual([what, 404]);
  }
  // ids in bodies resolve within the store: B's attachment id / order id never attach to A.
  const placedB = await placeOrder(b, b.simple.variantId, 1, { body: { contact: { phone: randomPhone() } } });
  const orderIdB = placedB.order.id as string | undefined;
  if (orderIdB) expect((await linkOrderRaw(a.s, convA, orderIdB)).status).toBe(404);
  const foreignAtt = await sendRaw(a.s, convA, { kind: 'reply', body: 'with foreign file', attachment_ids: [attachmentA.replace(/.$/, '0')] });
  expect([404, 422]).toContain(foreignAtt.status);
});

test('storefront host isolation: A’s session, order token and attachment are 404 on B; draft store has no chat', async () => {
  const onB = await widgetSessionRaw(b.apiHost, chatA.session);
  expect([onB.status, onB.json.error?.code]).toEqual([404, 'inbox_session_invalid']);
  expect((await shopperMessagesRaw(b.apiHost, chatA.session)).status).toBe(404);
  expect((await shopperSendRaw(b.apiHost, chatA.session, 'cross host')).status).toBe(404);
  expect((await shopperAttachmentRaw(b.apiHost, chatA.session, attachmentA)).status).toBe(404);
  expect((await shopperAttachmentRaw(a.apiHost, chatA.session, attachmentA)).status).toBe(200);

  const phone = randomPhone();
  const placed = await placeOrder(a, a.simple.variantId, 1, { body: { contact: { phone } } });
  const access = await orderAccess(a.apiHost, placed.order.number as string, phone);
  expect((await orderSendRaw(a.apiHost, access, 'order message A')).status).toBe(201);
  const cross = await orderMessagesRaw(b.apiHost, access);
  expect([cross.status, cross.json.error?.code]).toEqual([404, 'order_access_invalid']);

  // Draft store (not published): config has no widget; chat start refused.
  const draft = await inboxShop('ibxdr', {}, 'starter');
  try {
    await setChannels(draft.s, { web_chat: true });
    if (!/^[0-9a-z]{26}$/i.test(draft.s.storeId)) throw new Error('bad id');
    tinker(`DB::table('stores')->where('id','${draft.s.storeId}')->update(['status'=>'draft']); Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';`);
    const cfg = await sfConfigRaw(draft.apiHost);
    expect(cfg.json.data?.inbox?.web_chat ?? null).toBeNull();
    const st = await startChatRaw(draft.apiHost, { message: 'draft?' });
    expect([404, 409]).toContain(st.status);
  } finally {
    cleanupInboxShop(draft);
  }
});

test('support session: inbox reads; composer disabled; writes 403 impersonation_read_only; attachment link hidden', async ({ browser }) => {
  test.setTimeout(150_000);
  reseedSuperAdmin();
  const admin: AdminSession = await adminLogin('admin-inbox-imp');
  const tenantId = (await findTenant(admin, a.t.email)).id as string;
  const r = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/impersonations`, { reason: REASON, ticket_ref: 'SP-8880' });
  expect(r.status, r.text).toBe(201);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto((r.json.data.url as string).replace(/^https?:\/\/[^/]+/, urls.merchant));
  await expect(page.getByRole('region', { name: 'Support session' })).toBeVisible({ timeout: 20_000 });
  await page.goto(`${urls.merchant}/inbox?c=${convA}`);
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(replyBox(page)).toBeDisabled();
  await expect(replyBox(page)).toHaveAttribute('placeholder', 'Read-only support session');
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await expect(page.getByText('Photos are hidden in a support session').first()).toBeVisible();

  const probe = await inPage(page, a.s.tenantId, [
    ['POST', `/stores/${a.s.storeId}/inbox/conversations/${convA}/messages`, { kind: 'reply', body: 'imp', client_id: crypto.randomUUID() }],
    ['POST', `/stores/${a.s.storeId}/inbox/conversations/${convA}/status`, { status: 'closed' }],
    ['GET', `/stores/${a.s.storeId}/inbox/attachments/${attachmentA}/link`, undefined],
  ]);
  expect(probe).toEqual([
    [403, 'impersonation_read_only'],
    [403, 'impersonation_read_only'],
    [403, 'impersonation_attachment_hidden'],
  ]);
  await context.close();
});

/** Calls the API from inside the (impersonated) SPA page: same cookies, X-Tenant-Id, XSRF header. */
async function inPage(page: Page, tenantId: string, calls: Array<[string, string, unknown]>): Promise<Array<[number, string | null]>> {
  return page.evaluate(
    async ([tid, list]) => {
      const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.slice(11) ?? '');
      const out: Array<[number, string | null]> = [];
      for (const [method, path, body] of list) {
        const res = await fetch(`/api/v1${path}`, {
          method,
          credentials: 'include',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Tenant-Id': tid, 'X-XSRF-TOKEN': xsrf },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        out.push([res.status, j.error?.code ?? null]);
      }
      return out;
    },
    [tenantId, calls] as const,
  );
}

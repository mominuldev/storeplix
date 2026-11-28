import { describe, expect, it, vi } from 'vitest';
import {
  INBOX_ATTACHMENT_MIMES, INBOX_CHANNELS, INBOX_LIMITS, INBOX_MERGE_TAGS, INBOX_SHORTCUT_PATTERN, PERMISSION_KEYS,
  SMS_PURPOSES, SMS_PURPOSE_LABELS, SYSTEM_ROLE_PERMISSIONS,
} from '@storeplix/types';
import { createApiClient, inboxConversationQuery, inboxMessagesQuery, inboxSavedReplyQuery, isApiError } from './index';

// PHASE-8-8E (§4–§13): inbox.*, storefront.inbox.*, storefront.orderMessages.*, conditional GETs.

function json(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => (typeof response === 'function' ? response() : response));
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => 'T1', csrf: false });
  const call = (i = 0) => {
    const init = fetchMock.mock.calls[i]![1]!;
    return {
      url: new URL(String(fetchMock.mock.calls[i]![0])),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers: init.headers as Record<string, string>,
    };
  };
  return { client, call };
}

const base = '/api/v1/stores/S1/inbox';

describe('PHASE-8-8E types, permission and queries', () => {
  it('inbox.manage sits after customers.delete and staff holds it', () => {
    expect(PERMISSION_KEYS.indexOf('inbox.manage')).toBe(PERMISSION_KEYS.indexOf('customers.delete') + 1);
    expect(SYSTEM_ROLE_PERMISSIONS.staff).toContain('inbox.manage');
    expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain('inbox.manage');
    expect(PERMISSION_KEYS.filter((k) => k !== 'billing.manage')).toHaveLength(29); // + support.manage (PHASE-8-9C)
  });

  it('SMS purposes gain the two inbox purposes with labels', () => {
    expect(SMS_PURPOSES).toEqual(expect.arrayContaining(['inbox_verify', 'inbox_reply']));
    expect(SMS_PURPOSE_LABELS.inbox_reply).toBe('Inbox reply');
  });

  it('constants: channels, attachments, shortcuts, merge tags', () => {
    expect(INBOX_CHANNELS).toEqual(['web_chat', 'order', 'email']);
    expect(INBOX_ATTACHMENT_MIMES).toEqual(['image/jpeg', 'image/png', 'application/pdf']);
    expect(INBOX_LIMITS.attachment_max_bytes).toBe(5 * 1024 * 1024);
    expect(INBOX_LIMITS.attachments_per_message).toBe(3);
    expect(INBOX_SHORTCUT_PATTERN.test('delivery')).toBe(true);
    expect(INBOX_SHORTCUT_PATTERN.test('size-chart_2')).toBe(true);
    expect(INBOX_SHORTCUT_PATTERN.test('D')).toBe(false);
    expect(INBOX_SHORTCUT_PATTERN.test('Delivery')).toBe(false);
    expect(INBOX_SHORTCUT_PATTERN.test('a b')).toBe(false);
    expect(INBOX_MERGE_TAGS).toContain('payment_link');
  });

  it('list, messages and saved-reply queries', () => {
    expect(inboxConversationQuery({ status: 'pending', scope: 'all', channel: ['web_chat', 'email'], q: ' 0171 ', cursor: 'c1' })).toEqual({
      'filter[status]': 'pending', 'filter[scope]': 'all', 'filter[channel]': 'web_chat,email', q: '0171', cursor: 'c1',
    });
    expect(inboxConversationQuery({})).toEqual({ 'filter[status]': undefined, 'filter[scope]': undefined, 'filter[channel]': undefined, q: undefined, cursor: undefined });
    expect(inboxMessagesQuery({ after: 'M9', before: 'M1' })).toEqual({ after: 'M9' });
    expect(inboxMessagesQuery({ before: 'M1' })).toEqual({ before: 'M1' });
    expect(inboxSavedReplyQuery({ q: ' size ', chip: true })).toEqual({ q: 'size', 'filter[chip]': 1, 'filter[attachment]': undefined });
  });
});

describe('PHASE-8-8E merchant api-client', () => {
  it('summary: sends If-None-Match and maps 304 to not_modified', async () => {
    const ok = setup(() => json(200, { data: { unread: 5 } }, { ETag: 'W/"ix1"' }));
    const first = await ok.client.inbox.summary('S1');
    expect(ok.call(0).url.pathname).toBe(`${base}/summary`);
    expect(ok.call(0).headers['If-None-Match']).toBeUndefined();
    expect(first).toEqual({ status: 'ok', data: { unread: 5 }, etag: 'W/"ix1"' });
    const nm = setup(() => new Response(null, { status: 304, headers: { ETag: 'W/"ix1"' } }));
    const second = await nm.client.inbox.summary('S1', { etag: 'W/"ix1"' });
    expect(nm.call(0).headers['If-None-Match']).toBe('W/"ix1"');
    expect(nm.call(0).headers['X-Tenant-Id']).toBe('T1');
    expect(second).toEqual({ status: 'not_modified', etag: 'W/"ix1"' });
  });

  it('conversations: filters, meta with counts, errors still throw', async () => {
    const { client, call } = setup(() => json(200, { data: [{ id: 'C1' }], meta: { next_cursor: 'n', prev_cursor: null, per_page: 30, counts: { open: 9, pending: 3, closed: 40 } } }));
    const r = await client.inbox.conversations('S1', { status: 'open', scope: 'mine_unassigned' });
    expect(call(0).url.pathname).toBe(`${base}/conversations`);
    expect(call(0).url.searchParams.get('filter[scope]')).toBe('mine_unassigned');
    expect(r.status === 'ok' && r.data.meta.counts.pending).toBe(3);
    const err = setup(() => json(403, { error: { code: 'forbidden', message: 'No.' } }));
    const e = await err.client.inbox.conversations('S1').catch((x: unknown) => x);
    expect(isApiError(e) && e.status).toBe(403);
  });

  it('thread: detail, messages after, send reply with client_id, read', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.inbox.conversation('S1', 'C1');
    expect(call(0).url.pathname).toBe(`${base}/conversations/C1`);
    await client.inbox.messages('S1', 'C1', { after: 'M5' });
    expect(call(1).url.pathname).toBe(`${base}/conversations/C1/messages`);
    expect(call(1).url.searchParams.get('after')).toBe('M5');
    await client.inbox.send('S1', 'C1', { kind: 'note', body: 'Packed XL', client_id: 'u-1' });
    expect(call(2)).toMatchObject({ method: 'POST', body: { kind: 'note', body: 'Packed XL', attachment_ids: [], client_id: 'u-1', saved_reply_id: null } });
    await client.inbox.markRead('S1', 'C1', { last_read_message_id: 'M6' });
    expect(call(3)).toMatchObject({ method: 'POST', body: { last_read_message_id: 'M6' } });
    expect(call(3).url.pathname).toBe(`${base}/conversations/C1/read`);
  });

  it('actions: assign, status, link order, block, delete, assignees', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.inbox.assign('S1', 'C1', { assignee_id: null });
    expect(call(0)).toMatchObject({ method: 'POST', body: { assignee_id: null } });
    expect(call(0).url.pathname).toBe(`${base}/conversations/C1/assign`);
    await client.inbox.setStatus('S1', 'C1', { status: 'closed', revision: 4 });
    expect(call(1)).toMatchObject({ method: 'POST', body: { status: 'closed', revision: 4 } });
    await client.inbox.linkOrder('S1', 'C1', { order_id: 'O1' });
    expect(call(2)).toMatchObject({ method: 'PUT', body: { order_id: 'O1' } });
    await client.inbox.block('S1', 'C1');
    expect(call(3).url.pathname).toBe(`${base}/conversations/C1/block`);
    await client.inbox.remove('S1', 'C1');
    expect(call(4)).toMatchObject({ method: 'DELETE' });
    await client.inbox.assignees('S1');
    expect(call(5).url.pathname).toBe(`${base}/assignees`);
  });

  it('saved replies and settings', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { counts: { all: 2, chips: 1, with_attachment: 0 } } }));
    const list = await client.inbox.savedReplies.list('S1', { chip: true });
    expect(list.meta.counts.all).toBe(2);
    expect(call(0).url.searchParams.get('filter[chip]')).toBe('1');
    await client.inbox.savedReplies.create('S1', { title: 'Delivery time', shortcut: 'delivery', body: 'Dhaka {delivery_inside}' });
    expect(call(1)).toMatchObject({ method: 'POST', body: { shortcut: 'delivery' } });
    await client.inbox.savedReplies.update('S1', 'R1', { revision: 2, show_as_chip: true });
    expect(call(2)).toMatchObject({ method: 'PATCH', body: { revision: 2, show_as_chip: true } });
    await client.inbox.savedReplies.reorder('S1', ['R2', 'R1']);
    expect(call(3)).toMatchObject({ method: 'POST', body: { ids: ['R2', 'R1'] } });
    await client.inbox.savedReplies.render('S1', 'C1', 'R1');
    expect(call(4).url.pathname).toBe(`${base}/conversations/C1/saved-replies/R1/render`);
    await client.inbox.settings.update('S1', { revision: 1, web_chat_enabled: true });
    expect(call(5)).toMatchObject({ method: 'PATCH', body: { revision: 1, web_chat_enabled: true } });
    await client.inbox.settings.rotateEmailAddress('S1');
    expect(call(6).url.pathname).toBe(`${base}/settings/email-address/rotate`);
    await client.inbox.attachmentLink('S1', 'A1');
    expect(call(7).url.pathname).toBe(`${base}/attachments/A1/link`);
  });
});

describe('PHASE-8-8E storefront api-client (server-to-server)', () => {
  it('widget: start is multipart with storefront headers and no tenant header', async () => {
    const { client, call } = setup(() => json(201, { data: { session_token: 'tok', status: 'code_sent', phone_masked: '017••••5678', resend_after: 60 } }));
    const r = await client.storefront.inbox.start('Demo.LocalHost:3010', 'key', {
      name: 'Farhana', phone: '01712345678', message: 'XL ache?', client_id: 'u-1', product_slug: 'linen-kurta',
      file: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), filename: 'receipt.pdf',
    }, { clientIp: '203.0.113.5' });
    expect(r.status).toBe('code_sent');
    const c = call(0);
    expect(c.url.pathname).toBe('/api/v1/storefront/inbox/sessions');
    expect(c.headers['X-Storefront-Host']).toBe('demo.localhost');
    expect(c.headers['X-Storefront-Client-Ip']).toBe('203.0.113.5');
    expect(c.headers['X-Tenant-Id']).toBeUndefined();
    const form = c.body as FormData;
    expect(form.get('product_slug')).toBe('linen-kurta');
    expect(form.get('website')).toBe('');
    expect((form.get('file') as File).name).toBe('receipt.pdf');
  });

  it('widget: verify, messages (conditional), send, seen carry X-Inbox-Session', async () => {
    const { client, call } = setup(() => json(200, { data: [] }, { ETag: 'W/"s1"' }));
    await client.storefront.inbox.verify('shop.test', 'key', 'tok', '123456');
    expect(call(0)).toMatchObject({ method: 'POST', body: { code: '123456' } });
    expect(call(0).headers['X-Inbox-Session']).toBe('tok');
    const m = await client.storefront.inbox.messages('shop.test', 'key', 'tok', { after: 'M1' }, { etag: 'W/"s0"' });
    expect(call(1).url.searchParams.get('after')).toBe('M1');
    expect(call(1).headers['If-None-Match']).toBe('W/"s0"');
    expect(m.status).toBe('ok');
    await client.storefront.inbox.send('shop.test', 'key', 'tok', { body: 'Thanks', client_id: 'u-2' });
    expect(call(2).headers['X-Inbox-Session']).toBe('tok');
    expect((call(2).body as FormData).get('body')).toBe('Thanks');
    await client.storefront.inbox.seen('shop.test', 'key', 'tok');
    expect(call(3).url.pathname).toBe('/api/v1/storefront/inbox/messages/seen');
  });

  it('code errors expose attempts_left; magic link and order messages', async () => {
    const err = setup(() => json(422, { error: { code: 'inbox_code_invalid', message: 'Wrong code.', details: { attempts_left: 2 } } }));
    const e = await err.client.storefront.inbox.verify('shop.test', 'key', 'tok', '000000').catch((x: unknown) => x);
    expect(isApiError(e) && e.code).toBe('inbox_code_invalid');
    const { client, call } = setup(() => json(200, { data: { kind: 'order', access_token: 'acc', number: 'GS-1046' } }));
    await client.storefront.inbox.redeemLink('shop.test', 'key', 'abc');
    expect(call(0)).toMatchObject({ method: 'POST' });
    expect(call(0).url.pathname).toBe('/api/v1/storefront/inbox/links/abc');
    await client.storefront.orderMessages.order('shop.test', 'key', 'acc');
    expect(call(1).url.pathname).toBe('/api/v1/storefront/orders/access');
    expect(call(1).headers['X-Order-Access']).toBe('acc');
    await client.storefront.orderMessages.list('shop.test', 'key', 'acc');
    expect(call(2).url.pathname).toBe('/api/v1/storefront/orders/messages');
  });
});

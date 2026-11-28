import { describe, expect, it, vi } from 'vitest';
import {
  HELP_AUDIT_ACTIONS, HELP_LIMITS, HELP_SLUG_PATTERN, PERMISSION_KEYS, SUPPORT_LIMITS, SUPPORT_MERCHANT_PRIORITIES,
  SUPPORT_TICKET_CATEGORIES, SUPPORT_TICKET_CATEGORY_LABELS, SUPPORT_TICKET_TAB_STATUSES, SYSTEM_ROLE_PERMISSIONS,
  supportTicketReference, type HelpArticleDoc, type PlatformPermission,
} from '@storeplix/types';
import { adminHelpArticleQuery, adminSupportQuery, createApiClient, helpSearchQuery, supportTicketQuery } from './index';

// PHASE-8-9C (§4–§11, §15): help.*, help.tickets.*, admin.help.*, admin.support.*.

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response), tenant: string | null = 'T1') {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => (typeof response === 'function' ? response() : response));
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => tenant, csrf: false });
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

describe('PHASE-8-9C constants and queries', () => {
  it('permission catalogue: support.manage after developers.manage, owner + admin, never staff', () => {
    expect(PERMISSION_KEYS.indexOf('support.manage')).toBe(PERMISSION_KEYS.indexOf('developers.manage') + 1);
    expect(PERMISSION_KEYS.filter((k) => k !== 'billing.manage')).toHaveLength(29);
    expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain('support.manage');
    expect(SYSTEM_ROLE_PERMISSIONS.staff).not.toContain('support.manage');
    const platform: PlatformPermission[] = ['manage_help_content', 'manage_support'];
    expect(platform).toHaveLength(2);
  });

  it('ticket constants', () => {
    expect(supportTicketReference(1001)).toBe('T-1001');
    expect(SUPPORT_MERCHANT_PRIORITIES).not.toContain('low');
    expect(SUPPORT_TICKET_CATEGORIES.every((c) => SUPPORT_TICKET_CATEGORY_LABELS[c].length > 0)).toBe(true);
    expect(SUPPORT_TICKET_TAB_STATUSES.open).toEqual(['open', 'awaiting_support']);
    expect(SUPPORT_TICKET_TAB_STATUSES.solved).toEqual(['resolved', 'closed']);
    expect(SUPPORT_LIMITS.attachmentBytes).toBe(10 * 1024 * 1024);
    expect(HELP_LIMITS.searchMin).toBe(2);
    expect(HELP_AUDIT_ACTIONS).toContain('help_article.published');
  });

  it('slug pattern', () => {
    expect(HELP_SLUG_PATTERN.test('connect-bkash')).toBe(true);
    expect(HELP_SLUG_PATTERN.test('Connect-bKash')).toBe(false);
    expect(HELP_SLUG_PATTERN.test('-bkash')).toBe(false);
    expect(HELP_SLUG_PATTERN.test('a--b')).toBe(false);
  });

  it('doc type accepts image and callout blocks', () => {
    const doc: HelpArticleDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Connect bKash' }] },
        { type: 'callout', attrs: { tone: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use a merchant account.' }] }] },
        { type: 'image', attrs: { media_id: 'HM1', alt: 'Payments page' } },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open Payments' }] }] }] },
      ],
    };
    expect(doc.content).toHaveLength(4);
  });

  it('merchant queries: language both is dropped, tab all is dropped, trimmed q', () => {
    expect(helpSearchQuery({ q: ' bkash ', language: 'both', category: 'payments', page: 2 })).toEqual({
      q: 'bkash', language: undefined, category: 'payments', page: 2, per_page: undefined,
    });
    expect(helpSearchQuery({ q: 'কুরিয়ার', language: 'bn' })).toMatchObject({ q: 'কুরিয়ার', language: 'bn' });
    expect(supportTicketQuery({ tab: 'all', q: ' T-1001 ' })).toEqual({ 'filter[tab]': undefined, 'filter[q]': 'T-1001', page: undefined, per_page: undefined });
    expect(supportTicketQuery({ tab: 'waiting_on_you' })).toMatchObject({ 'filter[tab]': 'waiting_on_you' });
  });

  it('admin queries: comma lists and tabs', () => {
    expect(adminHelpArticleQuery({ tab: 'missing_bn', q: ' courier ', sort: 'helpful' })).toMatchObject({
      'filter[tab]': 'missing_bn', 'filter[q]': 'courier', sort: 'helpful',
    });
    expect(adminHelpArticleQuery({ tab: 'all' })['filter[tab]']).toBeUndefined();
    expect(adminSupportQuery({ status: ['open', 'awaiting_support'], assignee: 'me', priority: ['urgent'], sort: 'waiting' })).toMatchObject({
      'filter[status]': 'open,awaiting_support', 'filter[assignee]': 'me', 'filter[priority]': 'urgent', sort: 'waiting',
    });
  });
});

describe('PHASE-8-9C merchant help api-client', () => {
  it('home, categories, category, article send language and the tenant header (no store)', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.help.home('bn');
    expect(call(0).url.pathname).toBe('/api/v1/help/home');
    expect(call(0).url.searchParams.get('language')).toBe('bn');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    await client.help.categories();
    expect(call(1).url.searchParams.get('language')).toBe('en');
    await client.help.category('payments', 'en');
    expect(call(2).url.pathname).toBe('/api/v1/help/categories/payments');
    await client.help.article('connect-bkash', 'bn');
    expect(call(3).url.pathname).toBe('/api/v1/help/articles/connect-bkash');
    expect(call(3).url.searchParams.get('language')).toBe('bn');
  });

  it('search returns rows + meta with a fallback meta', async () => {
    const { client, call } = setup(json(200, { data: [{ article_id: 'A1', slug: 's', snippet: 'x' }] }));
    const r = await client.help.search({ q: 'bkash', language: 'en' });
    expect(call(0).url.pathname).toBe('/api/v1/help/articles');
    expect(call(0).url.searchParams.get('q')).toBe('bkash');
    expect(r.data).toHaveLength(1);
    expect(r.meta).toMatchObject({ query: 'bkash', counts_by_category: [] });
  });

  it('vote drops reason and note on a helpful vote; unvote is DELETE', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.help.vote('connect-bkash', { helpful: true, language: 'en', reason: 'out_of_date', note: 'x' });
    expect(call(0)).toMatchObject({ method: 'PUT', body: { helpful: true, language: 'en', reason: null, note: null } });
    expect(call(0).url.pathname).toBe('/api/v1/help/articles/connect-bkash/feedback');
    await client.help.vote('connect-bkash', { helpful: false, language: 'bn', reason: 'hard_to_follow', note: 'Step 3?' });
    expect(call(1).body).toEqual({ helpful: false, language: 'bn', reason: 'hard_to_follow', note: 'Step 3?' });
    const del = setup(new Response(null, { status: 204 }));
    await del.client.help.unvote('connect-bkash');
    expect(del.call(0).method).toBe('DELETE');
  });

  it('tickets: list meta fallback, create defaults, reply, resolve, rate', async () => {
    const list = setup(json(200, { data: [] }));
    const page = await list.client.help.tickets.list({ tab: 'open' });
    expect(list.call(0).url.pathname).toBe('/api/v1/help/tickets');
    expect(list.call(0).url.searchParams.get('filter[tab]')).toBe('open');
    expect(page.meta.counts).toEqual({ all: 0, open: 0, waiting_on_you: 0, solved: 0 });

    const { client, call } = setup(() => json(201, { data: { id: 'TK1' } }));
    await client.help.tickets.create({ category: 'shipping_couriers', subject: 'Pathao booking fails', description: 'Booking returns an error for every order.', client_id: 'c-1' });
    expect(call(0)).toMatchObject({
      method: 'POST',
      body: { category: 'shipping_couriers', priority: 'normal', order_id: null, attachment_ids: [], client_id: 'c-1' },
    });
    await client.help.tickets.get('TK1');
    expect(call(1).url.pathname).toBe('/api/v1/help/tickets/TK1');
    await client.help.tickets.messages('TK1');
    expect(call(2).url.pathname).toBe('/api/v1/help/tickets/TK1/messages');
    await client.help.tickets.reply('TK1', { body: 'Still failing', client_id: 'c-2' });
    expect(call(3)).toMatchObject({ method: 'POST', body: { body: 'Still failing', attachment_ids: [], client_id: 'c-2' } });
    await client.help.tickets.resolve('TK1');
    expect(call(4).url.pathname).toBe('/api/v1/help/tickets/TK1/resolve');
    await client.help.tickets.rate('TK1', { rating: 5 });
    expect(call(5)).toMatchObject({ method: 'PUT', body: { rating: 5, comment: null } });
    expect(call(5).url.pathname).toBe('/api/v1/help/tickets/TK1/rating');
  });

  it('attachments: multipart upload with the tenant header, signed link', async () => {
    const { client, call } = setup(() => json(201, { data: { id: 'SA1', status: 'ready' } }));
    await client.help.uploadAttachment({ file: new Blob(['%PDF-1.7']), filename: 'invoice.pdf' });
    expect(call(0).url.pathname).toBe('/api/v1/help/attachments');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    expect(((call(0).body as FormData).get('file') as File).name).toBe('invoice.pdf');
    await client.help.attachmentLink('SA1');
    expect(call(1).url.pathname).toBe('/api/v1/help/attachments/SA1/link');
  });
});

describe('PHASE-8-9C super-admin api-client', () => {
  it('help articles: list fallback meta, create, update PATCH, publish/schedule, lifecycle, feedback; no tenant header', async () => {
    const list = setup(json(200, { data: [] }));
    const page = await list.client.admin.help.articles.list({ tab: 'draft' });
    expect(list.call(0).url.pathname).toBe('/api/v1/admin/help-articles');
    expect(list.call(0).headers['X-Tenant-Id']).toBeUndefined();
    expect(page.meta.counts.missing_bn).toBe(0);

    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.help.articles.create({ slug: 'connect-bkash', category_id: 'C1', title_en: 'Connect bKash' });
    expect(call(0)).toMatchObject({ method: 'POST', body: { slug: 'connect-bkash', category_id: 'C1', title_en: 'Connect bKash' } });
    await client.admin.help.articles.update('A1', { revision: 3, translations: { bn: null } });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { revision: 3, translations: { bn: null } } });
    expect(call(1).url.pathname).toBe('/api/v1/admin/help-articles/A1');
    await client.admin.help.articles.publish('A1', { revision: 4 });
    expect(call(2)).toMatchObject({ method: 'POST', body: { revision: 4, scheduled_at: null } });
    await client.admin.help.articles.publish('A1', { revision: 4, scheduled_at: '2026-12-01T04:00:00Z' });
    expect(call(3).body).toEqual({ revision: 4, scheduled_at: '2026-12-01T04:00:00Z' });
    await client.admin.help.articles.unpublish('A1');
    expect(call(4).url.pathname).toBe('/api/v1/admin/help-articles/A1/unpublish');
    await client.admin.help.articles.archive('A1');
    expect(call(5).body).toEqual({ reason: null });
    await client.admin.help.articles.restore('A1');
    expect(call(6).url.pathname).toBe('/api/v1/admin/help-articles/A1/restore');
    await client.admin.help.articles.feedback('A1', { helpful: false });
    expect(call(7).url.searchParams.get('filter[helpful]')).toBe('0');
    for (let i = 0; i <= 7; i++) expect(call(i).headers['X-Tenant-Id']).toBeUndefined();
  });

  it('categories and help media upload without X-Tenant-Id', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.help.categories.create({ slug: 'payments', name_en: 'Payments', icon: 'card' });
    expect(call(0).url.pathname).toBe('/api/v1/admin/help-categories');
    await client.admin.help.categories.update('C1', { revision: 2, name_bn: 'পেমেন্ট' });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { revision: 2, name_bn: 'পেমেন্ট' } });
    await client.admin.help.categories.reorder(['C2', 'C1']);
    expect(call(2)).toMatchObject({ method: 'POST', body: { ids: ['C2', 'C1'] } });
    await client.admin.help.uploadMedia({ file: new Blob(['png']), filename: 'step-1.png', alt: 'Payments page' });
    expect(call(3).url.pathname).toBe('/api/v1/admin/help-media');
    expect(call(3).headers['X-Tenant-Id']).toBeUndefined();
    expect((call(3).body as FormData).get('alt')).toBe('Payments page');
  });

  it('support queue: list, reply defaults, note has no status, assign, status, update, uploads', async () => {
    const list = setup(json(200, { data: [] }));
    const page = await list.client.admin.support.list({ assignee: 'unassigned' });
    expect(list.call(0).url.pathname).toBe('/api/v1/admin/support/tickets');
    expect(list.call(0).url.searchParams.get('filter[assignee]')).toBe('unassigned');
    expect(page.meta.counts.awaiting_support).toBe(0);

    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.support.reply('TK1', { kind: 'reply', body: 'Fixed, please retry.', client_id: 'c-1' });
    expect(call(0)).toMatchObject({ method: 'POST', body: { kind: 'reply', status: 'awaiting_merchant', attachment_ids: [] } });
    expect(call(0).url.pathname).toBe('/api/v1/admin/support/tickets/TK1/messages');
    await client.admin.support.reply('TK1', { kind: 'note', body: 'Pathao API outage', client_id: 'c-2', status: 'resolved' });
    expect(call(1).body).toMatchObject({ kind: 'note', status: null });
    await client.admin.support.assign('TK1', { assignee_id: null });
    expect(call(2)).toMatchObject({ method: 'POST', body: { assignee_id: null } });
    await client.admin.support.setStatus('TK1', { status: 'resolved', revision: 5 });
    expect(call(3).url.pathname).toBe('/api/v1/admin/support/tickets/TK1/status');
    await client.admin.support.update('TK1', { priority: 'low', revision: 6 });
    expect(call(4)).toMatchObject({ method: 'PATCH', body: { priority: 'low', revision: 6 } });
    await client.admin.support.uploadAttachment('TK1', { file: new Blob(['%PDF']), filename: 'steps.pdf' });
    expect(call(5).url.pathname).toBe('/api/v1/admin/support/tickets/TK1/attachments');
    expect(call(5).headers['X-Tenant-Id']).toBeUndefined();
    await client.admin.support.assignees();
    expect(call(6).url.pathname).toBe('/api/v1/admin/support/assignees');
  });

  it('attachment stream as a blob', async () => {
    const { client, call } = setup(new Response('%PDF', { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="steps.pdf"' } }), null);
    const file = await client.admin.support.downloadAttachment('TK1', 'SA1');
    expect(call(0).url.pathname).toBe('/api/v1/admin/support/tickets/TK1/attachments/SA1');
    expect(file.filename).toBe('steps.pdf');
  });
});

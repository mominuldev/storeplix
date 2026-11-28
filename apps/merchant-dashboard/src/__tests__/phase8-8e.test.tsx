import { ApiError } from '@storeplix/api-client';
import { focusManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { inboxErrorText } from '../inbox/errors';
import {
  attachmentProblem,
  canUseInbox,
  durationLabel,
  inboxSearch,
  lastCustomerMessageId,
  listFilters,
  matchSavedReplies,
  mergeMessages,
  moveId,
  parseInboxUrl,
  remainingTags,
  replaceRange,
  replyStatus,
  riskSummary,
  rowPreview,
  seenByShopper,
  shortTime,
  shouldMarkRead,
  slashQuery,
  systemText,
  threadSubline,
  unknownTags,
} from '../inbox/inbox';
import { resolveConditional } from '../inbox/queries';
import { savedReplySchema } from '../inbox/SavedRepliesPage';
import { visibleNav } from '../layout/nav';
import { session } from '../lib/session';
import { callsTo, jsonResponse, mockApi, okHealth, renderApp, signedIn, store, tenantA, user } from '../test/utils';
import { assignees, conversation, listMeta, message, row, rows, savedReplies, savedReply, settings, summary, thread } from './phase8-8e.fixtures';

// PHASE-8-8E §16 Web: helpers; nav + badge gating; list (chips, scope, channel, search, unread, ETag); thread
// (system rows, notes, polling with `after`, read marking, failed send retry with the same client_id); composer
// (Reply / Internal note, `/` search, unresolved tags block Send, attachments with progress); assign popover; close +
// Undo, reopen; side panel permission variants; delete; saved replies CRUD; channels drawer; first-run, all caught up,
// loading, error; read-only support session.

vi.setConfig({ testTimeout: 20_000 });
const SLOW = { timeout: 5000 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

type Call = [string, RequestInit];
const bodyOf = (call: Call) => JSON.parse(String(call[1].body));
const header = (call: Call, name: string) => new Headers(call[1].headers).get(name);
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const params = (call: Call) => new URL(String(call[0]), 'http://localhost').searchParams;

/** 200 with an ETag; 304 when the request carries the same `If-None-Match`. */
function etagged(body: unknown, etag: string) {
  return (init: RequestInit) => {
    if (new Headers(init.headers).get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag } });
  };
}

function inboxRoutes(extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /stores/S1/inbox/summary': etagged({ data: summary() }, 'W/"ix1"'),
    'GET /stores/S1/inbox/conversations': etagged({ data: rows(), meta: listMeta() }, 'W/"ixl1"'),
    'GET /stores/S1/inbox/conversations/C1': jsonResponse(200, { data: conversation() }),
    'GET /stores/S1/inbox/conversations/C1/messages': etagged({ data: thread() }, 'W/"ixm1"'),
    'POST /stores/S1/inbox/conversations/C1/read': new Response(null, { status: 204 }),
    'GET /stores/S1/inbox/saved-replies': jsonResponse(200, { data: savedReplies(), meta: { counts: { all: 2, chips: 1, with_attachment: 0 } } }),
    'GET /stores/S1/inbox/assignees': jsonResponse(200, { data: assignees() }),
    'GET /stores/S1/inbox/settings': jsonResponse(200, { data: settings() }),
    ...extra,
  };
}

/** Refetch every stale query the way a window focus does (the polling paths). */
async function refocus() {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

/** Uploads go through XHR (progress): a fake that answers right after `send`. */
function stubXhr(status: number, body: unknown) {
  const sent: { url: string; body: FormData }[] = [];
  class FakeXhr {
    status = 0;
    statusText = '';
    responseText = '';
    url = '';
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    getResponseHeader() {
      return 'application/json';
    }
    getAllResponseHeaders() {
      return 'content-type: application/json';
    }
    send(form: FormData) {
      sent.push({ url: this.url, body: form });
      setTimeout(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
      }, 0);
    }
    abort() {}
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return sent;
}

describe('PHASE-8-8E helpers', () => {
  it('URL state round-trips with defaults left out; q reaches the API from 2 characters', () => {
    const s = parseInboxUrl(new URLSearchParams('c=C1&status=pending&scope=all&channel=email&q=ra'));
    expect(s).toEqual({ conversation: 'C1', status: 'pending', scope: 'all', channel: 'email', q: 'ra' });
    expect(inboxSearch(s).toString()).toBe('c=C1&status=pending&scope=all&channel=email&q=ra');
    expect(parseInboxUrl(new URLSearchParams('status=nope&scope=x&channel=sms'))).toMatchObject({ status: 'open', scope: 'mine_unassigned', channel: null });
    expect(inboxSearch(parseInboxUrl(new URLSearchParams(''))).toString()).toBe('');
    expect(listFilters({ status: 'open', scope: 'mine', channel: 'web_chat', q: ' r ' })).toEqual({ status: 'open', scope: 'mine', channel: ['web_chat'], q: undefined });
    expect(listFilters({ status: 'open', scope: 'mine', channel: null, q: ' 0171 ' }).q).toBe('0171');
  });

  it('labels: times, durations, rows, thread subline, system rows, reply status, risk', () => {
    const now = Date.parse('2026-11-28T12:00:00Z');
    expect(shortTime('2026-11-28T11:59:40Z', now)).toBe('now');
    expect(shortTime('2026-11-28T11:54:00Z', now)).toBe('6 min');
    expect(shortTime('2026-11-28T09:00:00Z', now)).toBe('3 h');
    expect(shortTime('2026-10-12T09:00:00Z', now)).toBe('12 Oct');
    expect(durationLabel(120)).toBe('2 min');
    expect(durationLabel(3900)).toBe('1 h 5 min');
    expect(durationLabel(null)).toBe('—');
    expect(rowPreview(row({ assignee: null }))).toEqual({ text: 'Ei linen kurta ta XL e ache?', who: 'Unassigned' });
    expect(rowPreview(row())).toMatchObject({ who: 'Rahim' });
    expect(threadSubline(conversation())).toBe('Website chat · from the Linen Kurta page');
    expect(threadSubline(conversation({ channel: 'order', order: { id: 'O1', number: 'GS-1046' } }))).toBe('Order message · GS-1046');
    expect(threadSubline(conversation({ channel: 'email', subject: 'Re: GS-1038' }))).toBe('Email · Re: GS-1038');
    const sys = (event: 'assigned' | 'closed' | 'reopened' | 'unassigned', actor: { id: string; name: string } | null, assignee: { id: string; name: string } | null = null) =>
      systemText({ system: { event, actor, assignee, order_number: null } }, 'U1');
    expect(sys('assigned', { id: 'U1', name: 'Rahim Ahmed' }, { id: 'U1', name: 'Rahim Ahmed' })).toBe('You assigned this to yourself');
    expect(sys('assigned', { id: 'U2', name: 'Sumon Das' }, { id: 'U1', name: 'Rahim Ahmed' })).toBe('Sumon assigned this to Rahim');
    expect(sys('closed', { id: 'U2', name: 'Sumon Das' })).toBe('Sumon closed this conversation');
    expect(sys('reopened', null)).toBe('Reopened — the customer wrote again');
    expect(sys('unassigned', { id: 'U1', name: 'R' })).toBe('You moved this back to the shared queue');
    expect(replyStatus(message({ kind: 'reply', delivery_status: 'failed' }))).toEqual({ text: 'Not delivered', danger: true });
    expect(replyStatus(message({ kind: 'reply', seen: true }))?.text).toBe('Seen');
    expect(replyStatus(message({ kind: 'note' }))).toBeNull();
    // WEB-3: a reply fetched before the shopper saw it turns Seen from the conversation's customer_seen_at.
    const r = message({ kind: 'reply', seen: false, created_at: '2026-11-20T10:00:00Z' });
    expect(seenByShopper(r, '2026-11-20T10:00:05Z').seen).toBe(true);
    expect(seenByShopper(r, '2026-11-20T09:59:00Z').seen).toBe(false);
    expect(seenByShopper(r, null)).toBe(r);
    expect(seenByShopper(message({ kind: 'customer', seen: false, created_at: '2026-11-20T10:00:00Z' }), '2026-11-21T00:00:00Z').seen).toBe(false);
    expect(riskSummary({ tier: 'good', rate: 1, delivered: 3, total: 3 })).toEqual({ text: 'Good buyer — 3 of 3 delivered with you.', tone: 'success' });
    expect(riskSummary({ tier: 'new', rate: null, delivered: 0, total: 0 })?.tone).toBe('neutral');
    expect(riskSummary(null)).toBeNull();
  });

  it('polling merge, read marking, conditional cache', () => {
    const [a, b, c] = thread();
    expect(mergeMessages([a!, c!], [b!, c!]).map((m) => m.id)).toEqual([a!.id, b!.id, c!.id]);
    const same = [a!];
    expect(mergeMessages(same, [])).toBe(same);
    expect(lastCustomerMessageId(thread())).toBe('01JM0000000000000000000004');
    expect(lastCustomerMessageId([])).toBeNull();
    expect(shouldMarkRead('01B', '01A')).toBe(true);
    expect(shouldMarkRead('01A', '01A')).toBe(false);
    expect(shouldMarkRead('01A', '01B')).toBe(false);
    expect(shouldMarkRead(null, undefined)).toBe(false);
    const prev = { data: summary(), etag: 'W/"1"' };
    expect(resolveConditional(prev, { status: 'not_modified', etag: 'W/"1"' })).toBe(prev);
    expect(resolveConditional(prev, { status: 'ok', data: summary({ unread: 9 }), etag: 'W/"2"' })).toEqual({ data: summary({ unread: 9 }), etag: 'W/"2"' });
    expect(() => resolveConditional(undefined, { status: 'not_modified', etag: 'x' })).toThrow();
  });

  it('attachments, `/` trigger, merge tags, reorder', () => {
    expect(attachmentProblem({ type: 'image/png', size: 100 })).toBeNull();
    expect(attachmentProblem({ type: 'image/gif', size: 100 })).toMatch(/JPG, PNG or PDF/);
    expect(attachmentProblem({ type: 'application/pdf', size: 6 * 1024 * 1024 })).toMatch(/5 MB/);
    expect(attachmentProblem({ type: 'application/pdf', size: 1 }, 3)).toMatch(/Up to 3/);
    expect(slashQuery('/del', 4)).toEqual({ query: 'del', start: 0 });
    expect(slashQuery('Hi /pa', 6)).toEqual({ query: 'pa', start: 3 });
    expect(slashQuery('a/b', 3)).toBeNull();
    expect(slashQuery('Hi there', 8)).toBeNull();
    expect(replaceRange('Hi /pa!', 3, 6, 'PAY')).toEqual({ text: 'Hi PAY!', caret: 6 });
    expect(matchSavedReplies(savedReplies(), 'pay').map((r) => r.id)).toEqual(['R2']);
    expect(matchSavedReplies(savedReplies(), 'charge').map((r) => r.id)).toEqual(['R1']);
    expect(matchSavedReplies(savedReplies(), '').length).toBe(2);
    expect(remainingTags('Pay at {payment_link}', ['payment_link', 'order_total'])).toEqual(['payment_link']);
    expect(unknownTags('Hi {customer_name}, {order_id} {tracking_link}')).toEqual(['order_id', 'tracking_link']);
    expect(moveId(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('saved-reply schema, error copy, permission', () => {
    const ok = savedReplySchema.safeParse({ title: 'Delivery charge', shortcut: '/Delivery', body: 'Inside {delivery_inside}' });
    expect(ok.success && ok.data.shortcut).toBe('delivery');
    expect(savedReplySchema.safeParse({ title: 'x', shortcut: '/a', body: 'x' }).success).toBe(false);
    expect(savedReplySchema.safeParse({ title: 'x', shortcut: '/ok', body: 'Hi {name}' }).success).toBe(false);
    expect(savedReplySchema.safeParse({ title: '', shortcut: '/ok', body: 'x' }).success).toBe(false);
    expect(inboxErrorText(new ApiError(403, 'impersonation_read_only', 'x'))).toBe('Read-only support session. Changes are disabled.');
    expect(inboxErrorText(new ApiError(422, 'saved_reply_unknown_merge_tag', 'x', { tags: ['order_id'] }))).toMatch(/\{order_id\} isn’t a merge tag/);
    expect(inboxErrorText(new ApiError(422, 'inbox_assignee_invalid', 'x'))).toMatch(/Pick someone else/);
    expect(canUseInbox({ role: 'staff' })).toBe(true);
    expect(canUseInbox({ role: 'custom', permissions: ['orders.view'] })).toBe(false);
    expect(visibleNav({ role: 'custom', permissions: ['orders.view'] }).some((n) => n.to === '/inbox')).toBe(false);
    expect(visibleNav({ role: 'staff' }).some((n) => n.to === '/inbox')).toBe(true);
  });
});

describe('PHASE-8-8E nav and gating', () => {
  it('sidebar shows Inbox with the unread badge from the summary', async () => {
    signedIn('staff', inboxRoutes());
    renderApp(<AppRoutes />, { route: '/' });
    const nav = await screen.findByRole('complementary', { name: 'Main navigation' }, SLOW);
    expect(await within(nav).findByLabelText('3 unread', undefined, SLOW)).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Inbox/ })).toHaveAttribute('href', '/inbox');
  });

  it('custom role without inbox.manage: no nav item, no summary poll, /inbox shows no access', async () => {
    const fetchMock = signedIn({ role: 'custom', permissions: ['orders.view'] }, inboxRoutes());
    renderApp(<AppRoutes />, { route: '/inbox' });
    expect(await screen.findByText('You don’t have access to this page', undefined, SLOW)).toBeInTheDocument();
    const nav = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(within(nav).queryByRole('link', { name: /Inbox/ })).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/stores/S1/inbox/summary')).toHaveLength(0);
  });
});

describe('PHASE-8-8E conversation list', () => {
  it('rows, chip counts, unread badges; filters reach the API; summary re-polls with If-None-Match', async () => {
    const fetchMock = signedIn('owner', inboxRoutes());
    renderApp(<AppRoutes />, { route: '/inbox' });
    const list = await screen.findByRole('list', { name: 'Conversation list' }, SLOW);
    expect(within(list).getByText('Farhana Yasmin')).toBeInTheDocument();
    expect(within(list).getByText('Rubel Hossain · GS-1042')).toBeInTheDocument();
    expect(within(list).getByText('Unassigned')).toBeInTheDocument();
    expect(within(list).getAllByText('unread')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Open · 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pending · 1' })).toBeInTheDocument();
    expect(screen.getByText('Select a conversation')).toBeInTheDocument();
    expect(params(callsTo(fetchMock, '/stores/S1/inbox/conversations')[0]!).get('filter[status]')).toBe('open');

    await userEvent.click(screen.getByRole('button', { name: 'Pending · 1' }));
    await waitFor(() => expect(params(callsTo(fetchMock, '/stores/S1/inbox/conversations').at(-1)!).get('filter[status]')).toBe('pending'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Channel' }), { target: { value: 'email' } });
    await waitFor(() => expect(params(callsTo(fetchMock, '/stores/S1/inbox/conversations').at(-1)!).get('filter[channel]')).toBe('email'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Assignee' }), { target: { value: 'unassigned' } });
    await waitFor(() => expect(params(callsTo(fetchMock, '/stores/S1/inbox/conversations').at(-1)!).get('filter[scope]')).toBe('unassigned'));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'rubel');
    await waitFor(() => expect(params(callsTo(fetchMock, '/stores/S1/inbox/conversations').at(-1)!).get('q')).toBe('rubel'));

    const before = callsTo(fetchMock, '/stores/S1/inbox/summary').length;
    await refocus();
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/inbox/summary').length).toBeGreaterThan(before));
    expect(header(callsTo(fetchMock, '/stores/S1/inbox/summary').at(-1)!, 'If-None-Match')).toBe('W/"ix1"');
  });

  it('loading skeleton, then error with Try again', async () => {
    let fail = true;
    signedIn('owner', inboxRoutes({ 'GET /stores/S1/inbox/conversations': () => (fail ? jsonResponse(500, { error: { code: 'server_error', message: 'x' } }) : jsonResponse(200, { data: rows(), meta: listMeta() })) }));
    renderApp(<AppRoutes />, { route: '/inbox' });
    expect(await screen.findByText('Couldn’t load conversations', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Messages open here once the list loads.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Conversation list' }, SLOW)).toBeInTheDocument();
  });

  it('all caught up: nothing open, pending count + View pending', async () => {
    signedIn('owner', inboxRoutes({ 'GET /stores/S1/inbox/conversations': jsonResponse(200, { data: [], meta: listMeta({ counts: { open: 0, pending: 3, closed: 2 } }) }) }));
    renderApp(<AppRoutes />, { route: '/inbox' });
    expect(await screen.findByText('All caught up', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText(/3 are pending — waiting on the customer/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View pending' }));
    expect(screen.getByRole('button', { name: 'Pending · 3' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('first run: no conversations at all → channel cards with Off + Turn on (settings.manage)', async () => {
    const fetchMock = signedIn(
      'owner',
      inboxRoutes({
        'GET /stores/S1/inbox/summary': jsonResponse(200, { data: summary({ unread: 0, open: 0, pending: 0 }) }),
        'GET /stores/S1/inbox/conversations': jsonResponse(200, { data: [], meta: listMeta({ counts: { open: 0, pending: 0, closed: 0 } }) }),
        'PATCH /stores/S1/inbox/settings': (init) => jsonResponse(200, { data: settings({ revision: 6, channels: { ...settings().channels, order_messages: { enabled: !!bodyOf(['', init]).order_messages_enabled } } }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox' });
    expect(await screen.findByText('No conversations yet', undefined, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('Live on mugdho.storeplix.com', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Preview on your shop' })).toHaveAttribute('href', 'https://mugdho.storeplix.com');
    expect(screen.getByText('Forwarding: shop-abc123@in.storeplix.com')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/settings', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/settings', 'PATCH')[0]!)).toEqual({ order_messages_enabled: true, revision: 5 });
  });
});

describe('PHASE-8-8E thread', () => {
  it('renders the thread (context card, system row, note, PDF) and side panel; marks read; polls with after + ETag', async () => {
    const fetchMock = signedIn('owner', inboxRoutes());
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    const messages = await screen.findByLabelText('Messages', undefined, SLOW);
    expect(await within(messages).findByText('Assalamu alaikum. XL ache?', undefined, SLOW)).toBeInTheDocument();
    expect(within(messages).getByText('Linen Kurta')).toBeInTheDocument();
    expect(within(messages).getByText(/You assigned this to Sumon/)).toBeInTheDocument();
    expect(within(messages).getByText('Internal note · only your team sees this')).toBeInTheDocument();
    expect(within(messages).getByText('bkash-receipt.pdf')).toBeInTheDocument();
    expect(within(messages).getByText(/Texted/)).toBeInTheDocument();
    expect(screen.getByText('Website chat · from the Linen Kurta page')).toBeInTheDocument();

    const panel = screen.getByRole('complementary', { name: 'Customer' });
    expect(within(panel).getByText('Customer since Mar 2026 · 4 orders')).toBeInTheDocument();
    expect(within(panel).getByText('01712-345678')).toBeInTheDocument();
    expect(within(panel).getByText('Good buyer — 3 of 3 delivered with you.')).toBeInTheDocument();
    expect(within(panel).getByText('GS-1046')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'GS-1031' })).toHaveAttribute('href', '/orders/O3');
    expect(within(panel).getByText('Verified phone')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'View customer' })).toHaveAttribute('href', '/customers/CU1');

    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/read', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/read', 'POST')[0]!)).toEqual({ last_read_message_id: '01JM0000000000000000000004' });
    expect(params(callsTo(fetchMock, '/stores/S1/inbox/conversations/C1/messages')[0]!).get('after')).toBeNull();

    await refocus();
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/inbox/conversations/C1/messages').length).toBeGreaterThan(1));
    const poll = callsTo(fetchMock, '/stores/S1/inbox/conversations/C1/messages').at(-1)!;
    expect(params(poll).get('after')).toBe('01JM0000000000000000000005');
    expect(header(poll, 'If-None-Match')).toBe('W/"ixm1"');
  });

  it('a poll appends new rows', async () => {
    let n = 0;
    signedIn(
      'owner',
      inboxRoutes({
        'GET /stores/S1/inbox/conversations/C1/messages': () => {
          n++;
          const data = n === 1 ? thread() : [message({ id: '01JM0000000000000000000009', body: 'Dhanmondi te kobe pabo?' })];
          return jsonResponse(200, { data });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    expect(await screen.findByText('Assalamu alaikum. XL ache?', undefined, SLOW)).toBeInTheDocument();
    await refocus();
    expect(await screen.findByText('Dhanmondi te kobe pabo?', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Assalamu alaikum. XL ache?')).toBeInTheDocument();
  });

  it('reply and internal note; a failed send retries with the same client_id', async () => {
    let fail = true;
    const fetchMock = signedIn(
      'owner',
      inboxRoutes({
        'POST /stores/S1/inbox/conversations/C1/messages': (init) => {
          const b = JSON.parse(String(init.body));
          if (fail && b.kind === 'reply') return jsonResponse(500, { error: { code: 'server_error', message: 'x' } });
          return jsonResponse(201, { data: message({ id: `01JM00000000000000000000${b.kind === 'note' ? 'N1' : 'R1'}`, kind: b.kind, body: b.body, author: { id: 'U1', name: 'Rahim Ahmed' } }) });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    const box = await screen.findByRole('textbox', { name: 'Reply' }, SLOW);
    await userEvent.type(box, 'Kal pouche jabe{Enter}');
    expect(await screen.findByRole('button', { name: 'Not sent · Tap to retry' }, SLOW)).toBeInTheDocument();
    const first = bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/messages', 'POST')[0]!);
    expect(first).toMatchObject({ kind: 'reply', body: 'Kal pouche jabe', attachment_ids: [], saved_reply_id: null });
    expect(first.client_id).toMatch(/^[0-9a-f-]{36}$/);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Not sent · Tap to retry' }));
    expect(await screen.findByText('Kal pouche jabe', undefined, SLOW)).toBeInTheDocument();
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/messages', 'POST')[1]!).client_id).toBe(first.client_id);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not sent · Tap to retry' })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(screen.getByText('Only your team sees this')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Internal note' }), 'Pack XL{Enter}');
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/messages', 'POST')).toHaveLength(3));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/messages', 'POST')[2]!)).toMatchObject({ kind: 'note', body: 'Pack XL' });
  });

  it('`/` inserts a server-rendered saved reply; unresolved tags block Send until edited', async () => {
    const fetchMock = signedIn(
      'owner',
      inboxRoutes({
        'POST /stores/S1/inbox/conversations/C1/saved-replies/R2/render': jsonResponse(200, { data: { body: 'Advance din ei link e: {payment_link}', attachment: null, unresolved: ['payment_link'] } }),
        'POST /stores/S1/inbox/conversations/C1/messages': (init) => jsonResponse(201, { data: message({ id: '01JM0000000000000000000010', kind: 'reply', body: JSON.parse(String(init.body)).body }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    const box = await screen.findByRole('textbox', { name: 'Reply' }, SLOW);
    await userEvent.type(box, '/pa');
    const options = await screen.findByRole('listbox', { name: 'Saved replies' }, SLOW);
    expect(within(options).getByText('Send payment link')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(box).toHaveValue('Advance din ei link e: {payment_link}'));
    expect(screen.getByRole('alert')).toHaveTextContent('Replace {payment_link} before sending');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, 'Advance din: https://pay.example/x');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/messages', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/messages', 'POST')[0]!)).toMatchObject({ saved_reply_id: 'R2' });
    // chip above the reply box
    expect(screen.getByRole('button', { name: 'Delivery charge' })).toBeInTheDocument();
  });

  it('attachments upload with progress and go out as attachment_ids; bad types are refused', async () => {
    const sent = stubXhr(201, { data: { id: 'A9', filename: 'photo.png', mime: 'image/png', size_bytes: 1000, kind: 'image', status: 'processing' } });
    const fetchMock = signedIn('owner', inboxRoutes({ 'POST /stores/S1/inbox/conversations/C1/messages': jsonResponse(201, { data: message({ id: '01JM0000000000000000000011', kind: 'reply', body: null }) }) }));
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    await screen.findByRole('textbox', { name: 'Reply' }, SLOW);
    const input = screen.getByTestId('composer-file');
    await userEvent.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }), { applyAccept: false });
    expect(await screen.findByText('notes.txt: Only JPG, PNG or PDF files.', undefined, SLOW)).toBeInTheDocument();
    await userEvent.upload(input, new File(['png'], 'photo.png', { type: 'image/png' }));
    const chips = await screen.findByRole('list', { name: 'Attachments' }, SLOW);
    await waitFor(() => expect(within(chips).queryByLabelText(/Uploading/)).not.toBeInTheDocument());
    expect(sent[0]!.url).toContain('/stores/S1/inbox/attachments');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/messages', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/messages', 'POST')[0]!)).toMatchObject({ body: '', attachment_ids: ['A9'] });
  });

  it('assign popover lists the team and assigns with the revision', async () => {
    const fetchMock = signedIn('owner', inboxRoutes({ 'POST /stores/S1/inbox/conversations/C1/assign': jsonResponse(200, { data: conversation({ assignee: { id: 'U2', name: 'Sumon Das' }, revision: 4 }) }) }));
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Assignee: Rahim Ahmed' }, SLOW));
    const pop = screen.getByRole('dialog', { name: 'Assign conversation' });
    expect(await within(pop).findByText('Rahim Ahmed (you)', undefined, SLOW)).toBeInTheDocument();
    expect(within(pop).getByText('Staff · 2 open')).toBeInTheDocument();
    expect(within(pop).getByText('Back to the shared queue')).toBeInTheDocument();
    expect(within(pop).getByText(/Only staff with the Inbox permission are listed/)).toBeInTheDocument();
    await userEvent.click(within(pop).getByText('Sumon Das'));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/assign', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/assign', 'POST')[0]!)).toEqual({ assignee_id: 'U2', revision: 3 });
    expect(await screen.findByRole('button', { name: 'Assignee: Sumon Das' }, SLOW)).toBeInTheDocument();
  });

  it('close shows the toast with Undo (back to open); Mark pending; a closed thread offers Reopen', async () => {
    const fetchMock = signedIn(
      'owner',
      inboxRoutes({
        'POST /stores/S1/inbox/conversations/C1/status': (init) => jsonResponse(200, { data: conversation({ status: JSON.parse(String(init.body)).status, revision: 4 }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Mark pending' }, SLOW));
    await waitFor(() => expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/status', 'POST')[0]!)).toEqual({ status: 'pending', revision: 3 }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }, SLOW));
    expect(await screen.findByText('Conversation closed. Showing the next open chat in 5 s.', undefined, SLOW)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reopen' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText(/Closed\. If Farhana writes again it reopens and goes back to Rahim/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/status', 'POST')).toHaveLength(3));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/status', 'POST')[2]!)).toEqual({ status: 'pending' });
  });

  it('side panel without customers.view / orders.view hides the customer and order cards; no delete', async () => {
    signedIn(
      { role: 'custom', permissions: ['inbox.manage'] },
      inboxRoutes({
        'GET /stores/S1/inbox/conversations/C1': jsonResponse(200, {
          data: conversation({
            customer: { contact: { name: 'Farhana Yasmin', phone: '8801712345678', email: null }, customer: null, linked_order: null, past_orders: [] },
            can: { reply: true, assign: true, link_order: false, delete: false, view_customer: false, view_order: false },
          }),
        }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    const panel = await screen.findByRole('complementary', { name: 'Customer' }, SLOW);
    expect(within(panel).getByText('Verified phone', { selector: 'p' })).toBeInTheDocument();
    expect(within(panel).queryByRole('region', { name: 'Linked order' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('link', { name: 'View customer' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    expect(screen.queryByRole('menuitem', { name: /Delete conversation/ })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Block customer/ })).toBeInTheDocument();
  });

  it('block and delete (customers.delete) from the ⋯ menu', async () => {
    const fetchMock = signedIn(
      'owner',
      inboxRoutes({
        'POST /stores/S1/inbox/conversations/C1/block': jsonResponse(200, { data: conversation({ blocked: true, revision: 4 }) }),
        'DELETE /stores/S1/inbox/conversations/C1': new Response(null, { status: 204 }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Conversation actions' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: /Block customer/ }));
    expect(await screen.findByText(/Blocked\. New messages from Farhana are dropped/, undefined, SLOW)).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/block', 'POST')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Delete conversation/ }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1', 'DELETE')).toHaveLength(1));
    expect(await screen.findByText('Select a conversation', undefined, SLOW)).toBeInTheDocument();
  });

  it('read-only support session: composer and actions disabled, no read marking', async () => {
    const meta = { id: 'IMP1', tenant_id: 'T1', tenant_name: 'Mugdho Fashion', owner_name: 'Rahim', reason: 'T-1', expires_at: new Date(Date.now() + 14 * 60_000).toISOString() };
    session.start({ expires_at: meta.expires_at });
    const fetchMock = mockApi({
      'GET /auth/me': jsonResponse(200, { data: { ...user([tenantA]), id: 'P1' }, meta: { session_expires_at: meta.expires_at, impersonation: meta } }),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
      ...inboxRoutes(),
    });
    renderApp(<AppRoutes />, { route: '/inbox?c=C1' });
    const box = await screen.findByRole('textbox', { name: 'Reply' }, SLOW);
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('placeholder', 'Read-only support session');
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Assignee/ })).toBeDisabled();
    expect(within(screen.getByLabelText('Messages')).getByText('Hidden')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/inbox/conversations/C1/read', 'POST')).toHaveLength(0);
  });
});

describe('PHASE-8-8E channels drawer', () => {
  it('switches with the revision, copies and rotates the address, shows coming-later channels', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fetchMock = signedIn(
      'owner',
      inboxRoutes({
        'PATCH /stores/S1/inbox/settings': jsonResponse(200, { data: settings({ revision: 6, channels: { ...settings().channels, web_chat: { enabled: false, live_on: null } } }) }),
        'POST /stores/S1/inbox/settings/email-address/rotate': jsonResponse(200, { data: settings({ revision: 7, channels: { ...settings().channels, email: { enabled: true, address: 'shop-new999@in.storeplix.com', available: true } } }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox' });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }, SLOW));
    const drawer = await screen.findByRole('dialog', { name: 'Channels' });
    const chat = await within(drawer).findByRole('switch', { name: 'Website chat' }, SLOW);
    expect(chat).toHaveAttribute('aria-checked', 'true');
    expect(within(drawer).getByText('Facebook Messenger')).toBeInTheDocument();
    expect(within(drawer).getAllByText('Coming later')).toHaveLength(3);
    await userEvent.click(within(drawer).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('shop-abc123@in.storeplix.com');
    await userEvent.click(chat);
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/settings', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/settings', 'PATCH')[0]!)).toEqual({ web_chat_enabled: false, revision: 5 });
    await userEvent.click(within(drawer).getByRole('button', { name: /Get a new address/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Get a new email address?' })).getByRole('button', { name: 'Get a new address' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/settings/email-address/rotate', 'POST')).toHaveLength(1));
    expect(await within(drawer).findByText('shop-new999@in.storeplix.com', undefined, SLOW)).toBeInTheDocument();
  });

  it('staff without settings.manage sees the switches disabled', async () => {
    signedIn('staff', inboxRoutes({ 'GET /stores/S1/inbox/settings': jsonResponse(200, { data: settings({ can: { edit: false } }) }) }));
    renderApp(<AppRoutes />, { route: '/inbox' });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }, SLOW));
    const drawer = await screen.findByRole('dialog', { name: 'Channels' });
    expect(await within(drawer).findByRole('switch', { name: 'Website chat' }, SLOW)).toBeDisabled();
    expect(within(drawer).getByText(/Only members who can change shop settings/)).toBeInTheDocument();
  });
});

describe('PHASE-8-8E saved replies page', () => {
  it('lists with counts; creates with a normalised shortcut; shows a taken shortcut inline', async () => {
    let taken = true;
    const fetchMock = signedIn(
      'owner',
      inboxRoutes({
        'POST /stores/S1/inbox/saved-replies': (init) =>
          taken ? jsonResponse(409, { error: { code: 'saved_reply_shortcut_taken', message: 'x' } }) : jsonResponse(201, { data: savedReply({ id: 'R3', ...JSON.parse(String(init.body)) }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox/saved-replies' });
    expect(await screen.findByText('Delivery charge', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All · 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shown as chips · 1' })).toBeInTheDocument();
    expect(screen.getByText('Used 214×')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'New reply' }));
    const form = screen.getByRole('region', { name: 'New saved reply' });
    await userEvent.type(within(form).getByLabelText('Title'), 'Thank you');
    await userEvent.type(within(form).getByLabelText('Shortcut'), 'Thanks');
    await userEvent.type(within(form).getByLabelText('Message'), 'Thank you ');
    await userEvent.click(within(form).getByRole('button', { name: '{customer_name}' }));
    expect(within(form).getByLabelText('Message')).toHaveValue('Thank you {customer_name}');
    await userEvent.click(within(form).getByRole('button', { name: 'Save reply' }));
    expect(await within(form).findByText('Another saved reply already uses this shortcut.', undefined, SLOW)).toBeInTheDocument();
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/saved-replies', 'POST')[0]!)).toEqual({
      title: 'Thank you',
      shortcut: 'thanks',
      body: 'Thank you {customer_name}',
      show_as_chip: false,
      attachment_id: null,
    });
    taken = false;
    await userEvent.click(within(form).getByRole('button', { name: 'Save reply' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New saved reply' })).not.toBeInTheDocument());
  });

  it('client checks unknown tags; edit sends the revision; delete asks first', async () => {
    const fetchMock = signedIn(
      'owner',
      inboxRoutes({
        'PATCH /stores/S1/inbox/saved-replies/R1': jsonResponse(200, { data: savedReply({ revision: 2 }) }),
        'DELETE /stores/S1/inbox/saved-replies/R1': new Response(null, { status: 204 }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inbox/saved-replies' });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Delivery charge' }, SLOW));
    const form = screen.getByRole('region', { name: 'Edit Delivery charge' });
    const body = within(form).getByLabelText('Message');
    fireEvent.change(body, { target: { value: 'Hi {order_id}' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Save reply' }));
    expect(within(form).getByText('Use only the Insert chips for {tags}.')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/inbox/saved-replies/R1', 'PATCH')).toHaveLength(0);
    fireEvent.change(body, { target: { value: 'Inside Dhaka {delivery_inside}' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Save reply' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/saved-replies/R1', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inbox/saved-replies/R1', 'PATCH')[0]!)).toMatchObject({ body: 'Inside Dhaka {delivery_inside}', revision: 1, shortcut: 'delivery' });

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Delivery charge' }, SLOW));
    await userEvent.click(within(screen.getByRole('region', { name: 'Edit Delivery charge' })).getByRole('button', { name: 'Delete reply' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete reply' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/inbox/saved-replies/R1', 'DELETE')).toHaveLength(1));
  });
});

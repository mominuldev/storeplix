import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import {
  attachmentProblem,
  formatDuration,
  highlightParts,
  HELP_LANG_KEY,
  helpSearchParams,
  isSearchable,
  parseHelpSearch,
  parseTicketTab,
  resolveHelpLanguage,
  showRatingCard,
  systemRowText,
} from '../help/help';
import { helpErrorText } from '../help/errors';
import { newTicketSchema } from '../help/NewTicketModal';
import { session } from '../lib/session';
import { callsTo, jsonResponse, mockApi, okHealth, renderApp, signedIn, store, tenantA, user } from '../test/utils';
import { orderSummary } from './phase5.fixtures';
import { article, home, link, messages, result, searchMeta, ticket, ticketMeta, ticketSummary } from './phase8-9c.fixtures';
import { ApiError } from '@storeplix/api-client';

// PHASE-8-9C §16 Web: helpers; home (toggle, chips, topic cards, Talk to us gating, My tickets row); search (language
// chips, category chips, no results, show more); topic; article (fallback note, TOC, renderer, helpful flow with reasons
// + Undo, 404, canonical slug); tickets list (tabs, stats, search, empty / error, no access); new ticket modal
// (validation, order picker gating, uploads with limits, retry keeps data + client_id); thread (system rows, reply,
// closed state, rating card, mark solved); impersonation read-only.

vi.setConfig({ testTimeout: 20_000 });
const SLOW = { timeout: 5000 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Calls = Parameters<typeof callsTo>[0];
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const byMethod = (fetchMock: Calls, path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const searchOf = (call: [string, RequestInit]) => new URL(String(call[0]), 'http://localhost').searchParams;

function helpRoutes(extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /help/home': jsonResponse(200, { data: home() }),
    'GET /help/tickets': jsonResponse(200, { data: [ticketSummary(), ticketSummary({ id: 'ST2', number: 2379, reference: 'T-2379', subject: 'bKash shows paid, order Unpaid', status: 'open', priority: 'urgent', related_order: null })], meta: ticketMeta() }),
    ...extra,
  };
}

/** Uploads go through XHR (progress): a fake that answers `status`/`body` right after `send`. */
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
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
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

function impersonating(routes: Record<string, Response | ((init: RequestInit) => Response)>) {
  const meta = { id: 'IMP1', tenant_id: 'T1', tenant_name: 'Mugdho Fashion', owner_name: 'Rahim', reason: 'T-1', expires_at: new Date(Date.now() + 14 * 60_000).toISOString() };
  session.start({ expires_at: meta.expires_at });
  return mockApi({
    'GET /auth/me': jsonResponse(200, { data: { ...user([tenantA]), id: 'P1' }, meta: { session_expires_at: meta.expires_at, impersonation: meta } }),
    'GET /stores': jsonResponse(200, { data: [store()] }),
    'GET /health': okHealth(),
    ...routes,
  });
}

describe('PHASE-8-9C helpers', () => {
  it('search URL state and query rules', () => {
    expect(parseHelpSearch(new URLSearchParams('q=bkash&language=bn&category=payments'))).toEqual({ q: 'bkash', language: 'bn', category: 'payments' });
    expect(parseHelpSearch(new URLSearchParams('q=x&language=fr')).language).toBe('both');
    expect(helpSearchParams({ q: 'cod', language: 'both', category: null }).toString()).toBe('q=cod');
    expect(isSearchable(' a ')).toBe(false);
    expect(isSearchable('ab')).toBe(true);
    expect(isSearchable('x'.repeat(101))).toBe(false);
  });

  it('bolds query terms without HTML', () => {
    expect(highlightParts('Refund a bKash payment', 'bkash refund')).toEqual([
      { text: 'Refund', hit: true },
      { text: ' a ', hit: false },
      { text: 'bKash', hit: true },
      { text: ' payment', hit: false },
    ]);
    expect(highlightParts('a (b) c', '(b)')).toEqual([{ text: 'a ', hit: false }, { text: '(b)', hit: true }, { text: ' c', hit: false }]);
    expect(highlightParts('রিফান্ড দেবেন', 'রিফান্ড')[0]).toEqual({ text: 'রিফান্ড', hit: true });
  });

  it('article language: URL first, then the remembered choice', () => {
    expect(resolveHelpLanguage('bn')).toBe('bn');
    expect(resolveHelpLanguage(null)).toBe('en');
    localStorage.setItem(HELP_LANG_KEY, 'bn');
    expect(resolveHelpLanguage(null)).toBe('bn');
    expect(resolveHelpLanguage('en')).toBe('en');
  });

  it('attachments, durations, tabs, system rows, rating card', () => {
    expect(attachmentProblem({ name: 'a.png', type: 'image/png', size: 1000 }, 0)).toBeNull();
    expect(attachmentProblem({ name: 'a.gif', type: 'image/gif', size: 1000 }, 0)).toBe('Only JPG, PNG or PDF files.');
    expect(attachmentProblem({ name: 'a.pdf', type: 'application/pdf', size: 10 * 1024 * 1024 + 1 }, 0)).toBe('Files must be 10 MB or smaller.');
    expect(attachmentProblem({ name: 'a.pdf', type: 'application/pdf', size: 1 }, 5)).toBe('You can attach up to 5 files.');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(360)).toBe('6 min');
    expect(formatDuration(7500)).toBe('2 h 5 min');
    expect(formatDuration(null)).toBe('—');
    expect(parseTicketTab('solved')).toBe('solved');
    expect(parseTicketTab('nope')).toBe('all');
    const [, assigned, , reopened, rated] = messages();
    expect(systemRowText(assigned!)).toBe('Picked up by Farhana from Store Plix support');
    expect(systemRowText(reopened!)).toBe('Reopened');
    expect(systemRowText(rated!)).toBeNull();
    expect(systemRowText({ ...rated!, system: { event: 'auto_closed' } })).toBe('Closed automatically');
    expect(showRatingCard(ticket({ status: 'resolved', can: { reply: true, resolve: false, rate: true } }))).toBe(true);
    expect(showRatingCard(ticket({ status: 'open' }))).toBe(false);
  });

  it('ticket form schema and error copy', () => {
    const bad = newTicketSchema.safeParse({ category: 'bug', subject: 'Hi', description: 'short', priority: 'normal' });
    expect(bad.success).toBe(false);
    expect(newTicketSchema.safeParse({ category: 'bug', subject: 'Checkout broken', description: 'Customers cannot pay since 10 AM today.', priority: 'urgent' }).success).toBe(true);
    expect(helpErrorText(new ApiError(409, 'support_ticket_closed', 'x'))).toBe('This ticket is closed. Open a new ticket.');
    expect(helpErrorText(new ApiError(403, 'impersonation_read_only', 'x'))).toBe('Read-only support session. Changes are disabled.');
  });
});

describe('PHASE-8-9C Help home', () => {
  it('hero with first name, 4 popular chips, topic cards, Talk to us → New ticket; toggle asks for বাংলা', async () => {
    const fetchMock = signedIn('owner', helpRoutes());
    renderApp(<AppRoutes />, { route: '/help' });
    expect(await screen.findByRole('heading', { name: 'Hi Rahim, how can we help today?' }, SLOW)).toBeInTheDocument();
    const hero = screen.getByRole('region', { name: 'Search the help center' });
    await waitFor(() => expect(within(hero).getAllByRole('link')).toHaveLength(4), SLOW);
    expect(await screen.findByRole('link', { name: /Couriers.*24 articles/ }, SLOW)).toHaveAttribute('href', '/help/categories/couriers');
    expect(screen.getByRole('heading', { name: 'Popular this week' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Talk to us' })).toBeInTheDocument();
    expect(screen.queryByText(/Live chat|WhatsApp|Video tutorials|Ask Storeplix AI|systems operational/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'বাংলা' }));
    await waitFor(() => expect(callsTo(fetchMock, '/help/home').some((c) => searchOf(c).get('language') === 'bn')).toBe(true));
    expect(localStorage.getItem(HELP_LANG_KEY)).toBe('bn');
    await userEvent.click(within(screen.getByRole('heading', { name: 'Talk to us' }).closest('section')!).getByRole('button', { name: 'New ticket' }));
    expect(await screen.findByRole('dialog', { name: 'New support ticket' }, SLOW)).toBeInTheDocument();
  });

  it('search box sends to /help?q=', async () => {
    signedIn('owner', helpRoutes({ 'GET /help/articles': jsonResponse(200, { data: [result()], meta: searchMeta({ total: 1 }) }) }));
    renderApp(<AppRoutes />, { route: '/help' });
    const box = await screen.findByRole('searchbox', { name: 'Search guides' }, SLOW);
    await userEvent.type(box, 'bkash refund{Enter}');
    expect(await screen.findByRole('heading', { name: 'Search the help center' }, SLOW)).toBeInTheDocument();
  });

  it('a member without support.manage sees "Ask your shop owner" and no tickets row', async () => {
    const fetchMock = signedIn('staff', helpRoutes({ 'GET /help/home': jsonResponse(200, { data: home({ can_contact_support: false }) }) }));
    renderApp(<AppRoutes />, { route: '/help' });
    expect(await screen.findByText(/Ask your shop owner or a manager to contact Store Plix support/, undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New ticket' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Contact support' })).toBeNull();
    expect(callsTo(fetchMock, '/help/tickets')).toHaveLength(0);
  });

  it('error state retries', async () => {
    let n = 0;
    signedIn('owner', helpRoutes({ 'GET /help/home': () => (n++ === 0 ? jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) : jsonResponse(200, { data: home() })) }));
    renderApp(<AppRoutes />, { route: '/help' });
    expect(await screen.findByText('We couldn’t load the help center', undefined, SLOW)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Browse by topic' }, SLOW)).toBeInTheDocument();
  });
});

describe('PHASE-8-9C search and topic', () => {
  it('language chips, category chips, bolded terms, show more, aside', async () => {
    const fetchMock = signedIn(
      'owner',
      helpRoutes({
        'GET /help/articles': (init) => {
          void init;
          const call = callsTo(fetchMock, '/help/articles').at(-1)!;
          const page = Number(searchOf(call).get('page') ?? 1);
          return jsonResponse(200, {
            data: page === 1 ? [result(), result({ article_id: 'HA8', slug: 'bkash-refund', language: 'bn', title: 'বিকাশে টাকা ফেরত' })] : [result({ article_id: 'HA9', slug: 'partial', title: 'Partial refunds on COD orders' })],
            meta: searchMeta({ total: 3, last_page: 2, current_page: page }),
          });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/help?q=bkash%20refund' });
    expect(await screen.findByRole('heading', { name: '3 results for “bkash refund”' }, SLOW)).toBeInTheDocument();
    const first = screen.getByRole('link', { name: /Refund a bKash payment to a customer/ });
    expect(within(first).getByText('Refund').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: /বিকাশে টাকা ফেরত/ })).toHaveAttribute('href', '/help/articles/bkash-refund?lang=bn');
    expect(screen.getByRole('heading', { name: 'Didn’t find your answer?' })).toBeInTheDocument();
    expect(screen.queryByText(/live chat/i)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show more results' }));
    expect(await screen.findByText('Partial refunds on COD orders', undefined, SLOW)).toBeInTheDocument();
    expect(searchOf(callsTo(fetchMock, '/help/articles').at(-1)!).get('page')).toBe('2');

    await userEvent.click(within(screen.getByRole('group', { name: 'Language' })).getByRole('button', { name: 'বাংলা' }));
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/help/articles').at(-1)!).get('language')).toBe('bn'));
    await userEvent.click(await screen.findByRole('button', { name: 'Orders & COD 1' }, SLOW));
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/help/articles').at(-1)!).get('category')).toBe('orders-cod'));
  });

  it('no results offers Contact support', async () => {
    signedIn('owner', helpRoutes({ 'GET /help/articles': jsonResponse(200, { data: [], meta: searchMeta({ total: 0, counts_by_category: [] }) }) }));
    renderApp(<AppRoutes />, { route: '/help?q=পিকআপ%20কোড' });
    expect(await screen.findByText(/No guides match/, undefined, SLOW)).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('region', { name: 'Results' })).getByRole('button', { name: 'Contact support' }));
    expect(await screen.findByRole('dialog', { name: 'New support ticket' }, SLOW)).toBeInTheDocument();
  });

  it('topic page lists articles; unknown topic shows the empty state', async () => {
    signedIn(
      'owner',
      helpRoutes({
        'GET /help/categories/couriers': jsonResponse(200, { data: { category: home().categories[0], articles: [link(), link({ id: 'HA2', slug: 'redx', title: 'Book RedX' })] } }),
        'GET /help/categories/gone': jsonResponse(404, { error: { code: 'help_category_not_found', message: 'Not found' } }),
      }),
    );
    const { unmount } = renderApp(<AppRoutes />, { route: '/help/categories/couriers' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Couriers' }, SLOW)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Book RedX/ }, SLOW)).toHaveAttribute('href', '/help/articles/redx');
    unmount();
    renderApp(<AppRoutes />, { route: '/help/topics/gone' });
    expect(await screen.findByText('This topic has no guides right now', undefined, SLOW)).toBeInTheDocument();
  });
});

describe('PHASE-8-9C article', () => {
  it('renders body, TOC, related, internal + external links, fallback note for বাংলা', async () => {
    const fetchMock = signedIn(
      'owner',
      helpRoutes({
        'GET /help/articles/book-steadfast': () => {
          const lang = searchOf(callsTo(fetchMock, '/help/articles/book-steadfast').at(-1)!).get('language');
          return jsonResponse(200, { data: article(lang === 'bn' ? { requested_language: 'bn', fallback: true } : {}) });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/help/articles/book-steadfast' });
    expect(await screen.findByRole('heading', { level: 1, name: 'How to book a parcel with Steadfast' }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Connect Steadfast' })).toHaveAttribute('id', '1-connect-steadfast');
    expect(within(screen.getByRole('navigation', { name: 'On this page' })).getByRole('link', { name: 'Connect Steadfast' })).toHaveAttribute('href', '#1-connect-steadfast');
    expect(screen.getByRole('link', { name: 'the courier guide' })).toHaveAttribute('href', '/help/articles/couriers');
    expect(screen.getByRole('link', { name: 'Steadfast portal' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('img', { name: 'Courier settings screen' })).toHaveAttribute('srcset', 'https://cdn.test/help/HM1/w640.webp 640w');
    expect(screen.getByRole('link', { name: /Track Steadfast parcels/ })).toBeInTheDocument();
    expect(screen.getByText('214 sellers found this helpful')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a ticket' })).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();

    await userEvent.click(within(screen.getByRole('group', { name: 'Article language' })).getByRole('button', { name: 'বাংলা' }));
    expect(await screen.findByText('এই লেখাটি এখনো বাংলায় নেই — ইংরেজিতে দেখানো হচ্ছে।', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Not available in বাংলা yet — showing English.')).toBeInTheDocument();
  });

  it('No → reason → Send feedback, then Undo', async () => {
    const fetchMock = signedIn(
      'owner',
      helpRoutes({
        'GET /help/articles/book-steadfast': jsonResponse(200, { data: article() }),
        'PUT /help/articles/book-steadfast/feedback': (init) => jsonResponse(200, { data: { ...JSON.parse(String(init.body)), updated_at: '2026-11-28T00:00:00Z' } }),
        'DELETE /help/articles/book-steadfast/feedback': new Response(null, { status: 204 }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/help/articles/book-steadfast' });
    await userEvent.click(await screen.findByRole('button', { name: 'No' }, SLOW));
    expect(screen.getByRole('heading', { name: 'Sorry it didn’t help. What was missing?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Out of date' }));
    await userEvent.type(screen.getByLabelText(/Optional: tell us more/), 'Menu moved');
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(await screen.findByText('Thanks for telling us. We read every note and fix the guide.', undefined, SLOW)).toBeInTheDocument();
    expect(bodyOf(byMethod(fetchMock, '/help/articles/book-steadfast/feedback', 'PUT')[0]!)).toEqual({ helpful: false, language: 'en', reason: 'out_of_date', note: 'Menu moved' });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Yes' }, SLOW)).toBeInTheDocument();
    expect(byMethod(fetchMock, '/help/articles/book-steadfast/feedback', 'DELETE')).toHaveLength(1);
  });

  it('Yes vote shows the thanks banner with the count', async () => {
    signedIn(
      'owner',
      helpRoutes({
        'GET /help/articles/book-steadfast': jsonResponse(200, { data: article() }),
        'PUT /help/articles/book-steadfast/feedback': jsonResponse(200, { data: { helpful: true, reason: null, note: null, updated_at: '2026-11-28T00:00:00Z' } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/help/articles/book-steadfast' });
    await userEvent.click(await screen.findByRole('button', { name: 'Yes' }, SLOW));
    expect(await screen.findByText('Thanks — 215 sellers found this helpful.', undefined, SLOW)).toBeInTheDocument();
  });

  it('404 shows "This guide was moved or unpublished"', async () => {
    signedIn('owner', helpRoutes({ 'GET /help/articles/old': jsonResponse(404, { error: { code: 'help_article_not_found', message: 'Not found' } }) }));
    renderApp(<AppRoutes />, { route: '/help/articles/old' });
    expect(await screen.findByText('This guide was moved or unpublished', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Help center' })).toBeInTheDocument();
  });

  it('read-only support session: votes disabled', async () => {
    impersonating(helpRoutes({ 'GET /help/articles/book-steadfast': jsonResponse(200, { data: article() }) }));
    renderApp(<AppRoutes />, { route: '/help/articles/book-steadfast' });
    expect(await screen.findByRole('button', { name: 'Yes' }, SLOW)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'No' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create a ticket' })).toBeDisabled();
  });
});

describe('PHASE-8-9C tickets list', () => {
  it('stats, tabs with counts, table rows, tab + search filters', async () => {
    const fetchMock = signedIn('owner', helpRoutes());
    renderApp(<AppRoutes />, { route: '/help/tickets' });
    expect(await screen.findByRole('heading', { name: 'Support tickets' }, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('Rated 4.9 / 5 by you', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText('4 min')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Waiting on you\s*1/ })).toBeInTheDocument();
    expect(screen.getAllByText('Steadfast booking fails for Chattogram orders').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Reply times/)).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: /Solved/ }));
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/help/tickets').at(-1)!).get('filter[tab]')).toBe('solved'));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'T-2381');
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/help/tickets').at(-1)!).get('filter[q]')).toBe('T-2381'), SLOW);
  });

  it('empty and error states', async () => {
    signedIn('owner', helpRoutes({ 'GET /help/tickets': jsonResponse(200, { data: [], meta: ticketMeta({ total: 0, counts: { all: 0, open: 0, waiting_on_you: 0, solved: 0 } }) }) }));
    const { unmount } = renderApp(<AppRoutes />, { route: '/help/tickets' });
    expect(await screen.findByText('No tickets yet', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse guides' })).toBeInTheDocument();
    unmount();
    signedIn('owner', helpRoutes({ 'GET /help/tickets': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) }));
    renderApp(<AppRoutes />, { route: '/help/tickets' });
    expect(await screen.findByText('Couldn’t load your tickets', undefined, SLOW)).toBeInTheDocument();
  });

  it('Staff (no support.manage) gets the no-access state and no request', async () => {
    const fetchMock = signedIn('staff', helpRoutes());
    renderApp(<AppRoutes />, { route: '/help/tickets' });
    expect(await screen.findByText('Ask your shop owner to contact support', undefined, SLOW)).toBeInTheDocument();
    expect(callsTo(fetchMock, '/help/tickets')).toHaveLength(0);
  });
});

describe('PHASE-8-9C new ticket modal', () => {
  const ORDER = orderSummary();

  it('validates, picks an order, uploads within limits, retries with the same client_id, then shows "Ticket T-n sent"', async () => {
    const sent = stubXhr(201, { data: { id: 'SA9', filename: 'shot.png', mime: 'image/png', size_bytes: 1000, kind: 'image', status: 'ready' } });
    let attempts = 0;
    const fetchMock = signedIn(
      'owner',
      helpRoutes({
        'GET /stores/S1/orders': jsonResponse(200, { data: [ORDER], meta: { current_page: 1, per_page: 5, total: 1, last_page: 1 } }),
        'POST /help/tickets': () => (attempts++ === 0 ? jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) : jsonResponse(201, { data: ticket({ id: 'ST9', number: 2382, reference: 'T-2382' }) })),
      }),
    );
    renderApp(<AppRoutes />, { route: '/help/tickets' });
    await userEvent.click(await screen.findByRole('button', { name: '+ New ticket' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'New support ticket' }, SLOW);
    expect(within(dialog).queryByText(/30 minutes/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Low' })).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit ticket' }));
    expect(await within(dialog).findByText('Pick a category.', undefined, SLOW)).toBeInTheDocument();
    expect(within(dialog).getByText(/Use at least 5 characters/)).toBeInTheDocument();

    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'orders_payments');
    await userEvent.type(within(dialog).getByLabelText('Subject'), 'bKash paid, order still Unpaid');
    await userEvent.type(within(dialog).getByLabelText('What happened?'), 'Customer paid 1850 by bKash at 10:12 today.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Urgent — money or orders blocked' }));

    await userEvent.click(within(dialog).getByRole('combobox', { name: /Related order/ }));
    await userEvent.click(await within(dialog).findByRole('option', { name: new RegExp(ORDER.number) }, SLOW));
    expect(within(dialog).getByRole('button', { name: 'Remove related order' })).toBeInTheDocument();

    const input = within(dialog).getByLabelText('Add files') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'.repeat(11 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' })] } });
    expect(await within(dialog).findByText(/big.pdf: Files must be 10 MB or smaller/, undefined, SLOW)).toBeInTheDocument();
    fireEvent.change(input, { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    expect(await within(dialog).findByRole('button', { name: 'Remove shot.png' }, SLOW)).toBeInTheDocument();
    await waitFor(() => expect(sent).toHaveLength(1));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit ticket' }));
    expect(await within(dialog).findByText(/Couldn’t send your ticket/, undefined, SLOW)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('bKash paid, order still Unpaid');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Ticket T-2382 sent/, undefined, SLOW)).toBeInTheDocument();

    const posts = byMethod(fetchMock, '/help/tickets', 'POST');
    expect(posts).toHaveLength(2);
    const [a, b] = posts.map(bodyOf);
    expect(a.client_id).toBe(b.client_id);
    expect(b).toMatchObject({ category: 'orders_payments', priority: 'urgent', order_id: ORDER.id, attachment_ids: ['SA9'] });
  });

  it('no order picker without orders.view', async () => {
    signedIn({ role: 'custom', permissions: ['support.manage'] }, helpRoutes());
    renderApp(<AppRoutes />, { route: '/help/tickets' });
    await userEvent.click(await screen.findByRole('button', { name: '+ New ticket' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'New support ticket' }, SLOW);
    expect(within(dialog).queryByRole('combobox', { name: /Related order/ })).toBeNull();
    expect(within(dialog).queryByText(/Related order/)).toBeNull();
  });
});

describe('PHASE-8-9C ticket thread', () => {
  it('shows bubbles, system rows (not staff-only events), side panel; replies and marks solved', async () => {
    const fetchMock = signedIn(
      'owner',
      helpRoutes({
        'GET /help/tickets/ST1': jsonResponse(200, { data: ticket() }),
        'GET /help/tickets/ST1/messages': jsonResponse(200, { data: messages() }),
        'POST /help/tickets/ST1/messages': jsonResponse(201, { data: messages()[0] }),
        'POST /help/tickets/ST1/resolve': jsonResponse(200, { data: ticket({ status: 'resolved', can: { reply: true, resolve: false, rate: true } }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/help/tickets/ST1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Steadfast booking fails for Chattogram orders' }, SLOW)).toBeInTheDocument();
    const thread = await screen.findByRole('list', { name: 'Messages' }, SLOW);
    expect(within(thread).getByText('Since this morning every Chattogram order fails.')).toBeInTheDocument();
    expect(within(thread).getByText(/Picked up by Farhana from Store Plix support/)).toBeInTheDocument();
    expect(within(thread).getByText(/Reopened/)).toBeInTheDocument();
    expect(within(thread).queryByText(/rated/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/orders/O1');
    expect(screen.getByText(/can see this order’s number, status, items and totals/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Reply'), 'Retried, it booked.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(byMethod(fetchMock, '/help/tickets/ST1/messages', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/help/tickets/ST1/messages', 'POST')[0]!)).toMatchObject({ body: 'Retried, it booked.', attachment_ids: [] });
    await waitFor(() => expect(screen.getByLabelText('Reply')).toHaveValue(''));

    await userEvent.click(screen.getByRole('button', { name: 'Mark as solved' }));
    expect(await screen.findByRole('heading', { name: 'How did Farhana do?' }, SLOW)).toBeInTheDocument();
    expect(screen.getByLabelText('Reply')).toHaveAttribute('placeholder', 'Reply to reopen this ticket…');
  });

  it('rating card sends 1–5 + comment', async () => {
    const fetchMock = signedIn(
      'owner',
      helpRoutes({
        'GET /help/tickets/ST1': jsonResponse(200, { data: ticket({ status: 'resolved', can: { reply: true, resolve: false, rate: true } }) }),
        'GET /help/tickets/ST1/messages': jsonResponse(200, { data: messages() }),
        'PUT /help/tickets/ST1/rating': jsonResponse(200, { data: ticket({ status: 'resolved', rating: { rating: 4, comment: 'Quick', rated_at: '2026-11-28T00:00:00Z' }, can: { reply: true, resolve: false, rate: true } }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/help/tickets/ST1' });
    await userEvent.click(await screen.findByRole('radio', { name: '4 stars' }, SLOW));
    await userEvent.type(screen.getByLabelText('Comment'), 'Quick');
    await userEvent.click(screen.getByRole('button', { name: 'Send rating' }));
    expect(await screen.findByText('You rated this ticket 4 / 5', undefined, SLOW)).toBeInTheDocument();
    expect(bodyOf(byMethod(fetchMock, '/help/tickets/ST1/rating', 'PUT')[0]!)).toEqual({ rating: 4, comment: 'Quick' });
  });

  it('closed ticket: no reply box, "Open a new ticket"', async () => {
    signedIn(
      'owner',
      helpRoutes({
        'GET /help/tickets/ST1': jsonResponse(200, { data: ticket({ status: 'closed', closed_at: '2026-11-26T00:00:00Z', can: { reply: false, resolve: false, rate: false } }) }),
        'GET /help/tickets/ST1/messages': jsonResponse(200, { data: messages() }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/help/tickets/ST1' });
    expect(await screen.findByText(/This ticket is closed/, undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByLabelText('Reply')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as solved' })).toBeNull();
    expect(screen.queryByText(/can see this order’s number/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open a new ticket' }));
    expect(await screen.findByRole('dialog', { name: 'New support ticket' }, SLOW)).toBeInTheDocument();
  });

  it('read-only support session: reply, solve and files disabled', async () => {
    impersonating(
      helpRoutes({
        'GET /help/tickets/ST1': jsonResponse(200, { data: ticket() }),
        'GET /help/tickets/ST1/messages': jsonResponse(200, { data: messages() }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/help/tickets/ST1' });
    expect(await screen.findByLabelText('Reply', undefined, SLOW)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark as solved' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /Hidden/ })[0]).toBeDisabled();
  });

  it('another tenant’s ticket answers 404', async () => {
    signedIn('owner', helpRoutes({ 'GET /help/tickets/ZZ': jsonResponse(404, { error: { code: 'not_found', message: 'Not found' } }) }));
    renderApp(<AppRoutes />, { route: '/help/tickets/ZZ' });
    expect(await screen.findByText('This ticket doesn’t exist', undefined, SLOW)).toBeInTheDocument();
  });
});

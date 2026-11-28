import type { AdminSupportMessage, AdminSupportTicket, AdminSupportTicketSummary, PlatformRole } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { adminSession, jsonResponse, mockApi, on, renderApp } from '../test/utils';
import { duration, waiting } from './format';

const HOUR = 3600_000;

function summary(overrides: Partial<AdminSupportTicketSummary> = {}): AdminSupportTicketSummary {
  return {
    id: 'K1',
    number: 4821,
    reference: 'T-4821',
    subject: 'Steadfast booking failed for 12 orders',
    category: 'shipping_couriers',
    priority: 'high',
    status: 'awaiting_support',
    shop: { tenant_id: 'T1', tenant_name: 'Gadget Haat', store_name: 'Gadget Haat', domain: 'gadgethaat.com.bd', plan: 'growth', tenant_status: 'active' },
    requester: { id: 'O1', name: 'Rahim Uddin' },
    assignee: null,
    related_order: { id: 'ORD1', number: 'GS-1053' },
    waiting_since: new Date(Date.now() - 30 * HOUR).toISOString(),
    first_reply_seconds: null,
    last_message_at: new Date(Date.now() - 8 * 60_000).toISOString(),
    last_reply: null,
    messages_count: 2,
    created_at: '2026-11-27T04:42:00Z',
    ...overrides,
  };
}

function ticket(overrides: Partial<AdminSupportTicket> = {}): AdminSupportTicket {
  return {
    ...summary(),
    requester_email: 'rahim@gadgethaat.com.bd',
    order_card: {
      id: 'ORD1',
      number: 'GS-1053',
      placed_at: '2026-11-27T04:31:00Z',
      status: 'confirmed',
      payment_status: 'unpaid',
      payment_method: 'cod',
      total_amount: 145000,
      paid_amount: 0,
      due_amount: 145000,
      currency: 'BDT',
      items_count: 2,
      first_item_name: 'Wireless earbuds',
      courier: { provider: 'steadfast', status: 'booking_failed' },
      customer: { first_name: 'Karim', district: 'Dhaka' },
    },
    first_staff_reply_at: null,
    last_staff_reply_at: null,
    last_merchant_reply_at: '2026-11-27T04:51:00Z',
    resolved_at: null,
    resolution_seconds: null,
    closed_at: null,
    reopened_count: 0,
    rating: null,
    files: [{ id: 'F1', filename: 'steadfast-error.png', mime: 'image/png', size_bytes: 188_000, kind: 'image', status: 'ready' }],
    can: { reply: true, assign: true, set_status: true },
    revision: 4,
    ...overrides,
  };
}

const messages: AdminSupportMessage[] = [
  { id: 'M0', kind: 'system', body: null, author: null, attachments: [], system: { event: 'created', meta: { actor_name: 'Rahim Uddin' } }, created_at: '2026-11-27T04:42:00Z' },
  {
    id: 'M1',
    kind: 'merchant',
    body: 'Steadfast says Invalid API credentials.',
    author: { id: 'O1', name: 'Rahim Uddin', is_staff: false, platform_role: null },
    attachments: [{ id: 'F1', filename: 'steadfast-error.png', mime: 'image/png', size_bytes: 188_000, kind: 'image', status: 'ready' }],
    system: null,
    created_at: '2026-11-27T04:42:00Z',
  },
  { id: 'M2', kind: 'note', body: 'Key rotated on 18 Nov.', author: { id: 'U3', name: 'Nusrat Jahan', is_staff: true, platform_role: 'support' }, attachments: [], system: null, created_at: '2026-11-27T04:47:00Z' },
  { id: 'M3', kind: 'staff', body: 'Checking your integration now.', author: { id: 'U1', name: 'Sadia Ahmed', is_staff: true, platform_role: 'super_admin' }, attachments: [], system: null, created_at: '2026-11-27T04:44:00Z' },
];

const page = (rows: AdminSupportTicketSummary[]) =>
  jsonResponse(200, {
    data: rows,
    meta: {
      current_page: 1,
      per_page: 25,
      total: rows.length,
      last_page: 1,
      counts: { open: 3, awaiting_support: 15, awaiting_merchant: 6, resolved: 4, closed: 20, mine: 5, unassigned: 7 },
      stats: { median_first_reply_seconds_7d: 840, csat_average_30d: 4.7, csat_count_30d: 31 },
    },
  });

const assignees = () => jsonResponse(200, {
  data: [
    { user: { id: 'U1', name: 'Sadia Ahmed' }, platform_role: 'super_admin', open_count: 5, is_you: true },
    { user: { id: 'U3', name: 'Nusrat Jahan' }, platform_role: 'support', open_count: 2, is_you: false },
  ],
});

function supportApi(t: AdminSupportTicket = ticket(), extra: Parameters<typeof mockApi>[0] = [], role: PlatformRole = 'super_admin') {
  return mockApi(
    [
      ...extra,
      on('GET', '/admin/support/tickets', () => page([summary(), summary({ id: 'K2', number: 4818, reference: 'T-4818', subject: 'bKash payments not reflecting', priority: 'urgent', waiting_since: new Date(Date.now() - 80 * HOUR).toISOString(), shop: { ...summary().shop, store_name: 'Deshi Organic' } })])),
      on('GET', '/admin/support/tickets/K1', () => jsonResponse(200, { data: t })),
      on('GET', '/admin/support/tickets/K1/messages', () => jsonResponse(200, { data: messages })),
      on('GET', '/admin/support/assignees', assignees),
    ],
    { session: adminSession(role) },
  );
}

describe('support helpers', () => {
  it('formats durations and waiting tones (amber > 24 h, red > 72 h)', () => {
    expect(duration(840)).toBe('14 min');
    expect(duration(3 * 3600 + 1200, true)).toBe('3 h 20 min');
    expect(duration(null)).toBe('—');
    const now = Date.parse('2026-11-28T00:00:00Z');
    expect(waiting(new Date(now - 2 * HOUR).toISOString(), now)).toEqual({ label: '2 h waiting', tone: 'neutral' });
    expect(waiting(new Date(now - 30 * HOUR).toISOString(), now)!.tone).toBe('warning');
    expect(waiting(new Date(now - 80 * HOUR).toISOString(), now)!.tone).toBe('danger');
    expect(waiting(null, now)).toBeNull();
  });
});

describe('support queue (39:15432)', () => {
  it('shows counts, stats, rows with waiting badges and maps tabs, assignee, filters and search to the query', async () => {
    const api = supportApi();
    renderApp(<AppRoutes />, { route: '/support' });
    expect(await screen.findByRole('heading', { name: 'Support tickets' })).toBeInTheDocument();
    expect(await screen.findByText('Steadfast booking failed for 12 orders')).toBeInTheDocument();
    expect(screen.getByText(/18 waiting on us · 7 unassigned · median first reply 14 min \(7 days\) · CSAT 4.7 \/ 5/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Waiting on us\s*18/ })).toBeInTheDocument();
    const rows = screen.getByRole('list', { name: 'Tickets' });
    expect(within(rows).getByText('30 h waiting').closest('span')).toHaveClass('text-warning');
    expect(within(rows).getByText('3 d waiting').closest('span')).toHaveClass('text-danger');
    await waitFor(() => expect(within(screen.getByRole('navigation')).getByRole('link', { name: /Support tickets/ })).toHaveTextContent('Support tickets, waiting 18'));

    const list = () => api.find('GET', '/admin/support/tickets').filter((c) => c.url.searchParams.get('per_page') === '25');
    expect(list().at(-1)!.url.searchParams.get('filter[status]')).toBe('open,awaiting_support');
    expect(list().at(-1)!.url.searchParams.get('sort')).toBe('waiting');

    await userEvent.click(screen.getByRole('tab', { name: /On merchant/ }));
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('filter[status]')).toBe('awaiting_merchant'));

    await userEvent.click(screen.getByRole('tab', { name: /My queue/ }));
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('filter[assignee]')).toBe('me'));
    await userEvent.click(screen.getByRole('tab', { name: /Unassigned/ }));
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('filter[assignee]')).toBe('unassigned'));

    await userEvent.click(screen.getByRole('button', { name: 'Priority' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Urgent' }));
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('filter[priority]')).toBe('urgent'));

    await userEvent.click(screen.getByRole('button', { name: 'Category' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Billing & plan' }));
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('filter[category]')).toBe('billing_plan'));

    await userEvent.click(screen.getByRole('button', { name: 'Sort' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Newest' }));
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('sort')).toBe('newest'));

    await userEvent.type(screen.getByLabelText('Search ticket, shop or owner email'), 'T-48');
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('filter[q]')).toBe('T-48'));
  });

  it('empty and error states', async () => {
    mockApi([on('GET', '/admin/support/tickets', () => page([]))]);
    const first = renderApp(<AppRoutes />, { route: '/support' });
    expect(await screen.findByText('Nobody is waiting on us')).toBeInTheDocument();
    expect(screen.getByText('Pick a ticket')).toBeInTheDocument();
    first.unmount();
    mockApi([on('GET', '/admin/support/tickets', () => jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }))]);
    renderApp(<AppRoutes />, { route: '/support' });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it.each<[PlatformRole, boolean]>([
    ['super_admin', true],
    ['support', true],
    ['billing', true],
    ['read_only', false],
  ])('%s: Support tickets nav and route gated by manage_support (%s)', async (role, allowed) => {
    const api = supportApi(ticket(), [], role);
    renderApp(<AppRoutes />, { route: '/support' });
    const nav = await screen.findByRole('navigation');
    if (allowed) {
      expect(await within(nav).findByRole('link', { name: /Support tickets/ })).toHaveAttribute('href', '/support');
      expect(await screen.findByText('Steadfast booking failed for 12 orders')).toBeInTheDocument();
    } else {
      expect(within(nav).queryByRole('link', { name: /Support tickets/ })).toBeNull();
      expect(await screen.findByText('You don’t have access to support tickets')).toBeInTheDocument();
      expect(api.find('GET', '/admin/support/tickets')).toHaveLength(0);
    }
  });
});

describe('ticket thread and side panel', () => {
  it('renders the thread with internal notes, system rows, the audited order card, SLA timestamps and files', async () => {
    supportApi();
    renderApp(<AppRoutes />, { route: '/support/K1' });
    const thread = await screen.findByRole('region', { name: 'Ticket T-4821' });
    expect(await within(thread).findByText('Steadfast says Invalid API credentials.')).toBeInTheDocument();
    expect(within(thread).getByText('Internal note · Nusrat Jahan')).toBeInTheDocument();
    expect(within(thread).getByText('Only staff can see this')).toBeInTheDocument();
    expect(within(thread).getByText(/Rahim Uddin opened the ticket/)).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: 'Merchant context' });
    expect(within(panel).getByText('#GS-1053')).toBeInTheDocument();
    expect(within(panel).getByText('Karim · Dhaka')).toBeInTheDocument();
    expect(within(panel).getByText(/your view is audited/)).toBeInTheDocument();
    expect(within(panel).queryByText(/01912|@example|Road/)).toBeNull();
    expect(within(panel).getByText('Not yet')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Download steadfast-error.png' })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Open merchant profile/ })).toHaveAttribute('href', '/merchants/T1');
  });

  it('closed ticket: order number only and no composer', async () => {
    supportApi(ticket({ status: 'closed', order_card: null, closed_at: '2026-11-28T04:00:00Z', can: { reply: false, assign: true, set_status: false }, rating: { rating: 5, comment: 'Fast help', rated_at: '2026-11-28T04:00:00Z' } }));
    renderApp(<AppRoutes />, { route: '/support/K1' });
    expect(await screen.findByText('Details are hidden once the ticket is closed.')).toBeInTheDocument();
    expect(screen.getByText(/This ticket is closed/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Reply to merchant' })).toBeNull();
    expect(screen.getByLabelText('Rated 5 out of 5')).toBeInTheDocument();
  });

  it('reply vs internal note toggle sends the right kind, status and a stable client_id', async () => {
    const api = supportApi(ticket(), [
      on('POST', '/admin/support/tickets/K1/messages', (c) => jsonResponse(201, { data: { ...messages[3], id: 'M9', kind: (c.body as { kind: string }).kind === 'note' ? 'note' : 'staff' } })),
    ]);
    renderApp(<AppRoutes />, { route: '/support/K1' });
    const form = await screen.findByRole('form', { name: 'Reply to merchant' });
    await userEvent.type(within(form).getByLabelText('Reply text'), 'Please paste the new key.');
    await userEvent.selectOptions(within(form).getByLabelText('Status after sending'), 'resolved');
    await userEvent.click(within(form).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(api.find('POST', '/admin/support/tickets/K1/messages')).toHaveLength(1));
    const reply = api.find('POST', '/admin/support/tickets/K1/messages')[0]!.body as Record<string, unknown>;
    expect(reply).toMatchObject({ kind: 'reply', body: 'Please paste the new key.', attachment_ids: [], status: 'resolved' });
    expect(reply.client_id).toMatch(/^[0-9a-f-]{36}$/);

    await userEvent.click(screen.getByRole('tab', { name: 'Internal note' }));
    const noteForm = screen.getByRole('form', { name: 'Internal note' });
    expect(within(noteForm).queryByLabelText('Status after sending')).toBeNull();
    await userEvent.type(within(noteForm).getByLabelText('Note text'), 'Escalate if no reply.');
    await userEvent.click(within(noteForm).getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(api.find('POST', '/admin/support/tickets/K1/messages')).toHaveLength(2));
    const note = api.find('POST', '/admin/support/tickets/K1/messages')[1]!.body as Record<string, unknown>;
    expect(note).toMatchObject({ kind: 'note', body: 'Escalate if no reply.', status: null });
    expect(note.client_id).not.toBe(reply.client_id);
  });

  it('assign, priority and status changes send the revision', async () => {
    const api = supportApi(ticket(), [
      on('POST', '/admin/support/tickets/K1/assign', () => jsonResponse(200, { data: ticket({ assignee: { id: 'U3', name: 'Nusrat Jahan' }, revision: 5 }) })),
      on('PATCH', '/admin/support/tickets/K1', () => jsonResponse(200, { data: ticket({ priority: 'urgent', revision: 5 }) })),
      on('POST', '/admin/support/tickets/K1/status', () => jsonResponse(200, { data: ticket({ status: 'resolved', revision: 5 }) })),
    ]);
    renderApp(<AppRoutes />, { route: '/support/K1' });
    const panel = await screen.findByRole('complementary', { name: 'Merchant context' });
    await within(panel).findByRole('option', { name: /Nusrat Jahan · 2 open/ });
    await userEvent.selectOptions(within(panel).getByLabelText('Assignee'), 'U3');
    await waitFor(() => expect(api.find('POST', '/admin/support/tickets/K1/assign')[0]!.body).toEqual({ assignee_id: 'U3', revision: 4 }));
    expect(await screen.findByText('Assigned to Nusrat Jahan')).toBeInTheDocument();

    await userEvent.selectOptions(within(panel).getByLabelText('Priority'), 'urgent');
    await waitFor(() => expect(api.find('PATCH', '/admin/support/tickets/K1')[0]!.body).toEqual({ priority: 'urgent', revision: 5 }));

    await userEvent.selectOptions(screen.getByLabelText('Change status'), 'resolved');
    await waitFor(() => expect(api.find('POST', '/admin/support/tickets/K1/status')[0]!.body).toMatchObject({ status: 'resolved' }));
  });

  it('Impersonate opens the reason dialog prefilled with the ticket reference', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const api = supportApi(ticket(), [
      on('POST', '/admin/tenants/T1/impersonations', () => jsonResponse(201, { data: { id: 'I1', url: 'https://merchant.test/#t=x', ticket_expires_at: new Date(Date.now() + 60_000).toISOString() } })),
    ]);
    renderApp(<AppRoutes />, { route: '/support/K1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Impersonate (audited)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Support ticket (optional)')).toHaveValue('T-4821');
    expect(api.find('POST', '/admin/tenants/T1/impersonations')).toHaveLength(0);
  });

  it('billing staff (no impersonate) answer tickets without the Impersonate button', async () => {
    supportApi(ticket(), [], 'billing');
    renderApp(<AppRoutes />, { route: '/support/K1' });
    expect(await screen.findByRole('form', { name: 'Reply to merchant' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Impersonate (audited)' })).toBeNull();
  });
});

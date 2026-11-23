import type { PlatformRole } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';
import { adminSession, cursorList, emptyList, grants, jsonResponse, mockApi, on, renderApp, tenant } from './test/utils';

const shop = { id: 'T1', name: 'Gadget Haat', slug: 'gadgethaat' };
const invoiceSummary = (status: 'open' | 'paid' | 'void') => ({
  id: 'I1',
  number: 'SP-2026-000123',
  tenant: shop,
  kind: 'renewal',
  status,
  plan_code: 'starter',
  billing_interval: 'month',
  total_amount: 49900,
  currency: 'BDT',
  provider: 'bkash',
  issued_at: '2026-11-17T04:00:00Z',
  due_at: '2026-11-24T04:00:00Z',
  paid_at: null,
});
const invoice = (status: 'open' | 'paid' | 'void') => ({
  ...invoiceSummary(status),
  description: 'Starter · monthly',
  is_overdue: false,
  can_pay: status === 'open',
  interval: 'month',
  subtotal_amount: 49900,
  tax_amount: 0,
  tax_rate_bps: 0,
  credit_amount: 0,
  lines: [
    {
      description: 'Starter plan · monthly',
      plan_code: 'starter',
      interval: 'month',
      period_start: null,
      period_end: null,
      quantity: 1,
      unit_amount: 49900,
      amount: 49900,
    },
  ],
  bill_to: {
    name: 'Gadget Haat',
    address: null,
    email: 'tanvir@example.com',
    phone: null,
  },
  period_start: null,
  period_end: null,
  voided_at: null,
  void_reason: null,
  paid_late: false,
  payments: [
    {
      id: 'P1',
      invoice_id: 'I1',
      provider: 'bkash',
      status: 'failed',
      amount: 49900,
      currency: 'BDT',
      redirect_url: null,
      failure_code: 'insufficient_balance',
      is_duplicate: false,
      created_at: '2026-11-17T04:00:00Z',
      expires_at: 'x',
      verified_at: null,
      provider_reference: 'TRX1',
    },
  ],
});

function billingApi(role: PlatformRole, status: 'open' | 'paid' | 'void') {
  return mockApi(
    [
      on('GET', '/admin/invoices', () =>
        jsonResponse(200, {
          data: [invoiceSummary(status)],
          meta: { current_page: 1, per_page: 25, total: 1, last_page: 1 },
        }),
      ),
      on('GET', '/admin/invoices/I1', () => jsonResponse(200, { data: invoice(status) })),
      on('POST', '/admin/invoices/I1/mark-paid', () => jsonResponse(200, { data: invoice('paid') })),
      on('POST', '/admin/invoices/I1/resend', () => new Response(null, { status: 202 })),
    ],
    { session: adminSession(role) },
  );
}

describe('billing + invoice drawer (34:859, 36:1598)', () => {
  it('tabs and method map to filters; no Failed/Retrying/Refunded tabs', async () => {
    const api = billingApi('super_admin', 'open');
    renderApp(<AppRoutes />, { route: '/billing' });
    expect(await screen.findByText('SP-2026-000123')).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Invoice status' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['All', 'Open', 'Paid', 'Void']);
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Paid' }));
    await userEvent.selectOptions(screen.getByLabelText('Method'), 'manual');
    await waitFor(() => {
      const p = api.find('GET', '/admin/invoices').at(-1)!.url.searchParams;
      expect(p.get('filter[status]')).toBe('paid');
      expect(p.get('filter[provider]')).toBe('manual');
    });
  });

  it('open invoice: More menu has Mark paid, Void, Resend (billing role); mark paid sends reference + Idempotency-Key', async () => {
    const api = billingApi('billing', 'open');
    renderApp(<AppRoutes />, { route: '/billing?invoice=I1' });
    const drawer = await screen.findByRole('dialog', {
      name: 'SP-2026-000123',
    });
    expect(within(drawer).queryByRole('button', { name: 'Refund' })).toBeNull();
    await userEvent.click(
      await within(drawer).findByRole('button', {
        name: 'More invoice actions',
      }),
    );
    const items = within(drawer)
      .getAllByRole('menuitem')
      .map((m) => m.textContent);
    expect(items.join('|')).toMatch(/Mark paid.*\|Void.*\|Resend/);
    await userEvent.click(within(drawer).getByRole('menuitem', { name: /Mark paid/ }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Mark SP-2026-000123 paid',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark paid' }));
    expect(await within(dialog).findByText('Enter the payment reference')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Payment reference'), 'BANK-889');
    await userEvent.type(within(dialog).getByLabelText(/Internal reason/), 'Paid by bank transfer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expect(api.find('POST', '/admin/invoices/I1/mark-paid')).toHaveLength(1));
    const call = api.find('POST', '/admin/invoices/I1/mark-paid')[0]!;
    expect(call.body).toEqual({
      reference: 'BANK-889',
      reason: 'Paid by bank transfer',
    });
    expect(call.headers['Idempotency-Key']).toBeTruthy();
  });

  it('paid invoice only offers Resend; read-only has no menu', async () => {
    billingApi('billing', 'paid');
    const first = renderApp(<AppRoutes />, { route: '/billing?invoice=I1' });
    const drawer = await screen.findByRole('dialog', {
      name: 'SP-2026-000123',
    });
    await userEvent.click(
      await within(drawer).findByRole('button', {
        name: 'More invoice actions',
      }),
    );
    expect(
      within(drawer)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual([expect.stringMatching(/^Resend/)]);
    first.unmount();

    billingApi('read_only', 'open');
    renderApp(<AppRoutes />, { route: '/billing?invoice=I1' });
    const d2 = await screen.findByRole('dialog', { name: 'SP-2026-000123' });
    expect(await within(d2).findByText('Payment attempts')).toBeInTheDocument();
    expect(within(d2).queryByRole('button', { name: 'More invoice actions' })).toBeNull();
  });

  it('empty state', async () => {
    mockApi([on('GET', '/admin/invoices', () => emptyList())]);
    renderApp(<AppRoutes />, { route: '/billing' });
    expect(await screen.findByText('No invoices yet')).toBeInTheDocument();
  });
});

const domain = (status: string) => ({
  id: 'D1',
  hostname: 'gadgethaat.com.bd',
  tenant: shop,
  kind: 'custom',
  status,
  failure_code: null,
  is_primary: true,
  dns_ok: true,
  ssl_ok: true,
  last_checked_at: null,
  created_at: 'x',
});

describe('domains (45:8156)', () => {
  it('chips map to filter[state]; menu per role', async () => {
    const api = mockApi(
      [
        on('GET', '/admin/domains', () =>
          jsonResponse(200, {
            data: [domain('active')],
            meta: { current_page: 1, per_page: 25, total: 1, last_page: 1 },
          }),
        ),
      ],
      { session: adminSession('support') },
    );
    renderApp(<AppRoutes />, { route: '/domains' });
    expect(await screen.findByText('gadgethaat.com.bd')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Expiring/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'SSL failing' }));
    await waitFor(() => expect(api.find('GET', '/admin/domains').at(-1)!.url.searchParams.get('filter[state]')).toBe('ssl_failing'));
    await userEvent.click(screen.getByRole('button', { name: 'Actions for gadgethaat.com.bd' }));
    expect(screen.getByRole('menuitem', { name: /Re-check/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Suspend/ })).toBeNull();
  });

  it('suspend needs a reason (super admin)', async () => {
    const api = mockApi(
      [
        on('GET', '/admin/domains', () =>
          jsonResponse(200, {
            data: [domain('active')],
            meta: { current_page: 1, per_page: 25, total: 1, last_page: 1 },
          }),
        ),
        on('POST', '/admin/domains/D1/suspend', () => jsonResponse(200, { data: domain('suspended') })),
      ],
      { session: adminSession('super_admin') },
    );
    renderApp(<AppRoutes />, { route: '/domains' });
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Actions for gadgethaat.com.bd',
      }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: /Suspend/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend domain' }));
    expect(await within(dialog).findByText('Enter a reason of at least 5 characters')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Internal reason/), 'Phishing page reported');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend domain' }));
    await waitFor(() =>
      expect(api.find('POST', '/admin/domains/D1/suspend')[0]?.body).toEqual({
        reason: 'Phishing page reported',
      }),
    );
  });
});

const teamMeta = {
  counts: { all: 2, active: 1, invited: 1, disabled: 0 },
  matrix: {
    roles: ['super_admin', 'billing', 'support', 'read_only'],
    permissions: ['view_merchants', 'impersonate', 'manage_billing', 'manage_domains', 'suspend', 'manage_team'],
    grants,
  },
  security: {
    totp_required: true,
    ip_allowlist_enabled: false,
    session_idle_minutes: 30,
    impersonation_minutes: 15,
  },
};
const staff = [
  {
    id: 'U1',
    kind: 'user',
    name: 'Sadia Ahmed',
    email: 'sadia@storeplix.com',
    role: 'super_admin',
    status: 'active',
    totp_enrolled: true,
    invited_at: null,
    expires_at: null,
  },
  {
    id: 'U2',
    kind: 'user',
    name: 'Rafiq Islam',
    email: 'rafiq@storeplix.com',
    role: 'billing',
    status: 'active',
    totp_enrolled: false,
    invited_at: null,
    expires_at: null,
  },
  {
    id: 'INV1',
    kind: 'invitation',
    name: null,
    email: 'new@storeplix.com',
    role: 'support',
    status: 'invited',
    totp_enrolled: false,
    invited_at: 'x',
    expires_at: '2026-11-30T00:00:00Z',
  },
];

describe('team & roles (39:12019, 45:9344)', () => {
  it('read-only matrix and security card; invite hidden without manage_team', async () => {
    mockApi([on('GET', '/admin/team', () => jsonResponse(200, { data: staff, meta: teamMeta }))], { session: adminSession('billing', { id: 'U2' }) });
    renderApp(<AppRoutes />, { route: '/team' });
    expect(await screen.findByText('Rafiq Islam')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite teammate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Billing: allowed' })).toHaveLength(2);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /New role|Save permissions/ })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Require 2FA' })).toBeDisabled();
    expect(screen.getByText('30 minutes')).toBeInTheDocument();
  });

  it('invite validates the email and posts email + role', async () => {
    const api = mockApi(
      [
        on('GET', '/admin/team', () => jsonResponse(200, { data: staff, meta: teamMeta })),
        on('POST', '/admin/team/invitations', () =>
          jsonResponse(201, {
            data: {
              id: 'INV2',
              email: 'n@storeplix.com',
              role: 'billing',
              expires_at: 'x',
              created_at: 'x',
            },
          }),
        ),
      ],
      { session: adminSession('super_admin') },
    );
    renderApp(<AppRoutes />, { route: '/team' });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite teammate' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(await within(dialog).findByText('Enter a valid work email')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Work email'), 'n@storeplix.com');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Billing/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() =>
      expect(api.find('POST', '/admin/team/invitations')[0]?.body).toEqual({
        email: 'n@storeplix.com',
        role: 'billing',
      }),
    );
  });

  it('no self actions; other members get role/2FA/disable; invitations get revoke', async () => {
    mockApi([on('GET', '/admin/team', () => jsonResponse(200, { data: staff, meta: teamMeta }))], { session: adminSession('super_admin') });
    renderApp(<AppRoutes />, { route: '/team' });
    await screen.findByText('Rafiq Islam');
    expect(screen.queryByRole('button', { name: 'Actions for sadia@storeplix.com' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for rafiq@storeplix.com' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent?.split(/(?=[A-Z][a-z]+ [a-z])/)[0])).toEqual(
      expect.arrayContaining([expect.stringMatching(/Change role/), expect.stringMatching(/Reset 2FA/), expect.stringMatching(/Disable/)]),
    );
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for new@storeplix.com' }));
    expect(screen.getByRole('menuitem', { name: /Revoke invitation/ })).toBeInTheDocument();
  });
});

const entry = (id: string, imp = false) => ({
  id,
  action: imp ? 'admin.impersonation_started' : 'subscription.plan_comped',
  actor: {
    type: 'platform_user',
    id: 'U1',
    name: 'Sadia Ahmed',
    email: 'sadia@storeplix.com',
  },
  tenant: shop,
  subject: null,
  reason: 'Ticket TK-1',
  ip: '103.112.54.21',
  user_agent: 'Chrome',
  meta: { plan: 'growth' },
  impersonation_id: imp ? 'IM1' : null,
  created_at: '2026-11-19T05:42:08Z',
});

describe('audit log (39:16118)', () => {
  it('impersonations-only toggle maps to filter[impersonation]=1; rows expand with Copy JSON; no hash chain UI', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const api = mockApi([on('GET', '/admin/audit-logs', () => cursorList([entry('E1'), entry('E2', true)]))]);
    renderApp(<AppRoutes />, { route: '/audit-log' });
    expect(await screen.findByText('Changed plan')).toBeInTheDocument();
    expect(screen.queryByText(/Verify chain|Export CSV|hash-chained/)).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Impersonations only' }));
    await waitFor(() => expect(api.find('GET', '/admin/audit-logs').at(-1)!.url.searchParams.get('filter[impersonation]')).toBe('1'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Show details' })[0]!);
    expect(screen.getByText('E1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(JSON.parse((writeText.mock.calls[0] as unknown as [string])[0]).id).toBe('E1');
  });

  it('actor and action filters', async () => {
    const api = mockApi([on('GET', '/admin/audit-logs', () => cursorList([]))]);
    renderApp(<AppRoutes />, { route: '/audit-log' });
    expect(await screen.findByText('No events yet')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Actor'), 'platform_user');
    await userEvent.selectOptions(screen.getByLabelText('Action type'), 'billing.');
    await waitFor(() => {
      const p = api.find('GET', '/admin/audit-logs').at(-1)!.url.searchParams;
      expect(p.get('filter[actor_type]')).toBe('platform_user');
      expect(p.get('filter[action]')).toBe('billing.');
    });
  });
});

describe('impersonations page', () => {
  it('revoke for super admins only, with a reason', async () => {
    const row = {
      id: 'IM1',
      status: 'active',
      staff: { id: 'U3', name: 'Farhana Akter', email: 'f@storeplix.com' },
      tenant: shop,
      reason: 'Check orders',
      ticket_ref: null,
      started_at: 'x',
      expires_at: 'y',
      ended_at: null,
      ended_by: null,
      request_count: 4,
      created_at: 'x',
    };
    const list = on('GET', '/admin/impersonations', () =>
      jsonResponse(200, {
        data: [row],
        meta: { current_page: 1, per_page: 25, total: 1, last_page: 1 },
      }),
    );
    mockApi([list], { session: adminSession('support') });
    const first = renderApp(<AppRoutes />, { route: '/impersonations' });
    expect(await screen.findByText('Farhana Akter')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    first.unmount();

    const api = mockApi([list, on('POST', '/admin/impersonations/IM1/revoke', () => jsonResponse(200, { data: { ...row, status: 'ended' } }))]);
    renderApp(<AppRoutes />, { route: '/impersonations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Internal reason/), 'Session no longer needed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke session' }));
    await waitFor(() => expect(api.find('POST', '/admin/impersonations/IM1/revoke')[0]?.body).toEqual({ reason: 'Session no longer needed' }));
    expect(api.find('GET', '/admin/impersonations')[0]!.url.searchParams.get('filter[status]')).toBe('active');
  });
});

describe('top bar', () => {
  it('global search groups shops, domains and invoices', async () => {
    const api = mockApi([
      on('GET', '/admin/overview', () => jsonResponse(500, { error: { code: 'x', message: 'x' } })),
      on('GET', '/admin/search', () =>
        jsonResponse(200, {
          data: {
            tenants: [{ ...tenant(), suspension: undefined }],
            domains: [domain('active')],
            invoices: [invoiceSummary('open')],
          },
        }),
      ),
    ]);
    renderApp(<AppRoutes />, { route: '/' });
    await userEvent.type(await screen.findByRole('combobox', { name: 'Search' }), 'g');
    expect(await screen.findByText('Type at least 2 characters.')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox', { name: 'Search' }), 'ad');
    const list = await screen.findByRole('listbox', { name: 'Search results' });
    expect(await within(list).findByRole('group', { name: 'Shops' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'Domains' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'Invoices' })).toBeInTheDocument();
    expect(api.find('GET', '/admin/search').at(-1)!.url.searchParams.get('q')).toBe('gad');
  });

  it('dashboard error state and needs-attention box', async () => {
    mockApi([
      on('GET', '/admin/overview', () =>
        jsonResponse(200, {
          data: {
            tenants: { total: 10, active: 9, suspended: 1 },
            subscriptions: {
              paying: 4,
              trialing: 2,
              free: 3,
              past_due: 2,
              by_plan: [],
            },
            past_due: { count: 2, amount: 99800, currency: 'BDT' },
            open_invoices: 2,
            domains: { active: 1, pending: 0, failing: 1, suspended: 0 },
            active_impersonations: 0,
            newest_tenants: [],
          },
        }),
      ),
    ]);
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('4 paying · 3 free')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /2 subscriptions past due/ })).toHaveAttribute('href', '/merchants?tab=past_due');
    expect(screen.getByText('1 custom domain failing')).toBeInTheDocument();
    expect(screen.queryByText(/impersonation/)).toBeNull();
    expect(screen.queryByText(/MRR|GMV|churn/i)).toBeNull();
  });
});

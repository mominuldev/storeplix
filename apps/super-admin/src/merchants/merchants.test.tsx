import type { PlatformRole } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { adminSession, cursorList, subscription, emptyList, jsonResponse, mockApi, on, renderApp, tenant } from '../test/utils';

const summary = { ...tenant(), suspension: undefined } as unknown as ReturnType<typeof tenant>;
const counts = { all: 12, paying: 5, trial: 4, past_due: 2, suspended: 1 };
const listOk = on('GET', '/admin/tenants', () =>
  jsonResponse(200, {
    data: [summary],
    meta: { current_page: 1, per_page: 25, total: 1, last_page: 1, counts },
  }),
);

function detailApi(role: PlatformRole, t = tenant()) {
  return mockApi(
    [
      on('GET', '/admin/tenants/T1', () => jsonResponse(200, { data: t })),
      on('GET', '/admin/tenants/T1/invoices', () => emptyList()),
      on('GET', '/admin/tenants/T1/audit-logs', () => cursorList()),
    ],
    { session: adminSession(role) },
  );
}

describe('merchants list (32:5527)', () => {
  it('shows tab counts and maps tabs, plan, signed-up and search to filter[...] params and the URL', async () => {
    const api = mockApi([listOk]);
    renderApp(<AppRoutes />, { route: '/merchants' });
    expect(await screen.findByText('Gadget Haat')).toBeInTheDocument();
    expect(screen.getByText('12 shops · 5 paying')).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Merchant status' });
    expect(within(tabs).getByRole('tab', { name: /Past due\s*2/ })).toBeInTheDocument();

    await userEvent.click(within(tabs).getByRole('tab', { name: /Trial/ }));
    await waitFor(() => expect(api.find('GET', '/admin/tenants').at(-1)!.url.searchParams.get('filter[status]')).toBe('trial'));

    await userEvent.selectOptions(screen.getByLabelText('Plan'), 'growth');
    await waitFor(() => expect(api.find('GET', '/admin/tenants').at(-1)!.url.searchParams.get('filter[plan]')).toBe('growth'));

    await userEvent.selectOptions(screen.getByLabelText('Signed up'), '30');
    await waitFor(() => expect(api.find('GET', '/admin/tenants').at(-1)!.url.searchParams.get('filter[created_from]')).toMatch(/^\d{4}-\d{2}-\d{2}$/));

    await userEvent.type(screen.getByLabelText('Search shop, owner, phone or domain'), '01912');
    await waitFor(() => expect(api.find('GET', '/admin/tenants').at(-1)!.url.searchParams.get('filter[q]')).toBe('01912'));
    const last = api.find('GET', '/admin/tenants').at(-1)!.url.searchParams;
    expect(last.get('filter[status]')).toBe('trial');
    expect(last.get('filter[plan]')).toBe('growth');
  });

  it('has no hidden columns, checkboxes, Export or Add merchant', async () => {
    mockApi([listOk]);
    renderApp(<AppRoutes />, { route: '/merchants' });
    await screen.findByText('Gadget Haat');
    for (const h of ['Shop', 'Owner', 'Plan', 'Status', 'Signed up']) expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    for (const h of [/MRR/, /GMV/, /Health/, /Last active/, /Orders/]) expect(screen.queryByRole('columnheader', { name: h })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Export|Add merchant/ })).toBeNull();
  });

  it('empty, error and loading states', async () => {
    mockApi([
      on('GET', '/admin/tenants', () =>
        emptyList({
          counts: { all: 0, paying: 0, trial: 0, past_due: 0, suspended: 0 },
        }),
      ),
    ]);
    const first = renderApp(<AppRoutes />, { route: '/merchants' });
    expect(await screen.findByText('No merchants yet')).toBeInTheDocument();
    first.unmount();

    mockApi([on('GET', '/admin/tenants', () => jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }))]);
    const second = renderApp(<AppRoutes />, { route: '/merchants' });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    second.unmount();

    mockApi([on('GET', '/admin/tenants', () => undefined as never)]);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/admin/tenants') ? new Promise(() => undefined) : Promise.resolve(jsonResponse(200, { data: adminSession() })),
      ),
    );
    renderApp(<AppRoutes />, { route: '/merchants' });
    expect(await screen.findByRole('status', { name: 'Loading merchants' })).toBeInTheDocument();
  });

  it('row menu offers Impersonate only with the permission', async () => {
    mockApi([listOk], { session: adminSession('billing') });
    renderApp(<AppRoutes />, { route: '/merchants' });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Gadget Haat' }));
    expect(screen.getByRole('menuitem', { name: /Open/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Impersonate/ })).toBeNull();
  });
});

describe('merchant detail actions per role (§2.1)', () => {
  const cases: [PlatformRole, string[], string[]][] = [
    ['super_admin', ['Change plan', 'Extend period', 'Suspend', 'Impersonate'], []],
    ['billing', ['Change plan', 'Extend period'], ['Suspend', 'Impersonate']],
    ['support', ['Impersonate'], ['Change plan', 'Extend period', 'Suspend']],
    ['read_only', [], ['Change plan', 'Extend period', 'Suspend', 'Impersonate']],
  ];
  it.each(cases)('%s', async (role, visible, hidden) => {
    detailApi(role, tenant({ subscription: subscription() }));
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    expect(await screen.findByRole('heading', { name: 'Gadget Haat' })).toBeInTheDocument();
    for (const name of visible) expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
    for (const name of hidden) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Impersonate shop' }) !== null).toBe(role === 'super_admin' || role === 'support');
  });

  it('shows Reactivate instead of Suspend for a suspended shop and only the Lifetime paid KPI', async () => {
    detailApi(
      'super_admin',
      tenant({
        status: 'suspended',
        suspension: {
          suspended_at: '2026-11-20T00:00:00Z',
          reason_code: 'fraud',
          store_status_before: 'active',
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
    expect(screen.getByText(/Suspended .* · Fraud reports/)).toBeInTheDocument();
    expect(screen.getByText('Lifetime paid')).toBeInTheDocument();
    for (const k of ['MRR', 'Health score', 'GMV · 30d']) expect(screen.queryByText(k)).toBeNull();
    expect(screen.queryByRole('tab', { name: /Orders|Integrations|Notes/ })).toBeNull();
  });
});

describe('dialogs', () => {
  it('Suspend validates reason code, reason and type-to-confirm, then posts the body', async () => {
    const api = detailApi('super_admin');
    api.fetchMock.mockClear();
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/90 days/)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend merchant' }));
    expect(await within(dialog).findByText('Choose a reason')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a reason of at least 5 characters')).toBeInTheDocument();
    expect(within(dialog).getByText('Type the shop name exactly to confirm')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('radio', { name: /Fraud reports/ }));
    await userEvent.type(within(dialog).getByLabelText(/Internal reason/), 'Chargebacks from 14 buyers');
    await userEvent.type(within(dialog).getByLabelText('Type Gadget Haat to confirm'), 'Gadget Hat');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend merchant' }));
    expect(await within(dialog).findByText('Type the shop name exactly to confirm')).toBeInTheDocument();
    expect(api.find('POST', '/admin/tenants/T1/suspend')).toHaveLength(0);

    await userEvent.clear(within(dialog).getByLabelText('Type Gadget Haat to confirm'));
    await userEvent.type(within(dialog).getByLabelText('Type Gadget Haat to confirm'), 'Gadget Haat');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend merchant' }));
    await waitFor(() => expect(api.find('POST', '/admin/tenants/T1/suspend')).toHaveLength(1));
    expect(api.find('POST', '/admin/tenants/T1/suspend')[0]!.body).toEqual({
      reason_code: 'fraud',
      reason: 'Chargebacks from 14 buyers',
      notify: true,
    });
  });

  it('Change plan requires a reason, has no "Charge today", and sends an Idempotency-Key', async () => {
    const api = detailApi('billing');
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Change plan' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/Charge today/)).toBeNull();
    await userEvent.click(await within(dialog).findByRole('radio', { name: /Growth/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm plan change' }));
    expect(await within(dialog).findByText('Enter a reason of at least 5 characters')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Internal reason/), 'Comp after outage');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm plan change' }));
    await waitFor(() => expect(api.find('POST', '/admin/tenants/T1/billing/change-plan')).toHaveLength(1));
    const call = api.find('POST', '/admin/tenants/T1/billing/change-plan')[0]!;
    expect(call.headers['Idempotency-Key']).toMatch(/.{8,}/);
    expect(call.body).toEqual({
      plan_code: 'growth',
      interval: 'month',
      effective: 'now',
      reason: 'Comp after outage',
      notify: true,
    });
    expect(api.find('POST', '/admin/tenants/T1/billing/quote')[0]!.body).toEqual({ plan_code: 'growth', interval: 'month', effective: 'now' });
  });

  it('Extend validates 1–90 days', async () => {
    const api = detailApi(
      'billing',
      tenant({
        subscription_status: 'trialing',
        trial_ends_at: '2026-12-01T00:00:00Z',
        subscription: subscription(),
      }),
    );
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Extend trial' }));
    const dialog = await screen.findByRole('dialog');
    const days = within(dialog).getByLabelText('Days');
    await userEvent.clear(days);
    await userEvent.type(days, '120');
    await userEvent.type(within(dialog).getByLabelText(/Internal reason/), 'Goodwill extension');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Extend trial' }));
    expect(await within(dialog).findByText('At most 90 days')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '30 days' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Extend trial' }));
    await waitFor(() => expect(api.find('POST', '/admin/tenants/T1/subscription/extend')).toHaveLength(1));
    expect(api.find('POST', '/admin/tenants/T1/subscription/extend')[0]!.body).toEqual({ days: 30, reason: 'Goodwill extension' });
  });

  it('Impersonate requires a reason and opens the ticket URL in a new tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const api = mockApi(
      [
        on('GET', '/admin/tenants/T1', () => jsonResponse(200, { data: tenant() })),
        on('GET', '/admin/tenants/T1/invoices', () => emptyList()),
        on('GET', '/admin/tenants/T1/audit-logs', () => cursorList()),
        on('POST', '/admin/tenants/T1/impersonations', () =>
          jsonResponse(201, {
            data: {
              id: 'IM1',
              url: 'http://localhost:5173/impersonate#ticket=abc',
              ticket_expires_at: 'x',
            },
          }),
        ),
      ],
      { session: adminSession('support') },
    );
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Impersonate' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Read-only')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start read-only session' }));
    expect(await within(dialog).findByText('Enter a reason of at least 5 characters')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Check courier booking');
    await userEvent.type(within(dialog).getByLabelText('Support ticket (optional)'), 'TK-4821');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start read-only session' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('http://localhost:5173/impersonate#ticket=abc', '_blank', 'noopener,noreferrer'));
    expect(api.find('POST', '/admin/tenants/T1/impersonations')[0]!.body).toEqual({ reason: 'Check courier booking', ticket_ref: 'TK-4821' });
    expect(await screen.findByRole('link', { name: /Open the merchant dashboard/ })).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

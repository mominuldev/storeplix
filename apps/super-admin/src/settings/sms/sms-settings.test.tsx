import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../App';
import { session } from '../../lib/session';
import { adminSession, cursorList, jsonResponse, mockApi, on, renderApp } from '../../test/utils';
import { audiences, broadcast, drivers, estimate, logEntry, messageTypes, messageTypesMeta, noneOverview, overview, provider } from './fixtures';

// PHASE-8-9B §14 Admin (Vitest): tab routing + gating, provider tab per source, configure drawer, manage/rotate,
// remove, balance, message types + editor, broadcasts + confirm, log filters + CSV, shell banner.

const dashboard = {
  tenants: { total: 0, active: 0, suspended: 0 },
  subscriptions: { paying: 0, trialing: 0, free: 0, past_due: 0, by_plan: [] },
  past_due: { count: 0, amount: 0, currency: 'BDT' },
  open_invoices: 0,
  domains: { active: 0, pending: 0, failing: 0, suspended: 0 },
  active_impersonations: 0,
  newest_tenants: [],
};
const ok = (data: unknown) => () => jsonResponse(200, { data });
const base = [
  on('GET', '/admin/overview', ok(dashboard)),
  on('GET', '/admin/sms/alerts', ok([])),
  on('GET', '/admin/sms/drivers', ok(drivers)),
  on('GET', '/admin/settings/security', ok({ staff_two_factor_required: true, environment_default: true, source: 'environment', updated_at: null, updated_by: null })),
];
const err = (status: number, code: string, details?: unknown) => () => jsonResponse(status, { error: { code, message: code, details } });

beforeEach(() => {
  session.start({ expires_at: new Date(Date.now() + 3600_000).toISOString() });
});

describe('Routing and permission', () => {
  it('Platform settings nav has SMS provider; unknown tab → provider', async () => {
    mockApi([...base, on('GET', '/admin/sms/providers', ok(overview()))]);
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=bogus' });
    expect(await screen.findByRole('heading', { name: 'SMS provider', level: 1 })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('link', { name: /SMS provider/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tab', { name: 'Provider' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('SMS gateway')).toBeInTheDocument();
  });

  it.each(['support', 'billing', 'read_only'] as const)('%s cannot open /settings/sms and never calls the SMS API', async (role) => {
    const api = mockApi(base, { session: adminSession(role) });
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=log' });
    expect(await screen.findByText('You can’t open platform settings')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.url.pathname.includes('/admin/sms/'))).toHaveLength(0);
    expect(screen.queryByTestId('platform-sms-banner')).toBeNull();
  });

  it('shell banner shows the most severe alert with a link', async () => {
    mockApi([
      on('GET', '/admin/sms/alerts', ok([
        { code: 'low_balance', severity: 'warning', message: 'Gateway balance is low', provider_id: 'PR1' },
        { code: 'no_provider', severity: 'danger', message: 'No SMS provider — sign-in codes will fail', provider_id: null },
      ])),
      ...base,
    ]);
    renderApp(<AppRoutes />, { route: '/' });
    const banner = await screen.findByTestId('platform-sms-banner');
    expect(banner).toHaveTextContent('No SMS provider — sign-in codes will fail');
    expect(within(banner).getByRole('link', { name: 'Open SMS provider' })).toHaveAttribute('href', '/settings/sms?tab=provider');
  });
});

describe('Provider tab', () => {
  it('source none: red banner, setup empty state and what is waiting', async () => {
    mockApi([...base, on('GET', '/admin/sms/providers', ok(noneOverview()))]);
    renderApp(<AppRoutes />, { route: '/settings/sms' });
    expect(await screen.findByText('Set up an SMS provider')).toBeInTheDocument();
    expect(screen.getAllByText('No SMS provider — sign-in codes will fail').length).toBeGreaterThan(0);
    expect(screen.getByText('48 queued')).toBeInTheDocument();
    expect(screen.getByText('7 failed')).toBeInTheDocument();
    expect(screen.getByText('Platform SMS wait 30 minutes, sign-in codes 5 minutes, then fail.')).toBeInTheDocument();
  });

  it('source environment: read-only env card with hints only', async () => {
    mockApi([
      ...base,
      on('GET', '/admin/sms/providers', ok(overview({ source: 'environment', primary: null, environment: { driver: 'revesms', caller_id: 'Storeplix', credentials_hint: { api_key: '••••9z1k' } } }))),
    ]);
    renderApp(<AppRoutes />, { route: '/settings/sms' });
    expect(await screen.findByText('REVE SMS (server environment)')).toBeInTheDocument();
    expect(screen.getByText(/9z1k/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure provider' })).toBeInTheDocument();
  });

  it('database: primary tile, failover slot, masked credentials, low balance and recent errors', async () => {
    const api = mockApi([...base, on('GET', '/admin/sms/providers', ok(overview()))]);
    renderApp(<AppRoutes />, { route: '/settings/sms' });
    expect(await screen.findByText('Primary route')).toBeInTheDocument();
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add failover' })).toBeInTheDocument();
    expect(screen.getAllByText(/3f9a/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Last rotated 2 Nov 2026 by Rafiq Islam/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('balance-amount')).toHaveTextContent('৳ 8,420');
    expect(screen.getByText(/Balance is below your ৳ 10,000 alert/)).toBeInTheDocument();
    expect(screen.getByText('Invalid number')).toBeInTheDocument();
    expect(screen.getByText('01711-•••234')).toBeInTheDocument();
    // Alert switch → PATCH with the revision.
    api.fetchMock.mockClear();
    await userEvent.click(screen.getByRole('switch', { name: 'Email super admins' }));
    await waitFor(() => expect(api.find('PATCH', '/admin/sms/providers/PR1')[0]?.body).toEqual({ revision: 4, alert_email: false }));
  });

  it('unsupported balance shows the provider note', async () => {
    mockApi([...base, on('GET', '/admin/sms/providers', ok(overview({ primary: provider({ balance: { ...provider().balance, status: 'unsupported', amount_paisa: null } }) })))]);
    renderApp(<AppRoutes />, { route: '/settings/sms' });
    expect(await screen.findByText('This provider doesn’t report a balance.')).toBeInTheDocument();
  });

  it('remove dialog needs the typed name', async () => {
    const draft = provider({ id: 'PR2', name: 'Alpha Backup', role: 'draft', driver: 'http' });
    const api = mockApi([...base, on('GET', '/admin/sms/providers', ok(overview({ others: [draft] }))), on('POST', '/admin/sms/providers/PR2/remove', ok(overview()))]);
    renderApp(<AppRoutes />, { route: '/settings/sms' });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Alpha Backup?' });
    const confirm = within(dialog).getByRole('button', { name: 'Remove provider' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Type Alpha Backup to confirm'), 'alpha backup');
    await userEvent.click(confirm);
    await waitFor(() => expect(api.find('POST', '/admin/sms/providers/PR2/remove')[0]?.body).toEqual({ confirm_name: 'alpha backup' }));
  });
});

describe('Configure drawer', () => {
  async function toStep2() {
    await userEvent.click(await screen.findByRole('button', { name: 'Configure provider' }));
    const drawer = await screen.findByRole('dialog', { name: /Configure SMS provider/ });
    return drawer;
  }

  it('coming-soon drivers are disabled; fields come from the catalogue; https checked', async () => {
    mockApi([...base, on('GET', '/admin/sms/providers', ok(noneOverview()))]);
    renderApp(<AppRoutes />, { route: '/settings/sms' });
    const drawer = await toStep2();
    expect(await within(drawer).findByRole('radio', { name: /SSL Wireless/ })).toBeDisabled();
    expect(within(drawer).getAllByText('Coming soon')).toHaveLength(3);
    await userEvent.click(within(drawer).getByRole('radio', { name: /REVE SMS/ }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Next' }));
    expect(within(drawer).getByLabelText('API key')).toHaveAttribute('type', 'password');
    expect(within(drawer).getByLabelText('API secret')).toBeInTheDocument();
    const endpoint = within(drawer).getByLabelText('API endpoint');
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'http://smpp.revesms.com');
    expect(within(drawer).getAllByText('Use an https:// address.').length).toBeGreaterThan(0);
  });

  it('full flow: creates a draft, test fails then passes, activation needs the typed name', async () => {
    let testCalls = 0;
    const draft = provider({ id: 'PR9', role: 'draft', last_test: null, test_required: true, revision: 1 });
    const api = mockApi([
      ...base,
      on('GET', '/admin/sms/providers', ok(noneOverview())),
      on('POST', '/admin/sms/providers', () => jsonResponse(201, { data: draft })),
      on('GET', '/admin/sms/providers/PR9', ok(draft)),
      on('POST', '/admin/sms/providers/PR9/test', () => {
        testCalls += 1;
        return jsonResponse(200, {
          data:
            testCalls === 1
              ? { status: 'failed', latency_ms: null, parts: 1, provider_message_id: null, balance_paisa: null, error_code: 'provider_auth', detail: 'Bad key', to_masked: '01711-•••211' }
              : { status: 'passed', latency_ms: 1200, parts: 1, provider_message_id: 'RV-1', balance_paisa: 842000, error_code: null, detail: null, to_masked: '01711-•••211' },
        });
      }),
      on('POST', '/admin/sms/providers/PR9/activate', ok(overview())),
    ]);
    renderApp(<AppRoutes />, { route: '/settings/sms' });
    const drawer = await toStep2();
    await userEvent.click(await within(drawer).findByRole('radio', { name: /REVE SMS/ }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Next' }));
    await userEvent.type(within(drawer).getByLabelText('API key'), 'key-123');
    await userEvent.type(within(drawer).getByLabelText('API secret'), 'secret-456');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Next' }));
    // Step 3: required groups locked on for the primary.
    expect(within(drawer).getByRole('checkbox', { name: 'Registration' })).toBeDisabled();
    expect(within(drawer).getByRole('checkbox', { name: 'Registration' })).toBeChecked();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.find('POST', '/admin/sms/providers')).toHaveLength(1));
    expect(api.find('POST', '/admin/sms/providers')[0]!.body).toMatchObject({
      driver: 'revesms',
      name: 'REVE SMS',
      credentials: { api_key: 'key-123', secret_key: 'secret-456' },
      settings: { base_url: 'https://smpp.revesms.com:7790', http: null },
    });
    const activate = await within(drawer).findByRole('button', { name: 'Activate REVE SMS' });
    expect(activate).toBeDisabled();
    await userEvent.clear(within(drawer).getByLabelText('Send a test SMS to'));
    await userEvent.type(within(drawer).getByLabelText('Send a test SMS to'), '01711555211');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Send test' }));
    expect(await within(drawer).findByText(/Test failed — Credentials refused/)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Check credentials' })).toBeInTheDocument();
    expect(api.find('POST', '/admin/sms/providers/PR9/test')[0]!.body).toEqual({ phone: '8801711555211' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Try again' }));
    expect(await within(drawer).findByText(/Test sent — REVE SMS accepted it in 1.2 s/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Activate REVE SMS' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make REVE SMS the primary provider?' });
    const go = within(dialog).getByRole('button', { name: 'Activate REVE SMS' });
    expect(go).toBeDisabled();
    expect(within(dialog).queryByRole('checkbox')).toBeNull(); // first activation: no "keep as failover"
    await userEvent.type(within(dialog).getByLabelText('Type REVE SMS to confirm'), 'REVE SMS');
    await userEvent.click(go);
    await waitFor(() =>
      expect(api.find('POST', '/admin/sms/providers/PR9/activate')[0]?.body).toEqual({ role: 'primary', confirm_name: 'REVE SMS', keep_previous_as_failover: true }),
    );
  });
});

describe('Manage drawer: rotate', () => {
  it('a failing rotation keeps the old key; a passing one is saved', async () => {
    let rotations = 0;
    const api = mockApi([
      ...base,
      on('GET', '/admin/sms/providers', ok(overview())),
      on('GET', '/admin/sms/providers/PR1', ok(provider())),
      on('POST', '/admin/sms/providers/PR1/rotate', () => {
        rotations += 1;
        return rotations === 1
          ? jsonResponse(422, { error: { code: 'sms_provider_test_failed', message: 'failed', details: { error_code: 'provider_auth', detail: 'Invalid key' } } })
          : jsonResponse(200, { data: provider({ revision: 5, credentials_hint: { api_key: '••••new1', secret_key: '••••new2' } }) });
      }),
    ]);
    renderApp(<AppRoutes />, { route: '/settings/sms' });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Rotate' }))[0]!);
    const drawer = await screen.findByRole('dialog', { name: /REVE SMS/ });
    const form = await within(drawer).findByTestId('rotate-form');
    await userEvent.type(within(form).getByLabelText('API key — new value'), 'new-key-1');
    await userEvent.type(within(form).getByLabelText('API secret — new value'), 'new-secret-2');
    await userEvent.clear(within(form).getByLabelText('Send the test SMS to'));
    await userEvent.type(within(form).getByLabelText('Send the test SMS to'), '01811000111');
    await userEvent.click(within(form).getByRole('button', { name: 'Test and save new key' }));
    await waitFor(() => expect(api.find('POST', '/admin/sms/providers/PR1/rotate')).toHaveLength(1));
    expect(await within(form).findByText(/Nothing was saved; the current credentials keep working/)).toBeInTheDocument();
    expect(api.find('POST', '/admin/sms/providers/PR1/rotate')[0]!.body).toEqual({
      credentials: { api_key: 'new-key-1', secret_key: 'new-secret-2' },
      settings: { account_id: 'STPX-2041', base_url: 'https://smpp.revesms.com/api/v2' },
      phone: '8801811000111',
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Test and save new key' }));
    await waitFor(() => expect(within(drawer).queryByTestId('rotate-form')).toBeNull());
    expect(await screen.findByText(/New key tested and saved/)).toBeInTheDocument();
  });
});

describe('Message types', () => {
  const list = on('GET', '/admin/sms/message-types', () => jsonResponse(200, { data: messageTypes, meta: messageTypesMeta }));

  it('KPIs, locked rows always on, hidden Figma rows, toggle PATCH', async () => {
    const api = mockApi([...base, list, on('PATCH', '/admin/sms/message-types/welcome', ok({ ...messageTypes[0], enabled: false }))]);
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=messages' });
    expect(await screen.findByText('38,214')).toBeInTheDocument();
    const locked = screen.getByTestId('type-phone_verification');
    expect(within(locked).getByText('Always on')).toBeInTheDocument();
    expect(within(locked).queryByRole('switch')).toBeNull();
    expect(within(locked).getByRole('button', { name: 'View' })).toBeInTheDocument();
    for (const hidden of ['New sign-in alert', 'Trial ending offer', 'Win-back', '2-step code']) expect(screen.queryByText(hidden)).toBeNull();
    await userEvent.click(within(screen.getByTestId('type-welcome')).getByRole('switch'));
    await waitFor(() => expect(api.find('PATCH', '/admin/sms/message-types/welcome')[0]?.body).toEqual({ enabled: false }));
  });

  it('editor: chips insert, client problems, debounced preview, 409 reload', async () => {
    const api = mockApi([
      ...base,
      list,
      on('POST', '/admin/sms/message-types/preview', ok({ text: 'preview text', parts: 2, encoding: 'ucs2', characters: 100 })),
      on('PUT', '/admin/sms/message-types/invoice_issued/templates/bn', err(409, 'revision_conflict')),
    ]);
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=messages' });
    await userEvent.click(within(await screen.findByTestId('type-invoice_issued')).getByRole('button', { name: 'Edit' }));
    const drawer = await screen.findByRole('dialog', { name: /Edit template/ });
    const box = within(drawer).getByLabelText('Message') as HTMLTextAreaElement;
    expect(within(drawer).getByText('Edited')).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, 'Pay now ');
    expect(await within(drawer).findByText(/Keep \{invoice_no\}, \{link\}/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: '{invoice_no}' }));
    await userEvent.click(within(drawer).getByRole('button', { name: '{link}' }));
    expect(box.value).toBe('Pay now {invoice_no}{link}');
    await waitFor(() => expect(api.find('POST', '/admin/sms/message-types/preview').length).toBeGreaterThan(0), { timeout: 2000 });
    expect(await within(drawer).findByTestId('template-preview')).toHaveTextContent('preview text');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save template' }));
    expect(await within(drawer).findByText('Someone else changed this template.')).toBeInTheDocument();
    expect(api.find('PUT', '/admin/sms/message-types/invoice_issued/templates/bn')[0]!.body).toEqual({ body: 'Pay now {invoice_no}{link}', revision: 2 });
  });

  it('locked editor is read-only', async () => {
    mockApi([...base, list]);
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=messages' });
    await userEvent.click(within(await screen.findByTestId('type-sign_in_code')).getByRole('button', { name: 'View' }));
    const drawer = await screen.findByRole('dialog', { name: /Template/ });
    expect(within(drawer).getByLabelText('Message')).toHaveAttribute('readonly');
    expect(within(drawer).queryByRole('button', { name: 'Save template' })).toBeNull();
  });
});

describe('Broadcasts', () => {
  const listMeta = { current_page: 1, per_page: 10, total: 1, last_page: 1, kpis: { broadcasts_this_month: 4, sent_success_rate: 98.9, opted_out_total: 312, spend_this_month_paisa: 256_500 } };
  const handlers = (extra: Parameters<typeof mockApi>[0] = []) => [
    ...base,
    ...extra,
    on('GET', '/admin/sms/providers', ok(overview())),
    on('GET', '/admin/sms/broadcasts/audiences', ok(audiences)),
    on('POST', '/admin/sms/broadcasts/estimate', ok(estimate())),
    on('GET', '/admin/sms/broadcasts', () => jsonResponse(200, { data: [broadcast({ status: 'scheduled', counts: { recipients: 1177, sent: 0, failed: 0, skipped: 0, pending: 1177 } })], meta: listMeta })),
  ];

  async function compose() {
    await userEvent.type(await screen.findByLabelText('Name (only admins see it)'), 'Eid offer');
    const box = screen.getByLabelText('Message');
    await userEvent.type(box, 'ঈদ অফার!');
    await userEvent.click(screen.getByRole('button', { name: /English/ }));
    await userEvent.type(screen.getByLabelText('Message'), 'Eid offer!');
    await userEvent.click(screen.getByRole('radio', { name: /By plan/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Starter · 1,284/ }));
  }

  it('STOP footer, estimate warning, schedule hours check, typed-count confirm and 409 refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-28T04:00:00Z') });
    let schedules = 0;
    const api = mockApi(
      handlers([
        on('POST', '/admin/sms/broadcasts', () => jsonResponse(201, { data: broadcast({ id: 'B9', revision: 1 }) })),
        on('POST', '/admin/sms/broadcasts/B9/schedule', () => {
          schedules += 1;
          return schedules === 1
            ? jsonResponse(409, { error: { code: 'broadcast_estimate_changed', message: 'changed', details: estimate({ recipients: 1170 }) } })
            : jsonResponse(200, { data: broadcast({ id: 'B9', status: 'scheduled' }) });
        }),
      ]),
    );
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=broadcasts' });
    expect(await screen.findByText('98.9%')).toBeInTheDocument();
    expect(screen.getByTestId('stop-footer')).toHaveTextContent('বন্ধ করতে: {link}');
    await compose();
    expect(screen.getByTestId('stop-footer')).toHaveTextContent('STOP: {link}');
    const panel = await screen.findByTestId('broadcast-estimate');
    expect(await within(panel).findByText('1,177 merchants')).toBeInTheDocument();
    expect(within(panel).getByText(/below the low-balance alert/)).toBeInTheDocument();
    await waitFor(() => expect(api.find('POST', '/admin/sms/broadcasts/estimate').at(-1)!.body).toMatchObject({ audience: { kind: 'plan', plans: ['starter'] } }));

    const time = screen.getByLabelText('Time');
    await userEvent.clear(time);
    await userEvent.type(time, '22:00');
    expect(screen.getByText('Promotional SMS can only go out between 9 AM and 9 PM Bangladesh time.')).toBeInTheDocument();
    await userEvent.clear(time);
    await userEvent.type(time, '10:00');

    await userEvent.click(screen.getByRole('button', { name: 'Review and schedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule this broadcast?' });
    expect(api.find('POST', '/admin/sms/broadcasts')[0]!.body).toMatchObject({ name: 'Eid offer', body_bn: 'ঈদ অফার!', body_en: 'Eid offer!', audience: { kind: 'plan', plans: ['starter'] } });
    const go = within(dialog).getByRole('button', { name: /Schedule for/ });
    expect(go).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.type(within(dialog).getByLabelText('Type 1177 to confirm'), '1,177');
    await userEvent.click(go);
    expect(await within(dialog).findByText(/audience changed since the last estimate/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Type 1170 to confirm')).toHaveValue('');
    expect(api.find('POST', '/admin/sms/broadcasts/B9/schedule')[0]!.body).toEqual({ acknowledged: true, confirm_recipients: 1177, revision: 1 });
    await userEvent.type(within(dialog).getByLabelText('Type 1170 to confirm'), '1170');
    await userEvent.click(within(dialog).getByRole('button', { name: /Schedule for/ }));
    await waitFor(() => expect(api.find('POST', '/admin/sms/broadcasts/B9/schedule')[1]?.body).toEqual({ acknowledged: true, confirm_recipients: 1170, revision: 1 }));
    vi.useRealTimers();
  });

  it('past list chips filter by status and Cancel calls the API', async () => {
    const api = mockApi(handlers([on('POST', '/admin/sms/broadcasts/B1/cancel', ok(broadcast({ status: 'cancelled' })))]));
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=broadcasts' });
    await userEvent.click(await screen.findByRole('button', { name: 'Drafts' }));
    await waitFor(() => expect(api.calls.some((c) => c.url.pathname.endsWith('/admin/sms/broadcasts') && c.url.searchParams.get('filter[status]') === 'draft')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    const menus = await screen.findAllByRole('button', { name: 'Actions for Eid offer 2026' });
    await userEvent.click(menus[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Cancel' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel broadcast' }));
    await waitFor(() => expect(api.find('POST', '/admin/sms/broadcasts/B1/cancel')).toHaveLength(1));
  });
});

describe('SMS log', () => {
  it('filters map to the query, codes are hidden, CSV export uses the same filters', async () => {
    const api = mockApi([
      ...base,
      on('GET', '/admin/sms/messages/export', () => new Response('time,phone\n', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="platform-sms-log.csv"' } })),
      on('GET', '/admin/sms/messages', () => cursorList([logEntry(), logEntry({ id: 'M2', type: 'invoice_issued', group: 'billing', body_hidden: false, body_preview: 'Store Plix: Invoice SP-1 [link]', status: 'failed' })])),
    ]);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=log&status=failed' });
    expect((await screen.findAllByTestId('code-hidden')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Store Plix: Invoice SP-1 [link]').length).toBeGreaterThan(0);
    const first = api.find('GET', '/admin/sms/messages')[0]!;
    expect(first.url.searchParams.get('filter[status]')).toBe('failed');
    expect(first.url.searchParams.get('filter[from]')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await userEvent.click(screen.getByRole('button', { name: 'Invoice & billing' }));
    await waitFor(() => expect(api.find('GET', '/admin/sms/messages').some((c) => c.url.searchParams.get('filter[group]') === 'billing')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(api.find('GET', '/admin/sms/messages/export')).toHaveLength(1));
    const exp = api.find('GET', '/admin/sms/messages/export')[0]!;
    expect(exp.url.searchParams.get('filter[group]')).toBe('billing');
    expect(exp.url.searchParams.get('filter[status]')).toBe('failed');
    expect(exp.url.searchParams.get('cursor')).toBeNull();
  });

  it('empty and no-match states', async () => {
    mockApi([...base, on('GET', '/admin/sms/messages', () => cursorList([]))]);
    renderApp(<AppRoutes />, { route: '/settings/sms?tab=log' });
    expect(await screen.findByText('No platform SMS yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Registration' }));
    expect(await screen.findByText('No messages match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No platform SMS yet')).toBeInTheDocument();
  });
});

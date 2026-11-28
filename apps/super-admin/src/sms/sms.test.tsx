import type { AdminSenderIdRequest, AdminSmsCredits, PlatformRole } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { adminSession, cursorList, emptyList, jsonResponse, mockApi, on, renderApp, tenant, type Call } from '../test/utils';
import { adjustPreview, relativeDay, senderIdChecks, signed, usesLabel } from './format';

function request(overrides: Partial<AdminSenderIdRequest> = {}): AdminSenderIdRequest {
  return {
    id: 'SR1',
    sender_id: 'GADGETHAAT',
    status: 'pending',
    business_name: 'Gadget Haat Ltd',
    uses: ['otp', 'order_updates'],
    note: null,
    document: { mime: 'application/pdf', size_bytes: 1_258_291, filename: 'trade-licence-2026.pdf' },
    requested_by: { id: 'O1', name: 'Tanvir Ahmed' } as AdminSenderIdRequest['requested_by'],
    requested_at: '2026-11-24T09:40:00Z',
    reviewed_at: null,
    decision_reason: null,
    tenant: { id: 'T1', name: 'Gadget Haat', slug: 'gadgethaat' },
    requested_by_email: 'tanvir@example.com',
    reviewed_by: null,
    current_sender_id: null,
    ...overrides,
  };
}

const page = (data: unknown[], pending = 4, meta: Record<string, unknown> = {}) =>
  jsonResponse(200, { data, meta: { current_page: 1, per_page: 25, total: data.length, last_page: 1, counts: { pending }, ...meta } });

const credits = (overrides: Partial<AdminSmsCredits> = {}): AdminSmsCredits => ({
  balance: 980,
  status: 'healthy',
  low_credit_threshold: 200,
  used_this_month: 120,
  purchased_total: 5000,
  last_purchase_at: '2026-11-10T04:00:00Z',
  ...overrides,
});

describe('PHASE-8-9A helpers', () => {
  it('labels uses in canonical order', () => {
    expect(usesLabel(['pos_receipts', 'order_updates'])).toBe('Order updates, POS receipts');
    expect(usesLabel([])).toBe('—');
  });

  it('relativeDay counts Dhaka calendar days', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    expect(relativeDay('2026-11-24T09:40:00Z', now)).toBe('Today, 3:40 PM');
    expect(relativeDay('2026-11-23T09:40:00Z', now)).toBe('Yesterday');
    expect(relativeDay('2026-11-21T09:40:00Z', now)).toBe('3 days ago');
    expect(relativeDay(null, now)).toBe('');
  });

  it('adjustPreview validates range and never goes below 0', () => {
    expect(adjustPreview(980, 'grant', '500')).toEqual({ delta: 500, after: 1480, error: null });
    expect(adjustPreview(980, 'deduct', '1,000')).toMatchObject({ delta: -1000, after: -20, error: 'Can’t go below 0 — the shop has 980 purchased credits.' });
    expect(adjustPreview(980, 'grant', '0').error).toMatch(/1 to 10,00,000|1 to 1,000,000/);
    expect(adjustPreview(980, 'grant', '1000001').error).not.toBeNull();
    expect(adjustPreview(980, 'grant', '1.5').error).toBe('Enter a whole number of credits.');
    expect(adjustPreview(980, 'grant', '')).toEqual({ delta: 0, after: 980, error: null });
    expect(signed(-20)).toBe('−20');
    expect(signed(500)).toBe('+500');
  });

  it('senderIdChecks: pattern and name similarity', () => {
    expect(senderIdChecks('GADGETHAAT', 'Gadget Haat', 'x').every((c) => c.ok)).toBe(true);
    const bad = senderIdChecks('ZZZ', 'Gadget Haat', 'Gadget Haat Ltd');
    expect(bad[0]!.ok).toBe(true);
    expect(bad[1]!.ok).toBe(false);
    expect(senderIdChecks('12', 'x', 'y')[0]!.ok).toBe(false);
  });
});

describe('sender ID queue (2087:7872)', () => {
  it('shows the nav badge, pending count, rows and maps tabs, search and page to the query', async () => {
    const api = mockApi([on('GET', '/admin/sender-ids', () => page([request()]))]);
    renderApp(<AppRoutes />, { route: '/sender-ids' });
    expect(await screen.findByRole('heading', { name: 'Sender ID requests' })).toBeInTheDocument();
    expect(await screen.findByText('GADGETHAAT')).toBeInTheDocument();
    expect(screen.getByText('Order updates, OTP codes')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pending review\s*4/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: /Sender ID requests/ })).toHaveTextContent('Sender ID requests, pending 4'));
    const list = () => api.find('GET', '/admin/sender-ids').filter((c) => c.url.searchParams.get('per_page') === '25');
    expect(list().at(-1)!.url.searchParams.get('filter[status]')).toBe('pending');

    await userEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('filter[status]')).toBe('approved'));

    await userEvent.type(screen.getByLabelText('Search shop or sender ID'), 'g');
    await new Promise((r) => setTimeout(r, 400));
    expect(list().at(-1)!.url.searchParams.get('filter[q]')).toBeNull();
    await userEvent.type(screen.getByLabelText('Search shop or sender ID'), 'a');
    await waitFor(() => expect(list().at(-1)!.url.searchParams.get('filter[q]')).toBe('ga'));
  });

  it('paginates', async () => {
    const api = mockApi([on('GET', '/admin/sender-ids', () => page([request()], 30, { total: 30, last_page: 2 }))]);
    renderApp(<AppRoutes />, { route: '/sender-ids' });
    await screen.findByText('GADGETHAAT');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(api.find('GET', '/admin/sender-ids').at(-1)!.url.searchParams.get('page')).toBe('2'));
  });

  it('downloads the licence through the authenticated document endpoint', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const api = mockApi([
      on('GET', '/admin/sender-ids/SR1/document', () => new Response(new Blob(['%PDF']), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="trade-licence-2026.pdf"' } })),
      on('GET', '/admin/sender-ids', () => page([request()])),
    ]);
    renderApp(<AppRoutes />, { route: '/sender-ids' });
    await userEvent.click(await screen.findByRole('button', { name: 'Download trade licence for GADGETHAAT' }));
    await waitFor(() => expect(api.find('GET', '/admin/sender-ids/SR1/document')).toHaveLength(1));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    // Opening the licence never opens the drawer.
    expect(api.find('GET', '/admin/sender-ids/SR1')).toHaveLength(0);
  });

  it('empty, error and loading states', async () => {
    mockApi([on('GET', '/admin/sender-ids', () => emptyList({ counts: { pending: 0 } }))]);
    const first = renderApp(<AppRoutes />, { route: '/sender-ids' });
    expect(await screen.findByText('No requests waiting for review')).toBeInTheDocument();
    first.unmount();

    mockApi([on('GET', '/admin/sender-ids', () => jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }))]);
    const second = renderApp(<AppRoutes />, { route: '/sender-ids' });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    second.unmount();

    mockApi([on('GET', '/admin/sender-ids', () => new Promise<Response>(() => undefined) as unknown as Response)]);
    renderApp(<AppRoutes />, { route: '/sender-ids' });
    expect(await screen.findByRole('status', { name: 'Loading sender ID requests' })).toBeInTheDocument();
  });

  it.each<PlatformRole>(['billing', 'read_only'])('%s: nav item hidden and the route shows no access', async (role) => {
    const api = mockApi([on('GET', '/admin/sender-ids', () => page([request()]))], { session: adminSession(role) });
    renderApp(<AppRoutes />, { route: '/sender-ids' });
    expect(await screen.findByText('You don’t have access to sender ID requests')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Sender ID requests/ })).toBeNull();
    expect(api.find('GET', '/admin/sender-ids')).toHaveLength(0);
  });
});

describe('review drawer (2095:8922)', () => {
  const detail = (r: AdminSenderIdRequest) => on('GET', '/admin/sender-ids/SR1', () => jsonResponse(200, { data: r }));
  const list = on('GET', '/admin/sender-ids', () => page([request()]));

  it('approve needs the REVE tick and a reason', async () => {
    let approveBody: unknown;
    const api = mockApi([
      detail(request()),
      on('POST', '/admin/sender-ids/SR1/approve', (c: Call) => {
        approveBody = c.body;
        return jsonResponse(200, { data: request({ status: 'approved', reviewed_at: '2026-11-25T04:00:00Z' }) });
      }),
      list,
    ]);
    renderApp(<AppRoutes />, { route: '/sender-ids?request=SR1' });
    const drawer = await screen.findByRole('dialog', { name: /GADGETHAAT/ });
    expect(within(drawer).getByText('Similar to the shop name “Gadget Haat”')).toBeInTheDocument();
    expect(within(drawer).getByText('Trade licence · 1.2 MB · PDF')).toBeInTheDocument();
    expect(within(drawer).getByText('Storeplix (platform default)')).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Approve' }));

    const dialog = await screen.findByRole('dialog', { name: 'Approve GADGETHAAT?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText('Confirm the ID is registered and active on REVE SMS first')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a reason of at least 5 characters')).toBeInTheDocument();
    expect(api.find('POST', '/admin/sender-ids/SR1/approve')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.type(within(dialog).getByRole('textbox'), 'Registered on REVE 25 Nov');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveBody).toEqual({ provider_registered: true, reason: 'Registered on REVE 25 Nov' }));
    expect(await screen.findByText(/GADGETHAAT approved/)).toBeInTheDocument();
  });

  it('approve shows a 409 inline', async () => {
    mockApi([
      detail(request()),
      on('POST', '/admin/sender-ids/SR1/approve', () => jsonResponse(409, { error: { code: 'sender_id_taken', message: 'Taken' } })),
      list,
    ]);
    renderApp(<AppRoutes />, { route: '/sender-ids?request=SR1' });
    const drawer = await screen.findByRole('dialog', { name: /GADGETHAAT/ });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve GADGETHAAT?' });
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.type(within(dialog).getByRole('textbox'), 'Registered today');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Another shop already uses or requested this sender ID');
  });

  it('reject requires a reason; a chip fills a merchant-facing one', async () => {
    let body: unknown;
    const api = mockApi([
      detail(request()),
      on('POST', '/admin/sender-ids/SR1/reject', (c: Call) => {
        body = c.body;
        return jsonResponse(200, { data: request({ status: 'rejected' }) });
      }),
      list,
    ]);
    renderApp(<AppRoutes />, { route: '/sender-ids?request=SR1' });
    const drawer = await screen.findByRole('dialog', { name: /GADGETHAAT/ });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Reject' }));
    expect(await within(drawer).findByText('Enter a reason of at least 5 characters')).toBeInTheDocument();
    expect(api.find('POST', '/admin/sender-ids/SR1/reject')).toHaveLength(0);

    await userEvent.click(within(drawer).getByRole('button', { name: 'Licence unreadable' }));
    expect(within(drawer).getByRole('textbox', { name: 'Reason if you reject' })).toHaveValue('We couldn’t read the trade licence. Upload a clear, complete scan or photo and request again.');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(body).toEqual({ reason: 'We couldn’t read the trade licence. Upload a clear, complete scan or photo and request again.' }));
  });

  it('approved requests offer Revoke (reason shown to the merchant), not Approve/Reject', async () => {
    let body: unknown;
    mockApi([
      detail(request({ status: 'approved', reviewed_at: '2026-11-25T04:00:00Z', reviewed_by: { id: 'U1', name: 'Sadia Ahmed' } })),
      on('POST', '/admin/sender-ids/SR1/revoke', (c: Call) => {
        body = c.body;
        return jsonResponse(200, { data: request({ status: 'revoked' }) });
      }),
      list,
    ]);
    renderApp(<AppRoutes />, { route: '/sender-ids?request=SR1' });
    const drawer = await screen.findByRole('dialog', { name: /GADGETHAAT/ });
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Reject' })).toBeNull();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke GADGETHAAT?' });
    expect(within(dialog).getByText('Shown to the merchant · saved to the audit log')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox'), 'BTRC withdrew the mask');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke sender ID' }));
    await waitFor(() => expect(body).toEqual({ reason: 'BTRC withdrew the mask' }));
  });
});

describe('merchant SMS credits (33:5121, §13.2)', () => {
  let keys: string[];
  beforeEach(() => {
    keys = [];
  });
  afterEach(() => vi.restoreAllMocks());

  function creditsApi(role: PlatformRole, adjust?: (c: Call) => Response) {
    return mockApi(
      [
        on('GET', '/admin/tenants/T1', () => jsonResponse(200, { data: tenant({ usage: [{ key: 'orders_per_month', used: 40, limit: 100 }, { key: 'sms_per_month', used: 880, limit: 1000 }] }) })),
        on('GET', '/admin/tenants/T1/sms-credits', () => jsonResponse(200, { data: credits() })),
        on('GET', '/admin/tenants/T1/sms-credits/ledger', () =>
          cursorList([
            { id: 'L1', type: 'admin_adjust', credits: 200, balance_after: 980, created_at: '2026-11-20T04:00:00Z', invoice: null, sms_message_id: null, reason: 'Promotion: bonus SMS credits from Store Plix.' },
            { id: 'L2', type: 'purchase', credits: 1000, balance_after: 780, created_at: '2026-11-10T04:00:00Z', invoice: { id: 'I1', number: 'SP-2026-0042' }, sms_message_id: null, reason: null },
          ]),
        ),
        on('POST', '/admin/tenants/T1/sms-credits/adjust', (c) => {
          keys.push(c.headers['Idempotency-Key'] ?? '');
          return adjust ? adjust(c) : jsonResponse(200, { data: credits({ balance: 980 + (c.body as { credits: number }).credits }) });
        }),
        on('GET', '/admin/tenants/T1/invoices', () => emptyList()),
        on('GET', '/admin/tenants/T1/audit-logs', () => cursorList()),
      ],
      { session: adminSession(role) },
    );
  }

  it('usage row shows allowance, purchased credits and Adjust credits for manage_billing', async () => {
    creditsApi('billing');
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    expect(await screen.findByText('SMS credits')).toBeInTheDocument();
    expect(screen.getByText('880 / 1,000')).toBeInTheDocument();
    expect(await screen.findByText('88% of plan allowance used · 980 purchased credits')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjust credits' })).toBeInTheDocument();
  });

  it.each<PlatformRole>(['support', 'read_only'])('%s sees the credits card and ledger but no Adjust credits', async (role) => {
    creditsApi(role);
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    expect(await screen.findByText('Staff adjustment')).toBeInTheDocument();
    expect(screen.getByText('Promotion: bonus SMS credits from Store Plix.')).toBeInTheDocument();
    expect(screen.getByText('SP-2026-0042')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Below 200')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adjust credits' })).toBeNull();
  });

  it('grant: preview, payload and one Idempotency-Key per open', async () => {
    const api = creditsApi('super_admin');
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    await screen.findByText('Staff adjustment');
    await userEvent.click(screen.getByRole('button', { name: 'Adjust credits' }));
    const dialog = await screen.findByRole('dialog', { name: 'Adjust SMS credits' });
    await userEvent.type(within(dialog).getByLabelText('Credits to grant'), '500');
    expect(within(dialog).getByTestId('adjust-delta')).toHaveTextContent('+500');
    expect(within(dialog).getByText('980 → 1,480')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Service issue/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.find('POST', '/admin/tenants/T1/sms-credits/adjust')).toHaveLength(1));
    expect(api.find('POST', '/admin/tenants/T1/sms-credits/adjust')[0]!.body).toEqual({ credits: 500, reason: 'Service issue: credits for SMS that failed or arrived late.' });
    expect(await screen.findByText('Granted 500 SMS credits · balance 1,480')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Adjust credits' }));
    const again = await screen.findByRole('dialog', { name: 'Adjust SMS credits' });
    await userEvent.type(within(again).getByLabelText('Credits to grant'), '5');
    await userEvent.type(within(again).getByLabelText(/Reason shown to the merchant/), 'Goodwill bonus');
    await userEvent.click(within(again).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('deduct below 0 shows the error and disables Apply; a 422 shows inline and a retry reuses the key', async () => {
    let calls = 0;
    creditsApi('billing', () => {
      calls += 1;
      return jsonResponse(422, { error: { code: 'sms_credits_insufficient', message: 'Insufficient' } });
    });
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    await screen.findByText('Staff adjustment');
    await userEvent.click(screen.getByRole('button', { name: 'Adjust credits' }));
    const dialog = await screen.findByRole('dialog', { name: 'Adjust SMS credits' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Deduct credits/ }));
    const field = within(dialog).getByLabelText('Credits to deduct');
    await userEvent.type(field, '1000');
    expect(within(dialog).getByText('Can’t go below 0 — the shop has 980 purchased credits.')).toBeInTheDocument();
    expect(within(dialog).getByTestId('adjust-delta')).toHaveTextContent('−1,000');
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, '100');
    await userEvent.type(within(dialog).getByLabelText(/Reason shown to the merchant/), 'Correction of an earlier grant');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Can’t go below 0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(keys[0]).toBe(keys[1]);
  });
});

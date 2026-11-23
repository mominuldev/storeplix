import { describe, expect, it, vi } from 'vitest';
import { adminAuditQuery, adminTenantQuery, createApiClient } from './index';

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
      method: init.method,
      body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers: init.headers as Record<string, string>,
    };
  };
  return { client, call, fetchMock };
}

const session = { user: { id: 'U1', name: 'Sadia', email: 's@storeplix.com', platform_role: 'super_admin', permissions: [], totp_enrolled: true, recovery_codes_left: 10 }, session_expires_at: 'x', idle_expires_at: 'y' };

describe('Phase 8.1 admin auth', () => {
  it('login posts only email and password, never X-Tenant-Id', async () => {
    const { client, call } = setup(json(200, { data: { step: 'totp', login_token: 'L', expires_at: 'x' } }));
    const step = await client.admin.auth.login({ email: 'a@b.c', password: 'p', remember: true } as never);
    expect(call().url.pathname).toBe('/api/v1/admin/auth/login');
    expect(call().body).toEqual({ email: 'a@b.c', password: 'p' });
    expect(call().headers['X-Tenant-Id']).toBeUndefined();
    expect(step.step).toBe('totp');
  });

  it('enrollment GET passes the login token; confirm returns the session and recovery codes from meta', async () => {
    const { client, call } = setup(() => json(200, { data: session, meta: { recovery_codes: ['a', 'b'] } }));
    await client.admin.auth.enrollment('LT');
    expect(call(0).url.pathname).toBe('/api/v1/admin/auth/enroll');
    expect(call(0).url.searchParams.get('login_token')).toBe('LT');
    const res = await client.admin.auth.confirmEnrollment('LT', '123456');
    expect(call(1).method).toBe('POST');
    expect(call(1).body).toEqual({ login_token: 'LT', code: '123456' });
    expect(res.recovery_codes).toEqual(['a', 'b']);
    expect(res.session.user.id).toBe('U1');
  });

  it('totp sends either the code or the recovery code', async () => {
    const { client, call } = setup(() => json(200, { data: session }));
    await client.admin.auth.totp({ login_token: 'L', code: '123456' });
    await client.admin.auth.totp({ login_token: 'L', recovery_code: 'ABCDE12345' });
    expect(call(0).body).toEqual({ login_token: 'L', code: '123456' });
    expect(call(1).body).toEqual({ login_token: 'L', recovery_code: 'ABCDE12345' });
  });

  it('surfaces invalid_totp with attempts_left', async () => {
    const { client } = setup(json(422, { error: { code: 'invalid_totp', message: 'Wrong code', details: { attempts_left: 3 } } }));
    await expect(client.admin.auth.totp({ login_token: 'L', code: '000000' })).rejects.toMatchObject({ status: 422, code: 'invalid_totp', details: { attempts_left: 3 } });
  });

  it('me, logout and invitation lookup/accept hit their paths', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.auth.me();
    await client.admin.auth.logout();
    await client.admin.invitations.lookup('tok/en');
    await client.admin.invitations.accept('tok', { name: 'N', password: 'p', password_confirmation: 'p' });
    expect(call(0).url.pathname).toBe('/api/v1/admin/auth/me');
    expect(call(0).headers['X-Tenant-Id']).toBeUndefined();
    expect(call(1).method).toBe('POST');
    expect(call(1).url.pathname).toBe('/api/v1/admin/auth/logout');
    expect(call(2).url.pathname).toBe('/api/v1/admin/invitations/tok%2Fen');
    expect(call(3).url.pathname).toBe('/api/v1/admin/invitations/tok/accept');
    expect(call(3).body).toEqual({ name: 'N', password: 'p', password_confirmation: 'p' });
  });
});

describe('Phase 8.1 admin reads', () => {
  it('tenant filters map to filter[...] params; all/blank are omitted', () => {
    expect(adminTenantQuery({ status: 'all', q: '  ', plan: '' })).toEqual({
      'filter[status]': undefined, 'filter[plan]': undefined, 'filter[q]': undefined, 'filter[created_from]': undefined,
      'filter[created_to]': undefined, sort: undefined, page: undefined, per_page: undefined,
    });
  });

  it('tenants.list returns rows and counts', async () => {
    const meta = { current_page: 1, per_page: 25, total: 1, last_page: 1, counts: { all: 1, paying: 0, trial: 1, past_due: 0, suspended: 0 } };
    const { client, call } = setup(json(200, { data: [{ id: 'T' }], meta }));
    const res = await client.admin.tenants.list({ status: 'trial', plan: 'starter', q: ' 01711 ', created_from: '2026-11-01', created_to: '2026-11-30', sort: 'name', page: 2 });
    const p = call().url.searchParams;
    expect(call().url.pathname).toBe('/api/v1/admin/tenants');
    expect(p.get('filter[status]')).toBe('trial');
    expect(p.get('filter[plan]')).toBe('starter');
    expect(p.get('filter[q]')).toBe('01711');
    expect(p.get('filter[created_from]')).toBe('2026-11-01');
    expect(p.get('filter[created_to]')).toBe('2026-11-30');
    expect(p.get('sort')).toBe('name');
    expect(p.get('page')).toBe('2');
    expect(res.meta.counts.trial).toBe(1);
  });

  it('tenant detail, members, domains, invoices and audit logs', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { next_cursor: 'c2', prev_cursor: null, per_page: 50 } }));
    await client.admin.tenants.get('T1');
    await client.admin.tenants.members('T1');
    await client.admin.tenants.domains('T1');
    await client.admin.tenants.invoices('T1', { status: 'open', page: 2 });
    const audit = await client.admin.tenants.auditLogs('T1', { cursor: 'c1', impersonation: true });
    expect(call(0).url.pathname).toBe('/api/v1/admin/tenants/T1');
    expect(call(1).url.pathname).toBe('/api/v1/admin/tenants/T1/members');
    expect(call(2).url.pathname).toBe('/api/v1/admin/tenants/T1/domains');
    expect(call(3).url.searchParams.get('filter[status]')).toBe('open');
    expect(call(4).url.pathname).toBe('/api/v1/admin/tenants/T1/audit-logs');
    expect(call(4).url.searchParams.get('cursor')).toBe('c1');
    expect(call(4).url.searchParams.get('filter[impersonation]')).toBe('1');
    expect(audit.meta.next_cursor).toBe('c2');
  });

  it('overview, search, invoices, domains, impersonations and team lists', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { counts: {} } }));
    await client.admin.overview();
    await client.admin.search(' gadget ');
    await client.admin.invoices.list({ status: 'paid', provider: 'bkash', q: 'SP-1' });
    await client.admin.domains.list({ state: 'ssl_failing', q: 'shop' });
    await client.admin.impersonations.list({ status: 'active' });
    await client.admin.team.list({ status: 'invited', role: 'billing', q: 'x' });
    await client.admin.auditLogs({ actor_type: 'platform_user', action: 'billing.', from: '2026-11-01', tenant: 'T9' });
    expect(call(0).url.pathname).toBe('/api/v1/admin/overview');
    expect(call(1).url.searchParams.get('q')).toBe('gadget');
    expect(call(2).url.searchParams.get('filter[provider]')).toBe('bkash');
    expect(call(2).url.searchParams.get('filter[status]')).toBe('paid');
    expect(call(3).url.searchParams.get('filter[state]')).toBe('ssl_failing');
    expect(call(4).url.searchParams.get('filter[status]')).toBe('active');
    expect(call(5).url.searchParams.get('filter[role]')).toBe('billing');
    expect(call(6).url.searchParams.get('filter[actor_type]')).toBe('platform_user');
    expect(call(6).url.searchParams.get('filter[tenant]')).toBe('T9');
    expect(adminAuditQuery({ impersonation: false })['filter[impersonation]']).toBeUndefined();
  });

  it('downloads the invoice pdf', async () => {
    const { client, call } = setup(new Response(new Blob(['%PDF']), { status: 200, headers: { 'Content-Disposition': 'attachment; filename="SP-1.pdf"' } }));
    const file = await client.admin.invoices.pdf('I1', 'SP-1');
    expect(call().url.pathname).toBe('/api/v1/admin/invoices/I1/pdf');
    expect(file.filename).toBe('SP-1.pdf');
  });
});

describe('Phase 8.1 admin writes', () => {
  it('suspend, reactivate, quote, change plan (Idempotency-Key), extend, impersonate', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.tenants.suspend('T1', { reason_code: 'fraud', reason: 'Chargebacks', notify: true });
    await client.admin.tenants.reactivate('T1', { reason: 'Paid up', notify: false });
    await client.admin.tenants.quote('T1', { plan_code: 'growth', interval: 'month', effective: 'now' });
    await client.admin.tenants.changePlan('T1', { plan_code: 'growth', interval: 'year', effective: 'next_renewal', reason: 'Asked', notify: true }, 'idem-1');
    await client.admin.tenants.extend('T1', { days: 14, reason: 'Goodwill' });
    await client.admin.tenants.impersonate('T1', { reason: 'Check orders', ticket_ref: '' });
    expect(call(0).url.pathname).toBe('/api/v1/admin/tenants/T1/suspend');
    expect(call(0).body).toEqual({ reason_code: 'fraud', reason: 'Chargebacks', notify: true });
    expect(call(1).body).toEqual({ reason: 'Paid up', notify: false });
    expect(call(2).url.pathname).toBe('/api/v1/admin/tenants/T1/billing/quote');
    expect(call(2).body).toEqual({ plan_code: 'growth', interval: 'month', effective: 'now' });
    expect(call(3).headers['Idempotency-Key']).toBe('idem-1');
    expect(call(3).url.pathname).toBe('/api/v1/admin/tenants/T1/billing/change-plan');
    expect(call(4).url.pathname).toBe('/api/v1/admin/tenants/T1/subscription/extend');
    expect(call(4).body).toEqual({ days: 14, reason: 'Goodwill' });
    expect(call(5).url.pathname).toBe('/api/v1/admin/tenants/T1/impersonations');
    expect(call(5).body).toEqual({ reason: 'Check orders', ticket_ref: null });
    for (let i = 0; i <= 5; i++) expect(call(i).headers['X-Tenant-Id']).toBeUndefined();
  });

  it('invoice mark-paid (Idempotency-Key), void, resend', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.invoices.markPaid('I1', { reference: 'TRX1', reason: 'Bank transfer' }, 'k1');
    await client.admin.invoices.void('I1', 'Duplicate invoice');
    await client.admin.invoices.resend('I1');
    expect(call(0).url.pathname).toBe('/api/v1/admin/invoices/I1/mark-paid');
    expect(call(0).headers['Idempotency-Key']).toBe('k1');
    expect(call(0).body).toEqual({ reference: 'TRX1', reason: 'Bank transfer' });
    expect(call(1).body).toEqual({ reason: 'Duplicate invoice' });
    expect(call(2).url.pathname).toBe('/api/v1/admin/invoices/I1/resend');
    expect(call(2).body).toBeUndefined();
  });

  it('domain recheck/suspend/reinstate and impersonation revoke', async () => {
    const { client, call } = setup(() => json(202, { data: {} }));
    await client.admin.domains.recheck('D1');
    await client.admin.domains.suspend('D1', 'Phishing page');
    await client.admin.domains.reinstate('D1', 'Cleaned up');
    await client.admin.impersonations.revoke('IM1', 'Session too long');
    expect(call(0).url.pathname).toBe('/api/v1/admin/domains/D1/recheck');
    expect(call(1).body).toEqual({ reason: 'Phishing page' });
    expect(call(2).url.pathname).toBe('/api/v1/admin/domains/D1/reinstate');
    expect(call(3).url.pathname).toBe('/api/v1/admin/impersonations/IM1/revoke');
  });

  it('team invite, revoke invitation, role change, disable, enable, reset 2FA', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.team.invite({ email: 'n@storeplix.com', role: 'support' });
    await client.admin.team.revokeInvitation('INV1');
    await client.admin.team.updateRole('U2', { role: 'billing', reason: 'Moved team' });
    await client.admin.team.disable('U2', 'Left company');
    await client.admin.team.enable('U2', 'Came back');
    await client.admin.team.resetTotp('U2', 'Lost phone');
    expect(call(0).url.pathname).toBe('/api/v1/admin/team/invitations');
    expect(call(0).body).toEqual({ email: 'n@storeplix.com', role: 'support' });
    expect(call(1).method).toBe('DELETE');
    expect(call(1).url.pathname).toBe('/api/v1/admin/team/invitations/INV1');
    expect(call(2).method).toBe('PATCH');
    expect(call(2).body).toEqual({ role: 'billing', reason: 'Moved team' });
    expect(call(3).url.pathname).toBe('/api/v1/admin/team/members/U2/disable');
    expect(call(4).url.pathname).toBe('/api/v1/admin/team/members/U2/enable');
    expect(call(5).url.pathname).toBe('/api/v1/admin/team/members/U2/reset-2fa');
  });

  it('surfaces 409 last_super_admin', async () => {
    const { client } = setup(json(409, { error: { code: 'last_super_admin', message: 'Last' } }));
    await expect(client.admin.team.disable('U1', 'reason here')).rejects.toMatchObject({ status: 409, code: 'last_super_admin' });
  });
});

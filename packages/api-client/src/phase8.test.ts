import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, isImpersonationEnded, isImpersonationReadOnly, isTenantSuspended } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => (typeof response === 'function' ? response() : response));
  const onUnauthorized = vi.fn();
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => 'T1', csrf: false, onUnauthorized });
  const call = (i = 0) => {
    const init = fetchMock.mock.calls[i]![1]!;
    return {
      url: new URL(String(fetchMock.mock.calls[i]![0])),
      method: init.method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers: init.headers as Record<string, string>,
    };
  };
  return { client, call, onUnauthorized };
}

const impersonation = { id: 'IMP1', tenant_id: 'T9', tenant_name: 'Mugdho Fashion', owner_name: 'Rahim', reason: 'Ticket T-2041', expires_at: '2026-11-23T10:15:00Z' };

describe('Phase 8.1 merchant impersonation client', () => {
  it('startImpersonation posts the ticket without X-Tenant-Id', async () => {
    const { client, call } = setup(json(200, { data: { user: { id: 'U1' }, impersonation, session_expires_at: impersonation.expires_at } }));
    const res = await client.auth.startImpersonation('tkt');
    expect(call().url.pathname).toBe('/api/v1/auth/impersonation');
    expect(call().method).toBe('POST');
    expect(call().body).toEqual({ ticket: 'tkt' });
    expect(call().headers['X-Tenant-Id']).toBeUndefined();
    expect(res.impersonation.tenant_id).toBe('T9');
  });

  it('endImpersonation sends DELETE and resolves on 204', async () => {
    const { client, call } = setup(new Response(null, { status: 204 }));
    await expect(client.auth.endImpersonation()).resolves.toBeUndefined();
    expect(call().method).toBe('DELETE');
    expect(call().url.pathname).toBe('/api/v1/auth/impersonation');
  });

  it('sessionInfo exposes meta.impersonation; the existing session() keeps its shape', async () => {
    const body = { data: { id: 'U1', tenants: [] }, meta: { session_expires_at: '2026-11-23T10:15:00Z', impersonation } };
    const { client } = setup(() => json(200, body));
    const info = await client.auth.sessionInfo();
    expect(info.impersonation).toEqual(impersonation);
    expect(info.session_expires_at).toBe('2026-11-23T10:15:00Z');
    expect(await client.auth.session()).toEqual({ user: body.data, session_expires_at: '2026-11-23T10:15:00Z' });
  });

  it('sessionInfo defaults impersonation to null when the meta has none', async () => {
    const { client } = setup(json(200, { data: { id: 'U1' }, meta: { session_expires_at: null } }));
    expect((await client.auth.sessionInfo()).impersonation).toBeNull();
  });

  it('401 impersonation_ended is typed and still reaches onUnauthorized', async () => {
    const { client, onUnauthorized } = setup(json(401, { error: { code: 'impersonation_ended', message: 'Impersonation ended.' } }));
    const error = await client.auth.sessionInfo().catch((e: unknown) => e);
    expect(isImpersonationEnded(error)).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledWith(error);
  });

  it('typed guards for read-only and suspended errors', () => {
    expect(isImpersonationReadOnly(new ApiError(403, 'impersonation_read_only', 'x'))).toBe(true);
    expect(isImpersonationReadOnly(new ApiError(403, 'forbidden', 'x'))).toBe(false);
    expect(isTenantSuspended(new ApiError(403, 'tenant_suspended', 'x'))).toBe(true);
    expect(isTenantSuspended(new Error('tenant_suspended'))).toBe(false);
    expect(isImpersonationEnded(new ApiError(401, 'unauthenticated', 'x'))).toBe(false);
  });

  it('storefront getConfig passes a StorefrontSuspended answer through', async () => {
    const { client } = setup(json(200, { data: { availability: 'suspended' } }));
    expect(await client.storefront.getConfig('demo.localhost', 'k')).toEqual({ availability: 'suspended' });
  });
});

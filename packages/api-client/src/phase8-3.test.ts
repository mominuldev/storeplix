import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => (typeof response === 'function' ? response() : response));
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => 'T1', csrf: false });
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

const role = { id: 'R1', key: null, name: 'Order staff', permissions: ['orders.view'], revision: 3 };

describe('Phase 8.3 roles & permissions client', () => {
  it('permissions.list reads the catalogue with X-Tenant-Id', async () => {
    const { client, call } = setup(json(200, { data: [{ key: 'orders', label: 'Orders', permissions: [] }] }));
    await expect(client.permissions.list()).resolves.toEqual([{ key: 'orders', label: 'Orders', permissions: [] }]);
    expect(call().url.pathname).toBe('/api/v1/permissions');
    expect(call().headers['X-Tenant-Id']).toBe('T1');
  });

  it('roles.list returns data + meta (fallback meta when absent)', async () => {
    const meta = { custom_roles_used: 1, custom_roles_limit: 20, custom_roles_enabled: true };
    let r = setup(json(200, { data: [role], meta }));
    await expect(r.client.roles.list()).resolves.toEqual({ data: [role], meta });
    r = setup(json(200, { data: [] }));
    expect((await r.client.roles.list()).meta).toEqual({ custom_roles_used: 0, custom_roles_limit: 20, custom_roles_enabled: false });
  });

  it('roles.get / create / update hit the right verbs and bodies', async () => {
    const { client, call } = setup(() => json(200, { data: role }));
    await client.roles.get('R1');
    await client.roles.create({ name: 'Packer', description: null, permissions: ['shipments.manage'] });
    await client.roles.update('R1', { revision: 3, permissions: ['orders.view', 'orders.process'] });
    expect([call(0).method, call(0).url.pathname]).toEqual(['GET', '/api/v1/roles/R1']);
    expect([call(1).method, call(1).url.pathname, call(1).body]).toEqual(['POST', '/api/v1/roles', { name: 'Packer', description: null, permissions: ['shipments.manage'] }]);
    expect([call(2).method, call(2).url.pathname, call(2).body]).toEqual(['PATCH', '/api/v1/roles/R1', { revision: 3, permissions: ['orders.view', 'orders.process'] }]);
  });

  it('roles.remove sends the revision, and reassign_to only when given', async () => {
    const { client, call } = setup(() => new Response(null, { status: 204 }));
    await client.roles.remove('R1', { revision: 3 });
    await client.roles.remove('R1', { revision: 4, reassign_to: 'R2' });
    expect(call(0).method).toBe('DELETE');
    expect(call(0).url.search).toBe('?revision=3');
    expect(call(1).url.searchParams.get('revision')).toBe('4');
    expect(call(1).url.searchParams.get('reassign_to')).toBe('R2');
  });

  it('surfaces role_in_use details', async () => {
    const { client } = setup(json(409, { error: { code: 'role_in_use', message: 'In use', details: { members: ['M1'], invitations: [] } } }));
    const err = await client.roles.remove('R1', { revision: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('role_in_use');
    expect((err as ApiError).details).toEqual({ members: ['M1'], invitations: [] });
  });

  it('staff invite and role change accept role_id', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.staff.invite({ email: 'a@b.com', name: null, role_id: 'R1' });
    await client.staff.updateRole('M1', { role_id: 'R2' });
    expect(call(0).body).toEqual({ email: 'a@b.com', name: null, role_id: 'R1' });
    expect([call(1).method, call(1).url.pathname, call(1).body]).toEqual(['PATCH', '/api/v1/staff/M1', { role_id: 'R2' }]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createApiClient, readCookie } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Simulates the browser cookie jar: `/sanctum/csrf-cookie` sets XSRF-TOKEN. */
function setup(handler: (url: string, init: RequestInit, n: number) => Response, initialToken: string | null = null) {
  let jar = initialToken ? `XSRF-TOKEN=${encodeURIComponent(initialToken)}` : '';
  let csrfCalls = 0;
  let n = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/sanctum/csrf-cookie')) {
      csrfCalls++;
      jar = `sp_other=1; XSRF-TOKEN=${encodeURIComponent(`tok${csrfCalls}==`)}`;
      return new Response(null, { status: 204 });
    }
    return handler(url, init, n++);
  });
  const client = createApiClient({ baseUrl: '', fetch: fetchMock, csrf: true, readCookies: () => jar, getTenantId: () => 'T1' });
  const apiCalls = () => fetchMock.mock.calls.filter(([u]) => !String(u).endsWith('/sanctum/csrf-cookie')) as [string, RequestInit][];
  return { client, fetchMock, apiCalls, csrfCalls: () => csrfCalls };
}

describe('4.7b cookie + CSRF client', () => {
  it('readCookie decodes the XSRF-TOKEN value', () => {
    expect(readCookie('a=1; XSRF-TOKEN=ab%3D%3D; b=2', 'XSRF-TOKEN')).toBe('ab==');
    expect(readCookie('a=1', 'XSRF-TOKEN')).toBeNull();
  });

  it('uses same-origin relative URLs and credentials, with no Authorization header', async () => {
    const { client, apiCalls } = setup(() => json(200, { data: { id: 'U1' }, meta: { session_expires_at: '2026-11-29T00:00:00Z' } }));
    await expect(client.auth.session()).resolves.toEqual({ user: { id: 'U1' }, session_expires_at: '2026-11-29T00:00:00Z' });
    const [url, init] = apiCalls()[0]!;
    expect(url).toBe('/api/v1/auth/me');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('GETs never fetch the CSRF cookie; the first write does, then sends X-XSRF-TOKEN (decoded)', async () => {
    const { client, apiCalls, csrfCalls } = setup(() => json(200, { data: {} }));
    await client.stores.get('S1');
    expect(csrfCalls()).toBe(0);
    expect((apiCalls()[0]![1].headers as Record<string, string>)['X-XSRF-TOKEN']).toBeUndefined();
    await client.stores.updateSettings('S1', {});
    expect(csrfCalls()).toBe(1);
    expect((apiCalls()[1]![1].headers as Record<string, string>)['X-XSRF-TOKEN']).toBe('tok1==');
  });

  it('reuses an existing XSRF-TOKEN cookie without a round trip', async () => {
    const { client, apiCalls, csrfCalls } = setup(() => json(201, { data: {} }), 'abc');
    await client.customers.addNote('S1', 'C1', 'hi');
    expect(csrfCalls()).toBe(0);
    expect((apiCalls()[0]![1].headers as Record<string, string>)['X-XSRF-TOKEN']).toBe('abc');
  });

  it('on 419 refreshes the CSRF cookie and retries exactly once', async () => {
    const { client, apiCalls, csrfCalls } = setup(
      (_u, _i, n) => (n === 0 ? json(419, { error: { code: 'csrf_token_mismatch', message: 'Your session refreshed. Please try again.' } }) : json(200, { data: { ok: true } })),
      'stale',
    );
    await expect(client.request('/x', { method: 'POST', body: {} })).resolves.toEqual({ ok: true });
    expect(csrfCalls()).toBe(1);
    expect(apiCalls().map(([, i]) => (i.headers as Record<string, string>)['X-XSRF-TOKEN'])).toEqual(['stale', 'tok1==']);
  });

  it('a second 419 is surfaced (no infinite retry)', async () => {
    const { client, apiCalls } = setup(() => json(419, { error: { code: 'csrf_token_mismatch', message: 'Your session refreshed. Please try again.' } }), 'stale');
    await expect(client.request('/x', { method: 'DELETE' })).rejects.toMatchObject({ status: 419, code: 'csrf_token_mismatch' });
    expect(apiCalls()).toHaveLength(2);
  });

  it('401 calls onUnauthorized (no retry)', async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn(async () => json(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } }));
    const client = createApiClient({ baseUrl: '', fetch: fetchMock, csrf: true, readCookies: () => 'XSRF-TOKEN=a', onUnauthorized });
    await expect(client.auth.me()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ensureCsrf de-duplicates concurrent calls and force re-fetches', async () => {
    const { client, csrfCalls } = setup(() => json(200, { data: {} }));
    await Promise.all([client.ensureCsrf(), client.ensureCsrf()]);
    expect(csrfCalls()).toBe(1);
    await client.ensureCsrf();
    expect(csrfCalls()).toBe(1);
    await client.ensureCsrf(true);
    expect(csrfCalls()).toBe(2);
  });

  it('multipart uploads carry X-XSRF-TOKEN', async () => {
    const { client, apiCalls } = setup(() => json(201, { data: { id: 'I1' } }), 'abc');
    await client.imports.upload('S1', { file: new Blob(['a']), type: 'products', filename: 'a.csv' });
    expect((apiCalls()[0]![1].headers as Record<string, string>)['X-XSRF-TOKEN']).toBe('abc');
    expect(apiCalls()[0]![1].credentials).toBe('same-origin');
  });
});

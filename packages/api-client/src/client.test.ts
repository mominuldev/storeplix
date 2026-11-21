import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, normalizeHost } from './index';

function jsonResponse(status: number, body?: unknown, statusText = '') {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(response: Response | (() => Promise<Response>), extra: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    typeof response === 'function' ? response : async () => response,
  );
  const client = createApiClient({ baseUrl: 'http://api.test/', fetch: fetchMock, ...extra });
  return { client, fetchMock };
}

describe('api-client', () => {
  it('unwraps the success envelope', async () => {
    const { client, fetchMock } = setup(jsonResponse(200, { data: { status: 'ok', version: '1.0.0', time: 'now' } }));
    await expect(client.health()).resolves.toEqual({ status: 'ok', version: '1.0.0', time: 'now' });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/health', expect.objectContaining({ method: 'GET' }));
  });

  it('sends Bearer token and X-Tenant-Id on authenticated calls', async () => {
    const { client, fetchMock } = setup(jsonResponse(200, { data: [], meta: { total: 0 } }), {
      getToken: () => 'tok',
      getTenantId: () => '01TENANT',
    });
    const result = await client.stores.list();
    expect(result).toEqual({ data: [], meta: { total: 0 } });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['X-Tenant-Id']).toBe('01TENANT');
  });

  it('does not send credentials on anonymous endpoints', async () => {
    const { client, fetchMock } = setup(jsonResponse(200, { data: { token: 't', user: {} } }), { getToken: () => 'tok' });
    await client.auth.login({ email: 'a@b.co', password: 'x' });
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.co', password: 'x' }));
  });

  it('maps error envelopes to ApiError with code, status and details', async () => {
    const { client } = setup(
      jsonResponse(422, { error: { code: 'validation_failed', message: 'Invalid', details: { email: ['Taken'] } } }),
    );
    const error = await client.auth.register({ name: 'a', email: 'a@b.co', password: 'p', password_confirmation: 'p' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'validation_failed', message: 'Invalid' });
    expect(error.isValidation).toBe(true);
    expect(error.fieldError('email')).toBe('Taken');
  });

  it('falls back to http_error for non-envelope errors and calls onUnauthorized on 401', async () => {
    const onUnauthorized = vi.fn();
    const { client } = setup(new Response('<html>', { status: 401, statusText: 'Unauthorized' }), { onUnauthorized });
    const error = await client.auth.me().catch((e) => e);
    expect(error).toMatchObject({ status: 401, code: 'http_error' });
    expect(onUnauthorized).toHaveBeenCalledWith(error);
  });

  it('wraps network failures as network_error', async () => {
    const { client } = setup(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client.health()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('resolves undefined for 204 logout', async () => {
    const { client } = setup(new Response(null, { status: 204 }));
    await expect(client.auth.logout()).resolves.toBeUndefined();
  });

  it('rejects success bodies without a data envelope', async () => {
    const { client } = setup(jsonResponse(200, { status: 'ok' }));
    await expect(client.health()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('storefront.getConfig sends normalized host and key without auth', async () => {
    const { client, fetchMock } = setup(jsonResponse(404, { error: { code: 'store_not_found', message: 'Not found' } }), {
      getToken: () => 'tok',
    });
    await expect(client.storefront.getConfig('Demo.LocalHost:3000', 'secret')).rejects.toMatchObject({
      status: 404,
      code: 'store_not_found',
    });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-Storefront-Host']).toBe('demo.localhost');
    expect(headers['X-Storefront-Key']).toBe('secret');
    expect(headers.Authorization).toBeUndefined();
  });

  it('normalizeHost strips port and trailing dot', () => {
    expect(normalizeHost(' Shop.Example.com.:443 ')).toBe('shop.example.com');
    expect(normalizeHost('shop.example.com.')).toBe('shop.example.com');
  });
});

describe('api-client phase 1.1', () => {
  it('stores.createPreviewToken posts to the store-scoped path', async () => {
    const preview = { token: 'p', url: 'http://demo.localhost:3000/?preview=p', expires_at: 'x' };
    const { client, fetchMock } = setup(jsonResponse(201, { data: preview }), { getToken: () => 't', getTenantId: () => 'ten' });
    await expect(client.stores.createPreviewToken('01STORE')).resolves.toEqual(preview);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/stores/01STORE/preview-token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('auth.forgotPassword resolves on an empty 202', async () => {
    const { client } = setup(new Response(null, { status: 202 }));
    await expect(client.auth.forgotPassword({ email: 'a@b.co' })).resolves.toBeUndefined();
  });

  it('storefront.getConfig forwards the preview token header', async () => {
    const { client, fetchMock } = setup(jsonResponse(200, { data: {} }));
    await client.storefront.getConfig('demo.localhost', 'k', { previewToken: 'pt' });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-Storefront-Preview']).toBe('pt');
  });
});

describe('tenant override', () => {
  it('stores.list can target a specific tenant', async () => {
    const { client, fetchMock } = setup(jsonResponse(200, { data: [] }), { getToken: () => 't', getTenantId: () => 'active' });
    await client.stores.list(undefined, { tenantId: 'other' });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-Tenant-Id']).toBe('other');
  });
});

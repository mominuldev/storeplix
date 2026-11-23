import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { NextRequest } from 'next/server';
import { getStorefrontConfig } from '@/lib/storefront-api';
import { clearSuspensionCache, isHostSuspended, needsSuspensionCheck, SUSPENSION_TTL_MS } from '@/lib/suspension';
import { isSuspendedConfigBody } from '@/lib/suspended-config';
import { unavailableHtml, UNAVAILABLE_COPY } from '@/lib/unavailable';
import { proxy } from '@/proxy';
import { StoreUnavailable } from '@/components/store-unavailable';

const suspendedBody = { data: { availability: 'suspended' } };

describe('Phase 8.1 suspended storefront (P8-12, §7.3)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearSuspensionCache();
    vi.stubEnv('STOREFRONT_API_KEY', 'k');
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('config fetch maps StorefrontSuspended to status "suspended"', async () => {
    fetchMock.mockResolvedValue(Response.json(suspendedBody));
    expect(await getStorefrontConfig('susp-1.localhost', null)).toEqual({ status: 'suspended' });
  });

  it('only the exact suspended shape counts', () => {
    expect(isSuspendedConfigBody(suspendedBody)).toBe(true);
    expect(isSuspendedConfigBody({ data: { availability: 'live' } })).toBe(false);
    expect(isSuspendedConfigBody({ availability: 'suspended' })).toBe(false);
    expect(isSuspendedConfigBody(null)).toBe(false);
  });

  it('proxy answers every page of a suspended host with the bare 503 page', async () => {
    fetchMock.mockResolvedValue(Response.json(suspendedBody));
    for (const path of ['/', '/products/x', '/checkout', '/robots.txt']) {
      const res = await proxy(new NextRequest(`http://placeholder${path}`, { headers: { host: 'mugdho.localhost' } }));
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('86400');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
      const html = await res.text();
      expect(html).toContain('This store is temporarily unavailable');
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(html).not.toMatch(/mugdho/i);
    }
    // One API lookup per host within the TTL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/storefront\/config$/);
    expect((init as RequestInit).headers).toMatchObject({ 'X-Storefront-Host': 'mugdho.localhost', 'X-Storefront-Key': 'k' });
  });

  it('active shops pass through; API errors never block a page', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: { store: {} } }));
    const ok = await proxy(new NextRequest('http://placeholder/', { headers: { host: 'live.localhost' } }));
    expect(ok.status).toBe(200);
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(await isHostSuspended('down.localhost')).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await isHostSuspended('err.localhost')).toBe(false);
  });

  it('re-checks after the TTL (reactivation shows the shop again)', async () => {
    let t = 0;
    fetchMock.mockResolvedValueOnce(Response.json(suspendedBody)).mockResolvedValueOnce(Response.json({ data: { store: {} } }));
    expect(await isHostSuspended('re.localhost', { now: () => t })).toBe(true);
    t += SUSPENSION_TTL_MS + 1;
    expect(await isHostSuspended('re.localhost', { now: () => t })).toBe(false);
  });

  it('skips writes, the storefront route API and static platform files', async () => {
    expect(needsSuspensionCheck('POST', '/')).toBe(false);
    expect(needsSuspensionCheck('GET', '/api/revalidate')).toBe(false);
    expect(needsSuspensionCheck('GET', '/platform/storeplix-favicon.svg')).toBe(false);
    expect(needsSuspensionCheck('HEAD', '/products/x')).toBe(true);
    vi.stubEnv('STOREFRONT_API_KEY', '');
    expect(await isHostSuspended('nokey.localhost')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HEAD gets the headers without a body', async () => {
    fetchMock.mockResolvedValue(Response.json(suspendedBody));
    const res = await proxy(new NextRequest('http://placeholder/', { method: 'HEAD', headers: { host: 'head.localhost' } }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('');
  });

  it('the static page and its React twin share the copy and carry no theme', () => {
    expect(unavailableHtml()).not.toMatch(/theme-root|Coming soon/);
    const markup = renderToStaticMarkup(createElement(StoreUnavailable));
    expect(markup).toContain(UNAVAILABLE_COPY.heading);
    expect(markup).toContain(UNAVAILABLE_COPY.footer);
    expect(markup).not.toContain('theme-root');
  });
});

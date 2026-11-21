import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { STOREFRONT_HOST_HEADER } from '@/lib/host';

function run(headers: Record<string, string>) {
  return proxy(new NextRequest('http://placeholder/', { headers }));
}

const forwarded = (res: Response) => res.headers.get(`x-middleware-request-${STOREFRONT_HOST_HEADER}`);

describe('proxy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('passes the normalized host to server components', () => {
    const res = run({ host: 'Demo.LocalHost:3000' });
    expect(res.status).toBe(200);
    expect(forwarded(res)).toBe('demo.localhost');
  });

  it('overwrites a client-supplied internal host header', () => {
    const res = run({ host: 'demo.localhost', [STOREFRONT_HOST_HEADER]: 'victim.storeplix.com' });
    expect(forwarded(res)).toBe('demo.localhost');
  });

  it('ignores a spoofed X-Forwarded-Host when TRUSTED_PROXY is unset', () => {
    vi.stubEnv('TRUSTED_PROXY', '');
    const res = run({ host: 'demo.localhost', 'x-forwarded-host': 'victim.storeplix.com' });
    expect(forwarded(res)).toBe('demo.localhost');
  });

  it('uses X-Forwarded-Host when TRUSTED_PROXY=true', () => {
    vi.stubEnv('TRUSTED_PROXY', 'true');
    const res = run({ host: 'storefront:3000', 'x-forwarded-host': 'shop.example.com' });
    expect(forwarded(res)).toBe('shop.example.com');
  });

  it('rejects malformed hosts with 400', async () => {
    const res = run({ host: 'evil.com@victim' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/invalid host/i);
  });
});

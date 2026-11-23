import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { routeRequest as proxy } from '@/proxy';
import { PREVIEW_COOKIE } from '@/lib/preview-token';

const loc = (res: Response) => {
  const u = new URL(res.headers.get('location')!);
  return u.pathname + u.search;
};

function run(url: string, init: { host?: string; method?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { host: init.host ?? 'demo.localhost:3000' };
  if (init.cookie) headers.cookie = init.cookie;
  return proxy(new NextRequest(`http://placeholder${url}`, { headers, method: init.method ?? 'GET' }));
}

describe('proxy: ?preview= -> sp_preview cookie', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('sets an httpOnly, SameSite=Lax, 1h cookie and redirects to the URL without the param', () => {
    const res = run('/collections/new?sort=price&preview=abc.DEF-123_x&page=2');
    expect(res.status).toBe(307);
    expect(loc(res)).toBe('/collections/new?sort=price&page=2');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain(`${PREVIEW_COOKIE}=abc.DEF-123_x`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=3600/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).not.toMatch(/Secure/i); // NODE_ENV=test
  });

  it('redirects to the bare path when preview was the only param', () => {
    expect(loc(run('/?preview=tok'))).toBe('/');
  });

  it('marks the cookie Secure in production on real domains, not on local dev hosts', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(run('/?preview=tok', { host: 'shop.example.com' }).headers.get('set-cookie')).toMatch(/Secure/i);
    expect(run('/?preview=tok', { host: 'demo.localhost:3000' }).headers.get('set-cookie')).not.toMatch(/Secure/i);
  });

  it('does not store junk tokens and clears an existing preview cookie', () => {
    const junk = run('/?preview=%3Cscript%3E');
    expect(junk.status).toBe(307);
    expect(junk.headers.get('set-cookie')).toBeNull();

    const cleared = run('/?preview=', { cookie: `${PREVIEW_COOKIE}=old` });
    expect(cleared.headers.get('set-cookie')).toMatch(new RegExp(`${PREVIEW_COOKIE}=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)`, 'i'));
  });

  it('does not redirect non-GET requests', () => {
    expect(run('/api/revalidate?preview=tok', { method: 'POST' }).status).toBe(200);
  });

  it('still rejects malformed hosts before handling preview', () => {
    expect(run('/?preview=tok', { host: 'bad host' }).status).toBe(400);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { framingPolicy, routeRequest as proxy } from '@/proxy';
import { EMBED_COOKIE, PREVIEW_COOKIE } from '@/lib/preview-token';
import { parseEditorOrigins } from '@/lib/editor-origins';

function run(url: string, init: { host?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { host: init.host ?? 'demo.localhost:3000' };
  if (init.cookie) headers.cookie = init.cookie;
  return proxy(new NextRequest(`http://placeholder${url}`, { headers }));
}
const cookies = (res: Response) => res.headers.getSetCookie();

describe('proxy: embedded preview (?preview=…&embed=1)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('sets sp_preview + sp_embed as HttpOnly; Secure; SameSite=None; Partitioned and strips both params', () => {
    vi.stubEnv('STOREFRONT_EDITOR_ORIGINS', 'http://localhost:5173');
    const res = run('/pages/about?preview=tok.123&embed=1&x=1');
    expect(res.status).toBe(307);
    const u = new URL(res.headers.get('location')!);
    expect(u.pathname + u.search).toBe('/pages/about?x=1');
    const [preview, embed] = [cookies(res).find((c) => c.startsWith(`${PREVIEW_COOKIE}=`))!, cookies(res).find((c) => c.startsWith(`${EMBED_COOKIE}=`))!];
    for (const c of [preview, embed]) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/Secure/i);
      expect(c).toMatch(/SameSite=none/i);
      expect(c).toMatch(/Partitioned/i);
      expect(c).toMatch(/Max-Age=3600/i);
      expect(c).toMatch(/Path=\//i);
    }
    expect(preview).toContain('sp_preview=tok.123');
    expect(embed).toContain('sp_embed=1');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self' http://localhost:5173");
  });

  it('non-embed preview keeps SameSite=Lax (no Partitioned) and clears sp_embed', () => {
    const res = run('/?preview=tok', { cookie: `${EMBED_COOKIE}=1` });
    const preview = cookies(res).find((c) => c.startsWith(`${PREVIEW_COOKIE}=`))!;
    expect(preview).toMatch(/SameSite=lax/i);
    expect(preview).not.toMatch(/Partitioned/i);
    expect(cookies(res).find((c) => c.startsWith(`${EMBED_COOKIE}=`))).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('embed=1 with a junk token sets no cookies', () => {
    const res = run('/?preview=%3Cscript%3E&embed=1');
    expect(cookies(res)).toEqual([]);
  });
});

describe('proxy: framing headers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("live pages: frame-ancestors 'none' + X-Frame-Options DENY", () => {
    vi.stubEnv('STOREFRONT_EDITOR_ORIGINS', 'http://localhost:5173');
    const res = run('/');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('with a preview cookie: only the exact editor origins may frame', () => {
    vi.stubEnv('STOREFRONT_EDITOR_ORIGINS', 'http://localhost:5173,https://app.storeplix.com');
    const res = run('/', { cookie: `${PREVIEW_COOKIE}=tok` });
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self' http://localhost:5173 https://app.storeplix.com");
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('empty STOREFRONT_EDITOR_ORIGINS fails closed even with a preview cookie', () => {
    vi.stubEnv('STOREFRONT_EDITOR_ORIGINS', '');
    const res = run('/', { cookie: `${PREVIEW_COOKIE}=tok` });
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(framingPolicy(true, [])).toBe("frame-ancestors 'none'");
  });

  it('a garbage preview cookie does not unlock framing', () => {
    vi.stubEnv('STOREFRONT_EDITOR_ORIGINS', 'http://localhost:5173');
    expect(run('/', { cookie: `${PREVIEW_COOKIE}=%3Cx%3E` }).headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('parseEditorOrigins', () => {
  it('keeps exact origins only (no wildcards, paths, credentials or junk)', () => {
    expect(
      parseEditorOrigins(' http://localhost:5173 , https://app.storeplix.com/, https://*.storeplix.com, https://a.com/path, https://u:p@b.com, javascript:alert(1), nope'),
    ).toEqual(['http://localhost:5173', 'https://app.storeplix.com']);
    expect(parseEditorOrigins(undefined)).toEqual([]);
  });
});

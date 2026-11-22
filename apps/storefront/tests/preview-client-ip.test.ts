import { describe, expect, it, vi } from 'vitest';
import { buildConfigRequest, buildPageRequest, buildProductFeedRequest } from '@/lib/config-request';

vi.mock('server-only', () => ({}));

const env = { apiUrl: 'http://api.test', apiKey: 'k', revalidateSeconds: 60 };
const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe('per-shopper client IP (5b §2.10)', () => {
  it('preview (no-store) requests carry the shopper IP', () => {
    expect(header(buildConfigRequest('shop.test', 'tok', env, '203.0.113.7').init, 'X-Storefront-Client-Ip')).toBe('203.0.113.7');
    expect(header(buildPageRequest('shop.test', 'about', 'tok', env, '203.0.113.7').init, 'X-Storefront-Client-Ip')).toBe('203.0.113.7');
    expect(header(buildProductFeedRequest('shop.test', { sort: 'latest', limit: 4 }, 'tok', env, '203.0.113.7').init, 'X-Storefront-Client-Ip')).toBe('203.0.113.7');
  });

  it('public (shared cache) requests never carry it, even if one is passed', () => {
    const { init } = buildConfigRequest('shop.test', null, env, '203.0.113.7');
    expect(header(init, 'X-Storefront-Client-Ip')).toBeUndefined();
    expect(init.cache).toBeUndefined();
  });

  it('previewClientIp returns null outside a request scope', async () => {
    const { previewClientIp } = await import('@/lib/preview-client-ip');
    await expect(previewClientIp('tok')).resolves.toBeNull();
    await expect(previewClientIp(null)).resolves.toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revalidateTag = vi.fn();
vi.mock('next/cache', () => ({ revalidateTag: (...args: unknown[]) => revalidateTag(...args) }));
const { POST } = await import('@/app/api/revalidate/route');

const call = (body: unknown, auth = 'Bearer s3cret') =>
  POST(
    new Request('http://x/api/revalidate', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('POST /api/revalidate', () => {
  beforeEach(() => vi.stubEnv('REVALIDATE_SECRET', 's3cret'));
  afterEach(() => {
    vi.unstubAllEnvs();
    revalidateTag.mockReset();
  });

  it('revalidates valid hosts, skips invalid ones, and returns 200', async () => {
    const res = await call({ hosts: ['demo.storeplix.com', 'bad host', 'Shop.Example.com'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { revalidated: ['demo.storeplix.com', 'shop.example.com'], skipped: ['bad host'] },
    });
    expect(revalidateTag.mock.calls).toEqual([
      ['store:demo.storeplix.com', { expire: 0 }],
      ['store:shop.example.com', { expire: 0 }],
    ]);
  });

  it('returns 422 only when no host is valid', async () => {
    const res = await call({ hosts: ['bad host', 'also bad/'] });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('keeps 401 for a wrong secret and 503 when unconfigured', async () => {
    expect((await call({ host: 'demo.localhost' }, 'Bearer nope')).status).toBe(401);
    vi.stubEnv('REVALIDATE_SECRET', '');
    expect((await call({ host: 'demo.localhost' })).status).toBe(503);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

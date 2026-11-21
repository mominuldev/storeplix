import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStorefrontConfig } from '@/lib/storefront-api';
import { manifestIcons, PLATFORM_FAVICON, storeIconsMetadata } from '@/lib/store-icons';

const base = {
  store: { id: '01J', name: 'Demo', slug: 'demo', status: 'active', currency: 'BDT', logo_url: null, favicon_url: null },
  preview: false,
  theme: null,
  seo: { title: 'Demo', description: null },
};

describe('StorefrontConfig schema: Phase 2 fields', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv('STOREFRONT_API_KEY', 'k');
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('treats missing contact/social/icons as nulls (rolling deploy)', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: base }));
    const res = await getStorefrontConfig('p2-missing.localhost', null);
    if (res.status !== 'found') throw new Error('expected found');
    expect(res.config.contact).toEqual({ phone: null, email: null, whatsapp: null, support_hours: null });
    expect(res.config.social).toEqual({ facebook: null, instagram: null, youtube: null });
    expect(res.config.store.icons).toEqual({ apple_touch: null, icon_192: null, icon_512: null });
  });

  it('accepts the new fields and nulls malformed ones without failing the payload', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: {
          ...base,
          store: { ...base.store, icons: { apple_touch: 'https://cdn/a.png', icon_192: 42, icon_512: null } },
          contact: { phone: '+8801712345678', email: '', whatsapp: null, support_hours: 'x'.repeat(500) },
          social: 'nope',
        },
      }),
    );
    const res = await getStorefrontConfig('p2-mixed.localhost', null);
    if (res.status !== 'found') throw new Error('expected found');
    expect(res.config.store.icons).toEqual({ apple_touch: 'https://cdn/a.png', icon_192: null, icon_512: null });
    expect(res.config.contact).toEqual({ phone: '+8801712345678', email: null, whatsapp: null, support_hours: null });
    expect(res.config.social).toEqual({ facebook: null, instagram: null, youtube: null });
  });
});

describe('store icons metadata', () => {
  const none = { apple_touch: null, icon_192: null, icon_512: null };

  it('falls back to the Store Plix favicon when no icons are set', () => {
    expect(storeIconsMetadata({ favicon_url: null, icons: none })).toEqual({
      icon: [{ url: PLATFORM_FAVICON, type: 'image/svg+xml' }],
    });
    expect(manifestIcons({ favicon_url: null, icons: none })).toEqual([]);
  });

  it('maps favicon (32x32), apple-touch and manifest icons', () => {
    const store = {
      favicon_url: 'https://cdn.storeplix.com/f32.png',
      icons: { apple_touch: 'https://cdn.storeplix.com/a180.png', icon_192: 'https://cdn.storeplix.com/i192.png', icon_512: null },
    };
    expect(storeIconsMetadata(store)).toEqual({
      icon: [{ url: 'https://cdn.storeplix.com/f32.png', sizes: '32x32', type: 'image/png' }],
      apple: [{ url: 'https://cdn.storeplix.com/a180.png', sizes: '180x180', type: 'image/png' }],
    });
    expect(manifestIcons(store)).toEqual([{ src: 'https://cdn.storeplix.com/i192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }]);
  });

  it('drops unsafe icon URLs and falls back', () => {
    const meta = storeIconsMetadata({ favicon_url: 'javascript:alert(1)', icons: { ...none, apple_touch: 'data:image/png;base64,AA' } });
    expect(meta).toEqual({ icon: [{ url: PLATFORM_FAVICON, type: 'image/svg+xml' }] });
  });
});

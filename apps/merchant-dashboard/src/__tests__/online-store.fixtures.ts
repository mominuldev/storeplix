import type { NavigationMenu, StorePage, StorePageSummary, StoreTheme, ThemeCatalogEntry } from '@storeplix/types';
import { defaults } from '../online-store/theme-package/modern-commerce';

export const catalog: ThemeCatalogEntry[] = [
  { code: 'modern-commerce', name: 'Gallery', description: 'Editorial serif, shop by age & collection', version: '1.1.0', status: 'available', tier: 'free', price_amount: null, currency: null, tags: [], is_new: true },
  { code: 'boutique', name: 'Boutique', description: 'Big photos, calm and elegant', version: '0.0.0', status: 'coming_soon', tier: 'free', price_amount: null, currency: null, tags: [], is_new: false },
  { code: 'festive', name: 'Festive', description: 'Eid & Puja ready, warm tones', version: '0.0.0', status: 'coming_soon', tier: 'premium', price_amount: 99000, currency: 'BDT', tags: [], is_new: false },
];

export function storeTheme(overrides: Partial<StoreTheme> = {}): StoreTheme {
  const config = structuredClone(defaults);
  return {
    id: 'TH1',
    code: 'modern-commerce',
    name: 'Gallery',
    version: '1.1.0',
    is_active: true,
    draft_revision: 3,
    published_revision: 3,
    has_unpublished_changes: false,
    draft_updated_at: '2026-11-21T10:42:00Z',
    draft_updated_by: { id: 'U1', name: 'Rahim' },
    published_at: '2026-11-20T10:00:00Z',
    published_by: null,
    applied_at: null,
    draft_config: config,
    published_config: structuredClone(config),
    media: {},
    ...overrides,
  };
}

export function pageSummary(overrides: Partial<StorePageSummary> = {}): StorePageSummary {
  return {
    id: 'P1',
    title: 'About us',
    slug: 'about',
    url_path: '/pages/about',
    status: 'published',
    template: 'about',
    in_menus: ['main'],
    revision: 2,
    published_at: '2026-11-20T00:00:00Z',
    updated_at: '2026-11-20T00:00:00Z',
    updated_by: { id: 'U1', name: 'Rahim' },
    ...overrides,
  };
}

export function page(overrides: Partial<StorePage> = {}): StorePage {
  return {
    ...pageSummary(),
    body: [{ id: 'hdg00001', type: 'heading', text: 'Our story', level: 2 }],
    seo: { title: null, description: null, share_image: null },
    media: {},
    ...overrides,
  };
}

export const menus: NavigationMenu[] = [
  {
    id: 'N1',
    handle: 'main',
    title: 'Main menu',
    revision: 4,
    updated_at: '',
    items: [
      { id: 'home0001', label: 'Home', link: { type: 'home' }, href: '/', link_status: 'ok' },
      { id: 'abt00001', label: 'About us', link: { type: 'page', page_id: 'P1' }, href: '/pages/about', link_status: 'ok', page_title: 'About us' },
      { id: 'drf00001', label: 'Size guide', link: { type: 'page', page_id: 'P2' }, href: null, link_status: 'page_unpublished', page_title: 'Size guide' },
    ],
  },
  { id: 'N2', handle: 'footer', title: 'Shop', revision: 1, updated_at: '', items: [{ id: 'home0002', label: 'Home', link: { type: 'home' }, href: '/', link_status: 'ok' }] },
  { id: 'N3', handle: 'help', title: 'Help', revision: 1, updated_at: '', items: [] },
];

export const pagesList = {
  data: [pageSummary(), pageSummary({ id: 'P2', title: 'Size guide', slug: 'size-guide', url_path: '/pages/size-guide', status: 'draft', template: 'size_guide', in_menus: ['main'] })],
  meta: { counts: { all: 2, draft: 1, published: 1, hidden: 0 }, limit: 50 },
};

export const previewToken = { token: 'tok123', url: 'http://demo.localhost:3010/?preview=tok123', expires_at: new Date(Date.now() + 3600_000).toISOString() };

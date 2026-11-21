import { describe, expect, it, vi } from 'vitest';
import { createApiClient, mediaListQuery } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    typeof response === 'function' ? response() : response,
  );
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getToken: () => 'tok', getTenantId: () => 'T1' });
  const call = (i = 0) => {
    const init = fetchMock.mock.calls[i]![1]!;
    return {
      url: String(fetchMock.mock.calls[i]![0]),
      method: init.method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string>,
    };
  };
  return { client, call };
}

const config = { theme: 'modern-commerce', version: '1.1.0', settings: {}, sections: [] } as never;

describe('Phase 3 endpoints', () => {
  it('themes.catalog is tenant-scoped GET /themes', async () => {
    const { client, call } = setup(json(200, { data: [{ code: 'modern-commerce' }] }));
    await expect(client.themes.catalog()).resolves.toEqual([{ code: 'modern-commerce' }]);
    expect(call().url).toBe('http://api.test/api/v1/themes');
    expect(call().headers['X-Tenant-Id']).toBe('T1');
  });

  it('storeThemes paths and bodies', async () => {
    const { client, call } = setup(() => json(200, { data: { code: 'modern-commerce', draft_revision: 2 } }));
    await client.storeThemes.list('S1');
    await client.storeThemes.get('S1', 'modern-commerce');
    await client.storeThemes.saveDraft('S1', 'modern-commerce', { config, base_revision: 4 });
    await client.storeThemes.publish('S1', 'modern-commerce', { draft_revision: 5 });
    await client.storeThemes.discard('S1', 'modern-commerce');
    await client.storeThemes.apply('S1', 'modern-commerce');
    const base = 'http://api.test/api/v1/stores/S1/themes';
    expect([0, 1, 2, 3, 4, 5].map((i) => `${call(i).method} ${call(i).url}`)).toEqual([
      `GET ${base}`,
      `GET ${base}/modern-commerce`,
      `PUT ${base}/modern-commerce/draft`,
      `POST ${base}/modern-commerce/publish`,
      `POST ${base}/modern-commerce/discard`,
      `POST ${base}/modern-commerce/apply`,
    ]);
    expect(call(2).body).toEqual({ config, base_revision: 4 });
    expect(call(3).body).toEqual({ draft_revision: 5 });
    expect(call(5).body).toBeUndefined();
  });

  it('saveDraft surfaces 409 revision_conflict', async () => {
    const { client } = setup(json(409, { error: { code: 'revision_conflict', message: 'Changed elsewhere' } }));
    await expect(client.storeThemes.saveDraft('S1', 'modern-commerce', { config, base_revision: 1 })).rejects.toMatchObject({
      status: 409,
      code: 'revision_conflict',
    });
  });

  it('theme codes are URL-encoded', async () => {
    const { client, call } = setup(json(200, { data: {} }));
    await client.storeThemes.get('S1', '../x');
    expect(call().url).toBe('http://api.test/api/v1/stores/S1/themes/..%2Fx');
  });

  it('pages.list sends filter[status] + q and returns meta counts', async () => {
    const meta = { counts: { all: 3, draft: 1, published: 2, hidden: 0 }, limit: 50 };
    const { client, call } = setup(json(200, { data: [], meta }));
    await expect(client.pages.list('S1', { status: ['draft', 'hidden'], q: 'faq' })).resolves.toEqual({ data: [], meta });
    const url = new URL(call().url);
    expect(url.pathname).toBe('/api/v1/stores/S1/pages');
    expect(url.searchParams.get('filter[status]')).toBe('draft,hidden');
    expect(url.searchParams.get('q')).toBe('faq');
  });

  it('pages.list without filters sends no query and defaults meta', async () => {
    const { client, call } = setup(json(200, { data: [] }));
    const res = await client.pages.list('S1');
    expect(call().url).toBe('http://api.test/api/v1/stores/S1/pages');
    expect(res.meta.counts.all).toBe(0);
  });

  it('pages CRUD', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'P1' } }));
    await client.pages.create('S1', { template: 'faq', add_to_menu: 'footer' });
    await client.pages.get('S1', 'P1');
    await client.pages.update('S1', 'P1', { revision: 3, status: 'published' });
    expect(call(0).method).toBe('POST');
    expect(call(0).body).toEqual({ template: 'faq', add_to_menu: 'footer' });
    expect(call(1).url).toBe('http://api.test/api/v1/stores/S1/pages/P1');
    expect(call(2).method).toBe('PATCH');
    expect(call(2).body).toEqual({ revision: 3, status: 'published' });
  });

  it('pages.delete resolves on 204', async () => {
    const { client, call } = setup(new Response(null, { status: 204 }));
    await expect(client.pages.delete('S1', 'P1')).resolves.toBeUndefined();
    expect(call().method).toBe('DELETE');
  });

  it('pageTemplates.list', async () => {
    const { client, call } = setup(json(200, { data: [{ code: 'faq' }] }));
    await client.pageTemplates.list();
    expect(call().url).toBe('http://api.test/api/v1/page-templates');
  });

  it('navigation list + save', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.navigation.list('S1');
    await client.navigation.save('S1', 'main', { items: [{ id: 'abcdefgh', label: 'Home', link: { type: 'home' } }], revision: 2 });
    expect(call(0).url).toBe('http://api.test/api/v1/stores/S1/navigation');
    expect(call(1).method).toBe('PUT');
    expect(call(1).url).toBe('http://api.test/api/v1/stores/S1/navigation/main');
    expect(call(1).body.revision).toBe(2);
  });

  it('media.list maps purpose filter and pagination', async () => {
    const { client, call } = setup(json(200, { data: [], meta: { current_page: 1 } }));
    const res = await client.media.list({ purpose: ['page_image', 'logo'], page: 2, per_page: 24 });
    const url = new URL(call().url);
    expect(url.pathname).toBe('/api/v1/media');
    expect(url.searchParams.get('filter[purpose]')).toBe('page_image,logo');
    expect(url.searchParams.get('page')).toBe('2');
    expect(res.meta).toEqual({ current_page: 1 });
    expect(mediaListQuery({})).toEqual({ 'filter[purpose]': undefined, page: undefined, per_page: undefined });
  });

  it('settings seo goes through updateSettings', async () => {
    const { client, call } = setup(json(200, { data: {} }));
    await client.stores.updateSettings('S1', { seo: { title: 'Shop', hide_from_search: true } });
    expect(call().method).toBe('PATCH');
    expect(call().body).toEqual({ seo: { title: 'Shop', hide_from_search: true } });
  });

  it('preview token', async () => {
    const { client, call } = setup(json(201, { data: { token: 't', url: 'http://demo.localhost:3000/?preview=t', expires_at: 'x' } }));
    await expect(client.stores.createPreviewToken('S1')).resolves.toMatchObject({ token: 't' });
    expect(call().url).toBe('http://api.test/api/v1/stores/S1/preview-token');
  });
});

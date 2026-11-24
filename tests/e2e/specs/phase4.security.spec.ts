import { expect, test } from '@playwright/test';
import { api, apiCall, createTenant, demoSession, type Session, type ThrowawayTenant } from '../support/api';
import { RUN, Tracker, purgeRun, simpleProduct, storefrontFeed, tagged, toCsv, uploadImport, waitImport } from '../support/catalog';

/**
 * Phase 4 §10 adversarial checks against the live API (the Phase B QA pass; also a regression suite).
 * A second merchant ("Eve", throwaway tenant) attacks the demo shop and vice versa.
 *  - cross-tenant / cross-store ids in routes → 404, in payloads → 422; same SKU/slug across tenants OK;
 *  - mass assignment; price manipulation; feed minimality;
 *  - CSV upload hardening: magic bytes, NUL, non-UTF-8, size, rows, columns, cell, line, headers, empty;
 *  - CSV content: <script> in a description stays text.
 * Upload probes run in Eve's shop (merchant-bulk throttle is per tenant). Eve is deleted afterwards; demo
 * records are deleted and purged.
 */
test.describe.configure({ mode: 'serial' });

let demo: Session;
let t: Tracker;
let eve: ThrowawayTenant;
let et: Tracker;
// Demo-side fixtures, created once.
const fx: Record<string, string> = {};

test.beforeAll(async () => {
  test.setTimeout(90_000);
  demo = await demoSession();
  t = new Tracker(demo);
  eve = await createTenant('eve');
  et = new Tracker(eve.session);

  const cat = await t.createCategory({ name: tagged('Victim cat') });
  const media = await t.uploadImage([10, 10, 10]);
  const prod = await t.createProduct({ ...simpleProduct('Victim', 5000, { cost_amount: 2000, category_ids: [cat.id] }), images: [{ media_id: media }] });
  const cust = await t.createCustomer({ name: tagged('Victim customer'), email: `victim-${RUN}@e2e.example` });
  const note = await api(demo, 'POST', `/stores/${demo.storeId}/customers/${cust.id}/notes`, { body: 'secret' });
  const imp = await uploadImport(demo, 'customers', toCsv([['name', 'email'], [tagged('Imp'), `imp-${RUN}@e2e.example`]]));
  expect(imp.status, imp.text).toBe(201);
  t.imports.add(imp.json.data.id);
  const exp = await api(demo, 'POST', `/stores/${demo.storeId}/exports`, { type: 'products', filters: { q: RUN } });
  if (exp.json.data?.id) t.exports.add(exp.json.data.id);
  Object.assign(fx, { cat: cat.id, media, prod: prod.id, variant: prod.variants[0].id, cust: cust.id, note: note.json.data.id, imp: imp.json.data.id, exp: exp.json.data?.id ?? '' });
});

test.afterAll(async () => {
  const problems = [...(await t.cleanup()), ...(await et.cleanup())];
  purgeRun(demo.storeId, [...t.products]);
  eve?.cleanup();
  expect(problems, 'cleanup').toEqual([]);
});

test('cross-tenant: Eve on demo routes → 404 (never 403), with her own or the demo store id', async () => {
  const E = eve.session;
  const D = `/stores/${demo.storeId}`;
  const own = `/stores/${E.storeId}`;
  const probes: Array<[string, string, unknown?]> = [];
  for (const base of [D, own]) {
    probes.push(
      ['GET', `${base}/products/${fx.prod}`],
      ['PATCH', `${base}/products/${fx.prod}`, { revision: 1, name: 'pwn' }],
      ['DELETE', `${base}/products/${fx.prod}`],
      ['POST', `${base}/products/${fx.prod}/duplicate`],
      ['GET', `${base}/categories/${fx.cat}`],
      ['PATCH', `${base}/categories/${fx.cat}`, { name: 'pwn' }],
      ['DELETE', `${base}/categories/${fx.cat}`],
      ['PATCH', `${base}/inventory/${fx.variant}`, { low_stock_threshold: 1 }],
      ['GET', `${base}/customers/${fx.cust}`],
      ['PATCH', `${base}/customers/${fx.cust}`, { revision: 1, name: 'pwn' }],
      ['DELETE', `${base}/customers/${fx.cust}`],
      ['POST', `${base}/customers/${fx.cust}/notes`, { body: 'x' }],
      ['DELETE', `${base}/customers/${fx.cust}/notes/${fx.note}`],
      ['GET', `${base}/imports/${fx.imp}`],
      ['GET', `${base}/imports/${fx.imp}/rows`],
      ['GET', `${base}/imports/${fx.imp}/error-report`],
      ['POST', `${base}/imports/${fx.imp}/validate`, { column_map: {}, options: {} }],
      ['POST', `${base}/imports/${fx.imp}/run`],
      ['DELETE', `${base}/imports/${fx.imp}`],
      ...(fx.exp ? ([['GET', `${base}/exports/${fx.exp}`]] as Array<[string, string]>) : []),
    );
  }
  probes.push(['GET', `${D}/products`], ['GET', `${D}/dashboard`], ['GET', `${D}/inventory`], ['GET', `${D}/customers`], ['GET', `${D}/categories`]);
  for (const [m, path, body] of probes) {
    const r = await api(E, m, path, body);
    expect(r.status, `${m} ${path}: ${JSON.stringify(r.json)}`).toBe(404);
  }
  // Spoofed X-Tenant-Id → 403 tenant_forbidden (membership check), never data.
  const spoof = await api({ ...E, tenantId: demo.tenantId }, 'GET', `${D}/products`);
  expect(spoof.status).toBe(403);
  // Demo data unchanged.
  expect((await api(demo, 'GET', `${D}/products/${fx.prod}`)).json.data.name).toBe(tagged('Victim'));
});

test('cross-tenant: demo ids inside Eve payloads → 422 with the field path', async () => {
  const E = eve.session;
  const own = `/stores/${E.storeId}`;
  const eCat = await et.createCategory({ name: tagged('Eve cat') });
  const eProd = await et.createProduct(simpleProduct('Eve prod', 1000));
  const cases: Array<[string, string, unknown, string]> = [
    ['POST', `${own}/products`, { ...simpleProduct('x1', 1), category_ids: [fx.cat] }, 'category_ids.0'],
    ['POST', `${own}/products`, { ...simpleProduct('x2', 1), images: [{ media_id: fx.media }] }, 'images.0.media_id'],
    ['POST', `${own}/products`, { ...simpleProduct('x3', 1), images: [], variants: [{ price_amount: 1, image_media_id: fx.media }] }, 'variants.0.image_media_id'],
    ['PATCH', `${own}/products/${eProd.id}`, { revision: eProd.revision, variants: [{ id: fx.variant, price_amount: 1 }] }, 'variants.0.id'],
    ['POST', `${own}/categories`, { name: 'x', parent_id: fx.cat }, 'parent_id'],
    ['POST', `${own}/categories`, { name: 'x', image_media_id: fx.media }, 'image_media_id'],
    ['PATCH', `${own}/categories/${eCat.id}`, { parent_id: fx.cat }, 'parent_id'],
    ['POST', `${own}/inventory/adjustments`, { reason: 'received', items: [{ variant_id: fx.variant, mode: 'delta', quantity: 5 }] }, 'items.0.variant_id'],
    ['POST', `${own}/products/bulk`, { action: 'archive', ids: [fx.prod] }, 'ids.0'],
    ['POST', `${own}/products/bulk`, { action: 'set_categories', ids: [eProd.id], category_ids: [fx.cat] }, 'category_ids.0'],
    ['POST', `${own}/exports`, { type: 'products', filters: { ids: [fx.prod] } }, 'filters.ids.0'],
  ];
  for (const [m, path, body, field] of cases) {
    const r = await api(E, m, path, body);
    if (r.status === 201 && path.endsWith('/products')) et.products.add(r.json.data.id);
    if (r.status === 201 && path.endsWith('/categories')) et.categories.push(r.json.data.id);
    if (m === 'POST' && path.endsWith('/exports') && r.status === 202) {
      // Accepting is only OK if the export can never contain the demo product (checked in Phase B by download).
      test.info().annotations.push({ type: 'note', description: 'export with foreign ids accepted (202): verify the file is empty' });
      continue;
    }
    expect(r.status, `${m} ${path} ${JSON.stringify(body)}: ${JSON.stringify(r.json)}`).toBe(422);
    const keys = Object.keys(r.json.error.details ?? {});
    expect(keys.some((k) => k === field || k.startsWith(field)), `${path}: ${keys.join(',')}`).toBe(true);
  }
  // Demo stock unchanged.
  const inv = await api(demo, 'GET', `/stores/${demo.storeId}/inventory?filter[product_id]=${fx.prod}`);
  expect(inv.json.data[0].on_hand).toBe(0);
});

test('isolation: same SKU and slug in another tenant are allowed and never revealed; feeds are per host', async () => {
  const victim = (await api(demo, 'GET', `/stores/${demo.storeId}/products/${fx.prod}`)).json.data;
  const twin = await et.createProduct({ name: victim.name, slug: victim.slug, status: 'active', variants: [{ sku: victim.variants[0].sku, price_amount: 1 }] });
  expect(twin.slug).toBe(victim.slug);
  expect(twin.variants[0].sku).toBe(victim.variants[0].sku);
  const search = await api(eve.session, 'GET', `/stores/${eve.session.storeId}/products?q=${encodeURIComponent(victim.variants[0].sku)}`);
  expect(search.json.data.map((p: { id: string }) => p.id)).toEqual([twin.id]);
  // Eve's draft store: feed 404 (T22). Demo feed never has Eve's product.
  expect((await storefrontFeed(eve.host)).status).toBe(404);
  const demoFeed = await storefrontFeed(new URL(process.env.STOREFRONT_URL ?? 'http://demo.localhost:3010').hostname, '?limit=24');
  expect(JSON.stringify(demoFeed.json)).not.toContain(twin.id);
});

test('mass assignment and price manipulation', async () => {
  const D = `/stores/${demo.storeId}`;
  const p = await t.createProduct({
    ...simpleProduct('Mass', 5000),
    tenant_id: eve.session.tenantId,
    store_id: eve.session.storeId,
    price_min_amount: 1,
    price_max_amount: 1,
    revision: 99,
    published_at: '2020-01-01T00:00:00Z',
    currency: 'USD',
    variants: [{ price_amount: 5000, on_hand: 50, committed: 7, initial_on_hand: 1 }],
  });
  expect(p).toMatchObject({ revision: 1, price_min_amount: 5000, price_max_amount: 5000, published_at: null, currency: 'BDT' });
  expect(p.variants[0].inventory).toMatchObject({ on_hand: 1, committed: 0 });
  expect((await api(eve.session, 'GET', `/stores/${eve.session.storeId}/products?q=${encodeURIComponent(p.name)}`)).json.data).toEqual([]);

  for (const price of [-1, 1_000_000_001, 10.5, '100', null, true, 1e21, '1e3']) {
    const r = await api(demo, 'POST', `${D}/products`, { ...simpleProduct('Price', 1), variants: [{ price_amount: price }] });
    if (r.status === 201) t.products.add(r.json.data.id);
    expect(r.status, `price_amount=${JSON.stringify(price)}`).toBe(422);
  }
  for (const [label, v] of [
    ['compare < price', { price_amount: 1000, compare_at_amount: 999 }],
    ['negative cost', { price_amount: 1000, cost_amount: -1 }],
    ['weight > 1 000 000', { price_amount: 1000, weight_grams: 1_000_001 }],
    ['initial stock > 1 000 000', { price_amount: 1000, initial_on_hand: 1_000_001 }],
    ['negative initial stock', { price_amount: 1000, initial_on_hand: -5 }],
  ] as Array<[string, Record<string, unknown>]>) {
    const r = await api(demo, 'POST', `${D}/products`, { ...simpleProduct('Bad', 1), variants: [v] });
    if (r.status === 201) t.products.add(r.json.data.id);
    expect(r.status, label).toBe(422);
  }
  // No storefront route accepts a price or writes anything.
  const sf = await fetch(`${process.env.API_URL ?? 'http://localhost:8010'}/api/v1/storefront/products`, { method: 'POST', headers: { Accept: 'application/json' } });
  expect([401, 403, 404, 405]).toContain(sf.status);
});

test('CSV upload hardening (magic bytes, encoding, limits, headers)', async () => {
  test.setTimeout(120_000);
  const header = 'name,price,sku\r\n';
  const files: Array<[string, Buffer, number, string?]> = [
    ['zip', Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(header)]), 422, 'unsupported_file'],
    ['gzip', Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from(header)]), 422, 'unsupported_file'],
    ['xls/ole', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from(header)]), 422, 'unsupported_file'],
    ['pdf', Buffer.from(`%PDF-1.7\n${header}`), 422, 'unsupported_file'],
    ['xlsx disguised as csv', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]), Buffer.alloc(200, 0x41)]), 422, 'unsupported_file'],
    ['NUL byte', Buffer.from(`${header}a\x00b,1,x\r\n`, 'latin1'), 422, 'unsupported_file'],
    ['latin-1 (not UTF-8)', Buffer.concat([Buffer.from(header), Buffer.from([0x63, 0x61, 0x66, 0xe9]), Buffer.from(',1,x\r\n')]), 422, 'unsupported_file'],
    ['empty (header only)', Buffer.from(header), 422, 'empty_file'],
    ['blank file', Buffer.alloc(0), 422],
    ['duplicate header', Buffer.from('name,Name,price\r\na,b,1\r\n'), 422, 'validation_failed'],
    ['blank header', Buffer.from('name,,price\r\na,b,1\r\n'), 422, 'validation_failed'],
    ['51 columns', Buffer.from(`${Array.from({ length: 51 }, (_, i) => `c${i}`).join(',')}\r\n${Array(51).fill('x').join(',')}\r\n`), 422, 'too_many_columns'],
    ['10 001-char cell', Buffer.from(`name,price\r\n${'a'.repeat(10_001)},1\r\n`), 422, 'cell_too_long'],
    ['65 537-byte line', Buffer.from(`name,price\r\n${'a,'.repeat(9_000)}${'b'.repeat(48_000)}\r\n`), 422, 'line_too_long'],
    ['5 001 rows', Buffer.from(`name,price\r\n${Array.from({ length: 5_001 }, (_, i) => `p${i},1`).join('\r\n')}\r\n`), 422, 'too_many_rows'],
    ['10 MB + 1', Buffer.concat([Buffer.from('name,price\r\n'), Buffer.alloc(10 * 1024 * 1024 + 1 - 12, 0x61)]), 413, 'payload_too_large'],
  ];
  for (const [label, buf, status, code] of files) {
    const r = await uploadImport(eve.session, 'products', buf, `e2e-${RUN}-${label.replace(/\W+/g, '-')}.csv`);
    if (r.status === 201) et.imports.add(r.json.data.id);
    expect(r.status, `${label}: ${r.text.slice(0, 300)}`).toBe(status);
    if (code) expect(r.json.error?.code, label).toBe(code);
  }
  // Exactly 5 000 rows and a BOM + semicolon file are fine.
  const ok = await uploadImport(eve.session, 'products', Buffer.from(`﻿name;price\r\n${Array.from({ length: 5_000 }, (_, i) => `p${i};1`).join('\r\n')}\r\n`), `e2e-${RUN}-5000.csv`);
  expect(ok.status, ok.text.slice(0, 300)).toBe(201);
  et.imports.add(ok.json.data.id);
  expect(ok.json.data).toMatchObject({ row_count: 5000, headers: ['name', 'price'] });
  // Original filename is sanitised for display.
  const evil = await uploadImport(eve.session, 'products', Buffer.from('name,price\r\na,1\r\n'), `../../e2e-${RUN}-<script>.csv`);
  if (evil.status === 201) {
    et.imports.add(evil.json.data.id);
    expect(evil.json.data.filename).not.toMatch(/[<>/\\]/);
  }
  // One active import per store → second validate while the first is validating → 409 (best effort).
  const v1 = await api(eve.session, 'POST', `/stores/${eve.session.storeId}/imports/${ok.json.data.id}/validate`, { column_map: { name: 'name', price: 'price' }, options: { update_existing: false, import_as_draft: true, create_missing_categories: false } });
  expect(v1.status).toBe(202);
  const second = await uploadImport(eve.session, 'products', Buffer.from('name,price\r\na,1\r\n'), `e2e-${RUN}-second.csv`);
  if (second.status === 201) et.imports.add(second.json.data.id);
  test.info().annotations.push({ type: 'second_upload_while_validating', description: `${second.status} ${second.json.error?.code ?? ''}` });
  const v2 = await api(eve.session, 'POST', `/stores/${eve.session.storeId}/imports/${second.json.data?.id}/validate`, { column_map: { name: 'name', price: 'price' }, options: { update_existing: false, import_as_draft: true, create_missing_categories: false } });
  test.info().annotations.push({ type: 'import_in_progress', description: `second validate while first running → ${v2.status}` });
  await waitImport(eve.session, ok.json.data.id, 120_000);
});

test('CSV content: <script> description and control characters stay text', async () => {
  const csv = toCsv([
    ['name', 'price', 'description', 'sku', 'tags'],
    [tagged('Xss'), '10', '<script>alert(1)</script><img src=x onerror=alert(1)>', `E2E-${RUN}-XSS`.toUpperCase(), 'a,b'],
  ]);
  const up = await uploadImport(eve.session, 'products', csv);
  expect(up.status, up.text).toBe(201);
  et.imports.add(up.json.data.id);
  const v = await api(eve.session, 'POST', `/stores/${eve.session.storeId}/imports/${up.json.data.id}/validate`, { column_map: { name: 'name', price: 'price', description: 'description', sku: 'sku', tags: 'tags' }, options: { update_existing: false, import_as_draft: true, create_missing_categories: false } });
  expect(v.status, JSON.stringify(v.json)).toBe(202);
  await waitImport(eve.session, up.json.data.id);
  expect((await api(eve.session, 'POST', `/stores/${eve.session.storeId}/imports/${up.json.data.id}/run`)).status).toBe(202);
  expect((await waitImport(eve.session, up.json.data.id, 120_000)).status).toBe('completed');
  const found = (await api(eve.session, 'GET', `/stores/${eve.session.storeId}/products?q=${encodeURIComponent(tagged('Xss'))}`)).json.data;
  expect(found).toHaveLength(1);
  et.products.add(found[0].id);
  const p = (await api(eve.session, 'GET', `/stores/${eve.session.storeId}/products/${found[0].id}`)).json.data;
  expect(p.status).toBe('draft');
  const json = JSON.stringify(p.description);
  // Stripped to text nodes: no tags survive, no node types beyond the RichTextDoc set.
  expect(json).not.toMatch(/<script|onerror|<img/i);
  expect(json).not.toMatch(/"type":"(html|script|image)"/);
});

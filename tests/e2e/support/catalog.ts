import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { API_DIR, api, apiCall, tinker, urls, type ApiAuth, type Session } from './api';

/**
 * Phase 4 helpers: fixtures built in memory, product/customer builders, import polling, CSV parsing and a
 * cleanup tracker. Every record a spec creates carries the per-run tag (`E2E {tag} …`), so cleanup can
 * find it even when a test dies half-way, and so it never matches the seeded demo catalog.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Short per-process tag, lowercase alnum (fits SKUs, slugs and names). */
export const RUN = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`;
export const tagged = (label: string) => `E2E ${RUN} ${label}`;
export const sku = (label: string) => `E2E-${RUN}-${label}`.toUpperCase();

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
/** Solid-colour RGB PNG built in memory (no fixture files). */
export function png(size: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** RFC 4180 writer (quotes when needed). */
export function toCsv(rows: string[][], { bom = true, eol = '\r\n' } = {}): Buffer {
  const cell = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return Buffer.from(`${bom ? '﻿' : ''}${rows.map((r) => r.map(cell).join(',')).join(eol)}${eol}`, 'utf8');
}

/** Minimal RFC 4180 parser (handles BOM, quotes, CRLF, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Rows as objects keyed by header. */
export function csvObjects(text: string): Record<string, string>[] {
  const [head, ...rest] = parseCsv(text);
  return rest.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])));
}

/** CsvCell::safe triggers (§5.6). */
export const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠'];
export const isFormulaUnsafe = (v: string) => FORMULA_TRIGGERS.some((t) => v.replace(/^[  ]+/, '').startsWith(t));

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------
export interface VariantIn {
  option_values?: string[];
  sku?: string | null;
  price_amount: number;
  compare_at_amount?: number | null;
  cost_amount?: number | null;
  initial_on_hand?: number;
  low_stock_threshold?: number | null;
  is_enabled?: boolean;
}

export function simpleProduct(label: string, price: number, extra: Partial<VariantIn> & { status?: string; category_ids?: string[] } = {}): Json {
  const { status = 'draft', category_ids, ...v } = extra;
  return {
    name: tagged(label),
    status,
    ...(category_ids ? { category_ids } : {}),
    variants: [{ sku: sku(label.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)), price_amount: price, ...v }],
  };
}

/** Variable product: 2 options (Size × Colour) → sizes.length × colours.length variants. */
export function variableProduct(label: string, sizes: string[], colours: string[], price: number, status = 'draft'): Json {
  const variants = sizes.flatMap((sz) =>
    colours.map((c) => ({ option_values: [sz, c], sku: sku(`${label.slice(0, 6)}-${sz}-${c}`.replace(/[^A-Za-z0-9-]/g, '')), price_amount: price, initial_on_hand: 3 })),
  );
  return { name: tagged(label), status, options: [{ name: 'Size', values: sizes }, { name: 'Colour', values: colours }], variants };
}

// ---------------------------------------------------------------------------------------------
// Tracker: everything created is undone in afterAll (products, categories, customers, media, imports)
// ---------------------------------------------------------------------------------------------
export class Tracker {
  products = new Set<string>();
  categories: string[] = []; // creation order; deleted in reverse (children first)
  customers = new Set<string>();
  media = new Set<string>();
  imports = new Set<string>();
  exports = new Set<string>();

  private readonly s: Session;

  constructor(s: Session) {
    this.s = s;
  }

  private get base() {
    return `/stores/${this.s.storeId}`;
  }

  async createProduct(input: Json, as: ApiAuth = this.s): Promise<Json> {
    const r = await api(as, 'POST', `${this.base}/products`, input);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    this.products.add(r.json.data.id);
    return r.json.data;
  }

  async createCategory(input: Json, as: ApiAuth = this.s): Promise<Json> {
    const r = await api(as, 'POST', `${this.base}/categories`, input);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    this.categories.push(r.json.data.id);
    return r.json.data;
  }

  async createCustomer(input: Json, as: ApiAuth = this.s): Promise<Json> {
    const r = await api(as, 'POST', `${this.base}/customers`, input);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    this.customers.add(r.json.data.id);
    return r.json.data;
  }

  async uploadImage(rgb: [number, number, number] = [200, 80, 60], as: ApiAuth = this.s): Promise<string> {
    const r = await apiCall(as, 'POST', '/media', {
      multipart: { purpose: 'product_image', file: { name: `e2e-${RUN}.png`, mimeType: 'image/png', buffer: png(320, rgb) } },
    });
    expect(r.status, r.text).toBe(201);
    this.media.add(r.json.data.id);
    return r.json.data.id as string;
  }

  /** Undo everything. Never throws (afterAll); returns the problems for the report. */
  async cleanup(): Promise<string[]> {
    const problems: string[] = [];
    const note = (what: string, status: number, ok: number[]) => {
      if (!ok.includes(status)) problems.push(`${what} → ${status}`);
    };
    for (const id of this.imports) {
      const r = await api(this.s, 'DELETE', `${this.base}/imports/${id}`);
      note(`DELETE import ${id}`, r.status, [204, 404, 409]);
    }
    // Detach images first: product_images keep media RESTRICT even after a soft delete.
    for (const id of this.products) {
      const p = await api(this.s, 'GET', `${this.base}/products/${id}`);
      if (p.status === 200 && p.json.data.images?.length) {
        const variants = (p.json.data.variants as Json[]).map((v) => ({ id: v.id, option_values: v.option_values, sku: v.sku, price_amount: v.price_amount, image_media_id: null }));
        const r = await api(this.s, 'PATCH', `${this.base}/products/${id}`, { revision: p.json.data.revision, images: [], variants });
        note(`detach images ${id}`, r.status, [200]);
      }
      const d = await api(this.s, 'DELETE', `${this.base}/products/${id}`);
      note(`DELETE product ${id}`, d.status, [204, 404]);
    }
    for (const id of [...this.categories].reverse()) {
      const r = await api(this.s, 'DELETE', `${this.base}/categories/${id}`);
      note(`DELETE category ${id}`, r.status, [204, 404]);
    }
    for (const id of this.customers) {
      const r = await api(this.s, 'DELETE', `${this.base}/customers/${id}`);
      note(`DELETE customer ${id}`, r.status, [204, 404]);
    }
    // Exports have no DELETE endpoint (they expire after 24 h): remove this run's rows and files directly.
    const ex = [...this.exports].filter((i) => /^[0-9a-z]{26}$/i.test(i));
    if (ex.length) {
      try {
        tinker(
          `$ids=['${ex.join("','")}']; foreach(DB::table('data_exports')->whereIn('id',$ids)->where('store_id','${this.s.storeId}')->get() as $e){ if($e->file_path){ foreach(['local','public'] as $d){ try { Illuminate\\Support\\Facades\\Storage::disk($d)->delete($e->file_path); } catch (Throwable $x) {} } } } DB::table('data_exports')->whereIn('id',$ids)->where('store_id','${this.s.storeId}')->delete(); echo 'ok';`,
        );
      } catch (e) {
        problems.push(`purge exports: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    for (const id of this.media) {
      const r = await api(this.s, 'DELETE', `/media/${id}`);
      note(`DELETE media ${id}`, r.status, [204, 404]);
    }
    return problems;
  }
}

/**
 * Hard-removes this run's soft-deleted rows from the store (products + their variants/inventory/ledger by
 * cascade, categories, customers, imports, exports), so the demo DB ends as it started. Test-only; scoped
 * to the store AND to names containing this run's tag AND (for soft-deletable rows) deleted_at not null.
 */
export function purgeRun(storeId: string, extraProductIds: string[] = [], tagLike = `%E2E ${RUN}%`, fileLike = `%e2e-${RUN}%`): string {
  if (!/^[0-9a-z]{26}$/i.test(storeId)) throw new Error('bad store id');
  const ids = extraProductIds.filter((i) => /^[0-9a-z]{26}$/i.test(i)).map((i) => `'${i}'`).join(',');
  const like = tagLike;
  return tinker(
    [
      `$sid='${storeId}'; $like='${like}'; $DB='Illuminate\\Support\\Facades\\DB'; $S='Illuminate\\Support\\Facades\\Schema';`,
      `$n=0;`,
      `if($S::hasTable('products')){ $q=$DB::table('products')->where('store_id',$sid)->whereNotNull('deleted_at')->where(function($w) use ($like){ $w->where('name','like',$like)${ids ? `->orWhereIn('id',[${ids}])` : ''}; }); $pids=$q->pluck('id')->all();`,
      `  if($pids){ $vids=$DB::table('product_variants')->whereIn('product_id',$pids)->pluck('id')->all(); $DB::table('inventory_movements')->whereIn('variant_id',$vids)->delete(); $DB::table('inventories')->whereIn('variant_id',$vids)->delete(); $DB::table('product_variants')->whereIn('product_id',$pids)->delete(); $DB::table('product_images')->whereIn('product_id',$pids)->delete(); $DB::table('product_categories')->whereIn('product_id',$pids)->delete(); $n+=$DB::table('products')->whereIn('id',$pids)->delete(); } }`,
      `if($S::hasTable('categories')){ foreach([3,2,1] as $d){ $n+=$DB::table('categories')->where('store_id',$sid)->where('depth',$d)->whereNotNull('deleted_at')->where('name','like',$like)->delete(); } }`,
      `if($S::hasTable('customers')){ $cids=$DB::table('customers')->where('store_id',$sid)->whereNotNull('deleted_at')->where('name','like',$like)->pluck('id')->all(); if($cids){ $DB::table('customer_notes')->whereIn('customer_id',$cids)->delete(); $n+=$DB::table('customers')->whereIn('id',$cids)->delete(); } }`,
      `if($S::hasTable('data_imports')){ $iids=$DB::table('data_imports')->where('store_id',$sid)->where('filename','like','${fileLike}')->pluck('id')->all(); if($iids){ $DB::table('data_import_rows')->whereIn('import_id',$iids)->delete(); $n+=$DB::table('data_imports')->whereIn('id',$iids)->delete(); } }`,
      `echo 'purged '.$n;`,
    ].join(' '),
  );
}

// ---------------------------------------------------------------------------------------------
// Imports / exports
// ---------------------------------------------------------------------------------------------
export async function uploadImport(s: Session, type: 'products' | 'customers', file: Buffer, filename = `e2e-${RUN}-${type}.csv`, as: ApiAuth = s) {
  return apiCall(as, 'POST', `/stores/${s.storeId}/imports`, {
    multipart: { type, file: { name: filename, mimeType: 'text/csv', buffer: file } },
  });
}

/** Polls GET /imports/{id} until the status leaves validating/importing. */
export async function waitImport(s: Session, id: string, timeoutMs = 120_000): Promise<Json> {
  let last: Json = {};
  await expect
    .poll(
      async () => {
        last = (await api(s, 'GET', `/stores/${s.storeId}/imports/${id}`)).json.data ?? {};
        return last.status;
      },
      // bulk is served after default/media by a shared worker: storefront revalidation jobs can delay it.
      { timeout: timeoutMs, intervals: [500, 1000, 2000], message: 'import still running: is a queue worker consuming the `bulk` queue?' },
    )
    .not.toMatch(/^(validating|importing)$/);
  return last;
}

export async function waitExport(s: Session, id: string, timeoutMs = 60_000): Promise<Json> {
  let last: Json = {};
  await expect
    .poll(
      async () => {
        last = (await api(s, 'GET', `/stores/${s.storeId}/exports/${id}`)).json.data ?? {};
        return last.status;
      },
      { timeout: timeoutMs, intervals: [500, 1000, 2000], message: 'export still queued/running: is a worker on the `bulk` queue?' },
    )
    .toMatch(/^(completed|failed|expired)$/);
  return last;
}

export async function allRows(s: Session, importId: string, status?: string): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 1; page < 60; page++) {
    const q = `?per_page=100&page=${page}${status ? `&filter[status]=${status}` : ''}`;
    const r = await api(s, 'GET', `/stores/${s.storeId}/imports/${importId}/rows${q}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    out.push(...(r.json.data as Json[]));
    if (page >= (r.json.meta?.last_page ?? 1)) break;
  }
  return out;
}

/** Total ledger rows for a product (all pages counted through meta.total). */
export async function movementCount(s: Session, productId: string): Promise<number> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/inventory/movements?filter[product_id]=${productId}&per_page=1`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.meta.total as number;
}

/** Products in the store whose name/SKU contains `q` (all statuses). */
export async function findProducts(s: ApiAuth & { storeId?: string }, storeId: string, q: string): Promise<Json[]> {
  const r = await api(s, 'GET', `/stores/${storeId}/products?q=${encodeURIComponent(q)}&per_page=100`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

/** Storefront API key (server-to-server), read from env or the local apps/api/.env, for feed assertions. */
export function storefrontKey(): string {
  if (process.env.STOREFRONT_API_KEY) return process.env.STOREFRONT_API_KEY;
  const env = resolve(API_DIR, '.env');
  const m = existsSync(env) ? readFileSync(env, 'utf8').match(/^STOREFRONT_API_KEY=(.*)$/m) : null;
  return (m?.[1] ?? 'dev-storefront-key-change-me').trim().replace(/^"|"$/g, '');
}

/** GET /storefront/products as the storefront server would (key + host). */
export async function storefrontFeed(host: string, query = '', preview?: string) {
  const res = await fetch(`${urls.api}/api/v1/storefront/products${query}`, {
    headers: { Accept: 'application/json', 'X-Storefront-Key': storefrontKey(), 'X-Storefront-Host': host, ...(preview ? { 'X-Storefront-Preview': preview } : {}) },
  });
  const text = await res.text();
  let json: Json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers: Object.fromEntries(res.headers) };
}

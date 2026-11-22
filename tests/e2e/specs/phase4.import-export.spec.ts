import { expect, test } from '@playwright/test';
import { api, apiCall, demoSession, signInDashboard, urls, type Session } from '../support/api';
import {
  RUN,
  Tracker,
  allRows,
  csvObjects,
  findProducts,
  isFormulaUnsafe,
  movementCount,
  parseCsv,
  purgeRun,
  simpleProduct,
  sku,
  tagged,
  toCsv,
  uploadImport,
  waitExport,
  waitImport,
} from '../support/catalog';

/**
 * Phase 4 §3.4 / §5 / §15.4: CSV import and export on the demo store. Needs a queue worker on `bulk`.
 *  - UI: upload a fixture → fix the column map (one header has no alias) → validate (dry-run) → review the
 *    error rows → download the error report → run → products exist.
 *  - API: nothing changes until Run; re-running the same file gives only `unchanged` rows and no new
 *    ledger rows; the error report and the export are formula-safe; export is a round-trip of the columns.
 */
test.describe.configure({ mode: 'serial' });

let s: Session;
let t: Tracker;
const IM = () => `/stores/${s.storeId}/imports`;

// "Unit Price" is deliberately not a §5.2 alias: the user has to map it to `price`.
const HEADER = ['Handle', 'Title', 'Description', 'Status', 'Category', 'Option1 Name', 'Option1 Value', 'SKU', 'Unit Price', 'Compare at price', 'Stock'];
const cat = tagged('Imported');
const rows = (): string[][] => [
  HEADER,
  // 1–2: one product, two variants, with price/digit normalisation (warnings).
  [`e2e-${RUN}-tee`, tagged('Import tee'), 'Soft cotton.\n\nSecond paragraph <b>bold</b>', 'active', cat, 'Size', 'M', sku('IMP-TEE-M'), '950tk', '', '5'],
  [`e2e-${RUN}-tee`, '', '', '', '', 'Size', 'L', sku('IMP-TEE-L'), '৳ 1,050', '1200', '৩'],
  // 3: missing price → error.
  [`e2e-${RUN}-mug`, tagged('Import mug'), '', 'draft', '', '', '', sku('IMP-MUG'), '', '', '2'],
  // 4: negative stock + formula-looking name → error, and the error report must neutralise the name.
  [`e2e-${RUN}-cap`, `=HYPERLINK("http://evil.example","${tagged('cap')}")`, '', 'draft', '', '', '', sku('IMP-CAP'), '300', '', '-1'],
  // 5: a plain simple product.
  [`e2e-${RUN}-bag`, tagged('Import bag'), '', 'draft', '', '', '', sku('IMP-BAG'), '2,500.50', '', '0'],
];

const OPTIONS = { update_existing: true, import_as_draft: false, create_missing_categories: true };

test.beforeAll(async () => {
  s = await demoSession();
  t = new Tracker(s);
});

test.afterAll(async () => {
  for (const p of await findProducts(s, s.storeId, RUN)) t.products.add(p.id);
  const cats = await api(s, 'GET', `/stores/${s.storeId}/categories?q=${encodeURIComponent(RUN)}`);
  for (const c of (cats.json.data ?? []) as Array<{ id: string; depth: number }>) if (!t.categories.includes(c.id)) t.categories.push(c.id);
  const problems = await t.cleanup();
  purgeRun(s.storeId, [...t.products]);
  expect(problems, 'cleanup').toEqual([]);
});

test('template: CSV with BOM, header and 2 example rows; formula-safe', async () => {
  const r = await apiCall(s, 'GET', `${IM()}/template?type=products`);
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/text\/csv/);
  expect(r.headers['content-disposition']).toContain('storeplix-products-template.csv');
  expect(r.text.charCodeAt(0)).toBe(0xfeff);
  const parsed = parseCsv(r.text);
  expect(parsed).toHaveLength(3);
  expect(parsed.flat().filter(isFormulaUnsafe)).toEqual([]);
  expect((await apiCall(s, 'GET', `${IM()}/template?type=orders`)).status).toBe(422);
});

test('UI: upload → fix the column map → dry-run review with errors → error report → run', async ({ page, context }) => {
  test.setTimeout(180_000);
  await signInDashboard(context, s);
  await page.goto(`${urls.merchant}/products/import`);

  const uploaded = page.waitForResponse((r) => r.url().endsWith(IM()) && r.request().method() === 'POST');
  await page.locator('input[type="file"]').first().setInputFiles({ name: `e2e-${RUN}-products.csv`, mimeType: 'text/csv', buffer: toCsv(rows()) });
  const up = await uploaded;
  expect(up.status(), await up.text()).toBe(201);
  const imp = (await up.json()).data;
  t.imports.add(imp.id);
  expect(imp).toMatchObject({ status: 'uploaded', row_count: 5, headers: HEADER });
  expect(imp.suggested_map).toMatchObject({ Title: 'name', SKU: 'sku', Stock: 'stock', 'Option1 Name': 'option1_name' });
  expect(imp.suggested_map['Unit Price']).toBeNull();

  // Step 2: match columns. Unmatched "Unit Price" → price.
  await page.getByLabel('Field for Unit Price').selectOption({ label: 'Price' });
  // Nothing has been written yet (dry run comes next).
  expect(await findProducts(s, s.storeId, `${RUN} Import`)).toEqual([]);

  const validating = page.waitForResponse((r) => r.url().endsWith(`/imports/${imp.id}/validate`));
  await page.getByRole('button', { name: 'Check rows', exact: true }).click();
  const v = await validating;
  expect(v.status(), await v.text()).toBe(202);
  expect(v.request().postDataJSON().column_map['Unit Price']).toBe('price');

  const done = await waitImport(s, imp.id);
  expect(done.status).toBe('validated');
  expect(done.summary).toMatchObject({ errors: 2 });
  expect(done.summary.warnings).toBeGreaterThanOrEqual(1);
  expect(await findProducts(s, s.storeId, `${RUN} Import`), 'dry-run writes nothing').toEqual([]);

  // Review: Errors chip shows rows 3 and 4 with their messages.
  await page.getByRole('tablist', { name: 'Row filter' }).getByRole('tab', { name: /^Errors/ }).click();
  const reviewList = page.getByRole('list', { name: 'Rows' });
  await expect(reviewList.getByText(/price/i).first()).toBeVisible();
  await expect(reviewList.getByText("Stock can't be negative").first()).toBeVisible();
  const errRows = await allRows(s, imp.id, 'error');
  // row_number is the spreadsheet line (header = line 1): the mug and cap rows are lines 4 and 5.
  expect(errRows.map((r) => r.row_number).sort()).toEqual([4, 5]);
  const warn = await allRows(s, imp.id, 'warning');
  expect(warn.flatMap((r) => r.messages.map((m: { message: string }) => m.message)).join(' | ')).toMatch(/950tk/);

  // Error report: original columns + errors; formula-safe.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download error report' }).first().click()]);
  const report = (await (await dl.createReadStream()).toArray()).map((b) => Buffer.from(b)).join('');
  const reportRows = csvObjects(report);
  expect(Object.keys(reportRows[0]!)).toEqual([...HEADER, 'errors']);
  expect(reportRows.length).toBeGreaterThanOrEqual(2);
  const capRow = reportRows.find((r) => r.SKU === sku('IMP-CAP'))!;
  expect(capRow.Title.startsWith("'="), `error report cell: ${capRow.Title}`).toBe(true);
  for (const cell of parseCsv(report).flat()) expect(isFormulaUnsafe(cell), `unsafe cell ${JSON.stringify(cell)}`).toBe(false);

  // Run (the Download-photos toggle is disabled, "Coming soon").
  await expect(page.getByRole('switch', { name: 'Download photos from image URLs' }).or(page.getByRole('checkbox', { name: 'Download photos from image URLs' })).first()).toBeDisabled();
  const running = page.waitForResponse((r) => r.url().endsWith(`/imports/${imp.id}/run`));
  await page.getByRole('button', { name: /^Import \d+ (rows?|products?)/ }).click();
  expect((await running).status()).toBe(202);
  const finished = await waitImport(s, imp.id, 120_000);
  expect(finished.status).toBe('completed');
  await expect(page.getByText(/imported|done|complete/i).first()).toBeVisible({ timeout: 15_000 });

  const created = await findProducts(s, s.storeId, `${RUN} Import`);
  expect(created.map((p) => p.name).sort()).toEqual([tagged('Import bag'), tagged('Import tee')].sort());
  const tee = (await api(s, 'GET', `/stores/${s.storeId}/products/${created.find((p) => p.name === tagged('Import tee'))!.id}`)).json.data;
  expect(tee).toMatchObject({ type: 'variable', status: 'active' });
  expect(tee.variants.map((v: { price_amount: number; inventory: { on_hand: number } }) => [v.price_amount, v.inventory.on_hand])).toEqual([
    [95000, 5],
    [105000, 3],
  ]);
  expect(tee.categories.map((c: { name: string }) => c.name)).toEqual([cat]);
  // HTML stripped to text; never stored as HTML.
  expect(JSON.stringify(tee.description)).not.toContain('<b>');
  const bag = created.find((p) => p.name === tagged('Import bag'))!;
  expect(bag.price_amount).toBe(250050);
});

test('API: re-running the same file → all unchanged, no new ledger rows', async () => {
  const before = await findProducts(s, s.storeId, `${RUN} Import`);
  expect(before).toHaveLength(2);
  const ledgerBefore = await Promise.all(before.map((p) => movementCount(s, p.id)));

  const up = await uploadImport(s, 'products', toCsv(rows()), `e2e-${RUN}-rerun.csv`);
  expect(up.status, up.text).toBe(201);
  t.imports.add(up.json.data.id);
  const map = { ...up.json.data.suggested_map, 'Unit Price': 'price' };
  const v = await api(s, 'POST', `${IM()}/${up.json.data.id}/validate`, { column_map: map, options: OPTIONS });
  expect(v.status, JSON.stringify(v.json)).toBe(202);
  const validated = await waitImport(s, up.json.data.id);
  expect(validated.summary).toMatchObject({ create: 0, update: 0, errors: 2 });
  expect(validated.summary.unchanged).toBe(3);

  const run = await api(s, 'POST', `${IM()}/${up.json.data.id}/run`);
  expect(run.status, JSON.stringify(run.json)).toBe(202);
  expect((await waitImport(s, up.json.data.id, 120_000)).status).toBe('completed');
  expect(await findProducts(s, s.storeId, `${RUN} Import`)).toHaveLength(2);
  expect(await Promise.all(before.map((p) => movementCount(s, p.id)))).toEqual(ledgerBefore);

  // Run from a non-validated state / cancel rules.
  expect((await api(s, 'POST', `${IM()}/${up.json.data.id}/run`)).status).toBe(409);
});

test('API: export is formula-safe (= + - @ and full-width), BOM + CRLF + quoted, and round-trips the columns', async () => {
  test.setTimeout(90_000);
  const names = ['=SUM(1+1)', '+cmd', '-2+3', '@SUM(A1)', '＝HYPERLINK()', ' =lead space'].map((n) => `${n} ${tagged('fx')}`);
  for (const [i, name] of names.entries()) {
    await t.createProduct({ ...simpleProduct(`fx${i}`, 1000 + i), name, tags: [`-tag${i}`, `@at${i}`] });
  }
  const ex = await api(s, 'POST', `/stores/${s.storeId}/exports`, { type: 'products', filters: { q: `${RUN} fx` } });
  expect(ex.status, JSON.stringify(ex.json)).toBe(202);
  t.exports.add(ex.json.data.id);
  expect(ex.json.data.status).toBe('queued');
  const done = await waitExport(s, ex.json.data.id);
  expect(done.status).toBe('completed');
  expect(done.download_url).toBeTruthy();
  expect(done.row_count).toBe(names.length);

  const res = await fetch(done.download_url);
  expect(res.status).toBe(200);
  const raw = Buffer.from(await res.arrayBuffer());
  expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
  const text = raw.toString('utf8');
  expect(text).toContain('\r\n');
  expect(text.split('\r\n')[0]!.split(',').every((c) => /^".*"$/.test(c.replace(/^﻿/, ''))), 'every field quoted').toBe(true);
  const table = parseCsv(text);
  for (const cell of table.flat()) expect(isFormulaUnsafe(cell), `unsafe exported cell ${JSON.stringify(cell)}`).toBe(false);
  const exportedNames = csvObjects(text).map((r) => r.name);
  expect(exportedNames.filter((n) => n.startsWith("'"))).toHaveLength(names.length);

  // Same columns as the import template (round-trip).
  const tpl = parseCsv((await apiCall(s, 'GET', `${IM()}/template?type=products`)).text)[0];
  expect(table[0]).toEqual(tpl);

  // A tampered signature is refused; every GET mints a fresh URL.
  const u = new URL(done.download_url);
  u.searchParams.set('signature', '0'.repeat(64));
  expect([401, 403]).toContain((await fetch(u)).status);
  const again = await api(s, 'GET', `/stores/${s.storeId}/exports/${ex.json.data.id}`);
  expect(again.json.data.download_url).toBeTruthy();
});

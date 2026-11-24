import { expect, test } from '@playwright/test';
import { api, apiCall } from '../support/api';
import { png } from '../support/catalog';
import {
  canvasJpeg,
  createExpense,
  exifSegments,
  expenseShop,
  fetchRaw,
  patchExpense,
  receiptLink,
  receiptLinkRaw,
  storedReceipt,
  tinyPdf,
  uploadReceipt,
  uploadReceiptRaw,
  withGpsExif,
  type ExpenseShop,
} from '../support/expenses';

/**
 * PHASE-8-7 §13 QA receipts + AC 4 (P87-7, P87-8, §5, S143–S146), the browser/API-checkable part (Pest covers the
 * full matrix, limiters, prune races and the route-generated media dataset):
 *  - a JPG with GPS EXIF uploaded and re-downloaded has no EXIF (stored object and download checked); the link answers
 *    409 `receipt_processing` until `ProcessMedia` ran;
 *  - a PDF receipt downloads as `attachment` with `nosniff` + CSP `sandbox`; a tampered signature → 403;
 *  - sniffing: SVG, HTML, GIF, a JPEG named `.pdf`, a `%PDF-` file without `%%EOF` → 422 with the contract message;
 *  - receipts never appear in, and can't be reached through, the generic `/media` library (S145);
 *  - binding: a product image id or a receipt already on another expense → 422 (S146).
 */
test.describe.configure({ mode: 'serial' });

let shop: ExpenseShop;
const ids: Record<string, string> = {};
const UNSUPPORTED = /Unsupported file type\. Allowed: JPG, PNG, WebP, PDF\./;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await expenseShop('exr', 'starter');
});
test.afterAll(() => shop?.cleanup());

test('JPG with GPS EXIF → stored and downloaded without EXIF (P87-7, S143)', async ({ browser }) => {
  test.setTimeout(120_000);
  const jpg = withGpsExif(await canvasJpeg(browser, 800, 600));
  expect(exifSegments(jpg), 'fixture really carries EXIF').toHaveLength(1);
  const receipt = await uploadReceipt(shop.s, { name: 'qa-gps.jpg', mimeType: 'image/jpeg', buffer: jpg });
  expect(receipt).toMatchObject({ mime: 'image/jpeg' });
  expect(JSON.stringify(receipt), 'no URL in the upload response (S144)').not.toMatch(/https?:\/\//);
  const e = await createExpense(shop.s, { amount: 50000, category: 'packaging', paid_from: 'cash', spent_on: shop.today, note: 'QA gps receipt', receipt_id: receipt.id });
  ids.gpsExpense = e.id;
  ids.gpsReceipt = receipt.id;
  expect(JSON.stringify(e)).not.toMatch(/https?:\/\//);

  const { link, sawProcessing } = await receiptLink(shop.s, e.id);
  test.info().annotations.push({ type: 'receipt', description: sawProcessing ? '409 receipt_processing seen before ready' : 'already ready at first look' });
  const res = await fetchRaw(link.url);
  expect(res.status, res.text).toBe(200);
  expect(res.headers.get('content-disposition')).toMatch(/^inline/);
  expect(exifSegments(res.body), 'downloaded receipt has no EXIF').toEqual([]);
  expect(res.body.includes(Buffer.from('QA-Phone')), 'camera make gone').toBe(false);

  const stored = storedReceipt(receipt.id);
  expect(stored, 'media row').toBeTruthy();
  expect(stored!.status).toBe('ready');
  expect(stored!.disk, 'private disk (storeplix.private_disk)').not.toBe('public');
  expect(stored!.path).toMatch(new RegExp(`^tenants/${shop.s.tenantId}/media/${receipt.id}/original\\.jpg$`, 'i'));
  expect(exifSegments(Buffer.from(stored!.bytesB64, 'base64')), 'stored object has no EXIF').toEqual([]);
});

test('PDF receipt → attachment, nosniff, CSP sandbox, no-store; tampered or stripped signature → 403 (§5.3, S144)', async () => {
  const receipt = await uploadReceipt(shop.s, { name: 'qa-bill.pdf', mimeType: 'application/pdf', buffer: tinyPdf() });
  expect(receipt.mime).toBe('application/pdf');
  const e = await createExpense(shop.s, { amount: 120000, category: 'rent_bills', paid_from: 'bank', spent_on: shop.today, note: 'QA pdf bill', receipt_id: receipt.id });
  ids.pdfExpense = e.id;
  const first = await receiptLinkRaw(shop.s, e.id);
  expect(first.status, 'PDF is ready at upload (never 409)').toBe(200);
  const res = await fetchRaw(first.json.data.url);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/pdf/);
  expect(res.headers.get('content-disposition')).toMatch(new RegExp(`^attachment;.*receipt-${shop.today}\\.pdf`));
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
  expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
  expect(res.headers.get('cache-control')).toMatch(/no-store/);
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  const u = new URL(first.json.data.url);
  const sig = u.searchParams.get('signature')!;
  u.searchParams.set('signature', `${sig.slice(0, -2)}${sig.endsWith('00') ? '11' : '00'}`);
  expect((await fetchRaw(u.toString())).status, 'tampered signature').toBe(403);
  u.searchParams.delete('signature');
  expect((await fetchRaw(u.toString())).status, 'no signature').toBe(403);
  // another media id under the original signature: signature no longer matches → 403
  const other = new URL(first.json.data.url);
  other.pathname = other.pathname.replace(receipt.id, ids.gpsReceipt);
  expect([403, 404]).toContain((await fetchRaw(other.toString())).status);
});

test('sniffing (S143): SVG, HTML, GIF, JPEG named .pdf with PDF type, %PDF- without %%EOF → 422', async ({ browser }) => {
  const jpg = await canvasJpeg(browser, 200, 200);
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const cases: Array<[string, string, Buffer]> = [
    ['qa.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="200" height="200"/></svg>')],
    ['qa.html', 'text/html', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['qa.gif', 'image/gif', gif],
    ['qa.php', 'application/pdf', Buffer.from('<?php echo 1; ?>')],
    ['qa-photo.pdf', 'application/pdf', jpg],
    ['qa-noeof.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n'.padEnd(3000, ' '))],
  ];
  for (const [name, mimeType, buffer] of cases) {
    const r = await uploadReceiptRaw(shop.s, { name, mimeType, buffer });
    expect(r.status, `${name}: ${r.text.slice(0, 300)}`).toBe(422);
    expect(JSON.stringify(r.json), name).toMatch(UNSUPPORTED);
  }
  const big = Buffer.concat([tinyPdf().subarray(0, 9), Buffer.alloc(5 * 1024 * 1024 + 10, 0x20), Buffer.from('\n%%EOF\n')]);
  const r = await uploadReceiptRaw(shop.s, { name: 'qa-big.pdf', mimeType: 'application/pdf', buffer: big });
  expect(r.status).toBe(422);
  expect(JSON.stringify(r.json)).toMatch(/larger than 5 MB/);
});

test('media library separation (S145): receipts not listed, show/destroy 404, POST /media purpose=expense_receipt 422', async () => {
  const list = await apiCall(shop.s, 'GET', '/media?per_page=60');
  expect(list.status, list.text.slice(0, 300)).toBe(200);
  expect(list.text).not.toContain(ids.gpsReceipt);
  expect(list.text).not.toContain('expense_receipt');
  const filtered = await apiCall(shop.s, 'GET', '/media?filter[purpose]=expense_receipt');
  expect([200, 400, 422], filtered.text.slice(0, 300)).toContain(filtered.status);
  expect(filtered.text).not.toContain(ids.gpsReceipt);
  const show = await api(shop.s, 'GET', `/media/${ids.gpsReceipt}`);
  expect([show.status, show.json.error?.code]).toEqual([404, 'not_found']);
  const destroy = await api(shop.s, 'DELETE', `/media/${ids.gpsReceipt}`);
  expect(destroy.status).toBe(404);
  const up = await apiCall(shop.s, 'POST', '/media', { multipart: { purpose: 'expense_receipt', file: { name: 'qa.png', mimeType: 'image/png', buffer: png(200, [10, 20, 30]) } } });
  expect(up.status, up.text.slice(0, 300)).toBe(422);
  // the receipt is still there and still works
  expect((await receiptLinkRaw(shop.s, ids.gpsExpense)).status).toBe(200);
});

test('binding (S146): product image id or a receipt already attached → 422; replace deletes the old one', async () => {
  const sid = shop.s.storeId;
  const productImage = await apiCall(shop.s, 'POST', '/media', { multipart: { purpose: 'product_image', file: { name: 'qa-prod.png', mimeType: 'image/png', buffer: png(320, [200, 40, 40]) } } });
  expect(productImage.status, productImage.text.slice(0, 300)).toBe(201);
  const base = { amount: 1000, category: 'other', paid_from: 'cash', spent_on: shop.today };
  for (const receipt_id of [productImage.json.data.id as string, ids.gpsReceipt]) {
    const r = await api(shop.s, 'POST', `/stores/${sid}/expenses`, { ...base, receipt_id });
    expect([r.status, r.json.error?.code], JSON.stringify(r.json)).toEqual([422, 'validation_failed']);
    expect(JSON.stringify(r.json.error?.details)).toContain('receipt_id');
  }
  // replace the PDF on its expense with a new one → old object gone after commit
  const oldId = (await api(shop.s, 'GET', `/stores/${sid}/expenses/${ids.pdfExpense}`)).json.data.receipt.id as string;
  const next = await uploadReceipt(shop.s, { name: 'qa-bill-2.pdf', mimeType: 'application/pdf', buffer: tinyPdf('second') });
  const patched = await patchExpense(shop.s, ids.pdfExpense, { receipt_id: next.id });
  expect(patched.receipt.id).toBe(next.id);
  await expect.poll(() => storedReceipt(oldId), { timeout: 15_000, message: 'replaced receipt row + object deleted' }).toBeNull();
  // remove → null, link 404
  const removed = await patchExpense(shop.s, ids.pdfExpense, { receipt_id: null });
  expect(removed.receipt).toBeNull();
  const link = await receiptLinkRaw(shop.s, ids.pdfExpense);
  expect([link.status, link.json.error?.code]).toEqual([404, 'receipt_not_found']);
});

test('isolation (S141): another tenant gets 404 for this store\'s expense, receipt link and download id', async () => {
  const eve = await expenseShop('exe', 'growth');
  try {
    const sid = shop.s.storeId;
    for (const path of [`/stores/${sid}/expenses`, `/stores/${sid}/expenses/${ids.gpsExpense}`, `/stores/${sid}/expenses/${ids.gpsExpense}/receipt`, `/stores/${sid}/expenses/summary`]) {
      const r = await api(eve.s, 'GET', path);
      expect(r.status, `${path} as another tenant`).toBe(404);
    }
    // own store, foreign expense id → 404
    const r = await api(eve.s, 'GET', `/stores/${eve.s.storeId}/expenses/${ids.gpsExpense}`);
    expect(r.status).toBe(404);
    const attach = await api(eve.s, 'POST', `/stores/${eve.s.storeId}/expenses`, { amount: 1000, category: 'other', paid_from: 'cash', spent_on: eve.today, receipt_id: ids.gpsReceipt });
    expect(attach.status, "another tenant's receipt id → 422").toBe(422);
  } finally {
    eve.cleanup();
  }
});

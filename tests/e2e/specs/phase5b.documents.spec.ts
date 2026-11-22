import { expect, test } from '@playwright/test';
import { api, signInDashboard, urls } from '../support/api';
import { placeOrder, setupShop, transition, type CommerceShop } from '../support/commerce';

/**
 * PHASE-5B-CONTRACT §13 QA "documents" on a throwaway shop (html driver in e2e, P5B-57): two confirmed orders are
 * in "Not printed"; the live preview is a sandboxed iframe showing the chosen order; "Print 2 labels" queues one
 * document, the worker on `documents` renders it, a new tab opens the 5-minute signed URL; both orders move to
 * "Printed today" and get `label_printed_at`. The signed URL is refused without its signature and after tampering.
 */
let shop: CommerceShop;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(90_000);
  shop = await setupShop('doc', { stock: 10 });
});
test.afterAll(() => shop?.cleanup());

const orderId = async (number: string) => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${number}`)).json.data[0].id as string;
const order = async (id: string) => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${id}`)).json.data;

test('print 2 labels → new tab with the document → both orders in Printed today', async ({ page, context }) => {
  test.setTimeout(120_000);
  const m = shop.variable.variants[0];
  const placed = [
    await placeOrder(shop, m.id, 1, { body: { contact: { name: 'রহিম উদ্দিন' } } }),
    await placeOrder(shop, shop.simple.variantId, 2, { body: { contact: { name: 'Karim Ahmed' } } }),
  ];
  const ids = await Promise.all(placed.map((p) => orderId(p.order.number as string)));
  for (const id of ids) expect((await transition(shop.s, id, 'confirm')).status).toBe(200);

  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders/print`);
  await expect(page.getByRole('heading', { name: 'Invoices & labels' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Not printed · 2/ })).toBeVisible();
  const list = page.getByRole('list', { name: 'Orders to print' });
  for (const p of placed) await expect(list.getByText(p.order.number)).toBeVisible();

  // Live preview: a sandboxed iframe (no scripts, no same-origin) rendering a real chosen order.
  const iframe = page.locator('iframe[title="Document preview"]');
  await expect(iframe).toHaveAttribute('sandbox', '');
  const frame = page.frameLocator('iframe[title="Document preview"]');
  await expect(frame.getByText(/রহিম উদ্দিন|Karim Ahmed/).first()).toBeVisible({ timeout: 15_000 });

  // "Print 2 labels" opens a tab first (popup blockers), then points it at the signed URL once ready.
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Print 2 labels' }).first().click(); // header action (the settings panel repeats it)
  const tab = await popup;
  await tab.waitForURL(/\/documents\/[0-9a-z]{26}\/download\?.*signature=/, { timeout: 60_000 });
  const signed = tab.url();
  const body = await tab.content();
  for (const p of placed) expect(body).toContain(p.order.number);
  expect(body).toContain('রহিম উদ্দিন');
  await tab.close();

  // Printed flags + tabs (the list refetches after printing).
  await expect.poll(async () => (await Promise.all(ids.map(order))).map((o) => !!o.label_printed_at), { timeout: 20_000 }).toEqual([true, true]);
  await expect(page.getByRole('tab', { name: /Not printed · 0/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: /Printed today · 2/ }).click();
  for (const p of placed) await expect(list.getByText(p.order.number)).toBeVisible();

  // S35: the download is only valid with its signature.
  const unsigned = await page.request.get(signed.replace(/[?&]signature=[^&]+/, ''), { maxRedirects: 0 });
  expect(unsigned.status()).toBe(403);
  const tampered = await page.request.get(signed.replace(/signature=([0-9a-f])/, (_s, c: string) => `signature=${c === '0' ? '1' : '0'}`), { maxRedirects: 0 });
  expect(tampered.status()).toBe(403);
  const ok = await page.request.get(signed);
  expect(ok.status()).toBe(200);
  expect(ok.headers()['cache-control'] ?? '').toContain('no-store');
});

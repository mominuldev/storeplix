import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { mUrl } from '../support/locations';
import { pageOverflow, watchConsole } from '../support/roles';
import { cart, cashSale, gotoPos, historyUrl, holdRaw, openSession, posShop, stubPrint, tile, WRAP, type PosShop } from '../support/pos';

/**
 * PHASE-8-8D part B screens (§11.6 Held sales 22:2409, §11.7 Sales history 27:754, Return items; §11.9; §16 AC 8) at 1280
 * and 390 px: no page overflow, no console errors, omissions absent ("Void receipt (manager PIN)", "Return or exchange
 * items", the 30-minute reservation copy), empty states "No held sales" / "No sales yet today".
 * Screenshots: tests/e2e/test-results/phase8-8d-b-visual/{1280,390}/.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let sess: Json;
let sale: Json;
const SHOTS = resolve(E2E_ROOT, 'test-results/phase8-8d-b-visual');

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('pbvis', 'growth', { online: 10, atShop: 8 });
  sess = await openSession(shop.s, shop.register.id, { opening_cash_amount: 200000 });
});
test.afterAll(() => shop?.cleanup());

async function shot(page: Page, width: number, name: string): Promise<void> {
  const dir = resolve(SHOTS, String(width));
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
}
const noOverflow = async (page: Page, where: string) => expect(await pageOverflow(page), `${where}: no horizontal scroll`).toBeNull();

test('empty states: No sales yet today, No held sales', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(mUrl(historyUrl(sess.id)));
    await expect(page.getByTestId('pos-history-empty')).toHaveText('No sales yet today', { timeout: 20_000 });
    await noOverflow(page, `history empty ${width}`);
    await shot(page, width, '01-history-empty');
    await gotoPos(page, `/pos/${sess.id}`);
    await page.getByTestId('pos-held-open').click();
    await expect(page.getByTestId('pos-held-empty')).toHaveText('No held sales');
    await shot(page, width, '02-held-empty');
  }
  sale = await cashSale(shop.s, sess.id, [{ variant_id: shop.wrap, quantity: 2 }, { variant_id: shop.kurtaM, quantity: 1 }], { tendered_cash_amount: 250000 });
  for (const n of ['Trying another size', 'Back in 10 min'])
    expect((await holdRaw(shop.s, { session_id: sess.id, lines: [{ variant_id: shop.kurtaL, quantity: 1 }], note: n })).status).toBe(201);
});

for (const width of [1280, 390]) {
  test(`${width} px: hold dialog, held drawer, history, receipt detail, return dialog`, async ({ page, context }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 800 });
    const c = watchConsole(page);
    await stubPrint(page);
    await signInDashboard(context, shop.s);
    await gotoPos(page, `/pos/${sess.id}`);
    await expect(page.getByTestId('pos-held-open')).toHaveText('Held · 2');
    await tile(page, WRAP).click();
    if (width < 768) await expect(page.getByTestId('pos-mobile-charge-bar')).toContainText('Charge');
    else await expect(cart(page).getByTestId('pos-cart-line')).toHaveCount(1);
    await page.getByTestId('pos-hold-sale').click();
    const dlg = page.getByRole('dialog', { name: 'Hold sale' });
    await expect(dlg).toContainText('Held sales don’t hold stock');
    await expect(page.getByText(/reserved for 30 minutes/)).toHaveCount(0);
    await noOverflow(page, 'hold dialog');
    await shot(page, width, '03-hold-dialog');
    await dlg.getByRole('button', { name: 'Cancel' }).click();

    await page.getByTestId('pos-held-open').click();
    const drawer = page.getByTestId('pos-held-drawer');
    await expect(drawer.getByTestId('pos-held-card')).toHaveCount(2);
    if (width < 768) {
      const box = await drawer.boundingBox();
      expect(box!.width, '390 px: drawer is full width').toBeGreaterThanOrEqual(width - 40);
    }
    await noOverflow(page, 'held drawer');
    await shot(page, width, '04-held-drawer');
    await page.keyboard.press('Escape');

    await page.goto(mUrl(historyUrl(sess.id)));
    await expect(page.getByTestId('pos-history-row')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('pos-history-kpis')).toContainText('৳ 2,200');
    for (const k of ['Receipts', 'Average sale', 'Returns']) await expect(page.getByTestId('pos-history-kpis')).toContainText(k);
    await noOverflow(page, 'history');
    await shot(page, width, '05-history');
    await page.getByTestId('pos-history-row').first().click();
    const detail = page.getByTestId('pos-sale-detail');
    await expect(detail).toContainText(`Receipt ${sale.number}`);
    await expect(detail.getByTestId('pos-reprint')).toBeVisible();
    await expect(detail.getByTestId('pos-return-items')).toHaveText(/Return items/);
    await expect(page.getByText(/Void receipt|manager PIN|Return or exchange items/)).toHaveCount(0);
    await noOverflow(page, 'receipt detail');
    await shot(page, width, '06-receipt-detail');
    await detail.getByTestId('pos-return-items').click();
    const ret = page.getByTestId('pos-return-dialog');
    await expect(ret.getByTestId('pos-return-line')).toHaveCount(2);
    await expect(ret.getByRole('radiogroup', { name: 'Refund method' })).toBeVisible();
    await noOverflow(page, 'return dialog');
    await shot(page, width, '07-return-dialog');
    await page.keyboard.press('Escape');
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}

// Regression for P88DB-QA-1 (fixed in 79e730b).
test('a simple product shows no "Default" variant caption in the receipt detail or the return dialog', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(historyUrl(sess.id, `&sale=${sale.id}`)));
  const detail = page.getByTestId('pos-sale-detail');
  await expect(detail).toContainText(`Receipt ${sale.number}`, { timeout: 20_000 });
  await expect(detail.getByText(/\bDefault\b/), 'receipt detail line: "Qty 2", not "Default · Qty 2" (as Orders hides it)').toHaveCount(0);
  await detail.getByTestId('pos-return-items').click();
  await expect(page.getByTestId('pos-return-dialog').getByText(/\bDefault\b/), 'return line: no "Default"').toHaveCount(0);
});

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { mUrl } from '../support/locations';
import { purchasingShop } from '../support/purchasing';
import { pageOverflow, watchConsole } from '../support/roles';
import type { CommerceShop } from '../support/commerce';
import {
  cart,
  createRegisterRaw,
  gotoPos,
  ok,
  openSession,
  paymentDialog,
  posShop,
  saleComplete,
  stubPrint,
  tile,
  WRAP,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D §11.9 / §16 AC 8 (part A screens): Open register 25:581, Sale 22:1737, Variant picker 22:1905, Payment
 * 22:2073, Sale complete 22:2241, Close register 25:829 at 1280 and 390 px. No page overflow, no console errors, the
 * documented omissions absent (Scanner ready, Open drawer, Void receipt, Cashier select), Cashier
 * read-only. 390 px (P88D-24): 2-column catalog, sticky "Charge ৳ x · n items" bar, cart as a bottom sheet, payment
 * full width. States: empty "Set up your first register" / "Create Register 1 at Main warehouse", "No products match —
 * try another name or scan the barcode", loading and error on the catalog.
 * Screenshots: tests/e2e/test-results/phase8-8d-a-visual/{1280,390}/.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let empty: CommerceShop;
let sess: Json;
const SHOTS = resolve(E2E_ROOT, 'test-results/phase8-8d-a-visual');
// "Hold sale" shipped with part B (PHASE-8-8D §11.6), so it is no longer an omission.
const OMITTED = [/Scanner ready/, /Open drawer/, /Void receipt/, /manager PIN/];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('pvis', 'growth', { online: 10, atShop: 8 });
  empty = await purchasingShop('pvie', 'growth', 2);
  await ok(await createRegisterRaw(shop.s, { name: 'Register 2', location_id: shop.shop.id }), 201, 'register 2');
  sess = await openSession(shop.s, shop.register.id, { counts: { '100000': 2, '50000': 1 } });
});
test.afterAll(() => {
  shop?.cleanup();
  empty?.cleanup();
});

async function shot(page: Page, width: number, name: string): Promise<void> {
  const dir = resolve(SHOTS, String(width));
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
}

async function noOverflow(page: Page, where: string): Promise<void> {
  expect(await pageOverflow(page), `${where}: no horizontal page scroll`).toBeNull();
}

async function noOmitted(page: Page, where: string): Promise<void> {
  for (const re of OMITTED) await expect(page.getByText(re).filter({ visible: true }), `${where}: ${re} is hidden (§11)`).toHaveCount(0);
}

for (const width of [1280, 390]) {
  const mobile = width < 768;
  test(`${width} px: open register, sale, picker, payment, complete, close`, async ({ page, context }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: mobile ? 844 : 800 });
    const c = watchConsole(page);
    await stubPrint(page);
    await signInDashboard(context, shop.s);

    // Open register (Register 2 is closed; Register 1 is open and listed as such).
    await gotoPos(page);
    await page.getByTestId('pos-register-select').selectOption({ label: 'Register 2 · Mirpur shop' });
    await expect(page.getByRole('heading', { name: 'Open register' })).toBeVisible();
    await expect(page.getByText('Count the cash in the drawer before the first sale')).toBeVisible();
    await expect(page.getByTestId('pos-cashier')).toHaveAttribute('readonly', '');
    await expect(page.getByTestId('pos-register-list')).toContainText(/Open · .+ · since/);
    await expect(page.getByTestId('pos-register-list')).toContainText('Closed · ready');
    for (const d of ['৳ 1,000', '৳ 500', '৳ 200', '৳ 100', '৳ 50', '৳ 20', '৳ 10', '৳ 5', '৳ 2', '৳ 1'])
      await expect(page.getByLabel(`Count of ${d}`, { exact: true }), `denomination ${d} (P88D-15)`).toBeVisible();
    await noOverflow(page, 'open register');
    await shot(page, width, '01-open-register');

    // Sale screen.
    await gotoPos(page, `/pos/${sess.id}`);
    await expect(page.getByTestId('pos-bar-subtitle')).toContainText('Register 1 · Mirpur shop · Opened');
    await expect(page.getByTestId('pos-cash-in-drawer')).toHaveText(width === 1280 ? '৳ 2,500' : '৳ 4,200');
    await expect(page.getByRole('tab', { name: 'All' })).toBeVisible();
    await expect(tile(page, WRAP)).toBeVisible();
    await noOmitted(page, 'sale');
    if (mobile) {
      const tiles = page.getByTestId('pos-catalog').getByRole('button');
      const boxes = await Promise.all([tiles.nth(0).boundingBox(), tiles.nth(1).boundingBox()]);
      expect(Math.abs(boxes[0]!.y - boxes[1]!.y), '390 px: 2-column catalog').toBeLessThan(2);
      await expect(page.getByTestId('pos-mobile-charge-bar')).toHaveText('Cart is empty');
      await expect(page.getByRole('complementary', { name: 'Current sale' })).toBeHidden();
    } else {
      await expect(page.getByRole('complementary', { name: 'Current sale' })).toBeVisible();
    }
    await noOverflow(page, 'sale');
    await shot(page, width, '02-sale-empty');

    // Variant picker.
    await tile(page, 'QA Cotton Kurta').click();
    const picker = page.getByRole('dialog', { name: 'Choose options' });
    await expect(picker).toBeVisible();
    await expect(picker.getByText('Scan a variant barcode to skip this step')).toBeVisible();
    await expect(picker.getByText(/8 left/).first()).toBeVisible();
    await noOverflow(page, 'variant picker');
    await shot(page, width, '03-variant-picker');
    await picker.getByTestId('pos-picker-add').click();
    await tile(page, WRAP).click();

    if (mobile) {
      const bar = page.getByTestId('pos-mobile-charge-bar');
      await expect(bar).toHaveText('Charge ৳ 1,700 · 2 items');
      await shot(page, width, '04-sale-charge-bar');
      await bar.click();
      const sheet = page.getByRole('dialog', { name: 'Current sale' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId('pos-cart-line')).toHaveCount(2);
      await noOverflow(page, 'cart sheet');
      await shot(page, width, '05-cart-sheet');
    } else {
      await expect(cart(page).getByTestId('pos-cart-line')).toHaveCount(2);
      await shot(page, width, '04-sale-cart');
    }
    await expect(cart(page).getByTestId('pos-charge')).toHaveText('Charge ৳ 1,700', { timeout: 15_000 });
    await cart(page).getByTestId('pos-charge').click();

    // Payment.
    const pay = paymentDialog(page);
    await expect(pay).toBeVisible();
    for (const m of ['Cash', 'bKash', 'Card', 'Split']) await expect(pay.getByRole('radio', { name: new RegExp(`^${m}`) })).toBeVisible();
    await expect(pay.getByRole('group', { name: 'Numpad' }).or(pay.getByLabel('Numpad'))).toBeVisible();
    await pay.getByTestId('pos-cash-received').fill('2000');
    await expect(pay.getByTestId('pos-change')).toContainText('৳ 300');
    await expect(pay.getByTestId('pos-change')).toContainText('Give');
    await noOmitted(page, 'payment');
    if (mobile) {
      const box = await pay.boundingBox();
      expect(box!.width, '390 px: payment fills the width').toBeGreaterThanOrEqual(width - 40);
    }
    await noOverflow(page, 'payment');
    await shot(page, width, '06-payment');
    await pay.getByTestId('pos-complete-sale').click();

    // Sale complete.
    const done = saleComplete(page);
    await expect(done).toBeVisible({ timeout: 20_000 });
    await expect(done.getByText('Sale complete')).toBeVisible();
    await expect(done.getByText('Press Enter to start a new sale')).toBeVisible();
    await noOverflow(page, 'sale complete');
    await shot(page, width, '07-sale-complete');
    await page.keyboard.press('Enter');
    await expect(done).toBeHidden();

    // Empty search result state.
    await page.getByTestId('pos-search').fill('zzz-nothing-like-this');
    await expect(page.getByText('No products match — try another name or scan the barcode')).toBeVisible();
    await shot(page, width, '08-no-products-match');
    await page.getByTestId('pos-search').fill('');

    // Close register.
    await page.getByTestId('pos-close-register').click();
    await expect(page.getByRole('heading', { name: 'Close register' })).toBeVisible();
    await expect(page.getByText('Count the drawer, check the difference, then print the end-of-day report.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to sale' })).toBeVisible();
    await expect(page.getByTestId('pos-expected')).toHaveText(width === 1280 ? '৳ 4,200' : '৳ 5,900');
    await noOverflow(page, 'close register');
    await shot(page, width, '09-close-register');
    await page.getByRole('link', { name: 'Back to sale' }).click();
    await expect(page).toHaveURL(new RegExp(`/pos/${sess.id}$`));
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}

test('states: no registers (empty), catalog loading and error', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, empty.s);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await gotoPos(page);
    const box = page.getByTestId('pos-no-registers');
    await expect(box).toContainText('Set up your first register');
    await expect(box.getByRole('button', { name: 'Create Register 1 at Main warehouse' })).toBeEnabled();
    await noOverflow(page, `no registers ${width}`);
    await shot(page, width, '10-no-registers');
  }

  // Catalog loading, then error (a 500 on every catalog read) with a retry.
  await signInDashboard(context, shop.s);
  await page.setViewportSize({ width: 1280, height: 800 });
  let fail = false;
  await page.route(/\/pos\/catalog\?/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'server_error', message: 'Boom' } }) });
    return route.continue();
  });
  await page.goto(mUrl(`/pos/${sess.id}`));
  await expect(page.getByLabel('Loading products').or(page.getByText('Loading products')).first()).toBeVisible({ timeout: 15_000 });
  await expect(tile(page, WRAP)).toBeVisible({ timeout: 15_000 });
  fail = true;
  await page.getByTestId('pos-search').fill('kurta');
  await expect(page.getByText('We couldn’t load products')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Try again|Retry/ }).first()).toBeVisible();
  await shot(page, 1280, '11-catalog-error');
  fail = false;
  await page.getByRole('button', { name: /Try again|Retry/ }).first().click();
  await expect(tile(page, 'QA Cotton Kurta')).toBeVisible({ timeout: 20_000 });
  const real = c.errors.filter((e) => !/500|Boom|Failed to load resource/.test(e));
  expect(real, real.join('\n')).toEqual([]);
});

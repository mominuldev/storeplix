import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { cartAdd, randomPhone, sf, useCart } from '../support/commerce';
import {
  AUTOMATIONS,
  RECOVERY,
  RUN_LOG,
  ageContactCarts,
  automationShop,
  checkoutNotice,
  deliveredOrder,
  detectAbandoned,
  mUrl,
  openAutomations,
  quietNote,
  startRecipe,
  waitRun,
  type AutomationShop,
} from '../support/automations';
import { pageOverflow, watchConsole } from '../support/roles';

/**
 * PHASE-8-6 §13 QA `phase8-6.visual` + AC 4 / Q166: Automations `140:30336`, recipe editor `141:30622`, Abandoned cart
 * recovery `71:20614`, run log and the storefront checkout notice at 1280, 390 and 375 px: no horizontal page overflow,
 * no console errors, documented omissions absent (WhatsApp, Clicked, Cost, Time saved, Risky orders held, Add a step).
 * Screenshots → test-results/phase8-6-visual/<width>/ (git-ignored) for the Figma review.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OUT = resolve(E2E_ROOT, 'test-results/phase8-6-visual');
const WIDTHS = [1280, 390, 375];

let shop: AutomationShop;
let thanks: Json;
let cart = '';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await automationShop('arv', 'starter', 13);
  const recovery = await startRecipe(shop.s, 'checkout_recovery', { delay_minutes: 15 });
  thanks = await startRecipe(shop.s, 'thank_you', { delay_hours: 0 });
  await startRecipe(shop.s, 'vip_tag', { min_delivered: 2, message: { enabled: false } });
  const order = await deliveredOrder(shop, randomPhone(), 'Visual Buyer');
  await waitRun(shop.s, thanks.id, (x) => x.subject?.id === order.id || x.subject?.label === order.number, 90_000);
  const added = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
  cart = added.cart;
  expect((await sf(shop.apiHost, 'PUT', '/cart/contact', { json: { phone: randomPhone(), name: 'Visual Cart' }, cart })).status).toBe(204);
  ageContactCarts(shop.s.storeId, 20);
  detectAbandoned();
  await waitRun(shop.s, recovery.id, (x) => x.subject?.type === 'cart', 90_000);
});
test.afterAll(() => shop?.cleanup());

async function shot(page: Page, width: number, name: string, overflow: string[]) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const o = await pageOverflow(page);
  if (o) overflow.push(`${width}px ${name}: ${o}`);
  await page.screenshot({ path: `${OUT}/${width}/${name}.png`, fullPage: true });
}

const OMITTED = [/WhatsApp/, /Time saved/, /Risky orders held/, /^Clicked$/, /^Cost$/, /Add a step/];

for (const width of WIDTHS) {
  test(`Automations pages + checkout notice at ${width}px: no page overflow, no console errors`, async ({ page, context }) => {
    test.setTimeout(150_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, shop.s);

    await openAutomations(page);
    await expect(page.getByRole('row').filter({ hasText: 'Thank-you message' }).first()).toBeVisible({ timeout: 30_000 });
    await expect(quietNote(page)).toBeVisible();
    for (const hidden of OMITTED) await expect(page.getByText(hidden), `omitted: ${hidden}`).toHaveCount(0);
    await shot(page, width, 'automations', overflow);

    await page.goto(mUrl(`${AUTOMATIONS}/${thanks.id}`));
    await expect(page.getByRole('button', { name: /Save changes/ }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Test with an order/).first()).toBeVisible();
    for (const hidden of OMITTED) await expect(page.getByText(hidden), `omitted: ${hidden}`).toHaveCount(0);
    await shot(page, width, 'editor-thank-you', overflow);

    await page.goto(mUrl(RECOVERY));
    await expect(page.getByText(/Carts left behind/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Recent carts/).first()).toBeVisible();
    for (const hidden of OMITTED) await expect(page.getByText(hidden), `omitted: ${hidden}`).toHaveCount(0);
    await shot(page, width, 'checkout-recovery', overflow);

    await page.goto(mUrl(RUN_LOG));
    await expect(page.getByText(/· Thank-you message/).first()).toBeVisible({ timeout: 20_000 });
    await shot(page, width, 'run-log', overflow);

    const sfPage = await context.newPage();
    await sfPage.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const sc = watchConsole(sfPage);
    await useCart(context, shop, cart);
    await sfPage.goto(`${shop.storefront}/checkout`);
    await expect(checkoutNotice(sfPage)).toBeVisible({ timeout: 20_000 });
    await shot(sfPage, width, 'checkout-notice', overflow);

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect([...c.errors, ...sc.errors], [...c.errors, ...sc.errors].join('\n')).toEqual([]);
  });
}

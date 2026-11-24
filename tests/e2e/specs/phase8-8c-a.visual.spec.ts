import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { pageOverflow, watchConsole } from '../support/roles';
import {
  addLocationButton,
  adjust,
  createLocation,
  DEFAULT_NAME,
  DHANMONDI,
  locationCard,
  locationSelector,
  mUrl,
  ONLINE_NOTE,
  openWarehouses,
  UPGRADE_NOTE,
} from '../support/locations';
import { purchasingShop } from '../support/purchasing';

/**
 * PHASE-8-8C §13 QA part A (e), §10.2, §10.6, AC 7 (part A): the Warehouses tab (composed, no Figma frame) and Inventory
 * with the location selector at 1280, 390 and 375 px — no horizontal page overflow, no console errors; Growth shop with
 * "Main warehouse" (default, "Online orders ship from here") + "Dhanmondi shop" (stock 3 of the wrap), the add-location
 * dialog open; Starter one-location shop (upgrade note, no selector). Screenshots →
 * test-results/phase8-8c-a-visual/<width>/ (git-ignored) for the PO (product owner) review.
 */
const OUT = resolve(E2E_ROOT, 'test-results/phase8-8c-a-visual');
const WIDTHS = [1280, 390, 375];

let growth: CommerceShop;
let starter: CommerceShop;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  growth = await purchasingShop('lvg', 'growth', 6);
  starter = await purchasingShop('lvs', 'starter', 4);
  const dhan = await createLocation(growth.s, DHANMONDI);
  await adjust(growth.s, [{ variant_id: growth.simple.variantId, quantity: 3, location_id: dhan.id }]);
});
test.afterAll(() => {
  growth?.cleanup();
  starter?.cleanup();
});

async function shot(page: Page, width: number, name: string, overflow: string[]) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const o = await pageOverflow(page);
  if (o) overflow.push(`${width}px ${name}: ${o}`);
  await page.screenshot({ path: `${OUT}/${width}/${name}.png`, fullPage: true });
}

for (const width of WIDTHS) {
  test(`Warehouses + Inventory at ${width}px: two locations, no overflow, no console errors`, async ({ page, context }) => {
    test.setTimeout(120_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, growth.s);

    await openWarehouses(page);
    await expect(locationCard(page, DEFAULT_NAME)).toBeVisible();
    await expect(locationCard(page, DHANMONDI)).toBeVisible();
    await expect(locationCard(page, DEFAULT_NAME).getByText(ONLINE_NOTE)).toBeVisible();
    await expect(locationCard(page, DHANMONDI).getByText(/\b3\b/).first(), 'units on hand at Dhanmondi').toBeVisible();
    await expect(page.getByText(UPGRADE_NOTE), 'no upgrade note on Growth').toHaveCount(0);
    await expect(addLocationButton(page)).toBeVisible();
    await shot(page, width, 'warehouses', overflow);

    await addLocationButton(page).click();
    const d = page.getByRole('dialog').last();
    await expect(d).toBeVisible();
    await expect(d.getByLabel(/^Name/i).first()).toBeVisible();
    await shot(page, width, 'warehouses-add', overflow);
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();

    await page.goto(mUrl('/inventory'));
    await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible({ timeout: 20_000 });
    await expect(locationSelector(page)).toBeVisible();
    await expect(page.getByText(/Transfer stock/i), 'part B').toHaveCount(0);
    await shot(page, width, 'inventory-all-locations', overflow);

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}

test('Starter one-location Warehouses at 390px: one card, upgrade note, no selector', async ({ page, context }) => {
  test.setTimeout(90_000);
  mkdirSync(`${OUT}/390`, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const c = watchConsole(page);
  await signInDashboard(context, starter.s);
  await openWarehouses(page);
  await expect(locationCard(page, DEFAULT_NAME)).toBeVisible();
  await expect(page.getByText(UPGRADE_NOTE).first()).toBeVisible();
  const empty = await page.getByText(/No other locations yet/).count();
  test.info().annotations.push({ type: 'empty-state', description: empty ? '"No other locations yet" shown' : '"No other locations yet" not shown on Starter' });
  expect(await pageOverflow(page)).toBeNull();
  await page.screenshot({ path: `${OUT}/390/warehouses-starter.png`, fullPage: true });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

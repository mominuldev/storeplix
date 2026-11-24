import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard, unique } from '../support/api';
import type { CommerceShop } from '../support/commerce';
import {
  createEndpoint,
  createKey,
  createKeyButton,
  devCard,
  devShop,
  openDeveloper,
  sinkUrl,
  storefrontOrder,
  waitDelivery,
} from '../support/developer';
import { pageOverflow, watchConsole } from '../support/roles';

/**
 * PHASE-8-4 §10 QA `phase8-4.visual` + AC 5 / Q137: the Developer page (keys, a healthy and a failing endpoint, recent
 * deliveries) and the create-key modal at 1280, 390 and 375 px: cards stack, tables scroll inside their card, no
 * horizontal page scroll, no console errors. Screenshots → test-results/phase8-4-visual/<width>/ (git-ignored) for the
 * Figma review against `144:40726`.
 */
const OUT = resolve(E2E_ROOT, 'test-results/phase8-4-visual');
const WIDTHS = [1280, 390, 375];

let shop: CommerceShop;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  shop = await devShop('dk-vis');
  await createKey(shop.s, 'Warehouse sync', ['orders:read', 'inventory:write']);
  await createKey(shop.s, 'Zapier', ['orders:read', 'products:read', 'customers:read']);
  const ok = await createEndpoint(shop.s, sinkUrl(unique('vis-')), ['order.created', 'order.paid', 'order.cancelled'], 'Accounting');
  const bad = await createEndpoint(shop.s, sinkUrl(unique('vis-'), '/fail-503'), ['order.created'], 'Old ERP');
  await storefrontOrder(shop);
  await waitDelivery(shop.s, ok.id as string, (d) => d.status === 'succeeded');
  await waitDelivery(shop.s, bad.id as string, (d) => d.status === 'retrying');
});
test.afterAll(() => shop?.cleanup());

async function shot(page: Page, width: number, name: string, overflow: string[]) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const o = await pageOverflow(page);
  if (o) overflow.push(`${width}px ${name}: ${o}`);
  await page.screenshot({ path: `${OUT}/${width}/${name}.png`, fullPage: true });
}

for (const width of WIDTHS) {
  test(`Developer page at ${width}px: no page overflow, no console errors`, async ({ page, context }) => {
    test.setTimeout(90_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, shop.s);
    await openDeveloper(page);
    for (const name of ['API keys', 'Webhooks', 'Signing secret', 'Recent deliveries']) await expect(devCard(page, name)).toBeVisible();
    await expect(devCard(page, 'API keys')).toContainText('Warehouse sync');
    await expect(devCard(page, 'Webhooks')).toContainText(/Failing since/);
    await shot(page, width, 'developer', overflow);

    await createKeyButton(page).click();
    await expect(page.getByRole('dialog').last()).toBeVisible();
    await shot(page, width, 'create-key-modal', overflow);

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
    test.info().annotations.push({ type: 'network', description: c.network.join('; ') || 'none' });
  });
}

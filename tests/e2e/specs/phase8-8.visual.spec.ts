import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { kpi } from '../support/analytics';
import { randomPhone, type CommerceShop } from '../support/commerce';
import {
  blockNumber,
  buildRecord,
  guardShop,
  heldBanner,
  holdTag,
  mUrl,
  OMITTED,
  openGuard,
  placeCod,
  protectionTag,
  RULE_TITLES,
  waitGuard,
} from '../support/fraud-guard';
import { pageOverflow, watchConsole } from '../support/roles';

/**
 * PHASE-8-8 §13 QA visual + AC 6: Fake order guard `39:11233` and a held order `33:3676` at 1280, 390 and 375 px — no
 * horizontal page overflow, no console errors; documented omissions absent (VPN rule, courier-record rule, "Delivery
 * charges saved", cross-shop record / Risk network); composed items present ("n of 6 rules on · checking your own
 * orders", "Advance collected", "Call first" tag + hold banner). Screenshots → test-results/phase8-8-visual/<width>/
 * (git-ignored) for the Figma review.
 */
const OUT = resolve(E2E_ROOT, 'test-results/phase8-8-visual');
const WIDTHS = [1280, 390, 375];

let shop: CommerceShop;
let heldId = '';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await guardShop('fgv', 'growth');
  const buyer = randomPhone();
  await buildRecord(shop, buyer, 1, 0);
  await placeCod(shop, buyer);
  const dup = await placeCod(shop, buyer);
  expect((await waitGuard(shop.s, dup.id)).guard.hold).toBe('call_first');
  heldId = dup.id;
  await blockNumber(shop.s, randomPhone(), 'Ordered 3 times, never picked up');
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
  test(`guard page + held order at ${width}px: no page overflow, no console errors, omissions absent`, async ({ page, context }) => {
    test.setTimeout(120_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, shop.s);

    await openGuard(page);
    await expect(protectionTag(page, true)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/\d of 6 rules on/).first()).toBeVisible();
    await expect(page.getByText(/checking your own orders/).first()).toBeVisible();
    for (const t of ['Orders protected this month', 'Fake orders stopped', 'Advance collected']) await expect(kpi(page, t), t).toBeVisible();
    for (const title of RULE_TITLES) await expect(page.getByText(title, { exact: true }).first(), title).toBeVisible();
    await expect(page.getByText('Ordered 3 times, never picked up').first()).toBeVisible();
    await expect(page.getByText(/Duplicate caught/).first()).toBeVisible();
    await expect(page.getByText(/Your data stays yours/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Check a number/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Block a number/ }).first()).toBeVisible();
    for (const hidden of OMITTED) await expect(page.getByText(hidden), `omitted: ${hidden}`).toHaveCount(0);
    await shot(page, width, 'guard', overflow);

    await page.goto(mUrl(`/orders/${heldId}`));
    await expect(holdTag(page, 'Call first')).toBeVisible({ timeout: 20_000 });
    await expect(heldBanner(page)).toBeVisible();
    for (const hidden of OMITTED) await expect(page.getByText(hidden), `omitted: ${hidden}`).toHaveCount(0);
    await shot(page, width, 'order-held', overflow);

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}

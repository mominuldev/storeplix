import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { pageOverflow, watchConsole } from '../support/roles';
import { createLocation, defaultLocation, DHANMONDI } from '../support/locations';
import { purchasingShop } from '../support/purchasing';
import {
  COUNTS,
  createTransfer,
  newTransferButton,
  openCounts,
  openTransfer,
  openTransfers,
  panel,
  receiveTransfer,
  scanRaw,
  sendTransfer,
  SKU_BOX,
  startCount,
  transferRow,
} from '../support/transfers';

/**
 * PHASE-8-8C §13 QA part B visual, §10.4–§10.6, AC 7 (part B): Transfers `153:34425` (KPI tiles Drafts / In transit /
 * Received this month / Locations, chips, a draft, an in-transit, a "Received · 2 short" and a cancelled-free list; the
 * side panel / full-screen sheet), the count screen `153:35246` (progress, SKU box, chips, "If you finish now", "When
 * you finish" with only "Set uncounted items to 0") and the counts list, at 1280, 390 and 375 px — no horizontal page
 * overflow, no console errors, documented omissions absent (Waiting for approval, Approve & send, Reject, Pause,
 * Scanner ready, Record shortage as expense, Lock online sales while counting). Empty states on a second shop.
 * Screenshots → test-results/phase8-8c-b-visual/<width>/ (git-ignored) for the PO (product owner) review.
 */
const OUT = resolve(E2E_ROOT, 'test-results/phase8-8c-b-visual');
const WIDTHS = [1280, 390, 375];
const OMITTED = [/Waiting for approval/i, /Approve & send/i, /^Reject$/i, /needs approval/i, /^Pause$/i, /Scanner ready/i, /Record shortage as expense/i, /Lock online sales/i];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: CommerceShop;
let empty: CommerceShop;
let received: Json;
let countJson: Json;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  shop = await purchasingShop('tvg', 'growth', 8);
  empty = await purchasingShop('tve', 'growth', 3);
  await createLocation(empty.s, DHANMONDI); // one-location Growth shows "No other locations yet" instead (§10.6)
  const main = await defaultLocation(shop.s);
  const dhan = await createLocation(shop.s, DHANMONDI);
  const [m, l] = shop.variable.variants as Json[];
  await createTransfer(shop.s, main.id, dhan.id, [{ variant_id: m.id, quantity: 1 }]);
  const inTransit = await createTransfer(shop.s, main.id, dhan.id, [{ variant_id: l.id, quantity: 2 }]);
  await sendTransfer(shop.s, inTransit.id);
  const r = await createTransfer(shop.s, main.id, dhan.id, [{ variant_id: m.id, quantity: 3 }, { variant_id: shop.simple.variantId, quantity: 2 }]);
  const sent = await sendTransfer(shop.s, r.id);
  const wrapLine = (sent.lines as Json[]).find((x) => x.variant?.id === shop.simple.variantId)!;
  received = await receiveTransfer(shop.s, sent, { [wrapLine.id]: 0 });
  countJson = await startCount(shop.s, main.id);
  await scanRaw(shop.s, countJson.id, m.sku);
  await scanRaw(shop.s, countJson.id, l.sku);
});
test.afterAll(() => {
  shop?.cleanup();
  empty?.cleanup();
});

async function shot(page: Page, width: number, name: string, overflow: string[]) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const o = await pageOverflow(page);
  if (o) overflow.push(`${width}px ${name}: ${o}`);
  await page.screenshot({ path: `${OUT}/${width}/${name}.png`, fullPage: true });
}

async function noOmissions(page: Page, where: string) {
  for (const hidden of OMITTED) await expect(page.getByText(hidden), `${where}: omitted ${hidden}`).toHaveCount(0);
}

for (const width of WIDTHS) {
  test(`Transfers + count at ${width}px: no overflow, no console errors, omissions absent`, async ({ page, context }) => {
    test.setTimeout(150_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, shop.s);

    await openTransfers(page);
    for (const tile of [/^Drafts$/, /^In transit$/, /Received this month/, /^Locations$/]) await expect(page.getByText(tile).first(), `KPI ${tile}`).toBeVisible();
    await expect(page.getByText(/Not sent yet/).first()).toBeVisible();
    await expect(transferRow(page, received.number).getByText(/Received · 2 short/)).toBeVisible();
    await noOmissions(page, 'transfers');
    await shot(page, width, 'transfers', overflow);

    await openTransfer(page, received.number);
    await expect(panel(page).getByText(received.number).first()).toBeVisible();
    await noOmissions(page, 'transfer detail');
    await shot(page, width, 'transfer-detail', overflow);
    await page.keyboard.press('Escape');

    await newTransferButton(page).click();
    await expect(panel(page).getByRole('button', { name: /Save draft/ })).toBeVisible();
    await shot(page, width, 'transfer-new', overflow);
    await page.keyboard.press('Escape');

    await openCounts(page);
    await expect(page.getByText(countJson.name).first()).toBeVisible();
    await shot(page, width, 'counts', overflow);

    await openCounts(page, `${COUNTS}/${countJson.id}`);
    const box = page.getByPlaceholder(SKU_BOX).or(page.getByRole('textbox', { name: SKU_BOX })).first();
    await expect(box).toBeVisible();
    await expect(page.getByText(/If you finish now/).first()).toBeVisible();
    await expect(page.getByText(/Set uncounted items to 0/).first()).toBeVisible();
    await noOmissions(page, 'count');
    await shot(page, width, 'count', overflow);
    if (width < 768) {
      // §10.6: the SKU box stays reachable (sticky) after scrolling
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(300);
      await expect(box).toBeInViewport();
    }

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}

test('empty states at 390px: "No transfers yet" (two locations), "No counts yet"', async ({ page, context }) => {
  test.setTimeout(90_000);
  mkdirSync(`${OUT}/390`, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const c = watchConsole(page);
  await signInDashboard(context, empty.s);
  await openTransfers(page);
  await expect(page.getByText(/No transfers yet/).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/390/transfers-empty.png`, fullPage: true });
  await openCounts(page);
  await expect(page.getByText(/No counts yet/).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/390/counts-empty.png`, fullPage: true });
  expect(await pageOverflow(page)).toBeNull();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

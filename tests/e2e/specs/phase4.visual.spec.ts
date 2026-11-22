import { expect, test } from '@playwright/test';
import { demoSession, signInDashboard, urls, type Session } from '../support/api';

/**
 * Phase 4 visual pass (QA review, not a pixel diff): screenshots of every Phase 4 screen at 1440, 834 and
 * 390 px, named after the Figma frame they are compared with (file 2W1wMKN79hhcr1czQS63oN, §9.1).
 * Opt-in: E2E_VISUAL=1. Output: test-results/<test>/<screen>-<width>-<frame>.png. Read-only.
 */
test.skip(!process.env.E2E_VISUAL, 'visual pass is opt-in: E2E_VISUAL=1');

const WIDTHS = [1440, 834, 390] as const;
const SCREENS: Array<{ name: string; path: string; frames: Record<number, string> }> = [
  { name: 'dashboard', path: '/', frames: { 1440: '10-600', 834: '10-600', 390: '31-4281' } },
  { name: 'products', path: '/products', frames: { 1440: '60-8984', 834: '60-8984', 390: '139-1077' } },
  { name: 'product-editor', path: '/products/new', frames: { 1440: '60-9381', 834: '60-9381', 390: '60-9381' } },
  { name: 'categories', path: '/products/categories', frames: { 1440: '60-9778', 834: '60-9778', 390: '60-9778' } },
  { name: 'import', path: '/products/import', frames: { 1440: '60-10175', 834: '60-10175', 390: '60-10175' } },
  { name: 'inventory', path: '/inventory', frames: { 1440: '11-589', 834: '11-589', 390: '11-589' } },
  { name: 'customers', path: '/customers', frames: { 1440: '63-14972', 834: '63-14972', 390: '63-14972' } },
  { name: 'onboarding-05', path: '/onboarding/products', frames: { 1440: '50-312', 834: '50-312', 390: '50-312' } },
];

let s: Session;
test.beforeAll(async () => {
  s = await demoSession();
});

for (const w of WIDTHS) {
  test(`screens at ${w} px`, async ({ page, context }, info) => {
    test.setTimeout(120_000);
    await signInDashboard(context, s);
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const sc of SCREENS) {
      await page.goto(`${urls.merchant}${sc.path}`);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: info.outputPath(`${sc.name}-${w}-figma-${sc.frames[w]}.png`), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect.soft(overflow, `${sc.path} @${w}: horizontal overflow`).toBeLessThanOrEqual(0);
    }
    // Customer detail (first customer), if any.
    await page.goto(`${urls.merchant}/customers`);
    const first = page.getByRole('row').nth(1);
    if (await first.isVisible().catch(() => false)) {
      await first.click();
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: info.outputPath(`customer-detail-${w}-figma-64-16382.png`), fullPage: true });
    }
    expect.soft(errors, 'page errors').toEqual([]);
  });
}

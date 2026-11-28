import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { getIntegration, META_PIXEL_ID, mUrl, noOverflow, putIntegration, token, turnOnAi } from '../support/integrations';
import { purchasingShop } from '../support/purchasing';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-9D §8, §16 QA ("390 px screenshots of the list and one detail page"), §17 AC 7: the Integrations list (with
 * the Marketing & tracking, Sales channels, Payments and AI for growth groups), the Meta pixel detail (connected), the
 * Claude page (On) and the Nagad page (not connected) at 1280 and 390 px. Asserts no horizontal page overflow and no
 * console errors; screenshots go to test-results/phase8-9d-visual/{width}/ (git-ignored) for review against Figma
 * 2136:1866 (mobile list), 2139:56806 / 2134:64916 (Meta pixel), 2135:55626 (Claude), 2134:67228 (Nagad).
 */
test.describe.configure({ mode: 'serial' });

const OUT = resolve(E2E_ROOT, 'test-results/phase8-9d-visual');
let shop: CommerceShop;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  shop = await purchasingShop('p89dvis', 'growth', 5);
  const meta = await getIntegration(shop.s, 'meta_pixel');
  await putIntegration(shop.s, 'meta_pixel', { settings: { ...meta.defaults, pixel_id: META_PIXEL_ID, test_event_code: 'TEST48211' }, credentials: { access_token: token('vis') } });
  await turnOnAi(shop.s, 'ai_writer');
});
test.afterAll(() => shop?.cleanup());

async function shot(page: Page, width: number, name: string) {
  mkdirSync(resolve(OUT, String(width)), { recursive: true });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: resolve(OUT, String(width), `${name}.png`), fullPage: true });
}

for (const width of [1280, 390] as const) {
  test(`${width}px: Integrations list, Meta pixel detail, Claude and Nagad pages`, async ({ page, context }) => {
    test.setTimeout(120_000);
    const c = watchConsole(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signInDashboard(context, shop.s);

    await page.goto(mUrl('/integrations'));
    for (const group of ['Payments', 'Marketing & tracking', 'Sales channels', 'AI for growth']) {
      await expect(page.getByRole('region', { name: group })).toBeVisible({ timeout: 20_000 });
    }
    const meta = page.getByRole('region', { name: 'Marketing & tracking' }).getByRole('article').first();
    await expect(meta).toBeVisible();
    await expect(page.getByRole('region', { name: 'AI for growth' }).getByText('On').first()).toBeVisible();
    await noOverflow(page, `list ${width}`);
    await shot(page, width, 'integrations-list');

    await page.goto(mUrl('/integrations/meta-pixel'));
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('region', { name: 'Tracking settings' })).toBeVisible();
    await noOverflow(page, `meta pixel ${width}`);
    await shot(page, width, 'meta-pixel-overview');
    await page.getByRole('tab', { name: 'Event log' }).click();
    await expect(page.getByRole('region', { name: 'Event log' })).toBeVisible();
    await noOverflow(page, `meta pixel log ${width}`);
    await shot(page, width, 'meta-pixel-event-log');

    await page.goto(mUrl('/integrations/claude'));
    await expect(page.getByRole('heading', { name: 'Claude by Anthropic' })).toBeVisible({ timeout: 20_000 });
    await noOverflow(page, `claude ${width}`);
    await shot(page, width, 'claude');

    await page.goto(mUrl('/integrations/payments/nagad'));
    await expect(page.getByRole('form', { name: 'Nagad credentials' })).toBeVisible({ timeout: 20_000 });
    await noOverflow(page, `nagad ${width}`);
    await shot(page, width, 'nagad');

    await page.goto(mUrl('/integrations/meta-catalog'));
    await expect(page.getByRole('button', { name: 'Continue with Facebook' })).toBeVisible({ timeout: 20_000 });
    await noOverflow(page, `meta catalog ${width}`);
    await shot(page, width, 'meta-catalog-connect');
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}

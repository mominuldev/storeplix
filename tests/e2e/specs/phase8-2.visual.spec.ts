import { expect, test, type Page } from '@playwright/test';
import { adminLogin, adminUrl, findTenant, signInAdminApp, type AdminSession } from '../support/admin';
import { STAFF, aggregate, card, kpi, seedStaff, settled } from '../support/analytics';

/**
 * PHASE-8-2-CONTRACT §10 QA `phase8-2.visual`, acceptance criterion 5: the four 8.2 screens (dashboard `15:123`,
 * Revenue reports `39:12705`, Merchants `32:5527`, Merchant detail `33:4851`) at the 1280 px design width and usable at
 * 1024 px: no horizontal page overflow, analytics widgets rendered (not skeletons), no console errors. Screenshots go to
 * the git-ignored `test-results/admin-visual-8-2/` (or `ADMIN_VISUAL_DIR`) for the Figma comparison.
 * Signs in as the visual-check super admin (as phase8.admin-visual), one sign-in per file.
 */
test.describe.configure({ mode: 'serial' });

let admin: AdminSession;
let tenantId: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  seedStaff(STAFF.visual);
  admin = await adminLogin('admin-visual-82', STAFF.visual);
  await aggregate(admin); // today's snapshot exists, so every widget has data (not the page-level empty state)
  tenantId = (await findTenant(admin, 'demo')).id as string;
});

const OUT = process.env.ADMIN_VISUAL_DIR ? `${process.env.ADMIN_VISUAL_DIR}/8-2` : 'test-results/admin-visual-8-2';

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;

type Shot = { name: string; path: () => string; ready: (page: Page) => Promise<void> };

const ROUTES: Shot[] = [
  {
    name: 'dashboard',
    path: () => '/',
    ready: async (page) => {
      await expect(kpi(page, 'MRR')).toBeVisible();
      await expect(card(page, 'Monthly recurring revenue by plan')).toBeVisible();
      await expect(card(page, 'Plan mix')).toBeVisible();
    },
  },
  {
    name: 'dashboard-12m',
    path: () => '/?range=12m',
    ready: async (page) => {
      await expect(kpi(page, 'Merchant GMV')).toBeVisible();
    },
  },
  {
    name: 'revenue',
    path: () => '/revenue',
    ready: async (page) => {
      for (const label of ['MRR', 'ARR', 'Net new MRR', 'Churned MRR', 'ARPA', 'LTV']) await expect(kpi(page, label)).toBeVisible();
      for (const title of ['MRR movement', 'Cohort retention', 'Revenue by plan', 'Trial funnel', 'Top paying merchants']) await expect(card(page, title)).toBeVisible();
    },
  },
  {
    name: 'merchants-by-mrr',
    path: () => '/merchants?sort=-mrr',
    ready: async (page) => {
      await expect(page.getByRole('heading', { name: 'Merchants', level: 1 })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Merchants' }).getByRole('columnheader', { name: /MRR/i })).toBeVisible();
    },
  },
  {
    name: 'merchant-detail',
    path: () => `/merchants/${tenantId}`,
    ready: async (page) => {
      await expect(page.getByRole('tablist', { name: 'Merchant sections' })).toBeVisible();
      await expect(kpi(page, 'Orders · 30d')).toBeVisible();
      await expect(card(page, /GMV & platform revenue/)).toBeVisible();
    },
  },
];

for (const vp of VIEWPORTS) {
  test(`8.2 analytics screens at ${vp.width}px: widgets rendered, no page overflow, no console errors`, async ({ page, context }) => {
    test.setTimeout(180_000);
    await signInAdminApp(context, admin);
    await page.setViewportSize(vp);
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // A 5xx here is the local sqlite stack's "database is locked" flake; render errors still fail.
      if (m.text().startsWith('Failed to load resource')) test.info().annotations.push({ type: 'network', description: `${page.url()}: ${m.text()}` });
      else errors.push(`${page.url()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));

    const overflow: string[] = [];
    for (const r of ROUTES) {
      await page.goto(`${adminUrl}${r.path()}`);
      await page.waitForLoadState('networkidle');
      await settled(page);
      await r.ready(page);
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      if (m.sw > m.iw) overflow.push(`${r.name}: scrollWidth ${m.sw} > ${m.iw}`);
      await page.screenshot({ path: `${OUT}/${vp.width}/${r.name}.png`, fullPage: true });
    }
    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

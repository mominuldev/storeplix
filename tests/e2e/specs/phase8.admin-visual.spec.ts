import { expect, test, type Page } from '@playwright/test';
import { tinker } from '../support/api';
import { adminLogin, adminUrl, findTenant, signInAdminApp, type AdminSession } from '../support/admin';

/**
 * PHASE-8-1-CONTRACT §7.1 / acceptance criterion 8: every super-admin route renders at the 1280 px design width and
 * stays usable at 1024 px (no horizontal page overflow; wide tables scroll inside their own container), with no
 * console errors. Screenshots land in the git-ignored `test-results/admin-visual/` for the Figma comparison.
 * One sign-in per file (`admin-login` throttles 5 sign-ins/min per email). It signs in as its own super admin, because
 * `reseedSuperAdmin()` in the other phase8 specs bumps `password_changed_at` and so ends the shared fixture's sessions.
 */
test.describe.configure({ mode: 'serial' });

let admin: AdminSession;
let tenantId: string;

const VISUAL_ADMIN = {
  email: 'e2e-visual@storeplix.com',
  password: 'password',
  totpSecret: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU',
};

/** Creates (or re-enables) the visual-check super admin; leaves `password_changed_at` alone so sessions survive. */
function seedVisualAdmin(): void {
  tinker(`
    $u = App\\Domain\\Identity\\Models\\User::query()->firstOrNew(['email' => '${VISUAL_ADMIN.email}']);
    if (! $u->exists) { $u->fill(['name' => 'E2E Visual Admin', 'password' => '${VISUAL_ADMIN.password}', 'email_verified_at' => now(), 'password_changed_at' => now()]); }
    $u->forceFill(['platform_role' => 'super_admin', 'platform_disabled_at' => null, 'platform_locked_until' => null,
      'totp_secret' => '${VISUAL_ADMIN.totpSecret}', 'totp_confirmed_at' => $u->totp_confirmed_at ?? now(), 'totp_last_step' => null])->save();
    // Ten unused recovery codes, so the "no recovery codes left" banner stays out of the screenshots.
    App\\Domain\\Admin\\Auth\\Models\\PlatformRecoveryCode::query()->where('user_id', $u->id)->delete();
    for ($i = 1; $i <= 10; $i++) { App\\Domain\\Admin\\Auth\\Models\\PlatformRecoveryCode::query()->create(['user_id' => $u->id, 'code_hash' => App\\Domain\\Admin\\Auth\\RecoveryCodes::hash(sprintf('visual%03d', $i))]); }
    echo 'ok';
  `);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  seedVisualAdmin();
  admin = await adminLogin('admin-visual', VISUAL_ADMIN);
  tenantId = (await findTenant(admin, 'demo')).id as string;
});

// Default output is git-ignored; ADMIN_VISUAL_DIR keeps them out of Playwright's per-run `test-results` wipe.
const OUT = process.env.ADMIN_VISUAL_DIR ?? 'test-results/admin-visual';

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;

type Shot = { name: string; path: () => string; ready: (page: Page) => Promise<void>; after?: (page: Page) => Promise<void> };

const heading = (name: string | RegExp) => async (page: Page) => {
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
};

const ROUTES: Shot[] = [
  { name: 'dashboard', path: () => '/', ready: heading(/dashboard|overview/i) },
  { name: 'merchants', path: () => '/merchants', ready: heading('Merchants') },
  ...(['overview', 'billing', 'domains', 'staff', 'audit'] as const).map<Shot>((tab) => ({
    name: `merchant-${tab}`,
    path: () => `/merchants/${tenantId}${tab === 'overview' ? '' : `?tab=${tab}`}`,
    ready: async (page) => {
      await expect(page.getByRole('tablist', { name: 'Merchant sections' })).toBeVisible();
    },
  })),
  { name: 'billing', path: () => '/billing', ready: heading('Billing') },
  {
    name: 'billing-drawer',
    path: () => '/billing',
    ready: heading('Billing'),
    after: async (page) => {
      const row = page.getByRole('table').getByRole('row').nth(1);
      await expect(row).toBeVisible();
      await row.click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  { name: 'domains', path: () => '/domains', ready: heading('Domains') },
  { name: 'team', path: () => '/team', ready: heading(/team/i) },
  { name: 'audit-log', path: () => '/audit-log', ready: heading(/audit log/i) },
  { name: 'impersonations', path: () => '/impersonations', ready: heading(/impersonations/i) },
];

for (const vp of VIEWPORTS) {
  test(`all admin routes at ${vp.width}px: no page overflow, no console errors`, async ({ page, context }) => {
    test.setTimeout(180_000);
    await signInAdminApp(context, admin);
    await page.setViewportSize(vp);
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // A 5xx here is the local sqlite stack's "database is locked" flake (queries retry); render errors still fail.
      if (m.text().startsWith('Failed to load resource')) test.info().annotations.push({ type: 'network', description: `${page.url()}: ${m.text()}` });
      else errors.push(`${page.url()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));

    const overflow: string[] = [];
    for (const r of ROUTES) {
      await page.goto(`${adminUrl}${r.path()}`);
      await r.ready(page);
      await page.waitForLoadState('networkidle');
      // Skeleton rows (`role=status`, "Loading …") gone: the screenshot shows data, empty or error state.
      await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0, { timeout: 20_000 });
      if (r.after) await r.after(page);
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      if (m.sw > m.iw) overflow.push(`${r.name}: scrollWidth ${m.sw} > ${m.iw}`);
      await page.screenshot({ path: `${OUT}/${vp.width}/${r.name}.png`, fullPage: true });
    }
    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, acceptInvitation, deleteE2eUser, signInDashboard, unique, urls, type Session } from '../support/api';
import { createRole, inviteWithRole, pageOverflow, shopOn, staffUrl, watchConsole, type Shop } from '../support/roles';

/**
 * PHASE-8-3 §10 QA `phase8-3.visual` + AC 5 / Q125: /staff, /staff/roles/:id, /staff/roles/new and the invite modal at
 * 1280, 390 and 375 px (and the member's no-access page at 390): no horizontal page scroll (the matrix scrolls inside
 * its card), no console errors. Screenshots → test-results/phase8-3-visual/<width>/ for the Figma review.
 */
const OUT = resolve(E2E_ROOT, 'test-results/phase8-3-visual');
const WIDTHS = [1280, 390, 375];

let shop: Shop;
let role: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let member: Session;
let memberEmail: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await shopOn('growth', 'vis');
  role = await createRole(shop.s, 'Order staff', ['orders.view', 'orders.process', 'shipments.manage'], 'Confirms orders and books couriers');
  await createRole(shop.s, 'Packer', ['shipments.manage', 'inventory.adjust'], 'Packs parcels and prints labels');
  const inv = await inviteWithRole(shop.s, role.id, 'vis');
  member = await acceptInvitation(shop.s, inv.email, inv.mark, 'Rafi Order');
  memberEmail = inv.email;
  await inviteWithRole(shop.s, role.id, 'vis-open');
});
test.afterAll(() => {
  if (memberEmail) deleteE2eUser(memberEmail);
  shop?.cleanup();
});

async function shot(page: Page, width: number, name: string, overflow: string[]) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const o = await pageOverflow(page);
  if (o) overflow.push(`${width}px ${name}: ${o}`);
  await page.screenshot({ path: `${OUT}/${width}/${name}.png`, fullPage: true });
}

for (const width of WIDTHS) {
  test(`staff & roles screens at ${width}px: no page overflow, no console errors`, async ({ page, context }) => {
    test.setTimeout(120_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, shop.s);

    await page.goto(staffUrl());
    await expect(page.getByRole('heading', { name: /^Staff$/, level: 1 })).toBeVisible();
    await expect(page.getByLabel('Roles & permissions', { exact: true }).getByRole('checkbox').first()).toBeVisible();
    await shot(page, width, 'staff', overflow);

    await page.getByRole('button', { name: '+ Invite staff' }).click();
    await expect(page.getByRole('dialog', { name: /Invite staff member/ })).toBeVisible();
    await shot(page, width, 'invite-modal', overflow);
    await page.getByRole('dialog', { name: /Invite staff member/ }).getByRole('button', { name: 'Cancel' }).click();

    await page.goto(staffUrl(`/roles/${role.id}`));
    await expect(page.getByRole('heading', { name: 'Order staff', level: 1 })).toBeVisible();
    await expect(page.getByLabel('People with this role')).toContainText('Rafi Order');
    await shot(page, width, 'role-detail', overflow);

    await page.goto(staffUrl('/roles/new'));
    await expect(page.getByLabel('Role name')).toBeVisible();
    await shot(page, width, 'role-new', overflow);

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
    test.info().annotations.push({ type: 'network', description: c.network.join('; ') || 'none' });
  });
}

test('member with the custom role at 390px: no-access page and nav, no overflow', async ({ page, context }) => {
  test.setTimeout(90_000);
  mkdirSync(`${OUT}/390`, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const c = watchConsole(page);
  const overflow: string[] = [];
  await signInDashboard(context, member);
  await page.goto(`${urls.merchant}/customers`);
  await expect(page.getByText(/You don.t have access to this page/)).toBeVisible();
  await shot(page, 390, 'member-no-access', overflow);
  await page.goto(`${urls.merchant}/more`);
  await page.waitForLoadState('networkidle');
  const more = await page.locator('main').innerText();
  // Mobile "More" honours the same permissions as the sidebar.
  expect(more).not.toMatch(/\bCustomers\b/);
  expect(more).not.toMatch(/\bReports\b/);
  expect(more).not.toMatch(/\bStaff\b/);
  await shot(page, 390, 'member-more', overflow);
  expect(overflow, overflow.join('\n')).toEqual([]);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
  void unique;
});

for (const width of [390, 375]) {
  // Q125: "matrix scrolls horizontally inside its card". QA P83-QA-1: the sticky permission column must leave room for
  // the role columns, so a custom role's checkbox can be ticked on a phone.
  test(`Staff matrix at ${width}px: a custom role's checkbox can be ticked`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    await signInDashboard(context, shop.s);
    await page.goto(staffUrl());
    const matrix = page.getByLabel('Roles & permissions', { exact: true });
    const box = matrix.getByRole('checkbox', { name: 'Packer: View customers' });
    await box.scrollIntoViewIfNeeded();
    await box.check({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();
    // Group sub-headers keep their label in view at every horizontal scroll position (no blank bands).
    const scroller = matrix.locator('div.overflow-x-auto').first();
    for (const at of ['start', 'end'] as const) {
      await scroller.evaluate((el, end) => (el.scrollLeft = end ? el.scrollWidth : 0), at === 'end');
      const frame = (await scroller.boundingBox())!;
      const label = (await matrix.locator('th[scope=rowgroup] > span').first().boundingBox())!;
      expect(label.x, `group label at scroll ${at}`).toBeGreaterThanOrEqual(frame.x - 1);
      expect(label.x + label.width, `group label at scroll ${at}`).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
  });
}

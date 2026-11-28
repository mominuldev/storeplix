import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { placeOrder, randomPhone, type CommerceShop } from '../support/commerce';
import {
  channelsDrawer,
  chatPanel,
  cleanupInboxShop,
  createSavedReply,
  findConversation,
  gotoWithWidget,
  inboundEmailRaw,
  inboxShop,
  launcher,
  listRegion,
  note,
  openInbox,
  openThread,
  orderCard,
  reply,
  SAVED_REPLIES,
  mUrl,
  storeAddress,
  thread,
  useChatSession,
  verifiedChat,
} from '../support/inbox';
import { pageOverflow, watchConsole } from '../support/roles';

/**
 * PHASE-8-8E AC 6 (Figma 2118:51165 inbox, 2124:1335 / 2124:1509 mobile list / thread, 2123:52602 first run,
 * 2123:52877 saved replies, 2125:9509 launcher, 2125:9736 open panel, 2125:10004 sent, 2126:10484 mobile sheet,
 * 2126:10642 order Messages) at 1440 and 390 px: no horizontal page scroll, no console errors; at 390 the inbox shows one
 * pane at a time (list → thread with a back button), the widget is a bottom sheet with a scrim at full width, the order
 * card stacks under the timeline. Screenshots: tests/e2e/test-results/phase8-8e-visual/{1440,390}/.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let empty: CommerceShop;
let chat: { session: string; id: string };
let order: { number: string; phone: string };
const SHOTS = resolve(E2E_ROOT, 'test-results/phase8-8e-visual');

test.beforeAll(async () => {
  test.setTimeout(300_000);
  shop = await inboxShop('ibxvis', { web_chat: true, order_messages: true, email: true });
  empty = await inboxShop('ibxvie', {});
  const v = await verifiedChat(shop, { name: 'Nusrat Jahan', message: 'Is the muslin wrap soft enough for a baby?', productSlug: shop.simple.slug, pagePath: `/products/${shop.simple.slug}` });
  chat = { session: v.session, id: (await findConversation(shop.s, (x) => x.preview.includes('muslin wrap soft'), 'visual chat')).id as string };
  await reply(shop.s, chat.id, 'Yes — 100% cotton muslin, washed twice. Very soft.');
  await note(shop.s, chat.id, 'Offer the gift box if she orders two.');
  await verifiedChat(shop, { name: 'Tanvir Ahmed', message: 'Do you have a shop in Dhanmondi?' });
  await inboundEmailRaw({ to: await storeAddress(shop.s), from: 'farzana@mail.e2e.storeplix.test', fromName: 'Farzana Akter', subject: 'Gift wrap?', text: 'Can you gift wrap my order?' });
  await createSavedReply(shop.s, { title: 'Delivery charges', shortcut: 'delivery', body: 'Inside Dhaka {delivery_inside}, outside {delivery_outside}.', show_as_chip: true });
  await createSavedReply(shop.s, { title: 'Thanks', shortcut: 'thanks', body: 'Thank you, {customer_name}!', show_as_chip: true });
  const phone = randomPhone();
  order = { number: (await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { phone } } })).order.number as string, phone };
});
test.afterAll(() => {
  cleanupInboxShop(shop);
  cleanupInboxShop(empty);
});

async function shot(page: Page, width: number, name: string): Promise<void> {
  const dir = resolve(SHOTS, String(width));
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
}
const noOverflow = async (page: Page, where: string) => expect(await pageOverflow(page), `${where}: no horizontal scroll`).toBeNull();

for (const width of [1440, 390]) {
  const mobile = width < 768;
  test(`${width} px: inbox list, thread, saved replies, channels drawer, first run`, async ({ page, context, browser }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    const c = watchConsole(page);
    await signInDashboard(context, shop.s);

    await openInbox(page);
    await expect(listRegion(page).getByRole('listitem')).toHaveCount(3);
    await noOverflow(page, `list ${width}`);
    await shot(page, width, '01-inbox-list');

    await openThread(page, chat.id);
    await expect(thread(page)).toContainText('Very soft.');
    await expect(thread(page)).toContainText('Internal note · only your team sees this');
    if (mobile) {
      await expect(listRegion(page)).toBeHidden(); // one pane at a time
      await expect(page.getByRole('button', { name: 'Back to conversations' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeHidden();
    } else {
      await expect(listRegion(page)).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Customer' })).toBeVisible();
    }
    await noOverflow(page, `thread ${width}`);
    await shot(page, width, '02-thread');
    if (mobile) {
      await page.getByRole('button', { name: /Customer/ }).filter({ hasText: 'Customer' }).last().click();
      await expect(page.getByRole('dialog', { name: 'Customer' })).toBeVisible();
      await shot(page, width, '03-customer-sheet');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Back to conversations' }).click();
      await expect(listRegion(page)).toBeVisible();
    }

    await page.goto(mUrl(SAVED_REPLIES));
    await expect(page.getByRole('heading', { name: 'Saved replies', level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Delivery charges').first()).toBeVisible();
    await noOverflow(page, `saved replies ${width}`);
    await shot(page, width, '04-saved-replies');

    await openInbox(page);
    await page.getByRole('button', { name: 'Connect a channel' }).click();
    await expect(channelsDrawer(page)).toBeVisible();
    await expect(channelsDrawer(page).getByText('Coming later')).toHaveCount(3);
    await shot(page, width, '05-channels-drawer');
    await page.keyboard.press('Escape');

    // First run (2123:52602) on a shop with nothing turned on, in its own browser context.
    const other = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 } });
    const fp = await other.newPage();
    const c2 = watchConsole(fp);
    await signInDashboard(other, empty.s);
    await openInbox(fp);
    await expect(fp.getByRole('heading', { name: 'No conversations yet' })).toBeVisible({ timeout: 20_000 });
    await noOverflow(fp, `first run ${width}`);
    await shot(fp, width, '06-first-run');
    await other.close();
    expect([...c.errors, ...c2.errors], [...c.errors, ...c2.errors].join('\n')).toEqual([]);
  });

  test(`${width} px: widget launcher, open panel / sheet, order Messages card`, async ({ page, context }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: mobile ? 844 : 900 });
    const c = watchConsole(page);
    await gotoWithWidget(page, shop, `/products/${shop.simple.slug}`);
    await noOverflow(page, `pdp + launcher ${width}`);
    await shot(page, width, '10-launcher');
    await launcher(page).click();
    const panel = chatPanel(page);
    await expect(panel.getByLabel('Your name')).toBeVisible();
    const box = await panel.boundingBox();
    if (mobile) {
      expect(box!.width, '390 px: the widget is a full-width bottom sheet').toBeGreaterThanOrEqual(width - 2);
      await expect(page.locator('[data-sp-chat-scrim]')).toBeVisible();
    } else {
      expect(Math.round(box!.width), '380 px panel').toBe(380);
    }
    await noOverflow(page, `widget form ${width}`);
    await shot(page, width, '11-widget-form');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // A verified session: thread with the shop reply (and never the note).
    await useChatSession(context, shop, chat.session);
    await gotoWithWidget(page, shop, '/');
    await launcher(page).click();
    await expect(chatPanel(page)).toContainText('Very soft.', { timeout: 20_000 });
    await expect(chatPanel(page)).not.toContainText('gift box');
    await noOverflow(page, `widget thread ${width}`);
    await shot(page, width, '12-widget-thread');
    await page.keyboard.press('Escape');

    await page.goto(`${shop.storefront}/track`);
    await page.getByLabel('Order number').fill(order.number);
    await page.getByLabel('Phone number').fill(order.phone);
    await page.getByRole('button', { name: 'Track order' }).click();
    await expect(orderCard(page)).toBeVisible({ timeout: 20_000 });
    await noOverflow(page, `track + messages ${width}`);
    await shot(page, width, '13-track-messages');
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}

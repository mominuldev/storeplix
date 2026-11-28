import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { placeOrder, type CommerceShop } from '../support/commerce';
import {
  channelCard,
  channelsDrawer,
  cleanupInboxShop,
  inboundEmailRaw,
  inboxShop,
  launcher,
  openInbox,
  rotateRaw,
  settings,
  sfConfigRaw,
  storeAddress,
  trackRaw,
} from '../support/inbox';
import { audit } from '../support/purchasing';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-8E §4, §9.1, §10, P88E-20 (Q303), AC 1 + AC 2 (channels):
 *  - a shop that turns nothing on: first-run card "No conversations yet" with three Off cards + Turn on, no widget in the
 *    storefront config, no `messages` on the tracking view;
 *  - Turn on from the first-run card and from the "Connect a channel" drawer (switches) → storefront config carries
 *    `inbox.web_chat` / `order_messages`, the launcher shows on the shop; the email card shows the forwarding address,
 *    Copy puts it on the clipboard; "Get a new address" (confirm) rotates it and the old address stops at once (202
 *    `{accepted: false}`);
 *  - turning a channel off hides the widget / Messages card again; Messenger / WhatsApp / Instagram are "Coming later".
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await inboxShop('ibxch', {}); // channels left off (P88E-20)
});
test.afterAll(() => cleanupInboxShop(shop));

test('nothing on: first-run card, no widget config, no order messages', async ({ page, context }) => {
  const st = await settings(shop.s);
  expect([st.channels.web_chat.enabled, st.channels.order_messages.enabled, st.channels.email.enabled]).toEqual([false, false, false]);
  expect(st.channels.email.address).toBeNull();
  expect((st.external_channels as Array<{ channel: string; status: string }>).map((e) => `${e.channel}:${e.status}`)).toEqual([
    'messenger:coming_later',
    'whatsapp:coming_later',
    'instagram:coming_later',
  ]);
  const cfg = await sfConfigRaw(shop.apiHost);
  expect(cfg.status, cfg.text.slice(0, 300)).toBe(200);
  expect(cfg.json.data.inbox?.web_chat ?? null, 'no widget while web_chat is off').toBeNull();
  const placed = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { phone: '01711000321' } } });
  const tr = await trackRaw(shop.apiHost, placed.order.number, '01711000321');
  expect(tr.status, tr.text.slice(0, 300)).toBe(200);
  expect(tr.json.data.messages ?? null, 'no Messages card while order messages are off').toBeNull();

  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openInbox(page);
  const first = page.getByRole('region', { name: 'Inbox' });
  await expect(first.getByRole('heading', { name: 'No conversations yet' })).toBeVisible();
  await expect(first.getByText('Turn on a channel so customers can reach you.', { exact: false })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Turn on' })).toHaveCount(3);
  await expect(first.getByText('Off', { exact: true })).toHaveCount(3);
  await page.goto(shop.storefront);
  await expect(page.locator('main, body').first()).toBeVisible();
  await expect(launcher(page)).toHaveCount(0);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('turn on website chat from the first-run card → launcher on the shop', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await openInbox(page);
  const first = page.getByRole('region', { name: 'Inbox' });
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/inbox/settings') && r.status() === 200);
  await first.getByRole('button', { name: 'Turn on' }).first().click();
  await saved;
  await expect(page.getByText('Website chat turned on.')).toBeVisible();
  await expect(first.getByText('On', { exact: true })).toHaveCount(1);
  expect((await settings(shop.s)).channels.web_chat.enabled).toBe(true);

  await expect
    .poll(async () => (await sfConfigRaw(shop.apiHost)).json.data?.inbox?.web_chat?.enabled ?? false, { timeout: 15_000 })
    .toBe(true);
  await expect
    .poll(
      async () => {
        await page.goto(shop.storefront);
        return launcher(page).isVisible();
      },
      { timeout: 30_000, intervals: [1_000, 2_000, 3_000], message: 'launcher after turning web chat on (storefront tag revalidated?)' },
    )
    .toBe(true);
  await expect(launcher(page)).toHaveAccessibleName('Chat with us');
});

test('channels drawer: order messages + email on, copy and rotate the address', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signInDashboard(context, shop.s);
  await openInbox(page);
  await page.getByRole('button', { name: 'Connect a channel' }).click();
  const drawer = channelsDrawer(page);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Coming later')).toHaveCount(3);
  for (const label of ['Facebook Messenger', 'WhatsApp', 'Instagram']) await expect(drawer.getByText(label, { exact: true })).toBeVisible();

  await channelCard(drawer, 'Order messages').getByRole('switch', { name: 'Order messages' }).click();
  await expect(page.getByText('Order messages turned on.')).toBeVisible();
  const email = channelCard(drawer, 'Email replies');
  await email.getByRole('switch', { name: 'Email replies' }).click();
  await expect(page.getByText('Email replies turned on.')).toBeVisible();

  const address = await storeAddress(shop.s);
  await expect(email.getByText(address, { exact: true })).toBeVisible();
  await email.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Address copied.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);

  // The current address receives (202 accepted true).
  const before = await inboundEmailRaw({ to: address, from: 'buyer.one@mail.e2e.storeplix.test' });
  expect([before.status, before.json.data?.accepted ?? before.json.accepted]).toEqual([202, true]);

  await email.getByRole('button', { name: 'Get a new address' }).click();
  const confirm = page.getByRole('dialog', { name: 'Get a new email address?' });
  await expect(confirm).toContainText('The current address stops working right away.');
  const rotated = page.waitForResponse((r) => r.url().includes('/email-address/rotate') && r.status() === 200);
  await confirm.getByRole('button', { name: 'Get a new address' }).click();
  await rotated;
  await expect(page.getByText('New address ready.')).toBeVisible();
  const next = await storeAddress(shop.s);
  expect(next).not.toBe(address);
  await expect(email.getByText(next, { exact: true })).toBeVisible();

  // The old address stops at once: accepted silently, nothing stored (no oracle).
  const old = await inboundEmailRaw({ to: address, from: 'buyer.two@mail.e2e.storeplix.test' });
  expect([old.status, old.json.data?.accepted ?? old.json.accepted]).toEqual([202, false]);
  const fresh = await inboundEmailRaw({ to: next, from: 'buyer.two@mail.e2e.storeplix.test' });
  expect([fresh.status, fresh.json.data?.accepted ?? fresh.json.accepted]).toEqual([202, true]);

  // Storefront: order messages on → the tracking view carries `messages`.
  const placed = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { phone: '01711000322' } } });
  const tr = await trackRaw(shop.apiHost, placed.order.number, '01711000322');
  expect(tr.json.data.messages?.enabled, tr.text.slice(0, 300)).toBe(true);
  expect(tr.json.data.messages.reply_time).toBe('minutes');
});

test('rotate again (audited); web chat off hides the launcher and the config; order messages off drops the card', async ({ page, context }) => {
  const a = await storeAddress(shop.s);
  const r = await rotateRaw(shop.s);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(await storeAddress(shop.s)).not.toBe(a);
  const actions = (await audit(shop.s)).map((e) => e.action as string);
  expect(actions.filter((x) => x === 'inbox.email_address_rotated').length).toBeGreaterThanOrEqual(2);
  expect(actions).toContain('inbox.settings_updated');

  await signInDashboard(context, shop.s);
  await openInbox(page);
  await page.getByRole('button', { name: 'Connect a channel' }).click();
  const drawer = channelsDrawer(page);
  const chat = channelCard(drawer, 'Website chat');
  await expect(chat.getByRole('switch', { name: 'Website chat' })).toHaveAttribute('aria-checked', 'true');
  await chat.getByRole('switch', { name: 'Website chat' }).click();
  await expect(page.getByText('Website chat turned off.')).toBeVisible();
  await expect.poll(async () => (await sfConfigRaw(shop.apiHost)).json.data?.inbox?.web_chat ?? null, { timeout: 15_000 }).toBeNull();
  await expect
    .poll(
      async () => {
        await page.goto(shop.storefront);
        return launcher(page).count();
      },
      { timeout: 30_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(0);

  // Order messages off → the tracking view drops `messages` again.
  await openInbox(page);
  await page.getByRole('button', { name: 'Connect a channel' }).click();
  await channelCard(channelsDrawer(page), 'Order messages').getByRole('switch', { name: 'Order messages' }).click();
  await expect(page.getByText('Order messages turned off.')).toBeVisible();
  const placed = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { phone: '01711000323' } } });
  const tr = await trackRaw(shop.apiHost, placed.order.number, '01711000323');
  expect(tr.json.data.messages ?? null).toBeNull();
});

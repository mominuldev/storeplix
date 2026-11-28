import { expect, test } from '@playwright/test';
import { api, signInDashboard, unique } from '../support/api';
import { confirmedOrder, type CommerceShop } from '../support/commerce';
import { purchasingShop } from '../support/purchasing';
import { watchConsole } from '../support/roles';
import { cleanupSmsShop, editor, messages, msisdn, openSms, smsMark, template, templateRow, waitSms } from '../support/sms';

/**
 * PHASE-8-9A §7, §12.2 (P89A-7, P89A-10, S214) and the §15 QA flow: edit the bn `order_confirmed` template in the
 * editor (Insert chip, counter, server preview, Unsaved → Edited) → place + confirm an order → the SMS the shop sends has
 * the custom text; Reset to default (confirm) → Default and the next order gets today's default text again; a body over
 * 3 parts shows "Too long …" and Save stays disabled; checkout OTP is Locked.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
const MARK = `QA${unique('').slice(-6).toUpperCase()}`;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('smstpl', 'starter', 10);
  // Bangla, and order_confirmed is OFF by default (StoreCommerce::SMS_DEFAULTS): switch it on for this shop.
  const r = await api(shop.s, 'PATCH', `/stores/${shop.s.storeId}/settings`, { notifications: { sms_language: 'bn', customer_sms: { order_confirmed: true } } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
});
test.afterAll(() => cleanupSmsShop(shop));

test('templates list: 7 editable keys with bn + en previews, checkout code locked', async ({ page, context }) => {
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openSms(page, 'templates');
  const list = page.getByRole('list', { name: 'SMS templates' });
  await expect(list.getByRole('listitem')).toHaveCount(8);
  const confirmed = templateRow(page, 'Order confirmed');
  await expect(confirmed).toContainText('When: you confirm the order');
  await expect(confirmed).toContainText('Default');
  await expect(confirmed).toContainText('বাংলা');
  await expect(confirmed).toContainText('English');
  const otp = templateRow(page, 'Checkout code');
  await expect(otp).toContainText('Read-only');
  await expect(otp).toContainText('Locked');
  await expect(otp.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('edit bn order_confirmed: insert chip, preview, save → Edited; the confirmed order SMS uses it', async ({ page, context }) => {
  test.setTimeout(150_000);
  await signInDashboard(context, shop.s);
  await openSms(page, 'templates');
  await templateRow(page, 'Order confirmed').getByRole('button', { name: 'Edit Order confirmed' }).click();
  await expect(page).toHaveURL(/key=order_confirmed/);
  const ed = editor(page);
  await expect(ed).toContainText('Order confirmed · sent when you confirm the order');
  await ed.getByRole('group', { name: 'Template language' }).getByRole('button', { name: 'বাংলা' }).click();
  const box = ed.getByRole('textbox', { name: 'Message' });
  await box.fill(`{shop}: ${MARK} অর্ডার {number} নিশ্চিত। মোট Tk `);
  await ed.getByRole('button', { name: '{total}' }).click(); // inserted at the cursor (end)
  await expect(box).toHaveValue(new RegExp(`${MARK} অর্ডার \\{number\\} নিশ্চিত। মোট Tk \\{total\\}$`));
  await expect(ed).toContainText('Unsaved');
  await expect(ed.getByTestId('part-meter')).toContainText(/SMS parts?/);
  await expect(ed.getByTestId('template-preview')).toContainText(`${MARK} অর্ডার QA-1042`, { timeout: 10_000 });
  await expect(ed).toContainText('is added because you use the Storeplix sender');
  await ed.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Template saved.').first()).toBeVisible();
  await expect(ed).toContainText('Edited');
  const saved = await template(shop.s, 'order_confirmed', 'bn');
  expect([saved.is_custom, saved.body.includes(MARK)]).toEqual([true, true]);
  await ed.getByRole('button', { name: 'Cancel' }).click();
  await expect(templateRow(page, 'Order confirmed')).toContainText('Edited');

  const mark = smsMark();
  const order = await confirmedOrder(shop);
  const sms = await waitSms(mark, (m) => m.to === msisdn(order.phone) && m.text.includes(MARK), `custom order_confirmed SMS for ${order.number}`);
  expect(sms.text.startsWith('QA smstpl shop: '), sms.text).toBe(true);
  expect(sms.text).toContain(`${MARK} অর্ডার ${order.number} নিশ্চিত।`);
  const rows = await messages(shop.s, 'filter[purpose]=order_confirmed');
  expect(rows.some((r) => String(r.body_preview ?? '').includes(MARK))).toBe(true);
});

test('over 3 parts: "Too long …" inline, Save disabled; Reset to default (confirm) → Default and the default text is sent', async ({ page, context }) => {
  test.setTimeout(150_000);
  await signInDashboard(context, shop.s);
  await openSms(page, 'templates', '&key=order_confirmed');
  const ed = editor(page);
  await ed.getByRole('group', { name: 'Template language' }).getByRole('button', { name: 'বাংলা' }).click();
  const box = ed.getByRole('textbox', { name: 'Message' });
  await box.fill(`{shop}: {number} ${'অনেক বড় বার্তা '.repeat(16)}`);
  await expect(ed.getByTestId('part-meter')).toContainText(/— max 3/);
  await expect(ed.getByRole('alert')).toContainText(/Too long for one message\. Keep it within 3 parts/);
  await expect(ed.getByRole('button', { name: 'Save' })).toBeDisabled();

  // Reset (the saved text is custom → confirm dialog).
  await ed.getByRole('button', { name: 'Reset to default' }).click();
  const confirm = page.getByRole('dialog', { name: 'Reset to the default text?' });
  await confirm.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText('Template reset to the default text.').first()).toBeVisible();
  const t = await template(shop.s, 'order_confirmed', 'bn');
  expect([t.is_custom, t.body]).toEqual([false, t.default_body]);
  await ed.getByRole('button', { name: 'Cancel' }).click();
  await expect(templateRow(page, 'Order confirmed')).toContainText('Default');

  const mark = smsMark();
  const order = await confirmedOrder(shop);
  const sms = await waitSms(mark, (m) => m.to === msisdn(order.phone) && m.text.includes('কনফার্ম হয়েছে'), `default order_confirmed SMS for ${order.number}`);
  expect(sms.text).toBe(`QA smstpl shop: আপনার অর্ডার ${order.number} কনফার্ম হয়েছে।`);
  expect(sms.text).not.toContain(MARK);
});

import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { purchasingShop } from '../support/purchasing';
import type { CommerceShop } from '../support/commerce';
import { watchConsole } from '../support/roles';
import { cleanupSmsShop, openSms, panel, randomSenderId, requestSenderIdRaw, senderIdsRaw, tinyPdf } from '../support/sms';

/**
 * PHASE-8-9A §8, §12.3 (S215, S216): Sender ID tab — Current sender "Storeplix" + "Platform default" and the prefix
 * explanation; the request form validates the ID pattern, the uses, the tick and the licence type on the client; a PDF
 * upload submits (multipart) → Pending request card with the timeline and the info banner; Cancel request (confirm) →
 * the form is back and "Earlier requests" lists it as Cancelled; a second shop asking for the same ID gets
 * "Another business already uses or asked for this sender ID."
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let other: CommerceShop;
const ID = randomSenderId();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await purchasingShop('smssid', 'starter', 2);
  other = await purchasingShop('smssid2', 'starter', 2);
});
test.afterAll(() => {
  cleanupSmsShop(shop);
  cleanupSmsShop(other);
});

test('request form: client validation, PDF upload → pending card; cancel → form back + history', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openSms(page, 'sender-id');
  const current = panel(page, 'Current sender');
  await expect(current).toContainText('Storeplix');
  await expect(current).toContainText('Platform default');
  await expect(current).toContainText('QA smssid shop: ');

  const form = page.getByRole('form', { name: 'Request a masked sender ID' });
  await form.getByRole('textbox', { name: 'Sender ID' }).fill('A B!');
  await form.getByRole('button', { name: 'Submit request' }).click();
  await expect(form).toContainText('Use 3–11 letters or numbers, with at least one letter.');
  await expect(form).toContainText('Upload your trade licence.');
  await expect(form).toContainText('Tick to confirm the name belongs to your business.');
  await expect(form).toContainText('Enter the business name on the trade licence.');
  await expect(form.getByRole('button', { name: 'Promotions' })).toBeDisabled();

  // Wrong file type is refused on the client.
  await form.locator('input[type=file]').setInputFiles({ name: 'licence.txt', mimeType: 'text/plain', buffer: Buffer.from('not a licence') });
  await form.getByRole('button', { name: 'Submit request' }).click();
  await expect(form).toContainText('Upload a PDF, JPG, PNG or WebP file.');
  await form.getByRole('button', { name: 'Remove' }).click();

  await form.getByRole('textbox', { name: 'Sender ID' }).fill(ID.toLowerCase());
  await expect(form).toContainText(`${ID.length} / 11`);
  await form.getByRole('textbox', { name: 'Business name on the trade licence' }).fill('QA Trading House');
  await form.getByRole('button', { name: 'POS receipts' }).click();
  await form.locator('input[type=file]').setInputFiles({ name: 'trade-licence.pdf', mimeType: 'application/pdf', buffer: tinyPdf() });
  await expect(form).toContainText('trade-licence.pdf');
  await form.getByRole('checkbox', { name: /This name belongs to my business/ }).check();
  await form.getByRole('button', { name: 'Submit request' }).click();
  await expect(page.getByText('Request sent. Review takes about 7–10 working days.').first()).toBeVisible();

  const pending = panel(page, 'Pending request');
  await expect(pending).toContainText(ID); // stored upper-case
  await expect(pending).toContainText('Pending review');
  await expect(pending).toContainText(/for order updates and POS receipts/i);
  await expect(pending.getByRole('list', { name: 'Request progress' }).getByRole('listitem')).toHaveCount(3);
  await expect(pending).toContainText('trade licence uploaded');
  await expect(pending).toContainText('nothing stops');
  await expect(page.getByRole('form', { name: 'Request a masked sender ID' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'SMS', exact: true })).toContainText(`${ID} in review`);
  const list = await senderIdsRaw(shop.s);
  expect([list.status, list.json.data.pending?.sender_id, list.json.data.pending?.document?.url ?? null]).toEqual([200, ID, null]);

  // Another shop asking for the same ID → 409 sender_id_taken (S215).
  const taken = await requestSenderIdRaw(other.s, ID);
  expect([taken.status, taken.json.error?.code]).toEqual([409, 'sender_id_taken']);

  await pending.getByRole('button', { name: 'Cancel request' }).click();
  const dlg = page.getByRole('dialog', { name: `Cancel the request for ${ID}?` });
  await dlg.getByRole('button', { name: 'Cancel request' }).click();
  await expect(page.getByText('Request cancelled.').first()).toBeVisible();
  await expect(page.getByRole('form', { name: 'Request a masked sender ID' })).toBeVisible();
  const earlier = panel(page, 'Earlier requests');
  await earlier.getByRole('button', { name: 'Show 1' }).click();
  await expect(earlier.getByRole('list', { name: 'Earlier requests' })).toContainText(ID);
  await expect(earlier).toContainText('Cancelled');
  expect(c.errors, c.errors.join('\n')).toEqual([]);

  // A cancelled ID is free again for another shop.
  const again = await requestSenderIdRaw(other.s, ID);
  expect(again.status, again.text).toBe(201);
});

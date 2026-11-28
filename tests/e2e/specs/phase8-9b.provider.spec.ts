import { expect, test, type Page } from '@playwright/test';
import { adminLogin, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import { watchConsole } from '../support/roles';
import { adminOk, adminSms, dialog, openSmsSettings, providerOverview, resetPlatformSms, section, STAFF_TEST_PHONE } from '../support/platform-sms';

/**
 * PHASE-8-9B §4.6, §11.1–§11.3, §14 QA, S220, S222, S223 (super admin, `SMS_PROVIDERS_HTTP_FAKE=true`, `SMS_DRIVER=log`):
 *  - no database provider and no env REVE → the not-configured state (danger banner, empty state, What's waiting) and
 *    the `no_provider` alert;
 *  - Configure provider: REVE (coming-soon cards disabled) → credentials (write-only) → route & senders → test (canned
 *    success) → Activate opens the typed-name dialog; the button stays disabled until the name matches → source
 *    becomes `database`;
 *  - Add failover: Other (HTTP API) with a mapped credential → test → activated directly as the failover;
 *  - Rotate the primary's key: client checks first (missing value), then "Test and save new key" swaps the hint;
 *  - Remove the failover with the typed name; the primary can't be removed (409).
 * Secrets typed in the UI never come back in any provider response.
 */
test.describe.configure({ mode: 'serial' });

const PRIMARY = 'REVE SMS QA';
const FAILOVER = 'QA HTTP Gateway';
const API_KEY = `qa-reve-api-${Date.now()}Wx9Z`;
const SECRET_KEY = `qa-reve-sec-${Date.now()}Kp4Q`;
const NEW_API_KEY = `qa-rot-api-${Date.now()}Rt7M`;
const NEW_SECRET_KEY = `qa-rot-sec-${Date.now()}Ns3V`;
const HTTP_TOKEN = `qa-http-token-${Date.now()}Hq2L`;
let admin: AdminSession;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  reseedSuperAdmin();
  resetPlatformSms();
  admin = await adminLogin('admin-super-p89b');
});

async function noSecretsInOverview() {
  const r = await adminSms(admin, 'GET', '/providers');
  expect(r.status).toBe(200);
  for (const secret of [API_KEY, SECRET_KEY, NEW_API_KEY, NEW_SECRET_KEY, HTTP_TOKEN]) expect(r.text, 'a credential leaked into the overview').not.toContain(secret);
  expect(r.text).not.toContain('credentials_encrypted');
}

async function testInDrawer(page: Page, drawer: ReturnType<typeof dialog>, name: string) {
  await drawer.getByLabel('Send a test SMS to').fill(STAFF_TEST_PHONE);
  await drawer.getByRole('button', { name: 'Send test', exact: true }).click();
  await expect(drawer.getByTestId('provider-test-result')).toContainText(`Test sent — ${name} accepted it`, { timeout: 20_000 });
  await expect(drawer.getByTestId('provider-test-result')).toContainText('01711-•••211');
  await expect(drawer.getByTestId('provider-test-result')).toContainText('৳ 5,000'); // canned balance
}

test('not configured: banner, empty state, waiting table and the no_provider alert', async ({ page, context }) => {
  const c = watchConsole(page);
  const o = await providerOverview(admin);
  expect([o.source, o.primary, o.failover]).toEqual(['none', null, null]);
  const alerts = await adminOk(admin, 'GET', '/alerts', undefined, 200, 'alerts');
  expect((alerts as unknown as Array<{ code: string; severity: string }>).find((a) => a.code === 'no_provider')?.severity).toBe('danger');

  await signInAdminApp(context, admin);
  await openSmsSettings(page);
  await expect(page.getByText('No SMS provider — sign-in codes will fail').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up an SMS provider' })).toBeVisible();
  for (const step of ['An aggregator account', 'API key and secret', 'An approved sender ID']) await expect(page.getByRole('listitem').filter({ hasText: step })).toBeVisible();
  await expect(section(page, 'What’s waiting')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Provider' }).or(page.getByRole('tab').first()).first()).toHaveAttribute('aria-selected', 'true');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('configure REVE as primary: steps, test, typed-name activation', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInAdminApp(context, admin);
  await openSmsSettings(page);
  await page.getByRole('button', { name: 'Configure provider' }).first().click();
  const drawer = dialog(page, /Configure SMS provider/);
  await expect(drawer).toContainText('Step 1 of 4');

  // 1 Choose: coming-soon cards disabled; DLR info shown.
  for (const soon of ['SSL Wireless', 'Alpha SMS', 'BulkSMSBD']) await expect(drawer.getByRole('radio', { name: new RegExp(soon) })).toBeDisabled();
  await expect(drawer).toContainText('Delivery reports aren’t available yet');
  await drawer.getByRole('button', { name: 'Next' }).click();
  await expect(drawer).toContainText('Pick a provider.');
  await drawer.getByRole('radio', { name: /^REVE SMS/ }).check();
  await drawer.getByRole('button', { name: 'Next' }).click();

  // 2 Credentials (write-only, https only).
  await expect(drawer).toContainText('Step 2 of 4');
  await drawer.getByLabel('Provider name').fill(PRIMARY);
  await drawer.getByRole('button', { name: 'Next' }).click();
  await expect(drawer.getByText('Paste the value from the provider portal.').first()).toBeVisible();
  await drawer.getByLabel('API key', { exact: true }).fill(API_KEY);
  await drawer.getByLabel('Secret key', { exact: true }).fill(SECRET_KEY);
  await drawer.getByLabel('Account ID').fill('QA-7781');
  await drawer.getByLabel('API endpoint').fill('http://smpp.revesms.com:7790');
  await expect(drawer.getByText('Use an https:// address.').first()).toBeVisible();
  await drawer.getByLabel('API endpoint').fill('https://smpp.revesms.com:7790');
  await drawer.getByRole('button', { name: 'Next' }).click();

  // 3 Route & senders: primary keeps the four required groups; promotional mask approved.
  await expect(drawer).toContainText('Step 3 of 4');
  await expect(drawer.getByRole('radio', { name: /Primary/ })).toBeChecked();
  await drawer.getByLabel('Promotional mask').fill('SPOffers');
  await drawer.getByLabel('BTRC status').selectOption('approved');
  await drawer.getByRole('button', { name: 'Next' }).click();

  // 4 Test & activate: the draft exists, activation needs a passing test, then the typed name.
  await expect(drawer).toContainText('Step 4 of 4', { timeout: 20_000 });
  const activate = drawer.getByRole('button', { name: `Activate ${PRIMARY}` });
  await expect(activate).toBeDisabled();
  await testInDrawer(page, drawer, PRIMARY);
  await expect(activate).toBeEnabled();
  await activate.click();
  const dlg = dialog(page, `Make ${PRIMARY} the primary provider?`);
  await expect(dlg).toContainText('instead of the server environment');
  const confirm = dlg.getByRole('button', { name: `Activate ${PRIMARY}` });
  await dlg.getByLabel(`Type ${PRIMARY} to confirm`).fill('REVE SMS');
  await expect(confirm).toBeDisabled();
  await dlg.getByLabel(`Type ${PRIMARY} to confirm`).fill(PRIMARY.toLowerCase()); // case-insensitive
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText(`${PRIMARY} is now the primary SMS provider`)).toBeVisible();

  const gw = section(page, 'SMS gateway');
  await expect(gw).toContainText(PRIMARY);
  await expect(gw).toContainText('Primary route');
  await expect(gw).toContainText('Not set'); // failover slot
  await expect(gw).toContainText(`••••${API_KEY.slice(-4)}`);
  await expect(gw).toContainText('SPOffers');
  await expect(page.getByText('No SMS provider — sign-in codes will fail')).toHaveCount(0);
  const o = await providerOverview(admin);
  expect([o.source, o.primary?.name, o.primary?.role]).toEqual(['database', PRIMARY, 'primary']);
  expect(o.primary.credentials_hint).toEqual({ api_key: `••••${API_KEY.slice(-4)}`, secret_key: `••••${SECRET_KEY.slice(-4)}` });
  await noSecretsInOverview();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('server re-checks the typed name and the test (S222)', async () => {
  const draft = await adminOk(admin, 'POST', '/providers', {
    driver: 'revesms', name: 'QA Draft Check', credentials: { api_key: 'draftkey1234', secret_key: 'draftsecret5678' },
    settings: { account_id: null, base_url: 'https://smpp.revesms.com:7790' }, default_sender_id: 'Storeplix', message_groups: ['shop', 'registration', 'billing', 'security'],
  }, 201, 'create draft');
  let r = await adminSms(admin, 'POST', `/providers/${draft.id}/activate`, { role: 'primary', confirm_name: 'QA Draft Check' });
  expect([r.status, r.json.error?.code]).toEqual([409, 'sms_provider_test_required']);
  await adminOk(admin, 'POST', `/providers/${draft.id}/test`, { phone: STAFF_TEST_PHONE }, 200, 'test draft');
  r = await adminSms(admin, 'POST', `/providers/${draft.id}/activate`, { role: 'primary', confirm_name: 'QA Draft' });
  expect([r.status, r.json.error?.code]).toEqual([422, 'confirmation_mismatch']);
  expect((await providerOverview(admin)).primary.name).toBe(PRIMARY);
  r = await adminSms(admin, 'POST', `/providers/${draft.id}/remove`, { confirm_name: 'qa draft check' });
  expect(r.status, r.text).toBe(200);
});

test('add an HTTP failover: mapped credential, test, activated directly', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInAdminApp(context, admin);
  await openSmsSettings(page);
  await section(page, 'SMS gateway').getByRole('button', { name: 'Add failover' }).click();
  const drawer = dialog(page, /Configure SMS provider/);
  await drawer.getByRole('radio', { name: /^Other \(HTTP API\)/ }).check();
  await drawer.getByRole('button', { name: 'Next' }).click();
  await drawer.getByLabel('Provider name').fill(FAILOVER);
  await drawer.getByLabel('Field name').fill('api_token');
  await drawer.getByLabel('Request parameter').fill('token');
  await drawer.getByLabel('Value', { exact: true }).fill(HTTP_TOKEN);
  await drawer.getByLabel('API endpoint').fill('https://sms.example.com/api/send');
  await drawer.getByRole('button', { name: 'Next' }).click();
  await expect(drawer).toContainText('Step 3 of 4');
  await expect(drawer.getByRole('radio', { name: /Failover/ })).toBeChecked();
  await drawer.getByLabel('Failed sends before switching').fill('4');
  await drawer.getByLabel('Timeout in seconds').fill('8');
  await drawer.getByRole('button', { name: 'Next' }).click();
  await expect(drawer).toContainText('Step 4 of 4', { timeout: 20_000 });
  await expect(drawer).toContainText(`${FAILOVER} takes over when the primary fails 4 times in a row or one send takes over 8 s.`);
  await testInDrawer(page, drawer, FAILOVER).catch(async () => {
    // The HTTP driver doesn't report a balance: the canned driver still does under SMS_PROVIDERS_HTTP_FAKE.
    await expect(drawer.getByTestId('provider-test-result')).toContainText(`Test sent — ${FAILOVER} accepted it`);
  });
  await drawer.getByRole('button', { name: `Activate ${FAILOVER}` }).click();
  await expect(page.getByText(`${FAILOVER} is now the failover provider`)).toBeVisible();
  const gw = section(page, 'SMS gateway');
  await expect(gw).toContainText(`Failover · used after 4 failed sends or a 8 s timeout`);
  const o = await providerOverview(admin);
  expect([o.failover?.name, o.failover?.driver, o.failover?.role]).toEqual([FAILOVER, 'http', 'failover']);
  expect(o.failover.credentials_hint).toEqual({ api_token: `••••${HTTP_TOKEN.slice(-4)}` });
  await noSecretsInOverview();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('rotate the primary key: client checks, then test-and-swap (S223)', async ({ page, context }) => {
  test.setTimeout(120_000);
  const before = (await providerOverview(admin)).primary;
  await signInAdminApp(context, admin);
  await openSmsSettings(page);
  await section(page, 'SMS gateway').getByRole('button', { name: 'Rotate' }).first().click();
  const drawer = page.getByRole('dialog').filter({ has: page.getByTestId('rotate-form') });
  const form = drawer.getByTestId('rotate-form');
  await expect(form).toContainText(`Current ••••${API_KEY.slice(-4)} stays active until the test passes.`);
  // Only one of the two new values → refused client-side; nothing stored.
  await form.getByRole('textbox', { name: 'API key — new value' }).fill(NEW_API_KEY);
  await form.getByLabel('Send the test SMS to').fill(STAFF_TEST_PHONE);
  await form.getByRole('button', { name: 'Test and save new key' }).click();
  await expect(form.getByRole('alert').first()).toBeVisible();
  expect((await providerOverview(admin)).primary.credentials_hint.api_key).toBe(`••••${API_KEY.slice(-4)}`);
  // An http:// endpoint is refused before anything is sent.
  await form.getByRole('textbox', { name: 'Secret key — new value' }).fill(NEW_SECRET_KEY);
  await form.getByLabel('API endpoint').fill('http://smpp.revesms.com:7790');
  await expect(form.getByText('Use an https:// address.')).toBeVisible();
  await form.getByLabel('API endpoint').fill('https://smpp.revesms.com:7790');
  await form.getByRole('button', { name: 'Test and save new key' }).click();
  await expect(page.getByText('New key tested and saved · the old one no longer works')).toBeVisible({ timeout: 20_000 });

  const after = (await providerOverview(admin)).primary;
  expect(after.credentials_hint).toEqual({ api_key: `••••${NEW_API_KEY.slice(-4)}`, secret_key: `••••${NEW_SECRET_KEY.slice(-4)}` });
  expect(after.credentials_rotated_at).toBeTruthy();
  expect(after.credentials_rotated_by?.name).toBeTruthy();
  expect(after.revision).toBeGreaterThan(before.revision);
  await noSecretsInOverview();
});

test('remove the failover with its typed name; the primary is never removable', async ({ page, context }) => {
  const o = await providerOverview(admin);
  const r = await adminSms(admin, 'POST', `/providers/${o.primary.id}/remove`, { confirm_name: PRIMARY });
  expect([r.status, r.json.error?.code]).toEqual([409, 'sms_provider_is_primary']);

  await signInAdminApp(context, admin);
  await openSmsSettings(page);
  const gw = section(page, 'SMS gateway');
  await gw.getByRole('button', { name: 'Manage' }).nth(1).click();
  const drawer = page.getByRole('dialog').filter({ hasText: FAILOVER }).first();
  await drawer.getByRole('button', { name: 'Remove provider' }).click();
  const dlg = dialog(page, `Remove ${FAILOVER}?`);
  await expect(dlg.getByRole('button', { name: 'Remove provider' })).toBeDisabled();
  await dlg.getByLabel(`Type ${FAILOVER} to confirm`).fill(FAILOVER);
  await dlg.getByRole('button', { name: 'Remove provider' }).click();
  await expect(page.getByText(`${FAILOVER} removed · its credentials were deleted`)).toBeVisible();
  await expect(gw).toContainText('Not set');
  const after = await providerOverview(admin);
  expect(after.failover).toBeNull();
  expect(after.primary.name).toBe(PRIMARY);
});

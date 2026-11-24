import { expect, test } from '@playwright/test';
import { api, signInDashboard, unique } from '../support/api';
import type { CommerceShop } from '../support/commerce';
import {
  API_VERSION,
  addEndpointButton,
  delivery,
  devCard,
  devShop,
  endpoints,
  openDeveloper,
  parseSignature,
  revealSecret,
  rotateSecret,
  rowOf,
  sign,
  sinkUrl,
  storefrontOrder,
  verifies,
  waitDelivery,
  waitSink,
} from '../support/developer';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-4 §10 QA `phase8-4.webhooks` (§4, P84-8, S108, AC 1), fake driver `WEBHOOKS_OUT_FAKE=true`:
 * owner adds an endpoint in the Developer page (URL on the fake sink, `order.created`) → a storefront order →
 * `order.created` delivery `succeeded` → the request the fake sink recorded carries the §4.2 headers and payload, and its
 * `X-Storeplix-Signature` verifies with the revealed secret using the documented algorithm (tampered body / wrong
 * secret don't). Rotation: during the 24 h overlap a test event carries two `v1=` (new + previous secret).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
const tag = unique('wh-');
const URL_OK = sinkUrl(tag);
let endpoint: Json | undefined;
let order: { id: string; number: string };

test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await devShop('dk-hooks');
});
test.afterAll(() => shop?.cleanup());

test('UI: + Add endpoint (fake sink URL, order.created)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openDeveloper(page);
  const card = devCard(page, 'Webhooks');
  // Footer lists the catalogue.
  await expect(card).toContainText('Events you can send');
  await expect(card).toContainText('order.created');

  await addEndpointButton(page).click();
  const d = page.getByRole('dialog').last();
  await d.getByLabel(/URL/).fill(URL_OK);
  await d.getByRole('checkbox', { name: 'order.created', exact: true }).check();
  await d.getByLabel(/Description/).fill('E2E sink');
  const saved = page.waitForResponse((r) => r.url().endsWith(`/stores/${shop.s.storeId}/webhook-endpoints`) && r.request().method() === 'POST');
  await d.getByRole('button', { name: /^(Add endpoint|Save)/ }).click();
  expect((await saved).status()).toBe(201);
  await expect(d).toBeHidden();
  await expect(rowOf(card, /storeplix-e2e/)).toBeVisible();

  endpoint = (await endpoints(shop.s)).find((e) => e.url === URL_OK);
  expect(endpoint).toMatchObject({ events: ['order.created'], is_active: true, description: 'E2E sink', success_rate_7d: null });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('order placed → order.created delivered; the signature verifies (P84-8)', async () => {
  test.skip(!endpoint, 'needs the endpoint from the UI test');
  test.setTimeout(90_000);
  order = await storefrontOrder(shop);
  const d = await waitDelivery(shop.s, endpoint!.id, (x) => x.event_type === 'order.created' && x.status === 'succeeded');
  expect(d).toMatchObject({ endpoint_id: endpoint!.id, attempts: 1, response_status: 200, subject_label: order.number });

  const [hit] = await waitSink(shop.s, URL_OK, (e) => e.headers['x-storeplix-delivery'] === d.id);
  expect(hit.headers['x-storeplix-event']).toBe('order.created');
  expect(hit.headers['content-type']).toMatch(/^application\/json/);
  expect(hit.headers['user-agent']).toBe('Storeplix-Webhooks/1.0');

  const body = JSON.parse(hit.body) as Json;
  expect(body).toMatchObject({ id: d.event_id, type: 'order.created', api_version: API_VERSION, store_id: shop.s.storeId });
  expect(body.data.object.id).toBe(order.id);
  expect(Date.parse(body.created_at)).not.toBeNaN();

  // Receiver-side check, exactly as documented.
  const header = hit.headers['x-storeplix-signature'];
  expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  const { t, v1 } = parseSignature(header);
  expect(Math.abs(Date.now() / 1000 - Number(t)), 'timestamp within the 5 min replay window').toBeLessThan(300);
  const secret = await revealSecret(shop.s);
  expect(v1[0]).toBe(sign(secret, t, hit.body));
  expect(verifies(header, hit.body, secret)).toBe(true);
  expect(verifies(header, hit.body.replace(order.id, '01ARZ3NDEKTSV4RRFFQ69G5FAV'), secret), 'tampered body').toBe(false);
  expect(verifies(header, hit.body, `whsec_${'x'.repeat(32)}`), 'wrong secret').toBe(false);
  expect(verifies(header.replace(/^t=\d+/, `t=${Number(t) + 1}`), hit.body, secret), 'altered timestamp').toBe(false);

  // Detail: stored payload, request headers with the signature redacted (S100-style), response excerpt.
  const detail = await delivery(shop.s, d.id);
  expect(detail.payload.id).toBe(d.event_id);
  expect(JSON.stringify(detail.request_headers)).not.toContain(v1[0]);
  // The list never carries the payload.
  expect(d).not.toHaveProperty('payload');
});

test('rotation: the next delivery is signed with the new AND the previous secret (24 h overlap)', async () => {
  test.skip(!endpoint, 'needs the endpoint from the UI test');
  test.setTimeout(90_000);
  const before = await revealSecret(shop.s);
  const after = await rotateSecret(shop.s);
  expect(after).not.toBe(before);
  const meta = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/webhook-secret`);
  expect(meta.json.data.last_four).toBe(after.slice(-4));
  const overlap = Date.parse(meta.json.data.previous_expires_at) - Date.now();
  expect(overlap).toBeGreaterThan(23.9 * 3600_000);
  expect(overlap).toBeLessThanOrEqual(24 * 3600_000 + 60_000);

  const test202 = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/webhook-endpoints/${endpoint!.id}/test`, {});
  expect(test202.status, JSON.stringify(test202.json)).toBe(202);
  const pingId = test202.json.data.id as string;
  const [hit] = await waitSink(shop.s, URL_OK, (e) => e.headers['x-storeplix-delivery'] === pingId);
  expect(hit.headers['x-storeplix-event']).toBe('ping');
  const header = hit.headers['x-storeplix-signature'];
  expect(parseSignature(header).v1).toHaveLength(2);
  expect(verifies(header, hit.body, after), 'new secret').toBe(true);
  expect(verifies(header, hit.body, before), 'previous secret within 24 h').toBe(true);
});

test('UI: Recent deliveries shows the order.created delivery; endpoint row shows the last delivery', async ({ page, context }) => {
  test.skip(!order, 'needs the delivered order');
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openDeveloper(page);
  const recent = devCard(page, 'Recent deliveries');
  await expect(recent).toContainText(`order.created · ${order.number}`);
  await expect(recent).toContainText('200');
  await expect(rowOf(devCard(page, 'Webhooks'), /storeplix-e2e/)).toContainText(/Last delivery/);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

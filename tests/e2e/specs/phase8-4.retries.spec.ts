import { expect, test } from '@playwright/test';
import { api, signInDashboard, unique } from '../support/api';
import type { CommerceShop } from '../support/commerce';
import {
  createEndpoint,
  delivery,
  deliveries,
  devCard,
  devShop,
  forceDeliveryFailed,
  openDeveloper,
  rowMenu,
  rowOf,
  sinkUrl,
  storefrontOrder,
  waitDelivery,
  waitSink,
} from '../support/developer';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-4 §10 QA `phase8-4.retries` (§4.4, P84-9, AC 2), fake driver: an endpoint on `/fail-503` →
 * "Send test event" from the row menu and a real `order.created` → both `retrying` after attempt 1 (503, `http_error`,
 * next attempt ≈ +1 min) and the row shows "Failing since" → Resend (API) creates a NEW delivery with the same event id
 * and a new `X-Storeplix-Delivery` → after the delivery is forced to `failed` (test-only; the real schedule is ≈ 20.6 h)
 * "Resend failed (1)" re-queues it.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
const URL_FAIL = sinkUrl(unique('rt-'), '/fail-503');
let endpoint: Json;
let first: Json | undefined;
/** The manual resend of `first` (test 2): the newest delivery of that event, so the one "Resend failed" picks up. */
let resentId: string | undefined;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await devShop('dk-retry');
  endpoint = await createEndpoint(shop.s, URL_FAIL, ['order.created'], 'E2E failing');
});
test.afterAll(() => shop?.cleanup());

test('UI "Send test event" + an order → both deliveries retrying after a 503 (P84-9 first step)', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openDeveloper(page);
  const row = rowOf(devCard(page, 'Webhooks'), /fail-503/);
  await rowMenu(row).click();
  const sent = page.waitForResponse((r) => r.url().endsWith(`/webhook-endpoints/${endpoint.id}/test`) && r.request().method() === 'POST');
  await page.getByRole('menuitem', { name: /Send test event/ }).click();
  expect((await sent).status()).toBe(202);

  const ping = await waitDelivery(shop.s, endpoint.id, (d) => d.event_type === 'ping' && d.status === 'retrying');
  expect(ping).toMatchObject({ attempts: 1, response_status: 503, error_code: 'http_error' });

  const order = await storefrontOrder(shop);
  first = await waitDelivery(shop.s, endpoint.id, (d) => d.event_type === 'order.created' && d.status === 'retrying');
  expect(first).toMatchObject({ attempts: 1, response_status: 503, error_code: 'http_error', subject_label: order.number });
  const gap = Date.parse(first.next_attempt_at) - Date.parse(first.last_attempt_at);
  expect(gap, 'second attempt +1 min').toBeGreaterThanOrEqual(55_000);
  expect(gap).toBeLessThanOrEqual(75_000);
  // The fake answered 503 to the request it recorded.
  await waitSink(shop.s, URL_FAIL, (e) => e.headers['x-storeplix-delivery'] === first!.id);

  // Row: red "Failing since …", success pill "<n>% · failing".
  await page.reload();
  const again = rowOf(devCard(page, 'Webhooks'), /fail-503/);
  await expect(again).toContainText(/Failing since/);
  await expect(again).toContainText(/% · failing/);
  const ep = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/webhook-endpoints`)).json.data.find((e: Json) => e.id === endpoint.id);
  expect(ep.failing_since).toBeTruthy();
  expect(ep.last_status).toBe(503);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('Resend → a new delivery row, same event id, new X-Storeplix-Delivery', async () => {
  test.skip(!first, 'needs the retrying order.created delivery');
  test.setTimeout(90_000);
  const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/webhook-deliveries/${first!.id}/resend`, {});
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  const resent = r.json.data as Json;
  resentId = resent.id as string;
  expect(resent.id).not.toBe(first!.id);
  expect(resent).toMatchObject({ event_id: first!.event_id, event_type: 'order.created', endpoint_id: endpoint.id });

  const [hit] = await waitSink(shop.s, URL_FAIL, (e) => e.headers['x-storeplix-delivery'] === resent.id);
  expect((JSON.parse(hit.body) as Json).id, 'same event id in the body').toBe(first!.event_id);
  // Stored payload unchanged.
  expect((await delivery(shop.s, resent.id)).payload).toEqual((await delivery(shop.s, first!.id)).payload);
  // The original keeps its own lifecycle.
  expect((await delivery(shop.s, first!.id)).status).toBe('retrying');
});

test('UI: "Resend failed (n)" after the delivery is failed → re-queued', async ({ page, context }) => {
  test.skip(!first || !resentId, 'needs the resent order.created delivery');
  test.setTimeout(90_000);
  const c = watchConsole(page);
  // The API resends only the newest delivery per (endpoint, event) (WebhookDeliveries::failedQuery), so fail the resend
  // of test 2, not the superseded original (see QA P84-QA-1 for the UI count mismatch on superseded rows).
  forceDeliveryFailed(resentId!);
  const failed = (await deliveries(shop.s, `filter[status]=failed&filter[endpoint_id]=${endpoint.id}`)).map((d) => d.id);
  expect(failed).toEqual([resentId]);
  const known = new Set((await deliveries(shop.s, `filter[endpoint_id]=${endpoint.id}`)).map((d) => d.id as string));

  await signInDashboard(context, shop.s);
  await openDeveloper(page);
  const button = page.getByRole('button', { name: new RegExp(`^Resend failed \\(${failed.length}\\)`) });
  await expect(button).toBeVisible();
  const done = page.waitForResponse((r) => r.url().endsWith('/webhook-deliveries/resend-failed') && r.request().method() === 'POST');
  await button.click();
  const confirm = page.getByRole('dialog');
  if (await confirm.count()) await confirm.last().getByRole('button', { name: /^Resend/ }).click();
  const res = await done;
  expect(res.status()).toBeLessThan(300);
  expect(((await res.json()) as Json).data.count).toBe(failed.length);

  const fresh = await waitDelivery(shop.s, endpoint.id, (d) => d.event_id === first!.event_id && !known.has(d.id));
  expect(fresh.event_type).toBe('order.created');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

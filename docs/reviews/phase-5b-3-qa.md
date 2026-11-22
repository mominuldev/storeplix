# QA gate: Phase 5b-3 (couriers)

Date: 2026-11-22 · Branch `phase-5b-online-money` (uncommitted tree with API-C1/C2 and WEB-1/WEB-2 work in progress) ·
Contract PHASE-5B-CONTRACT §1.C, §4.3, §4.6, §4.7, §6, §11 `/track`, §12 S24/S25/S26/S32, §13, §15, §17. Reviewer: QA.

**Verdict: not yet, two open items.** Connecting, booking (single and bulk), signed webhooks, re-query on money
statuses, polling and the Shipments page work end to end on Postgres with RLS on, through the real dashboard, on the
fake courier. Two items block the gate: the storefront `/track` response has no courier status (H-1), and the
Shipments list overflows at 390 px (M-1).

## 1. What ran

| Check | Environment | Result |
|---|---|---|
| Migrations `000700`–`001100` on the dev DB as `storeplix_owner` | Docker Postgres 16 :55432, `storeplix` | ran; new tables have forced RLS, app role can read |
| Storefront `typecheck`, `lint`, `test`, `build` | — | pass; **377 tests / 23 files** (+3 courier tests) |
| Playwright `phase5b.couriers` (new, 7 tests) | API :8100 (`artisan serve`, RLS on, `PAYMENTS_FAKE`, `COURIERS_FAKE`), database-queue worker on all queues, dashboard :5183, storefront :3000 | **6 pass, 1 fail** (`/track`, H-1) |
| Playwright `phase5b.mobile` (+ Shipments 390 px) | same | **2 pass, 1 fail** (Shipments list, M-1; shipment detail passes) |
| All other `phase5b.*` (documents, edit-and-return, online-checkout, payment-link, payments-security, refund) | same | all pass |
| Regression trio `phase5.merchant-orders`, `phase5.security`, `phase5.storefront-buy` | same | all pass (incl. S14 on the storefront) |
| **Total** (`playwright test phase5b phase5.merchant-orders phase5.security phase5.storefront-buy`) | same | **38 passed, 2 failed** (4.8 min) |

What `phase5b.couriers` proves: bad keys → 422 `credentials_invalid`; Integrations → Connect Steadfast Courier
(Sandbox) → Booking rules (pickup preselected) → Status updates with the webhook URL and a 40-char Bearer token shown
once; neither secret appears in `GET /couriers` or `/test` (S26); order detail **Book with Steadfast** →
`ready_to_ship`, `FK…` consignment, COD = due (৳ 1,060), a second booking 409 `shipment_booked`; Steadfast-style webhook
with the Bearer → `in_transit` → order `shipped`; **S32**: `delivered` while the courier API still says `in_transit` →
no order or money change; once the courier agrees → `delivered`, COD charge `succeeded` ৳ 1,060, `paid`, events marked
`webhook`; Shipments KPIs (Delivered this week, COD held) match `meta.kpis`; **S25** wrong/no Bearer → 401 and nothing
stored, unknown route key / provider → 404; **S24** the same event twice → one event; A's consignment on tenant B's key
(B's own valid secret) → A untouched; poll: **Sync now** → `poll` event + order shipped, second call 429; **Refresh** →
`user` event; dev fake-advance end to end; bulk book 3 (Starter) → batch `completed` 3/0/0, all `ready_to_ship`,
unknown id → 422 on `order_ids.1`; Free plan → 402 `feature_not_in_plan`.

## 2. Findings (open)

| # | Sev | Finding | Repro / fix |
|---|---|---|---|
| H-1 | **High** (API-C2, contract gap) | **`/track` has no courier status.** §11 says the shipment block gains the courier status and time from courier events. `OrderPresenter::tracking` (`apps/api/app/Domain/Orders/OrderPresenter.php:368-372`) still returns only `carrier_name`, `tracking_code`, `tracking_url`; `StorefrontOrderTracking` in `packages/types` and `openapi.yaml` have no field for it either, so the storefront can't show "Out for delivery". | Book a parcel, `POST /dev/shipments/{id}/advance {status: out_for_delivery}`, `POST /storefront/orders/track` → `shipment` has no status. Proposed additive shape (what the storefront now parses): `shipment.status` (ShipmentStatus \| null), `status_at`, `checked_at` (= `last_synced_at`/`last_event_at`), `events: { status, at }[]` — status + time only, never `description`/`location`/`provider_status` (rider names and phones arrive there). Update presenter, types, openapi in one PR. Spec: `phase5b.couriers` "/track shows the courier status". |
| M-1 | **Medium** (WEB-2) | **Shipments list overflows at 390 px** (scrollWidth 545). The Needs attention / COD grid (`apps/merchant-dashboard/src/shipments/ShipmentsPage.tsx:154`) has no column template below `lg`, so its implicit `auto` track grows to the min-content of the problem row's `truncate` (nowrap) name + order + consignment line. The whole page scrolls sideways once a problem parcel with a long name exists. | `phase5b.mobile` "5b-3 Shipments…" (screenshot `test-results/phase5b.mobile-5b-3-*/shipments-list-390.png`). Fix: `grid-cols-1` (or `grid-cols-[minmax(0,1fr)]`) on that grid. Shipment detail at 390 px is fine. |
| L-1 | Low (API-C2) | The tracking presenter picks `->first()` non-cancelled shipment with no order (`OrderPresenter.php:356`), so after a `booking_failed` attempt and a rebook it can show the failed one. Contract §4.7: "`Order.shipment` returns the active shipment (the newest non-cancelled)". | Order by `created_at desc` and skip `booking_failed`, as `Order.shipment` does. |

Checked and fine: `RunBulkBooking` timeout (300 s) fits the `queue-bulk` worker's `--timeout=310` and
`REDIS_QUEUE_RETRY_AFTER=360`; batch booking runs on `bulk`, courier webhook events on `webhooks`, Sync now on
`default`; `couriers:sync` (15 min) and `couriers:reconcile-bookings` (2 min) are scheduled.

## 3. QA deliverables added

- **Storefront `/track`** (`apps/storefront`): Zod for the courier fields above (unknown keys stripped, bad
  status/time → null, events reduced to `{status, at}`); while the order is `shipped`, the courier step shows the
  latest courier status and its time (Picked up by the courier, On the way, Out for delivery, On hold at the courier,
  Delivery attempt failed, Returning to the shop) and, per Figma `1:11959`, "Courier status is checked with the courier
  directly and shown with the time we last checked: 11:42 am." Without the fields (today's API, manual shipments)
  the page renders exactly as before. `StorefrontTracking` is a local extension in `lib/tracking.ts` until H-1 lands
  in `packages/types`. Vitest: schema stripping/leak test, timeline label + time, event fallback, Dhaka clock.
- `docker-compose.yml`: `COURIERS_FAKE: ${COURIERS_FAKE:-true}` (dev-only) in the shared API env (api, queue workers,
  scheduler); header notes for courier queues and scheduled commands. `infrastructure/docker/.env.example`:
  `COURIERS_FAKE=true`. `e2e.yml`: `COURIERS_FAKE=true` in the stack `.env` and the Playwright env.
- Playwright `phase5b.couriers` (7 tests), `phase5b.mobile` + Shipments list/detail at 390 px (overflow report now
  skips SVG nodes and names the outermost culprits). Helpers in `support/commerce.ts`: `connectFakeCourier`,
  `ensurePickup`, `setPlan`, `confirmedOrder`, `bookShipment`, `shipmentDetail`, `shipmentList`, `steadfastWebhook`,
  `fakeAdvance`, `fakeParcelState`, `waitOrderStatus`. TESTING.md updated.

## 4. Notes for whoever runs this next

- The fake courier keeps parcels in the API's **tenant cache**. `Cache::flush()` in `browserHost`/`setPlan`/
  `mapStoreHost` wipes them; after that the fake reports the shipment's own status and a `delivered` webhook is
  (correctly) refused on re-query. The spec does all flushes in `beforeAll`.
- `fakeParcelState` changes what the fake courier answers without notifying Store Plix (needed for S32 and the poll
  path); the dev endpoint `POST /api/v1/dev/shipments/{id}/advance` always delivers the change like a signed webhook.
- The fake webhook parser takes normalised status words (`in_transit`, `delivered`), not Steadfast's raw words. The
  real Steadfast mapping (`pending` after `in_review` → `in_transit`, …) is covered by API-C1's driver tests only.

## 5. Not verified

- No real courier: Steadfast, Pathao and RedX certification against test accounts (§16) is still pending, so
  payload and header details marked **VERIFY** are unproven.
- Pathao and RedX flows in the browser (area selects, `X-PATHAO-Signature`, RedX poll-only) and onboarding 06 courier
  cards: not covered by this spec.
- Pest suites of API-C1/C2 and the dashboard Vitest suites were not run by QA here.
- The edited `e2e.yml` and compose env were not run in GitHub Actions or `docker compose`; the stack ran on the host.
- The storefront courier status display was verified by Vitest only: it can't be seen in the browser until H-1.

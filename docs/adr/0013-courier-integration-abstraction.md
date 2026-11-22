# ADR 0013 — Courier integration abstraction

Status: Accepted (Phase 5b, task 5.8) · Date: 2026-11-22 · Binding detail: PHASE-5B-CONTRACT §4, §6 (P5B-30–P5B-41)

## Context
BD merchants ship through Steadfast, Pathao and RedX (Q11, Q41: Steadfast first). Each courier has its own auth
(static keys, OAuth password grant, bearer JWT), address model (free text vs city/zone/area ids), status vocabulary,
webhook style and none publishes a complete, versioned public spec. Merchants use **their own** courier accounts
(Figma "Your own Steadfast account"); Storeplix never holds COD money. 5a records shipments manually
(`shipments.provider = manual`).

## Decision
- `CourierGateway` interface in `app/Integrations/Couriers`: `verifyCredentials(account)`, `quote(account, parcel)`
  (optional), `createConsignment(account, parcel): Consignment`, `bulkCreate(account, parcels[])` (optional),
  `status(account, shipment): CourierStatus`, `cancel(account, shipment)` (optional), `areas(account, level, parent)`
  (optional), `parseWebhook(account, request): CourierEvent[]`. Capabilities are declared per driver
  (`supports(): CourierCapability[]`), so the UI hides what a courier can't do. `CourierManager::driver($provider)`
  resolves `SteadfastCourier`, `PathaoCourier`, `RedxCourier`, plus `FakeCourier` for local dev and CI.
- **Per-store credentials** in `courier_accounts` (encrypted with the integration-credentials key, never returned,
  masked hint only). One account per provider per store; plan limit `courier_connections`.
- **One normalized shipment status set** (`booking`, `booked`, `picked_up`, `in_transit`, `out_for_delivery`,
  `on_hold`, `delivery_failed`, `delivered`, `partially_delivered`, `returning`, `returned`, `cancelled`,
  `booking_failed`, plus 5a `shipped` for manual). Each driver maps raw statuses to it; raw status is kept.
  Order effects are applied by one `ShipmentSync` service: `picked_up` → order `shipped` (stock leaves `on_hand`),
  `delivered` → `delivered` + COD collected, `returned` → order `returned` without automatic restock.
- **Booking never holds DB locks across HTTP.** The shipment row is written as `booking` in a short transaction, the
  courier is called outside it, and the result is written back. Our `invoice`/`merchant_order_id` = shipment id, so a
  retry can be reconciled with the courier instead of double-booking.
- **Webhooks are triggers, polling is the safety net.** Each account has a random `route_key`
  (`/webhooks/{provider}/{route_key}`) and a per-account secret (Steadfast bearer we generate; Pathao
  `X-PATHAO-Signature` secret; RedX: VERIFY). Events are stored in `webhook_events` (unique per tenant + provider +
  event id) and processed on the `webhooks` queue. Money-relevant states (delivered, partial, returned, cancelled) are
  re-queried from the courier API before they change the order. A 15-minute poll syncs non-final shipments.
- **Area mapping is per store and remembered.** Our district/thana codes are mapped to Pathao city/zone/area and RedX
  area ids when the merchant first books to that area; later bookings reuse the mapping.

## Consequences
+ A new courier = one driver + fixtures; orders, shipments UI and documents don't change.
+ A lost webhook or a courier outage can't lose a delivery; the poll catches up.
− Several courier details are not publicly documented (Steadfast webhook, RedX webhook and auth). They are marked
  "VERIFY against sandbox" in the contract and need merchant/test accounts before the driver can be certified.
− Polling costs API calls per merchant account; the interval and batch size are config.

## Alternatives
- An aggregator (e.g. a courier marketplace API): fewer drivers, but merchants lose their own rates and COD payout
  terms. Rejected (merchant-owned accounts, Figma).
- Trusting webhook payloads directly for COD amounts: forgeable or stale. Rejected.

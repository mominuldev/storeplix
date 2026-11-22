# ADR 0011 — Order lifecycle and stock commitment

Status: Accepted (Phase 5a) · Date: 2026-11-22 · Binding detail: PHASE-5-CONTRACT P5-5, P5-17, P5-18, §7

## Context
Phase 4 introduced `inventories.on_hand`, `committed` (always 0) and an append-only `inventory_movements` ledger
written only by `InventoryService`. Phase 5 adds orders. BD commerce is COD-first: an order is confirmed by phone,
packed, handed to a courier, delivered (cash collected) or returned undelivered. We need one stock model that never
oversells under concurrency and one order state machine that both the storefront and the dashboard use.

## Decision
- **Commit at placement, decrement at shipping.** Placing an order (storefront checkout or manual order) adds the
  quantities to `committed` for tracked variants, in one transaction, under `SELECT … FOR UPDATE` ordered by
  `variant_id`, and only when `on_hand − committed ≥ qty` (or `allow_backorder`). Cancelling an unshipped order
  releases `committed`. Shipping decrements `on_hand` and `committed` together and writes ledger reason
  `order_shipped`. A return restocks the quantities the merchant chooses (ledger `order_returned`).
- Committing writes **no** ledger row: the ledger records `on_hand` changes only; the order timeline (`order_events`)
  explains `committed`.
- **Carts never reserve stock.** For COD the order is the reservation, so no TTL exists. Unpaid online orders (5b)
  get a hold TTL and an expiry job that cancels them and releases `committed`.
- **One state machine** (`OrderStateMachine`): `pending → confirmed | cancelled`; `confirmed → ready_to_ship | shipped |
  cancelled`; `ready_to_ship → shipped | confirmed | cancelled`; `shipped → delivered | returned`. `pending_payment` is
  reserved for 5b. Every transition locks the order row, writes an append-only `order_events` row and bumps
  `revision`; anything else is 409 `invalid_state_transition`.
- **Fixed lock order** in every money/stock path: order row → inventories by `variant_id` → coupon → store counter.
- Orders and payments are never deleted. Order items snapshot product data, including unit cost; product/variant ids
  on items are soft references (no FK), so catalog purges never break history.

## Consequences
+ No oversell by construction; Postgres race tests prove it in CI.
+ The inventory screen's "Held for orders" is real; available = on_hand − committed everywhere.
+ The same model extends to online payments (hold TTL) and couriers (shipped = handed over) without schema changes.
− A merchant adjustment can set `on_hand` below `committed`; available then shows negative (out of stock) until
  orders ship or cancel. The UI explains it.
− Stock leaves `on_hand` late (at shipping), so stock counts include packed-but-unshipped goods; this matches how BD
  merchants count shelves.

## Alternatives
- Decrement `on_hand` at placement (Shopify-style): simpler, but cancellations then need ledger reversals and the
  "held for orders" figure disappears.
- Reserve on add-to-cart with a TTL: lets bots lock stock; rejected (ADR 0006).

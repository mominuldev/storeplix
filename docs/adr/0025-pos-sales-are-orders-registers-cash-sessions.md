# ADR 0025 — Till sales are orders; registers and cash sessions

Status: **Proposed** (Phase 8.8d; scope POS-first set by the PO (product owner), Q232, 2026-11-25; defaults Q233–Q256
pending) · Date: 2026-11-25 · Binding detail once accepted: PHASE-8-8D-CONTRACT §1 (P88D-1 – P88D-24), §3–§9, §13
(S195–S207)
Builds on: ADR 0001 (shared-database tenancy), 0006 (cart and checkout: server prices), 0007 (payments), 0011 (orders and
stock commitment), 0012 (Postgres RLS), 0014 (documents), 0017 (granular permissions), 0024 (per-location stock).

## Context
Figma page `22:1736` designs a full till: open register with a counted float (`25:581`), sale (`22:1737`), variant
picker (`22:1905`), payment with cash / bKash / card / split (`22:2073`), sale complete with an 80 mm receipt
(`22:2241`), held sales (`22:2409`), sales history with returns (`27:754`) and close register with a cash check and
Z-report (`25:829`). The Growth plan has sold "Multiple warehouses & POS" since Phase 7, and the `pos` feature key is
seeded but not enforced. 8.8c gave every store locations (warehouse / shop) and per-location stock rows.

What already exists and must keep working:
- Orders (`orders`, `order_items`, `OrderStateMachine`, `OrderPlacementService::manual`), with `channel = 'walk_in'`
  already in the channel list, a per-store number sequence, coupon redemption, customer linking by phone, and customer
  counters updated on delivery.
- Manual payments (`payments.provider = 'manual'`, methods `cash`, `bkash_personal`, …) and manual refunds; returns
  (`ReturnService`: create → receive with restock at the line's stored location → refund).
- Reports and Profit & loss read delivered orders by `delivered_at`; the Sales report counts `shipped` / `delivered`.
- `InventoryService` with `commit` / `ship` / `restock` per location, append-only ledger, lock order `(variant_id,
  location_id)`.
- The `receipt_80mm` document template (Q51) and store tax settings (Q52).

Constraints: no merchant hardware code (CLAUDE.md rule 7 spirit, no new dependencies), payments are never trusted from a
redirect (rule 8), money in integer minor units (rule 9), tenant isolation by code and RLS (rule 1).

## Decision
1. **A till sale is an order** with `created_via = 'pos'`, `channel = 'walk_in'`, `payment_method = 'pos'`, created
   directly in status `delivered` and `paid` (all lifecycle timestamps = placement time). A 1:1 `pos_sales` row keeps
   what only the till knows: register, session, location, cashier, cash tendered, change. The receipt number is the
   order number.
2. **Stock leaves the register's location in one step**: new `InventoryService::sell` locks the rows at that location
   in the standard order, requires `on_hand − committed ≥ quantity` (no backorder at the till), lowers `on_hand` and
   writes ledger reason `pos_sale` with reference `order`. Order lines store the location, so returns restock there
   (P88C-16 unchanged).
3. **Registers and sessions** are new store-scoped tables: `pos_registers` (name, location) and `pos_sessions` (one open
   per register via a partial unique index; opening float with denomination counts; at close: counted, expected,
   variance, left in drawer, banked, note). Payments made at the till carry `payments.pos_session_id`; the expected cash
   in drawer is always computed from those rows, never stored mid-session.
4. **Till payments are manual payment rows** (`provider = 'manual'`, `status = 'succeeded'`): cash, bKash (cashier
   attests, optional TrxID), card (new method; external terminal, optional approval code); split = several rows.
   Σ rows = order total; change is stored on `pos_sales`, never as a payment.
5. **Walk-in sentinels instead of nullable columns**: a walk-in sale stores `customer_phone = ''`, `shipping_address =
   {}`, `district_code = ''`, `shipping_zone_name = ''` (allowed only for `created_via = 'pos'` by CHECK). Every reader
   of those columns is listed, tested with a walk-in till sale and guarded by a static allow-list test.
6. **Till sales stay out of online-only flows**: no order notifications, no 8.6 recipes, no fake-order-guard record or
   check, no courier/label flows, not findable by storefront tracking; outbound webhooks and exports include them.
7. **Receipts are rendered by the SPA** from a `PosReceipt` JSON built with the store's `receipt_80mm` template config
   and printed through the browser; the 5b PDF remains for the order page. SMS receipts are a new counted transactional
   SMS event.
8. **Permission and plan**: new key `pos.sell` (Staff included), register writes `settings.manage`, returns also need
   `orders.refund`; `pos` (Growth) enforced on every POS write; after a downgrade history stays readable and an open
   register can be closed.

## Consequences
- Positive: Orders, Dashboard, Sales report, Profit & loss, customer history, analytics snapshots, exports and webhooks
  include till sales with no new reporting code; returns and refunds reuse tested services; one-step stock out keeps the
  ledger honest per location; cash differences are explainable from payment rows.
- Negative: the orders table carries rows that never ship, so every address/district reader must tolerate the walk-in
  sentinels (mitigated by the static test); the till depends on the network (no offline mode); held sales don't reserve
  stock, so a parked item can sell elsewhere before it is resumed; bKash and card at the till are trusted on the
  cashier's word (audited per session, like other manual payments).
- Follow-ups (Q256): offline mode, hardware integration (drawer kick, silent printing), per-person register/location
  access (Q119), manager PIN, void, one-step exchange, paid in/out.

## Alternatives considered
- **A separate `pos_sales` + `pos_sale_items` ledger beside orders**: rejected — every report, Profit & loss, customer
  stat, webhook and export would need a second source and a union, and returns/refunds would be built twice.
- **Make the order columns nullable for walk-ins**: rejected for now — `customer_phone`, `shipping_address` and
  `district_code` are non-null in `packages/types` and in ~20 readers; sentinels limit the blast radius to readers that
  can meet a till sale, and the CHECK keeps them out of online orders.
- **Commit at sale and ship later (two steps)**: rejected — the goods leave with the customer; a committed-but-unshipped
  till order would need a second action and could strand `committed`.
- **Server-rendered PDF receipts (Gotenberg) on the till path**: rejected — adds a render queue and seconds of latency
  per sale; the SPA already has every figure, and the PDF stays available from the order.
- **Reserve stock for held sales for 30 minutes (Figma copy)**: rejected as default — needs commit/release and an
  expiry job on shop stock; offered to the PO (product owner) in Q242.

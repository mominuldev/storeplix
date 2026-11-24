# ADR 0024 — Per-location stock with one online location

Status: Accepted (Phase 8.8c; scope set by the PO (product owner), defaults Q215–Q230 accepted, 2026-11-24) · Date:
2026-11-24 · Binding detail: PHASE-8-8C-CONTRACT §1 (P88C-1 – P88C-18), §3–§6, §12 (S179–S186 part A, S187–S194 part B)
Builds on: ADR 0001 (shared-database tenancy), 0011 (orders and stock commitment), 0012 (Postgres RLS), 0017 (granular
permissions), 0023 (purchasing, weighted-average landed cost).

## Context
Growing Bangladeshi shops keep stock in a godown (warehouse) plus one or two shops, or a hub in another city. Figma
Inventory (`11:589`: location selector `11:842`, Warehouses tab `11:808`), Transfers (`153:34425`) and Stock count
(`153:35246`) show stock per place, moves between places and counts per place. Until 8.8c Store Plix had one stock pool:
`inventories` was one row per variant (U(variant_id)), and about 25 readers relied on that 1:1 shape — storefront
availability, carts, checkout `commit`, order presenters, dashboard tiles, inventory list and summary, export, reorder
suggestions, the external API, the `stock.low` webhook and the 8.8b weighted-average cost. Constraints:
- Stock changes only through `InventoryService` (PHASE-4 P4-12: lock order, append-only ledger).
- Checkout commits stock under row locks and never oversells (ADR 0011); the courier and return flows ship and restock
  the rows committed at placement; all of this has race tests that must stay green.
- A single-location shop (almost every shop today) must see no change.
- The largest risk of the change is **double counting or mixing numbers**: a 1:1 `join('inventories')` over a table
  that becomes 1:n silently multiplies rows, and a reader that mixes "total" with "online" numbers shows stock the
  storefront cannot sell.

## Decision
1. **Stock rows per location (P88C-3).** New store-scoped `locations` table (name, type `warehouse`/`shop`, optional
   address and link to a shipping pickup address, `is_default`, `archived_at`; ≤ 10 active). `inventories` gains
   `location_id` with U(tenant_id, store_id, variant_id, location_id); `inventory_movements` gains `location_id`, so
   every ledger row says where stock moved. Rows are created lazily on the first positive delta at a location; a
   missing row reads as 0. The low-stock threshold stays per row. Migrations backfill one default "Main warehouse" per
   store and point every existing stock row, movement, tracked order line and purchase order at it (forward-only; Σ
   `on_hand` per variant unchanged, S182). Store creation makes the same default.
2. **One online location (P88C-4, Q217).** The default location **is** the online location ("Online orders ship from
   here"). Storefront availability, carts, checkout `commit`, dashboard/manual orders and external-API orders all use
   it. Every tracked order line stores `location_id` at commit; release, ship and restock (returns, Q229) always use
   the line's stored location. The merchant can switch the online location at any time (`make-default`, audited);
   storefront availability switches immediately, and open orders keep committing/shipping from where they committed,
   so a switch never moves or strands committed stock (S184). The lock order of P4-12 becomes `(variant_id,
   location_id)` ascending.
3. **Every reader is classified (P88C-6).**
   - *Online* (the online location's row): storefront PDP availability and in-stock filter, carts, `LineLoader`, order
     and return presenters, the product `inventory` block (which also reports `total_on_hand` and
     `other_locations_on_hand`), the external API top-level `on_hand` / `available`.
   - *Total* (Σ over non-archived locations): dashboard units on hand and low count, inventory "All locations" list and
     summary tiles, product list stock filter, export, reorder suggestions, weighted-average cost.
   - *Location* (one row): inventory and movements with `filter[location_id]`, adjustments with `location_id`, and the
     part-B transfers and counts.
   `ProductVariant::inventory()` becomes a `HasOne` scoped to the online location, so online readers keep their code;
   Σ readers use `inventories()` / `Inventory::scopeTotals()`. A parity test seeds two locations and asserts every
   reader against its class, and a static test fails the build on a 1:1 `join('inventories'` outside an allow-list
   (S185).
4. **Receive at; cost stays one per variant (P88C-8, amends ADR 0023).** Purchase orders and receipts carry a location
   (default unless chosen; locked after the first receipt). The weighted-average landed cost uses the variant's
   **total** on hand across locations, read with all of the variant's rows locked in lock order. No per-location cost.
5. **Plan and permissions (P88C-13/14).** `multi_warehouse` (Growth) gates a 2nd+ active location (and, in part B,
   transfers); after a downgrade extra locations stay readable, adjustable and archivable. No new permission key:
   location writes need `settings.manage`, stock writes `inventory.adjust`, value fields `costs.view`.
6. **Low stock per row (P88C-15).** `stock.low` and the 8.6 Low stock alert fire per stock row and name the location.

## Consequences
- Positive: checkout, courier booking, returns and their race tests keep a single-row model; one-location shops see no
  change; the ledger explains stock per place; ops can switch where online orders ship from without touching orders in
  flight; part B (transfers, counts) needs no further schema change to `inventories`.
- Negative: with several locations the storefront shows only the online location's stock, so stock elsewhere is not
  sellable online until it is transferred (part B) or the online location is switched; dashboard totals and storefront
  availability legitimately differ and the UI must label which is which; every new stock reader must pick a class (the
  static test enforces it); an archived location keeps its ledger rows forever (no hard delete).
- Follow-ups (Q230): selling online from several locations / split fulfilment, shop pickup, per-location reorder
  suggestions and cost, per-person warehouse access (Q119), approval of transfers, transfer costs and carriers.

## Alternatives considered
- **Summed availability online** (storefront and checkout sell Σ over all locations): rejected — an order would have
  to commit across several rows without knowing where it ships from, so the courier pickup address, packing and
  returns would need a location decision per line; it breaks the tested single-row commit/ship/restock and invites
  overselling a place that is physically empty.
- **Split fulfilment** (an order's lines committed and shipped from different locations): rejected for 8.8c — needs a
  per-shipment location, several courier bookings per order and a routing rule; recorded as a later module (Q217, Q230).
- **Keep one row per variant with a JSON per-location breakdown**: rejected — no row locks or ledger per place, no FK
  integrity, and every write would rewrite the whole JSON under contention.
- **Separate `inventory_levels` table beside a total row**: rejected — two sources of truth for on hand that must be
  kept in sync on every write.
- **Online location separate from the default** (two flags): rejected for now — one flag is simpler to explain ("Online
  orders ship from here"); the two can be split later without a data change.

## Part B addendum — transfers and counts (Phase 8.8c part B, 2026-11-25)
Binding detail: PHASE-8-8C-CONTRACT P88C-9 – P88C-12, §3.2–§3.3, §7–§8, §12 S187–S194. No change to decisions 1–6; part
B adds two store-scoped document pairs (`stock_transfers` + `stock_transfer_items`, `stock_counts` +
`stock_count_items`) and writes the ledger reasons part A reserved. Every stock change still goes through
`InventoryService`.

7. **Transfers take stock out on send and put it in on receive (P88C-9/10, Q218).** `draft` → **Send** → `in_transit`
   → **Receive** → `received`. Send locks the transfer row, then the source rows in `(variant_id, location_id)` order,
   checks each line against the source's **available** (`on_hand − committed`, so stock already promised to orders is
   never moved; 422 `insufficient_stock`) and writes `transfer_out` at the source. While in transit the units are in
   neither location (no "in transit" stock row; the transfer's `units_sent` is the record). Receive takes a received
   quantity per line (0 ≤ received ≤ sent) and writes `transfer_in` at the destination; the rest is **short**:
   recorded on the transfer and its line, written off, never returned, with no ledger row of its own (the units
   already left on send). One receive per transfer. Cancel from `draft` changes nothing; cancel from `in_transit`
   returns exactly the sent units to the **source** (`transfer_in`, note "Cancelled"). No approval step; permission
   `inventory.adjust` is the control. Send and receive require an `Idempotency-Key`.
8. **Counts apply the difference measured at count time (P88C-11/12, Q221).** A count covers one location (optionally
   one category); lines are created for every tracked variant in scope with `counted = null`. When a line is counted
   (scan +1 or a typed quantity) the server stores `expected` = that location's `on_hand` at that moment. **Finish &
   adjust** applies `delta = counted − expected` per counted line — not "set on hand to counted" — in one
   `InventoryService` call (reason `count`), so a sale or receipt that happens after a line was counted is kept and
   checkout never has to be locked during a count (Q222). Uncounted lines keep their stock, or with "Set uncounted items
   to 0" get `−on_hand` read under the finish lock. One `in_progress` count per location (partial unique index). Money
   values (delta × variant cost) are shown only with `costs.view`; counts need no plan.

### Consequences (part B)
- Positive: stock moved between places is explainable from the ledger on both sides; counts can run during trading;
  retries are safe (idempotent send / receive / finish).
- Negative: in-transit units are not counted in any location's on hand (dashboard "Units on hand" dips while a
  transfer travels; the Transfers summary shows `in_transit_units`); a wrong count can only be fixed with a manual
  adjustment or a new count (no "undo finish"); a line counted early and then physically disturbed before finish keeps
  its early measurement until it is counted again.

### Alternatives considered (part B)
- **Move stock on receive only** (source keeps it until arrival): rejected — the source could sell units already on a
  truck. **"In transit" stock row/location**: rejected — a pseudo-location would leak into every reader class.
- **Return short units to the source**: rejected — short means lost or damaged on the way; the merchant can send a
  reverse transfer if units turn up.
- **Count sets on hand to counted at finish**: rejected — it silently undoes sales and receipts made between counting a
  line and finishing; locking online sales during a count (Figma) would touch checkout (Q222).


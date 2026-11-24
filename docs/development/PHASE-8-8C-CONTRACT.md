# Phase 8.8c contract: Locations, stock transfers and stock count (binding for ARCH, API, WEB, QA)

Status: **Accepted, 2026-11-24 — PO (product owner) set the scope (multi-location / warehouses, stock transfers, stock
count; POS and Inbox later) and the branch base (`main` @ 84fe1ac, after PR #16 / 8.8b merged), and accepted the proposed defaults
for Q215–Q230**. "PO" in this file means
**purchase order**; the product owner is written "PO (product owner)".
Roadmap task **8.8c+** is split again: this file is **8.8c "locations, transfers, stock count"**. POS and Inbox become
**8.8d+** and are not in this contract.
AC: **"A merchant keeps stock in more than one place, sees how much is where, moves stock between places with a
transfer that takes it out on send and puts it in on receive, and corrects stock with a count; online orders keep
selling from one chosen location; a single-location shop sees no change"** (§16).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-8B contracts and
docs/api/API-CONVENTIONS.md still applies. PHASE-4 P4-12 (stock changes only through `InventoryService`, lock order,
append-only ledger) applies in full, with the lock order widened in §3.3. **Amends** PHASE-4 §2–§3 (`inventories` is one
row per variant **per location**; movements carry a location), PHASE-5 order placement (order lines record the location
their stock came from), PHASE-7 §2.1 (`multi_warehouse` becomes enforced), PHASE-8-4 (`stock.low` payload gains
`location`), PHASE-8-6 (Low stock alert recipe fires per location), PHASE-8-8B §5.3–§5.4 ("Receive at"; weighted average
uses stock across all locations). Machine-readable spec: `docs/api/openapi.yaml` **v1.18.0** (part A) and **v1.19.0**
(part B). ADR **0024** (new: per-location stock with one online location). Product defaults: OPEN-QUESTIONS
**Q215–Q230**.

### Scope

**Two parts, two PRs, two QA gates** (Q215). Each part is small enough to review and each leaves `main` releasable.

| Part | Branch | Ships |
|---|---|---|
| **A — Locations** | `feat/phase-8-8c-locations` (from `main`) | `locations`, per-location stock rows and ledger, default "Main" location backfilled, online location, order lines remember their location, Inventory location selector + Warehouses tab, product editor per-location stock, "Receive at" on POs, plan gate `multi_warehouse` (§2–§6, §10.1–§10.3) |
| **B — Transfers + count** | `feat/phase-8-8c-transfers-counts` (from `main` after A merges) | Stock transfers `TR-{n}` (draft → in transit → received / cancelled, short units), stock counts (start, count by SKU or quantity, review, finish & adjust) (§7–§8, §10.4–§10.5) |

| Area | Owner | Part |
|---|---|---|
| **Locations** | API/WEB | A: CRUD, default + online location, archive, optional link to a pickup address (§4) |
| **Per-location stock** | API | A: schema change, backfill, `InventoryService` gains a location, every reader classified (§3, §5) |
| **Orders** | API | A: lines commit from the online location and remember it; cancel/ship/return use the same row (§5.2) |
| **Purchasing** | API/WEB | A: "Receive at" on POs; cost average over all locations (§5.4) |
| **Transfers** | API/WEB | B: §7 |
| **Stock count** | API/WEB | B: §8 |
| **Plan** | API | A: `multi_warehouse` enforced (§2.2) |
| **Docs + types** | ARCH | A and B: openapi, `packages/types`, `packages/api-client`, ADR 0024, DATABASE-DESIGN §5.10, SECURITY T40, OPEN-QUESTIONS, FIGMA-INDEX, RUNBOOK, roadmap (§11) |
| **QA** | QA | A: `phase8-8c-a.*`, Pest group `locations`; B: `phase8-8c-b.*`, Pest group `stocktransfer` (§13) |

**Out of scope** (hide, never fake): POS and POS receipt movement rows (8.8d+); Inbox; manager **approval** of transfers
("Waiting for approval" tile/chip/pill, "needs approval", "Reject", "Approve & send" → a plain **Send**, Q218); warehouse
access per staff member or role (Q119 stays deferred, Q226); selling online from more than one location / splitting an
order across locations (Q217); "Lock online sales while counting" (Q222); "Record shortage as expense" / "Stock loss"
(Q223); "Pause" on a count (Q224); "Scanner ready" tag (typed or USB-scanner SKU entry is built, Q225); transfer shipping
cost, carrier and tracking; blind counts; several people counting one count with per-person attribution; per-location
cost; per-location reorder suggestions; per-location storefront pickup ("collect in shop").

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- "Location" = one `locations` row (a warehouse or a shop). "Default location" = the one existing rows were backfilled
  to and the fallback when a call names no location. "Online location" = the location storefront and dashboard orders
  sell from (§1 P88C-4). In part A the default **is** the online location; they are one flag (`is_default`, label
  "Online orders ship from here").
- "Stock row" = one `inventories` row (variant × location). "Available" at a location = `on_hand − committed` there.
- "Total on hand" of a variant = Σ `on_hand` over its stock rows at non-archived locations.
- "Transfer" = one `stock_transfers` row; "line" = one `stock_transfer_items` row. "Count" = one `stock_counts` row;
  "count line" = one `stock_count_items` row.
- Money: integer minor units, store currency. Dates: store timezone.
- `[S]` = store-scoped table (`BelongsToStore`, composite FK `(tenant_id, store_id) → stores`).
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**, storefront **:3010**.

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§14). Before every Edit of a shared-read file, re-read it.
- New dependencies: **none**. Never `migrate:fresh` the local dev DB; use Pest or a scratch DB.
- Stock changes only through `InventoryService` (P4-12); never write `inventories` / `inventory_movements` directly.
- **A single-location store must behave exactly as before part A** (every existing Pest test and Playwright spec stays
  green without edits except added `location` fields in shapes).

---

## 0. Summary and goals
Growing Bangladeshi shops keep stock in a godown (warehouse) and one or two shops, or a hub in another city. Today Store
Plix has one stock pool, so the merchant can't tell what is where, and moving goods to a shop is invisible. 8.8c adds
locations, splits stock per location, lets the merchant move stock with a transfer, and lets them correct a location's
stock with a count. Online orders keep selling from one location the merchant chooses, so checkout, courier booking and
returns keep their current, tested behaviour.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P88C-1 | **Scope** (PO (product owner) 2026-11-24): locations + transfers + stock count; POS, Inbox later. Delivered as **part A** (locations, no visible change for one-location shops) and **part B** (transfers, counts) | Per-location stock touches ~25 stock readers; two reviewable PRs (Q215) |
| P88C-2 | **Locations**: per store, name (≤ 60), type `warehouse` / `shop`, optional address line, optional link to a pickup address (`pickup_location_id`, display + prefill only), `is_default`, `archived_at`. At most **10** non-archived locations. Every store always has exactly one default; a "Main warehouse" default is created for every existing and new store | Figma "Main warehouse · Mirpur", "Dhanmondi shop", "Chattogram hub"; pickup names match (Q216) |
| P88C-3 | **Stock rows per location**: `inventories` gains `location_id`; unique `(variant_id, location_id)`. A row is created lazily the first time stock goes to a location; a missing row reads as 0. `low_stock_threshold` stays per row (new rows copy the default row's threshold) | Smallest schema change; keeps the ledger per row (Q219) |
| P88C-4 | **One online location** (Q217): storefront availability, carts, checkout `commit`, dashboard/manual orders, external-API orders all use the **online location** (= default). Order lines store `location_id`; release/ship/restock always use the line's stored location, so changing the online location later never moves committed stock | Checkout, courier booking and returns stay single-row and keep their race tests; split fulfilment is a later module |
| P88C-5 | **Changing the online location** (`POST …/locations/{location}/make-default`): allowed any time; storefront availability switches immediately; open orders keep their lines' location. Audited | Merchant moves online selling to a new godown |
| P88C-6 | **Readers classified** (§5.3): *online* readers (storefront, cart, checkout, order/return presenters, product `inventory` block) read the online location's row; *total* readers (dashboard units on hand, stock value, inventory "All locations", export, reorder suggestions, weighted-average cost) read Σ over locations; *location* readers (inventory with `filter[location_id]`, transfers, counts) read one row. No reader may `join('inventories')` 1:1 any more — a parity test fails the build if one does (§13) | The double-counting risk is the main risk of this phase (ADR 0024) |
| P88C-7 | **Manual adjust, import, external adjust** take an optional `location_id` (default = default location). Product editor stock edits and CSV `stock` column write the **default** location; product editor shows "n at other locations" | Backward compatible for API keys and CSVs (Q220) |
| P88C-8 | **Receive at** (amends PHASE-8-8B §5.3): `purchase_orders.location_id` (default location; editable while the PO has no receipts); each receipt records its location and stocks it there. Weighted-average cost uses **total on hand** before the receipt (all location rows of the variant locked, §3.3). Cost stays one per variant | One cost per product; Figma "Receive at", "Adding 38 units to Main warehouse" |
| P88C-9 | **Transfers** (part B, Q218): `draft` → `in_transit` (**Send**: stock leaves the source, reason `transfer_out`) → `received` (**Receive**: per line received quantity ≤ sent; arrives at the destination, reason `transfer_in`; the rest is recorded as **short** and written off, never returned) ; `cancelled` from `draft` (no stock change) or `in_transit` (sent units go back to the source, reason `transfer_in`, note "Cancelled"). No approval. One receive per transfer. Number `TR-{n}` per store, 3-digit padded (`TR-021`), via `StoreCounter` | Figma `153:34425` "Stock leaves on send and arrives when received", "Received · 2 short"; approval hidden like P88B-7 |
| P88C-10 | **Send checks**: from ≠ to; both active; tracked variants only; each line ≤ the source's **available** (`on_hand − committed`) under lock, else 422 `insufficient_stock` with the lines. The panel warns when a line takes the source below its low-stock threshold, and says "online orders may sell out" when the source is the online location | Never strand stock already promised to an order |
| P88C-11 | **Stock count** (part B, Q221): start for one location with an optional category; count lines are created for every tracked variant in scope (≤ 5,000) with `counted = null`. Counting: type/scan a SKU or barcode → +1; or set a quantity on a line. When a line is first counted (and on every change) the server stores `expected` = that location's `on_hand` at that moment. **Finish & adjust** applies `delta = counted − expected` per counted line (not "set to counted"), so sales and receipts that happened after a line was counted are kept. Uncounted lines: keep stock (default) or set to 0 (`delta = −on_hand` at finish). One adjust call, reason `count`, reference the count. Statuses `in_progress` → `completed` / `cancelled`; one open count per location | Figma `153:35246`; delta-at-count avoids undoing sales made mid-count without locking checkout |
| P88C-12 | **Count value** = delta × variant `cost_amount`; shown only with `costs.view` ("If you finish now" Short / Extra / Not counted yet / Net stock loss) | P4-5 |
| P88C-13 | **Plan** (Q227): `multi_warehouse` (Growth, already seeded) is now enforced: creating a **second** non-archived location and creating/sending transfers need it (402 `feature_not_in_plan`). Stock counts need no plan (they are structured adjustments). After a downgrade, extra locations stay readable, adjustable and countable; new locations and new transfers are blocked (an in-transit transfer can still be received or cancelled); a location can be archived once empty (Q228) | Feature already sold on the Growth card "Multiple warehouses & POS" |
| P88C-14 | **Permissions** (Q226): no new key. Locations CRUD and make-default: `settings.manage`. Transfers and counts: `inventory.adjust`. Count values and stock value: `costs.view`. Reads: `perm:base` as today | Avoids a 28th key; staff already adjust stock |
| P88C-15 | **Low stock** (Q219): `stock.low` webhook and the 8.6 Low stock alert recipe fire per stock row (subject = row, dedupe `inventory:{id}:{day}` unchanged); payload gains `location {id, name}`; message text gains "at {location}" when the store has > 1 location | Per-row threshold already; the merchant restocks a place, not a total |
| P88C-16 | **Returns** (Q229): restock goes to the order line's stored location (where it shipped from). No location picker in the return flow | Keeps return flow unchanged |
| P88C-17 | **Archive** a location: only when every stock row there has `on_hand = 0` and `committed = 0`, no open transfer touches it, no open count, no open PO receives there, and it is not the default (409 `location_in_use` with reasons). No hard delete once it has ledger rows | Ledger rows keep their location forever |
| P88C-18 | **Audit**: `location.created/updated/archived/unarchived/made_default`, `stock_transfer.created/updated/sent/received/cancelled/deleted` (lines + quantities), `stock_count.started/finished/cancelled` (deltas, uncounted rule, value when `costs.view`) | Stock moves must be explainable |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q215–Q230; **answered 2026-11-24: proposed defaults accepted**)

| Q | Question | Proposed default |
|---|---|---|
| Q215 | Delivery split | Two PRs under this contract: A locations + per-location stock (no visible change for one-location shops), B transfers + counts |
| Q216 | Location fields; relation to shipping pickup addresses | Name, type warehouse/shop, address line, optional link to a pickup address (prefills address; shipping unchanged); max 10; no separate Settings page — managed in Inventory → **Warehouses** tab |
| Q217 | Which location sells online | One online location (= default, switchable); no multi-location selling or split orders in 8.8c |
| Q218 | Transfer approval (Figma "Manager approves before sending") | None: Draft → Send → Receive; permission is the control (as P88B-7) |
| Q219 | Low-stock threshold and alerts | Per location row; webhook/automation fire per location with the location named |
| Q220 | Adjust / CSV import / external API without a location | Default location; optional `location_id` / CSV column `location` (name) accepted |
| Q221 | Count method | Expected stored when a line is counted; finish applies the difference; uncounted keep stock unless "Set uncounted items to 0" |
| Q222 | "Lock online sales while counting" | Hidden (would touch checkout); the P88C-11 rule makes it unnecessary |
| Q223 | "Record shortage as expense" (no "Stock loss" category in 8.7) | Hidden; count losses show in the count summary and the ledger only |
| Q224 | "Pause" on a count | Hidden: a count stays in progress until finished or cancelled |
| Q225 | Barcode scanning | SKU/barcode text box (works with a USB scanner as keyboard); camera scanning and the "Scanner ready" tag hidden |
| Q226 | Permissions; warehouse access per role/person (Q119) | No new key (`settings.manage` for locations, `inventory.adjust` for transfers/counts); Q119 stays deferred to POS (8.8d) |
| Q227 | Plan | `multi_warehouse` (Growth) for a 2nd location and for transfers; counts on every plan |
| Q228 | Downgrade with several locations | Locations and stock stay visible, adjustable and countable; new transfers and new locations blocked; archive when empty |
| Q229 | Return restock location | The order line's stored location |
| Q230 | Later features (record only) | Approval, multi-location online selling / split fulfilment, shop pickup, per-location reorder, per-person warehouse access, transfer costs and carriers, blind / multi-person counts, count schedules, stock-loss expense, camera scanning |

## 2. Permission and plan

### 2.1 Permission
No new key (P88C-14). Route map rows added for every §9 route; O/A/S parity fixture updated.

### 2.2 Plan (amends PHASE-7 §2.1: `multi_warehouse` row becomes enforced)
| Key | Free / Starter / Growth | Checked at | Without it |
|---|---|---|---|
| `multi_warehouse` | – / – / ✓ | create or unarchive a location when the store already has ≥ 1 non-archived location; create/update/send a transfer | 402 `feature_not_in_plan`; reads, adjusts, counts, receive of an in-transit transfer, cancel, archive allowed |

## 3. Data (owner API; forward-only; RLS in each create migration; `database/sql/rls-emergency-off.sql`)

### 3.1 Part A (migrations prefix `2026_12_07_`; `RlsTables::TENANT` docblock "83 after Phase 8.8c-A")
- **locations** (`000100`, `[S]`): id · tenant_id · store_id · name varchar(60) · type varchar(10) CHECK (warehouse, shop)
  · address varchar(200) null · pickup_location_id null FK3(pickup_locations) **SET NULL** · is_default bool · position
  smallint · archived_at null · created_by · timestamps. UNIQUE `(tenant_id, store_id, id)`; UNIQUE `(store_id,
  lower(name))` among non-archived; partial UNIQUE `(store_id) WHERE is_default`; CHECK NOT (is_default AND archived_at
  IS NOT NULL).
- **Backfill** (`000200`): one location per existing store, name "Main warehouse", type warehouse, `is_default = true`,
  address prefilled from the store's default pickup address when one exists (and linked). Store creation (`StoreService`
  / onboarding) creates the same row.
- **inventories** (`000300`): add `location_id char(26)` → backfill to the store's default (batched per store) → NOT
  NULL + FK3(locations) **RESTRICT**; drop UNIQUE(variant_id); add UNIQUE `(tenant_id, store_id, variant_id,
  location_id)`, UNIQUE `(tenant_id, store_id, id)`, index `(tenant_id, store_id, location_id, on_hand)`; add CHECK
  `on_hand >= 0` on Postgres (app already guarantees it; verified by a pre-check that aborts the migration with a clear
  message if any row is negative).
- **inventory_movements** (`000400`): add `location_id` (backfilled from the row's inventory, batched) NOT NULL FK3;
  index `(tenant_id, store_id, location_id, created_at)`; reason CHECK widened with `transfer_out`, `transfer_in`,
  `count`; `reference_type` values gain `stock_transfer`, `stock_count` (no CHECK, as today).
- **order_items** (`000500`): add `location_id` null FK3 RESTRICT; backfilled to the default location for tracked lines
  of orders whose stock is still committed or shipped (all tracked lines, batched); new tracked lines always set it.
- **purchase_orders** / **purchase_receipts** (`000600`): add `location_id` NOT NULL FK3 (backfilled to default).
- `ProductVariant::inventory()` becomes `HasOne` **scoped to the online location** (keeps every online reader's code);
  new `inventories()` `HasMany`; `Inventory::scopeTotals()` helper for Σ readers.

### 3.2 Part B (migrations prefix `2026_12_08_`; docblock "87 after Phase 8.8c")
- **stock_transfers** (`000100`, `[S]`): id · sequence int · number varchar(12) UNIQUE per store · from_location_id FK3 ·
  to_location_id FK3 · CHECK from ≠ to · status varchar(12) CHECK (draft, in_transit, received, cancelled) · note
  varchar(500) null · sent_at · sent_by · received_at · received_by · cancelled_at · cancelled_by · items_count int ·
  units_sent int · units_received int · units_short int · revision int · created_by · timestamps. Index `(tenant_id,
  store_id, status, created_at desc)`.
- **stock_transfer_items** (`000100`, `[S]`): id · stock_transfer_id · variant_id FK3 · quantity int 1–100000 ·
  quantity_received int null · position smallint. UNIQUE `(stock_transfer_id, variant_id)`; CHECK received ≤ quantity.
  ≤ 200 lines.
- **stock_counts** (`000200`, `[S]`): id · location_id FK3 · name varchar(80) · category_id null FK3 SET NULL · status
  varchar(12) CHECK (in_progress, completed, cancelled) · zero_uncounted bool null (set at finish) · lines_count ·
  counted_count · started_by · started_at · finished_by · finished_at · cancelled_at · revision · timestamps. Partial
  UNIQUE `(store_id, location_id) WHERE status = 'in_progress'`.
- **stock_count_items** (`000200`, `[S]`): id · stock_count_id · variant_id FK3 · counted int null (0–1,000,000) ·
  expected int null · counted_at null · counted_by null · applied_delta int null. UNIQUE `(stock_count_id, variant_id)`.
- `StoreCounter::TRANSFERS = 'stock_transfers'` (START 1).

### 3.3 Locking (amends P4-12)
Lock order is `(variant_id, location_id)` ascending for every multi-row operation. Weighted-average receive locks **all**
stock rows of the variant (in that order) before reading total on hand. A transfer send/receive/cancel locks the transfer
row first (FOR UPDATE), then stock rows. A count finish locks the count row, then stock rows of that location.

## 4. Locations (owner API, part A)
CRUD + `archive` / `unarchive` / `make-default`; list sorted default first, then position, then name; each item carries
`units_on_hand` (Σ on_hand there), `stock_value_amount` (`costs.view` only, Σ on_hand × variant cost), `variants_count`
(rows with on_hand > 0), `is_default`, `pickup_location` summary. Name unique among active (422 `location_name_taken`);
archive rules P88C-17; making an archived location default → 422 `location_archived` (as every other
reference to an archived location: adjust, PO, filter; corrected 2026-11-24 from "409" to match §9 and the types).

## 5. Per-location stock (owner API, part A)

### 5.1 InventoryService
Every method gains a location: `adjust($storeId, $locationId, …)`, `createFor/createMany(…, $locationId)` (default when
null), `commit($storeId, $lines)` (each line carries `location_id`, filled by the caller with the online location),
`release/ship/restock` (location from the order line). New: `transfer…` helpers used by §7 (out/in in one call each) and
`applyCount` for §8. Ledger rows always carry the location. A missing row is created on the first positive delta.

### 5.2 Orders
Placement, dashboard orders, order edits and the external API set `order_items.location_id = online location` on
tracked lines inside the order transaction (read once under the same lock as commit). Cancel/release, ship (manual,
courier status, external), and returns restock use the stored location; lines with null `location_id` (untracked) are
skipped as today.

### 5.3 Readers (P88C-6; every item has a test)
- **Online** (online location row): storefront PDP availability and in-stock filter, carts, `LineLoader`, order and
  return presenters, `ProductPresenter` variant `inventory` block (gains `location_id`, `total_on_hand`,
  `other_locations_on_hand`).
- **Total** (Σ over non-archived locations; `committed` Σ): dashboard units on hand / low count (low = any row at or
  below its threshold), inventory summary tiles, product list stock filter (`in` = total on hand > 0), export, reorder
  suggestions (`available` = Σ available), weighted-average cost.
- **Location**: inventory list with `filter[location_id]`; movements `filter[location_id]`; transfers; counts.

### 5.4 Inventory API changes
`GET …/inventory`: new `filter[location_id]` (omitted = **All locations**: one row per variant with totals and
`locations: [{id, name, on_hand, committed, available}]`; with a location: that row only, ON HAND/HELD/AVAILABLE for it).
`incoming` stays per variant (POs) but, with a location filter, counts only POs receiving there. `POST …/inventory/
adjustments` items gain optional `location_id`; `PATCH …/inventory/{variant}` (threshold) gains optional
`location_id`. Movements gain `location {id, name}` and the new reasons. External API: `GET /external/inventory` gains
`location_id` filter and `locations[]`; top-level `on_hand`/`available` keep meaning **online location** (documented);
external adjust accepts `location_id`.

### 5.5 Changed numbers (PO (product owner) must notice)
- With one location: none.
- With several: storefront shows only the online location's stock; dashboard "Units on hand" and inventory stock value
  are totals; weighted-average cost counts stock at every location.

## 6. Purchasing (part A, amends PHASE-8-8B)
`location_id` on create/edit (default location; 422 `location_locked` once received); receipts stock at the PO's
location; quick purchase takes `location_id`. Receive screen and PDF show "Receive at {location}" when the store has
> 1 non-archived location.

## 7. Stock transfers (owner API, part B; `App\Domain\Inventory\Transfers\*`)
- Create draft `{from_location_id, to_location_id, note?, lines: [{variant_id, quantity}]}` → number assigned; edit while
  draft (`revision`); delete draft.
- `POST …/{transfer}/send` → lock, P88C-10 checks, one `InventoryService` call (`transfer_out` at source, reference
  `stock_transfer`, note "TR-021 → Dhanmondi shop") → `in_transit`. Create-and-send in one call allowed
  (`send: true`). `Idempotency-Key` required on send.
- `POST …/{transfer}/receive` `{lines: [{item_id, received}]}` (each 0 ≤ received ≤ quantity; "Receive all" =
  client shortcut) → `transfer_in` at destination for received > 0, short = quantity − received recorded on the
  transfer (no ledger row: the units already left the source) → `received`. Idempotent.
- `POST …/{transfer}/cancel` (P88C-9).
- Summary `GET …/stock-transfers/summary`: `drafts_count`, `in_transit_count`, `in_transit_units`, `last_sent_at`,
  `received_this_month_count`, `received_this_month_units`, `locations` (count + names).
- List `filter[status]`, `filter[location_id]` (either side), `q` (number), counts per status in meta.
- Wrong state → 409 `invalid_state_transition`.

## 8. Stock counts (owner API, part B; `App\Domain\Inventory\Counts\*`)
- `POST …/stock-counts` `{location_id, name?, category_id?}` → lines created (P88C-11); 409 `count_in_progress` if the
  location has one; 422 `count_too_large` over 5,000 lines. Default name "Count {d M} · {location}".
- `POST …/{count}/scan` `{code}` → matches SKU then barcode among the count's lines (case-insensitive); +1; 404
  `count_line_not_found` with the code. `PUT …/{count}/lines/{line}` `{counted}` (null = un-count). Both set `expected`,
  `counted_at`, `counted_by`; `revision` optional.
- `GET …/{count}`: header, progress, summary (short units/value, extra units/value, not counted, net — values null
  without `costs.view`), lines paged 100 with `filter[state]` = `not_counted|differences|matched`, `q`.
- `POST …/{count}/finish` `{zero_uncounted: bool}` → one `applyCount` (reason `count`, reference `stock_count`, per
  line delta, zero deltas skipped) → `completed`; `applied_delta` stored. Idempotent. `POST …/{count}/cancel`.
- List of counts (latest first) with status, location, progress, net value.

## 9. Merchant API (openapi 1.18.0 part A, 1.19.0 part B; `{store}` scoped, merchant group)

| Method | Path (`/api/v1/stores/{store}`) | Perm | Part · notes |
|---|---|---|---|
| GET | `/locations` | base | A |
| POST | `/locations` | `settings.manage` | A · plan for 2nd+; 201 |
| PATCH | `/locations/{location}` | `settings.manage` | A |
| POST | `/locations/{location}/archive` · `/unarchive` · `/make-default` | `settings.manage` | A · unarchive plan-checked |
| GET | `/inventory`, `/inventory/movements` | base | A · `filter[location_id]` |
| POST | `/inventory/adjustments` | `inventory.adjust` | A · `location_id` per item |
| GET | `/stock-transfers`, `/stock-transfers/summary`, `/stock-transfers/{transfer}` | base | B |
| POST | `/stock-transfers` | `inventory.adjust` | B · plan; 201 |
| PATCH / DELETE | `/stock-transfers/{transfer}` | `inventory.adjust` | B · draft only; plan on PATCH |
| POST | `/stock-transfers/{transfer}/send` · `/receive` · `/cancel` | `inventory.adjust` | B · send plan-checked; idempotent |
| GET | `/stock-counts`, `/stock-counts/{count}` (header + summary only), `/stock-counts/{count}/lines` (paged 100; `filter[state]`, `q`; `meta.counts` per state + `all`) | base | B · `/lines` added 2026-11-25 (split from the detail so a 5,000-line count is never one payload) |
| POST | `/stock-counts` | `inventory.adjust` | B · 201 |
| POST | `/stock-counts/{count}/scan` · `/finish` · `/cancel` | `inventory.adjust` | B |
| PUT | `/stock-counts/{count}/lines/{line}` | `inventory.adjust` | B |

Shapes: `Location`, `LocationType`, `InventoryItem.locations[]`, `InventoryLevel` (+ `location_id`, `total_on_hand`,
`other_locations_on_hand`), `StockMovement.location`, `StockMovementReason` (+3), reference union (+2), `StockTransfer`,
`StockTransferDetail`, `StockTransferLine`, `StockTransferStatus`, `StockTransferSummary`, `StockCount`,
`StockCountDetail`, `StockCountLine`, `StockCountStatus`, `StockCountSummary` (part B as built in `packages/types`,
2026-11-25: also `StockVariantRef` on lines, `StockTransferEvent` on `StockTransferDetail` — the body of every transfer
write — `StockCountLineState`, `StockCountLineResult` `{line, summary, count}` as the body of scan and line PUT,
`StockCountLine.on_hand`, `StockCount.currency`, list/line metas with `counts` per status/state + `all`, status filters
as comma lists, and `error.details` shapes `InsufficientStockDetails`, `CountInProgressDetails`, `CountTooLargeDetails`,
`CountLineNotFoundDetails`; `revision` on scan/line PUT/finish/cancel is the count's own revision, optional, stale →
409; `location_archived` (422) on transfers and counts; `Idempotency-Key` required on finish too).
Errors: `location_in_use` (409), `location_name_taken` (422), `location_locked` (422), `location_archived` (422),
`insufficient_stock` (422, existing), `count_in_progress` (409), `count_too_large` (422), `count_line_not_found` (404),
`invalid_state_transition`, `revision_mismatch` (on the wire the existing `revision_conflict`, as in 8.8b; corrected
2026-11-25), `feature_not_in_plan` (existing). Limiter `stock-write` 120/min per
user (scan is frequent).

## 10. Merchant dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`
Inventory tabs: Stock levels · Stock movements · Purchase orders · Suppliers · **Warehouses** (A) · **Transfers** (B) ·
**Stock count** (B). Routes `/inventory/warehouses`, `/inventory/transfers`, `/inventory/transfers/:id`,
`/inventory/counts`, `/inventory/counts/:id`. With one location and no `multi_warehouse`, every location element below
is hidden except the Warehouses tab (shows the one location and an upgrade note) and Stock count.

### 10.1 Inventory `11:589` (part A, amends 8.8b §10.1)
Location selector `11:842` (build when > 1 location: "All locations" first, then each "Name"); with a location
selected the table shows that location's numbers; with "All locations" a row expands to per-location numbers
(composed). "Transfer stock" `11:788` (B: build → new transfer). Movement rows show the location and "Transfer →
{location}" / "Count · {name}" (B). Adjust dialog gains a location select (A, > 1 location).

### 10.2 Warehouses tab `11:808` (part A, **composed** — no Figma frame)
Cards/table: name + type tag + Default ("Online orders ship from here"), address, units on hand, stock value
(`costs.view`), variants in stock; "+ Add location" (dialog: name, type, address or "Use a pickup address", plan note),
row menu Edit / Make default / Archive (with the P88C-17 reasons). Upgrade note on Free/Starter.

### 10.3 Product editor and purchasing (part A)
Product editor stock field edits the default location; below it "+ n at other locations" with a popover listing them
(> 1 location). New PO "Receive at" `35:6644` and Receive subtitle `36:6615` / footer `36:7118` (build when > 1
location).

### 10.4 Transfers `153:34425` (part B)
Header + "+ New transfer"; KPI tiles **Drafts** (replaces "Waiting for approval"; sub "Not sent yet"), In transit ("n
items · sent {relative}"), Received this month ("n items moved"), Locations; chips All / Draft / In transit / Received
(+ Cancelled, composed); table TRANSFER · ROUTE · ITEMS · STATUS · DATE (date = sent, else created); pills Draft
(neutral), In transit (info), Received (success), "Received · n short" (danger), Cancelled (neutral). Side panel `153:35202`
for create/edit/detail: From / To selects, lines with "{From} stock a → b" (red when below threshold), warning text from
P88C-10, "+ Add product" (variant picker, composed), quantity inputs; buttons **Save draft** / **Send** (draft), **Receive**
(in transit: per-line received inputs, "Receive all", short shown live), **Cancel transfer** (menu). Hidden: Reject,
Approve & send, "Requested by … needs approval" (shows "Created by {name} · {time}").

### 10.5 Stock count `153:35246` (part B)
Counts list (composed: name, location, status, progress, net value, started) + "Start count" dialog (location, optional
category, name). Count screen: title "{name}", breadcrumb "Inventory › Stock counts · started {date} by {name}",
progress card, SKU/barcode box ("Type or scan a SKU — each scan adds 1"; Enter submits; focus kept), chips All / Not
counted / Differences / Matched, table PRODUCT · EXPECTED · COUNTED (editable number on click, composed) · DIFFERENCE ·
VALUE, "If you finish now" card, "When you finish" card with **only** "Set uncounted items to 0"; buttons **Finish &
adjust stock** (confirm dialog with the summary) and **Cancel count** (menu). Hidden: Pause, Scanner ready, "Record
shortage as expense", "Lock online sales while counting". Completed counts open read-only.

### 10.6 States and mobile
Loading/empty ("No other locations yet", "No transfers yet — move stock between your locations.", "No counts yet")/
error per `148:34032`. No mobile frames: tables become cards below `md`; transfer panel becomes a full-screen sheet; count
screen keeps the SKU box sticky; 375 px usable.

## 11. ARCH and types (owner ARCH)
**Types first**, per part. Part A: openapi **1.18.0** (locations, inventory/movement/adjust changes, external inventory,
`stock.low` payload, errors), `packages/types` (`Location*`, inventory/movement changes, `StockMovementReason` + 3,
audit actions), `packages/api-client` (`locations.*`, inventory params), ADR **0024**, DATABASE-DESIGN §5.10 (and fix
§inventories drift: `committed` not `reserved`, real reason list) + replace the §6 locations sketch row, SECURITY T40
(S179–S186), MULTI-TENANCY count 83, PHASE-7 §2.1 `multi_warehouse` row, PHASE-8-4 payload note, OPEN-QUESTIONS
Q215–Q230 (+ Q1, Q119 notes), FIGMA-INDEX rows, RUNBOOK (choosing the online location, archive), roadmap (8.8c this,
8.8d POS + Inbox). Part B: openapi **1.19.0** (transfers, counts), types + client (`stockTransfers.*`, `stockCounts.*`),
SECURITY S187–S194, MULTI-TENANCY 87, FIGMA-INDEX, RUNBOOK (wrong transfer: cancel or reverse transfer; wrong count:
manual correction).

## 12. Security checklist (each has a test)
Part A:
- **S179** isolation: locations cross-tenant/cross-store 404; a `location_id` from another store in adjust, PO, filter →
  404/422; RLS on `locations`.
- **S180** permissions: location writes need `settings.manage`; adjust with a location needs `inventory.adjust`.
- **S181** plan: 2nd location without `multi_warehouse` → 402; downgrade keeps reads/adjust/archive working.
- **S182** backfill integrity: after migration every inventory/movement/PO row has the default location; Σ on_hand per
  variant equals the pre-migration value (migration test on a seeded fixture).
- **S183** online isolation: storefront availability and checkout never see stock at a non-online location; an order
  can't commit more than the online location's available (race test, Postgres).
- **S184** stored location: cancel/ship/return after the online location changes hit the original row (no negative,
  no stock appearing at the new location).
- **S185** reader parity: a test seeds two locations and asserts every §5.3 total reader equals Σ and every online reader
  equals the online row; a static test fails on any 1:1 `join('inventories'` outside the allow-list.
- **S186** cost: weighted average with stock at two locations uses the total; past order snapshots unchanged.
Part B:
- **S187** isolation: transfers, lines, counts, count lines → cross-tenant/cross-store 404; RLS on four tables.
- **S188** transfer integrity: send never takes source below committed (race: two sends + a checkout on Postgres);
  received ≤ sent; short never re-enters stock; cancel in transit returns exactly the sent units once.
- **S189** idempotency: retried send/receive/finish with the same key → one ledger row per line.
- **S190** count maths: delta-at-count vectors (sale after counting a line is kept; receipt after counting kept;
  uncounted keep vs zero); one open count per location (race).
- **S191** count values hidden without `costs.view`.
- **S192** plan: transfer create/send without `multi_warehouse` → 402; receive/cancel of an existing in-transit transfer
  allowed.
- **S193** scan input: code length ≤ 64, no SQL wildcards interpreted (`%`, `_` literal), lookup only within the count.
- **S194** audit: every P88C-18 action recorded with the actor; impersonation read-only.

## 13. Test requirements
**API (Pest)**: part A group `locations`, part B group `stocktransfer` (+ `rls`, `security`, `race`): every §9 route
(happy, validation, authz, isolation); migration backfill test; reader parity matrix (S185); online-location change
matrix (S184); weighted average across locations; external inventory shape; `stock.low` per location; transfer state
machine, short, cancel, races; count scan/set/finish vectors, races; all existing inventory/order/purchasing/returns tests
unchanged and green.
**Web (Vitest)**: location selector + All locations expansion, Warehouses tab + dialog + archive reasons, adjust dialog
location, product editor "at other locations", Receive at; transfer list/panel/send/receive/short maths/cancel; count
list/start/scan box (+1, unknown code), editable count, chips, summary maths, finish confirm; permission/plan gating;
one-location store shows no location UI except Warehouses/Stock count.
**QA (Playwright)**: A `phase8-8c-a.*`: one-location store unchanged (smoke of 8.8b flow), Growth store adds "Dhanmondi
shop", adjusts stock there, storefront shows only the online location's stock, switch online location → storefront
changes, order placed before the switch still ships from the old one; 390 px Warehouses. B `phase8-8c-b.*`: transfer
draft → send (source down) → receive with 2 short (destination up, pill "Received · 2 short") → movements show both
sides; cancel in transit; count: scan 3 SKUs, set one quantity, place an order mid-count, finish → stock = counted minus
the order; Starter store sees no transfer button; 390 px screenshots.
**QA infra**: CI Pest steps for `locations` (A) and `stocktransfer` (B) on sqlite, Postgres, RLS; race test names added
to `api-perf` and `api-rls` lists.

## 14. File ownership

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**` only: `app/Domain/Inventory/**` (locations, transfers, counts, service, presenters), `routes/inventory*.php` + include line, migrations `2026_12_07_*` (A) / `2026_12_08_*` (B), `Orders/**` and `Returns/**` only for the line location, `Catalog/**` readers in §5.3, `Storefront/**` readers, `Cart/**` readers, `Dashboard`, `DataTransfer/**` (import/export location), `Purchasing/**` (location, cost total), `Developer/**` (external inventory, `stock.low` payload), `Automations/**` (low-stock text), `Billing/Feature` gate, `Shared/Models/StoreCounter.php`, store creation default location, `Tenancy/Authorization/*` route map, `AuditLogger` subject types, `RlsTables`, `rls-emergency-off.sql`, tests |
| **WEB** | `apps/merchant-dashboard/**` (`src/inventory/**`, `src/inventory/warehouses/**`, `src/inventory/transfers/**`, `src/inventory/counts/**` new, `src/products/**` stock field, `src/purchasing/**` Receive at, `App.tsx`, fixtures/tests), `packages/ui/**` only if a shared piece is needed |
| **ARCH** | `docs/**` except `docs/reviews/**` and TESTING.md; `packages/types/**`, `packages/api-client/**` |
| **QA** | `tests/e2e/**` (`phase8-8c-a.*`, `phase8-8c-b.*`, helpers), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-8c-{a,b}-qa.md` |

Shared-read rules: re-read `InventoryService.php`, `OrderPlacementService.php`, `routes/api.php`, `InventoryPage.tsx`
before each Edit. Storefront app (`apps/storefront`) needs **no** change (it reads the API).

## 15. Order of work (per part)
1. ARCH: types + api-client, then openapi, ADR 0024, docs.
2. API (A): migrations + backfill + RLS → `InventoryService` location argument → orders line location → reader
   classification + parity test → locations CRUD + plan → inventory/movements/adjust API → purchasing location + cost
   total → external API + `stock.low` → import/export → audit.
   API (B): migrations + RLS → transfers (service, routes, races) → counts (service, routes, races) → audit + limiter.
3. WEB (A): location selector + adjust → Warehouses tab → product editor → Receive at. (B): transfers list + panel →
   counts list + start + count screen → movement rows.
4. QA: specs + CI groups while the others build; gate after all are green, per part.

## 16. Acceptance criteria
1. A one-location store behaves exactly as before part A; every pre-existing test passes unchanged (S182).
2. Stock is kept per location; storefront and checkout use only the online location; orders release, ship and restock
   at the location they committed from, even after the online location changes (S183, S184).
3. Every stock reader is either online, total or location and is tested as such; no 1:1 inventory join remains (S185).
4. Transfers take stock out on send and put received units in on receive; short units are written off; nothing is ever
   sent beyond the source's available stock (S188, S189).
5. A finished count changes each counted line by counted − expected-at-count; sales during the count are kept (S190).
6. `multi_warehouse` gates second locations and transfers; counts work on every plan (S181, S192).
7. Figma `11:589`, `153:34425`, `153:35246`, `35:6210`, `36:6607` match with the documented omissions and composed
   items; loading/empty/error; 375 px usable.
8. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `locations`, `stocktransfer`, `rls`,
   `security`, `race`), Playwright `phase8-8c-*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml`
   passes.

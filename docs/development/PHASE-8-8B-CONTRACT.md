# Phase 8.8b contract: Suppliers + purchase orders (binding for ARCH, API, WEB, QA)

Status: **Accepted, 2026-11-24 — PO (product owner) set the scope and key choices (suppliers + purchase orders first;
weighted-average cost; no approval step; Starter + Growth; PO PDF + WhatsApp link, quick purchase, supplier CSV import,
reorder suggestions) and accepted the proposed defaults for Q200–Q214**. Branch `feat/phase-8-8b-suppliers-pos` (from `main`
@ b331633). "PO" in this file means **purchase order**; the product owner is written "PO (product owner)".
Roadmap task **8.8b+** is split again: this file is **8.8b "suppliers + purchase orders"** only. Multi-location,
transfers, stock count, POS (point of sale) and Inbox stay **8.8c+** and are not in this contract.
AC: **"A merchant records suppliers, sends purchase orders, receives stock in one or more deliveries (damaged pieces
excluded), and the variant cost becomes the weighted-average landed cost; what is owed to each supplier is always the
received value minus payments; no purchase ever enters Profit & loss as an expense"** (§16).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-8 contracts and
docs/api/API-CONVENTIONS.md still applies. PHASE-4 P4-12 (stock changes only through `InventoryService`, lock order,
append-only ledger) and P4-5 (cost visible only with `costs.view`) apply in full. **Amends** PHASE-4 §2 (variant
`cost_amount` can now change on receipt), PHASE-7 §2.1 (new feature `purchasing`), PHASE-8-3 §2.1 (new key
`purchasing.manage`), PHASE-8-8 §3.3 (the `CustomerRisk` alias is removed here). Machine-readable spec:
`docs/api/openapi.yaml` **v1.17.0**. ADR **0023** (new: purchasing, weighted-average landed cost, supplier balance
outside the expenses ledger). Product defaults: OPEN-QUESTIONS **Q200–Q214**.

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-8b-qa.md`). No external provider, no new dependency, no new queue.

| Area | Owner | Ships |
|---|---|---|
| **Suppliers** | API/WEB | Supplier records, list with KPIs and detail panel, archive, CSV import (§4, §6.1, §10.4) |
| **Purchase orders** | API/WEB | Draft → ordered → partly received → received / closed / cancelled; lines, transport, discount; per-store PO numbers (§5) |
| **Receiving** | API/WEB | Multiple receipts per PO, damaged pieces excluded, stock in via `InventoryService`, quick purchase (§5.3, §5.5) |
| **Cost** | API | Weighted-average landed cost written to the variant on every receipt; before/after kept per receipt line (§5.4) |
| **Supplier payments** | API/WEB | Advances and part payments, PO payment status, supplier balance and overdue (§6.2) |
| **Documents** | API/WEB | PO PDF and a WhatsApp share link; "Send to supplier" marks the PO ordered (§5.6) |
| **Reorder suggestions** | API/WEB | From the last 30 days of shipped units and the supplier's lead time (§7) |
| **Inventory additions** | API/WEB | INCOMING column, PO reference on stock movements, Purchase orders + Suppliers tabs (§10.1) |
| **Plan + permission** | API | New feature `purchasing` (Starter, Growth); new key `purchasing.manage` (§2) |
| **Docs + types** | ARCH | openapi 1.17.0, `packages/types`, `packages/api-client`, ADR 0023, DATABASE-DESIGN §5.9, SECURITY T39, API-CONVENTIONS, OPEN-QUESTIONS, FIGMA-INDEX, RUNBOOK, roadmap (§11) |
| **QA** | QA | Playwright `phase8-8b.*`, CI Pest group `purchasing`, TESTING.md, gate report (§13) |

**Out of scope** (hide, never fake): "Receive at" location, Warehouses tab, Transfers `153:34425`, Stock count
`153:35246` and every location label (single stock pool; 8.8c+); owner approval over an amount (PO (product owner):
no approval in v1); sending by email; supplier "claim" for damaged pieces (damaged quantity is recorded only, Q206);
returns to supplier (Q207); FIFO cost layers; revaluing stock for charges added after receiving (Q205); VAT / Mushak
registers (an optional supplier invoice reference only, Q208); payouts to suppliers (payments are records only, no
bKash/bank API); "Bought this month vs last month" comparison line (Q211); purchases as expenses (§6.3).

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- "PO" = one `purchase_orders` row. "Line" = one `purchase_order_items` row (one variant). "Receipt" = one delivery
  recorded against a PO (`purchase_receipts`).
- "Left" on a line = ordered − received − damaged (never negative).
- "Landed unit cost" = unit cost + the line's share of (transport − discount), §5.4.
- "Received value" of a PO = Σ over receipts of received quantity × landed unit cost (damaged excluded).
- "Owed" to a supplier = Σ received value of its non-cancelled POs − Σ its payments (can be negative = credit).
- Money: integer minor units, store currency at write time (never from input), no FX. Dates: store timezone.
- `[S]` = store-scoped table (`BelongsToStore`, composite FK `(tenant_id, store_id) → stores`).
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**, storefront **:3010**.

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§14). Before every Edit of a shared-read file, re-read it.
- New dependencies: **none**. Never `migrate:fresh` the local dev DB; use Pest or a scratch DB.
- Stock changes only through `InventoryService` (P4-12); never write `inventories` / `inventory_movements` directly.

---

## 0. Summary and goals
Merchants buy stock from wholesale markets and import agents, often on credit (baki) or with an advance. 8.8b lets
them keep supplier records, raise a purchase order (or record a quick cash purchase), receive goods in one or more
deliveries, and see what they owe each supplier. Receiving adds stock through the existing inventory service and
updates the variant cost to the weighted-average landed cost, so future orders snapshot a truer cost and Profit & loss
becomes more accurate going forward without counting purchases twice.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P88B-1 | **Scope** (PO (product owner) 2026-11-24): suppliers + purchase orders only; one stock pool; locations, transfers, stock count, POS, Inbox later | Smallest useful slice; no external provider; multi-location touches every stock path |
| P88B-2 | **Statuses**: `draft` → `ordered` (via "Send to supplier" or "Mark as ordered") → `partially_received` → `received`; `closed` (finish early: remaining quantities stop counting as incoming; allowed from `ordered`/`partially_received`); `cancelled` (only when nothing has been received). Only `draft` can be deleted. Lines, transport, discount and expected date editable in `draft` and `ordered` (lines with received quantity can't drop below received + damaged). Optimistic `revision` on every write (409 `revision_mismatch`) | Matches Figma chips and Zoho/Shopify; keeps history consistent |
| P88B-3 | **PO number**: per-store sequence `PO-{n}` via `StoreCounter` (new counter `purchase_orders`), assigned at draft creation, never reused | Figma shows "PO-0015 · Draft" on a new PO |
| P88B-4 | **Receiving**: a receipt carries per-line `received` and `damaged` quantities (≥ 0, at least one > 0); received + damaged ≤ left (else 422 `over_receive`); received units go into stock through `InventoryService::adjust` (reason `received`, reference `{type: 'purchase_order', id}`) in one transaction with the receipt; damaged units are recorded, never stocked. Status follows: all lines left = 0 → `received`, else `partially_received`. Idempotent by an `Idempotency-Key` (existing `IdempotencyGuard`) | Figma Receive stock `36:6607`; ledger stays the stock audit trail |
| P88B-5 | **Cost** (PO (product owner): weighted average): for each received line, `new_cost = round_half_up((max(on_hand_before, 0) × old_cost + qty × landed_unit_cost) / (max(on_hand_before, 0) + qty))`; when `old_cost` is null or `on_hand_before ≤ 0` → `landed_unit_cost`. Written to `product_variants.cost_amount` inside the receipt transaction (row lock already held by the inventory adjust). The receipt line stores `cost_before`, `cost_after`, `landed_unit_cost`. A manual cost edit still overrides. Past orders keep their snapshot (P5-31), so Profit & loss changes only for future orders | Smooths market-price swings; standard in Lightspeed/Zoho/Odoo |
| P88B-6 | **Landed cost**: PO `shipping_amount` ("Transport") and `discount_amount` ("Supplier discount") are spread over lines by line value (unit cost × ordered quantity ÷ subtotal), per unit ordered; computed at each receipt from the PO's current values; integer division remainder goes to the largest line. Charges changed after a receipt affect later receipts only | Figma New PO "Stock value goes up by ৳ 84,000 … Cost prices update automatically" |
| P88B-7 | **No approval step** (PO (product owner)): the permission is the control; the Figma "Orders above ৳ 50,000 need owner approval" note and "Approved by" history are hidden | v1 simplicity |
| P88B-8 | **Supplier payments** are records (`supplier_payments`: supplier, optional PO, amount, method `cash|bkash|nagad|bank|card|other`, paid on, note). A PO's payment status = `unpaid` / `partially_paid` / `paid` / `overpaid` from payments linked to it vs its **total** (so advances before receipt show progress). Supplier owed = received value − all payments | Baki tracking; MicroSave: partial and advance payments are common |
| P88B-9 | **Due and overdue**: a PO's `due_on` = first receipt date + supplier `payment_terms_days` (null terms → due on receipt); overdue when `due_on < today` and its received value − its payments > 0. "Payments due this week" = POs with `due_on` in the next 7 days and a balance | Figma "2 payments due this week", "overdue since …" |
| P88B-10 | **Purchases are not expenses** (§6.3): supplier payments and PO values never enter `expenses`, `ExpenseSummary` or Profit & loss. Product cost reaches profit only through order-line cost snapshots | Avoids double counting (PHASE-8-7 §7) |
| P88B-11 | **Permission** `purchasing.manage` (new, group `products`, sensitive, requires `costs.view`; O ✓ A ✓ S ✗): suppliers, POs (all prices), payments, PDF, import, suggestions. **Receiving** is allowed with `purchasing.manage` **or** `inventory.adjust`; an `inventory.adjust`-only actor sees quantities only (every cost and money field null, values sent ignored) | Figma history "Received 60 units · Sumi" (staff receives); purchase prices are cost data |
| P88B-12 | **Plan** (PO (product owner)): new feature `purchasing` on Starter and Growth (seeder + a data migration adding it to existing plan rows). Without it: reads allowed, writes 402 `feature_not_in_plan`; pages show an upgrade note | Same shape as `fake_order_guard` |
| P88B-13 | **Quick purchase** (PO (product owner)): `POST …/purchase-orders/quick` creates a PO, marks it ordered, records one receipt for the given lines and optionally a payment — one transaction, one audit entry `purchase_order.quick_received` | Cash buying at a wholesale market |
| P88B-14 | **PO PDF + WhatsApp** (PO (product owner)): PDF rendered on demand with the existing `DocumentDriver` (pattern `BillingInvoicePdf`), A4, store branding; WhatsApp = a `https://wa.me/{supplier phone}?text=…` link built client-side with the PO number, line summary and total (no attachment, no API). "Send to supplier" records `sent_at` + `sent_via` (`whatsapp|pdf|manual`) and moves `draft → ordered`. Email channel hidden | No messaging provider; works with the merchant's own WhatsApp |
| P88B-15 | **Supplier CSV import** (PO (product owner)): DataTransfer type `suppliers` (columns name, contact_name, phone, city, supplies, payment_terms_days, lead_time_days, pays_by_method, pays_by_account, notes); match by phone, else by exact name; same validate → run flow and limits as products; `purchasing.manage` + `data.import` | Figma "Import" |
| P88B-16 | **Reorder suggestions** (PO (product owner)): computed on request (§7); hidden when the store has no shipped units in 30 days | Figma cards; real data only |
| P88B-17 | **Carry-over**: remove the `CustomerRisk` alias (PHASE-8-8 §3.3); all callers use `RiskTier` | Promised in 8.8a |
| P88B-18 | **Audit**: supplier created/updated/archived, PO created/updated/sent/cancelled/closed/deleted, receipt recorded (with line quantities and cost before/after), payment recorded/deleted, quick purchase, import run (`purchasing.*` actions) | Money and stock-value changes must be explainable |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q200–Q214; **answered 2026-11-24: proposed defaults accepted**)

| Q | Question | Proposed default |
|---|---|---|
| Q200 | Split 8.8b+: 8.8b suppliers + POs now; multi-location, transfers, stock count, POS, Inbox later (answers Q1 for this part) | Yes (PO (product owner) chose suppliers + POs first) |
| Q201 | Cost method on receipt | Weighted average of landed cost (PO (product owner)) |
| Q202 | Approval over an amount | None in v1 (PO (product owner)) |
| Q203 | Plan | New feature `purchasing`, Starter + Growth (PO (product owner)) |
| Q204 | Who may receive stock | `purchasing.manage` or `inventory.adjust` (quantities only for the latter) |
| Q205 | Transport/discount changed after a receipt | Affects later receipts only; no revaluation of stock already received |
| Q206 | Damaged pieces | Recorded on the receipt, not stocked, not owed (excluded from received value); no claim workflow |
| Q207 | Returns to supplier | Not in 8.8b |
| Q208 | VAT on purchases | Optional `supplier_invoice_ref` on a receipt + an attached invoice photo/PDF; no tax maths |
| Q209 | "Owed" (Figma mixes received and unreceived) | Received value − payments; advances on unreceived POs show as credit |
| Q210 | Packaging bought from a supplier (PackRight BD in Figma) vs the Packaging expense | Stock items (variants) through POs; consumables (mailers, tape) stay expenses; never both |
| Q211 | "Bought this month vs last month" | Shown as "Bought this month" only (received value by receipt date); comparison line hidden |
| Q212 | Supplier lead time (Figma shows computed "~5 days" and typed "5–7 days") | One typed `lead_time_days`; the PO card shows "Delivers in ~{n} days" from it |
| Q213 | Damaged pieces and the "Left" column | Damaged counts as handled (left = ordered − received − damaged), so a short delivery can still complete |
| Q214 | Later purchasing features (record only) | Approval, email sending, supplier claims, returns to supplier, FIFO, landed-cost revaluation, VAT registers, multi-location receiving, PO from storefront dropship |

## 2. Permission and plan

### 2.1 Permission (amends PHASE-8-3 §2.1: 26 grantable keys + owner-only `billing.manage`)
`Permission::PurchasingManage = 'purchasing.manage'`, after `InventoryAdjust` in catalogue order, group `products`,
label **"Suppliers & purchase orders"**, description "Suppliers, purchase orders, supplier payments and purchase
prices", `sensitive() = true`, `requires() = [CostsView]`. SystemRole: Owner ✓, Admin ✓, Staff ✗. Tests: catalogue
(27 cases / 26 grantable), enforcement, route map, parity fixture, `roles.fixtures.ts`.

### 2.2 Plan (amends PHASE-7 §2.1)
| Key | Free / Starter / Growth | Checked at | Without it |
|---|---|---|---|
| `purchasing` | – / ✓ / ✓ | every purchasing write (suppliers, POs, receipts, payments, quick purchase, import) | 402 `feature_not_in_plan`; reads allowed |

## 3. Data (owner API; migrations prefix `2026_12_06_`, forward-only; RLS in each create migration; `RlsTables::TENANT` docblock "82 after Phase 8.8b"; `database/sql/rls-emergency-off.sql`)

- **suppliers** (`000100`, `[S]`): id · tenant_id · store_id · name varchar(120) · contact_name varchar(120) null · phone
  varchar(13) null (bdMsisdn) · city varchar(80) null · supplies varchar(200) null ("what they supply") ·
  payment_terms_days smallint null 0–180 · advance_percent smallint null 0–100 · lead_time_days smallint null 0–180 ·
  pays_by_method varchar(8) null CHECK (cash, bkash, nagad, bank, card, other) · pays_by_account varchar(60) null ·
  notes varchar(500) null · archived_at null · created_by · timestamps. UNIQUE `(tenant_id, store_id, lower(name))`
  among non-archived; index `(tenant_id, store_id, phone)`.
- **purchase_orders** (`000100`, `[S]`): id · tenant_id · store_id · supplier_id (FK3) · sequence int · number
  varchar(20) UNIQUE per store · status varchar(20) CHECK (6) · expected_on date null · ordered_at null · sent_at null ·
  sent_via varchar(8) null · closed_at null · cancelled_at null · notes varchar(1000) null · subtotal_amount ·
  shipping_amount (≥ 0) · discount_amount (≥ 0, ≤ subtotal + shipping) · total_amount · received_value_amount ·
  paid_amount · currency char(3) · due_on date null · revision int · created_by · updated_by · timestamps. Indexes
  `(tenant_id, store_id, status, created_at desc)`, `(tenant_id, store_id, supplier_id)`.
- **purchase_order_items** (`000100`, `[S]`): id · purchase_order_id · variant_id (FK3) · unit_cost_amount (0–1e9) ·
  quantity_ordered int 1–100000 · quantity_received int · quantity_damaged int · position smallint · CHECK received +
  damaged ≤ ordered. UNIQUE `(purchase_order_id, variant_id)`.
- **purchase_receipts** (`000100`, `[S]`): id · purchase_order_id · received_at timestamptz · received_by FK users null ·
  supplier_invoice_ref varchar(60) null · invoice_media_id null (private receipt media, reuses the 8.7 expense-receipt
  purpose rules — new purpose `purchase_invoice`, private disk, never in the media library) · note varchar(500) null ·
  value_amount · created_at.
- **purchase_receipt_items** (`000100`, `[S]`): id · purchase_receipt_id · purchase_order_item_id · variant_id ·
  quantity_received · quantity_damaged · landed_unit_cost_amount · cost_before_amount null · cost_after_amount ·
  on_hand_before int.
- **supplier_payments** (`000100`, `[S]`): id · supplier_id · purchase_order_id null · amount (1–1e10) · currency · method
  (CHECK as above) · paid_on date (≤ today, ≥ 2020-01-01) · reference varchar(60) null · note varchar(200) null ·
  created_by · timestamps. Hard delete with audit snapshot.
- `store_counters` gains kind `purchase_orders` (code constant; CHECK widened if the table has one).
- `inventory_movements`: no schema change (reason `received`, `reference_type = 'purchase_order'`); the TS
  `StockMovement.reference.type` union gains `purchase_order` (and the already-written `return`).
- `plans.features`: data migration adds `purchasing` to Starter and Growth.

## 4. Suppliers (owner API)
CRUD (`archive` instead of delete when the supplier has POs or payments; delete allowed otherwise), list with search
(name, phone, city), filter `archived`, sort by owed/last order/name, 50 per page. Derived per supplier: `products_count`
(distinct variants' products on its POs), `open_pos_count` (ordered + partially received), `owed_amount`,
`overdue_amount`, `overdue_since`, `last_order_on`, `past_orders_count`, `active_this_month` (any PO created or
receipt this month). Detail adds recent POs (last 5) with delivery and payment status.

## 5. Purchase orders (owner API; `App\Domain\Purchasing\*`)

### 5.1 Create and edit
Draft from supplier + lines (variant, unit cost, quantity), optional expected date, transport, discount, notes; unit
cost defaults to the variant's last PO unit cost for that supplier, else its current `cost_amount` ("Last bought at"
hint = last PO unit cost for the variant from any supplier). Totals recomputed server-side. Variant must be tracked
inventory of this store (untracked → 422 `variant_not_tracked`). Up to 200 lines.

### 5.2 Transitions
`POST …/{po}/send` (`draft → ordered`, `sent_via`), `POST …/{po}/mark-ordered` (draft → ordered without sending),
`POST …/{po}/close`, `POST …/{po}/cancel`, `DELETE …/{po}` (draft only). Wrong state → 409 `invalid_state_transition`.

### 5.3 Receive
`POST …/{po}/receipts` (`Idempotency-Key` required) `{lines: [{item_id, received, damaged}], supplier_invoice_ref?,
invoice_media_id?, note?}`. Order of work in one transaction: lock PO (FOR UPDATE) → validate left quantities →
`InventoryService::adjust` (all received lines, one call, `received`, reference PO, note "PO-0012 · {supplier}") →
cost update per variant (§5.4) → receipt rows → PO counters/status/received value/due_on → audit. "Receive all
remaining" is a client shortcut. `ordered`/`partially_received` only.

### 5.4 Landed cost and weighted average
Per line: `share = (shipping − discount) × line_value ÷ subtotal` (line_value = unit cost × ordered); landed unit cost
= unit cost + share ÷ quantity ordered (round half up; minimum 0). Weighted average per P88B-5 using `on_hand` read under
the inventory row lock **before** the adjust. Two lines of the same variant can't exist (unique). Cost written even for
actors without `costs.view` (they never see it).

### 5.5 Quick purchase
`POST …/purchase-orders/quick` `{supplier_id, lines: [{variant_id, unit_cost, quantity, damaged?}], shipping?, discount?,
payment?: {amount, method, paid_on}, supplier_invoice_ref?, invoice_media_id?}` → PO `received` with one receipt (+
payment). `Idempotency-Key` required.

### 5.6 Documents and sharing
`GET …/{po}/pdf` (`purchasing.manage`) → `application/pdf` inline, filename `PO-0012.pdf`, rendered with the existing
driver; content: store name/address, supplier block, PO number/dates, lines (product, variant, quantity, unit cost,
line total), transport, discount, total, notes. WhatsApp link built by WEB (no server call besides `send`).

## 6. Payments, balance and the expenses boundary

### 6.1 Supplier list KPIs (`GET …/suppliers/summary`)
`suppliers_count`, `active_this_month`, `owed_amount`, `owed_suppliers_count`, `overdue_count`, `pos_on_the_way`
(ordered + partially received), `arriving_this_week` (expected within 7 days), `bought_this_month_amount` (received
value by receipt date this month).

### 6.2 Payments
`POST …/suppliers/{supplier}/payments` and `DELETE …/supplier-payments/{payment}`; list per supplier and per PO. A
payment linked to a PO updates `paid_amount` and payment status (P88B-8). PO list KPIs (`GET …/purchase-orders/summary`):
`open_count`, `open_total_amount`, `units_coming`, `suppliers_coming`, `owed_amount`, `payments_due_this_week`,
`late_count` + first late PO number and days late (expected date passed, not fully received, status ordered/partial).

### 6.3 Not expenses (amends nothing in PHASE-8-7; states the boundary)
No row is ever written to `expenses` by purchasing; `ProfitReport` and `ExpenseSummary` are unchanged. ADR 0023 and the
Expenses page help text say "Stock you buy from suppliers belongs in Purchase orders, not in Expenses."

### 6.4 Changed numbers (PO (product owner) must notice)
- `product_variants.cost_amount` now changes when stock is received (weighted average). Consequences: inventory stock
  value at cost, product/variant cost fields, and the cost snapshot of **future** orders — hence future Profit & loss
  product cost. Past orders and past Profit & loss do not change.
- Inventory list gains `incoming` per variant; stock movements gain `purchase_order` references.
- No change to Sales, Delivery, Expenses or the dashboard.

## 7. Reorder suggestions (`GET …/purchasing/reorder-suggestions`)
For tracked variants of active products: `daily = units shipped in the last 30 days (order_shipped movements) ÷ 30`;
skip when `daily = 0`. `available = on_hand − committed`; `incoming` from open POs; `days_left = floor((available +
incoming) ÷ daily)`; suggest when `days_left ≤ lead + 7` (lead = the variant's last supplier's `lead_time_days`, else 7);
`suggested_qty = max(1, ceil(daily × 30) − available − incoming)`. Group by last supplier (or "No supplier yet"),
sorted by `days_left`; at most 50. Each item: variant, available, days_left ("Sells out in n days" / "Out of stock"),
suggested quantity. "Create PO for n items" creates a draft per supplier group (client calls create).

## 8. Merchant API (openapi 1.17.0 binding)

### 8.1 Endpoints (`routes/purchasing.php`; merchant group as 8.7/8.8a; `{store}` scoped)
| Method | Path (`/api/v1/stores/{store}`) | Perm | Notes |
|---|---|---|---|
| GET | `/suppliers` | `purchasing.manage` | list |
| GET | `/suppliers/summary` | `purchasing.manage` | §6.1 |
| POST | `/suppliers` | `purchasing.manage` | plan; 201 |
| GET | `/suppliers/{supplier}` | `purchasing.manage` | detail |
| PATCH | `/suppliers/{supplier}` | `purchasing.manage` | plan |
| POST | `/suppliers/{supplier}/archive` · `/unarchive` | `purchasing.manage` | plan |
| DELETE | `/suppliers/{supplier}` | `purchasing.manage` | plan; 409 `supplier_in_use` |
| GET | `/suppliers/{supplier}/payments` | `purchasing.manage` | |
| POST | `/suppliers/{supplier}/payments` | `purchasing.manage` | plan; 201 |
| DELETE | `/supplier-payments/{payment}` | `purchasing.manage` | plan; 204 |
| GET | `/purchase-orders` | `purchasing.manage` **or** `inventory.adjust` | `filter[status]`, `filter[supplier_id]`, `q`, counts per status in meta; money null for adjust-only |
| GET | `/purchase-orders/summary` | `purchasing.manage` | §6.2 |
| POST | `/purchase-orders` | `purchasing.manage` | plan; 201 draft |
| POST | `/purchase-orders/quick` | `purchasing.manage` | plan; idempotent |
| GET | `/purchase-orders/{po}` | `purchasing.manage` **or** `inventory.adjust` | detail incl. receipts, payments, history |
| PATCH | `/purchase-orders/{po}` | `purchasing.manage` | plan; `revision` |
| DELETE | `/purchase-orders/{po}` | `purchasing.manage` | draft only |
| POST | `/purchase-orders/{po}/send` · `/mark-ordered` · `/close` · `/cancel` | `purchasing.manage` | plan |
| POST | `/purchase-orders/{po}/receipts` | `purchasing.manage` **or** `inventory.adjust` | plan; idempotent |
| GET | `/purchase-orders/{po}/pdf` | `purchasing.manage` | |
| GET | `/purchasing/reorder-suggestions` | `purchasing.manage` | |
| POST | `/purchasing/invoices` | `purchasing.manage` **or** `inventory.adjust` | multipart invoice upload (private), 201 `{id, mime, size_bytes}` |
Imports reuse `POST /imports` with `type = suppliers` (needs `data.import` + `purchasing.manage`). Inventory list gains
`incoming` (null-free integer) and movements filter `filter[reference_type]`.

### 8.2 Shapes (summary; openapi binding)
`Supplier`, `SupplierSummary`, `SupplierDetail`, `PurchaseOrder` (list item), `PurchaseOrderDetail` (lines, receipts,
payments, events), `PurchaseOrderLine`, `PurchaseReceipt`, `SupplierPayment`, `PurchaseOrderSummary`,
`ReorderSuggestionGroup`, `PurchaseOrderStatus`, `PurchasePaymentStatus`, `SupplierPaymentMethod`. Money fields are null
for actors without `purchasing.manage` (adjust-only receivers).

### 8.3 Validation
Form Requests only; names ≤ 120, notes per §3; phone `PhoneRule::bdMobile`; amounts integer minor units within §3
ranges; quantities integers; variant ids of this store; dates ≥ 2020-01-01; `paid_on` ≤ today; `expected_on` any
future date ≤ 1 year.

### 8.4 Error codes (API-CONVENTIONS §3)
`over_receive` (422), `variant_not_tracked` (422), `supplier_in_use` (409), `invalid_state_transition` (409, existing),
`revision_mismatch` (409, existing), `feature_not_in_plan` (402, existing). Limiters: `purchasing-write` 60/min per user.

## 9. Scheduler and ops
None. RUNBOOK: the purchasing plan feature, the cost rule, and how to correct a wrong receipt (record an inventory
correction + manual cost edit; receipts are never deleted).

## 10. Merchant dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`
`can.managePurchasing` (`purchasing.manage`), `can.receiveStock` (`purchasing.manage || inventory.adjust`). Inventory
tabs: Stock levels · Stock movements · **Purchase orders** · **Suppliers** (Warehouses and Stock count hidden). Routes
`/inventory/purchase-orders`, `/inventory/purchase-orders/new`, `/inventory/purchase-orders/:id`,
`/inventory/suppliers`. No new sidebar item (Inventory stays active, as Figma).

### 10.1 Inventory additions (amends PHASE-4 UI) — `11:589`
INCOMING column (build), header buttons "Purchase order" (build → new PO) and "Transfer stock" (hidden), Reorder
suggestion card (build when suggestions exist), location selector (hidden), movement rows show "Received · PO-0012" +
supplier (build).

### 10.2 Purchase orders `35:5619`
KPI tiles Open orders / Units coming / Owed to suppliers / Late deliveries (build), status chips with counts, search,
table (PO, supplier · items with up to 2 thumbnails, receiving bar, ordered, expected with "· late", total, paid,
status pill), Reorder suggestions card with "Create PO for n items" (build), "Suppliers" header button (hidden — the tab
exists), "+ New purchase order" (build). Composed: a **"Quick purchase"** secondary button opening a dialog (supplier,
lines, transport, discount, payment); empty/loading/error states.

### 10.3 New PO `35:6210` and PO detail / Receive `36:6607`
New PO: supplier card (name, contact, city, "Delivers in ~n days", "n past orders", "You owe ৳ x", Change → supplier
picker dialog, composed), Expected by, Payment terms select (from supplier, editable text), **Receive at hidden**, items
table with "Last bought at" hint, IN STOCK, unit cost and quantity inputs, line totals, remove-line control (composed),
"+ Add product" (variant picker, composed), "Add n suggested" (build when suggestions for that supplier exist),
Summary with editable Transport and Supplier discount, Advance now / Pay from / On delivery (build as a suggested
payment from `advance_percent`; "Record advance" records a payment), info note "Stock value goes up by ৳ x when
received. Cost prices update automatically." (build), approval warning (**hidden**), "Save draft", "Send to supplier"
with channels **WhatsApp** and **PDF** (Email hidden).
Detail/Receive: header pill, Print (PDF), Record payment, More (Mark as ordered, Edit, Close, Cancel, Delete draft —
composed menu), progress card with received / receiving now / damaged legend, money summary (Total / Paid / Due; hidden
for adjust-only), Receive items table with RECEIVING NOW and DAMAGED inputs, "Receive all remaining", footer "Adding n
units to stock" (location text dropped) / "Stock value + ৳ x · cost prices updated" (damaged text "n damaged, not
added to stock"), "Attach supplier invoice", "Receive n units"; supplier card with Call (`tel:`) and WhatsApp
(`wa.me`); payments card; history (created, sent, payments, receipts — no "Approved by"); documents (invoice
attachments + PO PDF).

### 10.4 Suppliers `153:35999`
KPI tiles Suppliers / You owe / On the way / **Bought this month** (comparison line hidden), table (supplier, supplies ·
city, products, open POs, you owe in red when overdue, last order), detail panel (contact, owed banner with overdue,
payment terms, pays by, lead time, recent POs with delivery/payment pills, Record payment, New PO), "Import" (CSV,
build), "+ Add supplier" (composed form dialog), selected-row highlight (composed), search (composed), archive in the
panel menu (composed).

### 10.5 States and mobile
Loading/empty ("No purchase orders yet — create one or record a quick purchase.", "No suppliers yet")/error per
`148:34032`; plan note for Free. No mobile frames: tables become cards below `md`, receive table stacks per line, 375 px
usable.

## 11. ARCH and types (owner ARCH)
openapi **1.17.0** (§8 paths + import type + inventory `incoming` + movement filter + schemas + error codes),
`packages/types` (all §8.2 shapes, `PermissionKey` + `purchasing.manage`, `FeatureKey` + `purchasing`, movement
reference union, `ImportType` + `suppliers`, audit actions), `packages/api-client` (`suppliers.*`, `purchaseOrders.*`,
`supplierPayments.*`, `purchasing.reorderSuggestions`, `purchasing.uploadInvoice`), ADR 0023, DATABASE-DESIGN §5.9
(replace the §6 sketch row for suppliers/purchasing; locations/transfers stay sketched), SECURITY T39 (S167–S178),
API-CONVENTIONS (§3 codes, §8 limiter), MULTI-TENANCY table count 82, PHASE-4 cost note, PHASE-7 §2.1 row, PHASE-8-3
§2.1 row, PHASE-8-8 §3.3 alias removed, OPEN-QUESTIONS Q200–Q214 (+ Q1 note), FIGMA-INDEX rows, RUNBOOK, roadmap split
(8.8b this, 8.8c+ rest). **Types first.**

## 12. Security checklist (S167–S178; each has a test)
- **S167** isolation: suppliers, POs, lines, receipts, payments, invoices → cross-tenant and cross-store 404; RLS on all
  six tables.
- **S168** permissions: staff without `purchasing.manage` → 403 on supplier/PO money routes; staff with
  `inventory.adjust` can list/view POs and receive, with every money/cost field null and sent costs ignored.
- **S169** plan: Free → writes 402, reads 200.
- **S170** receiving integrity: over-receive → 422; concurrent receipts on one PO never exceed ordered (row lock); a
  retried request with the same `Idempotency-Key` creates one receipt and one stock movement per line.
- **S171** stock path: receipts change stock only through `InventoryService` (movement rows with reference
  `purchase_order`, `on_hand_after` correct); damaged never stocked.
- **S172** cost maths: weighted-average vectors (null old cost, on_hand ≤ 0, rounding, landed share with transport and
  discount, remainder to the largest line); past order snapshots unchanged (P&L for an earlier range identical before
  and after a receipt).
- **S173** money: totals recomputed server-side (client totals ignored); discount ≤ subtotal + shipping; currency = store
  currency.
- **S174** payments: owed = received value − payments; payment status vectors; deleting a payment audited with snapshot.
- **S175** no expenses: no purchasing action writes `expenses`; ProfitReport/ExpenseSummary unchanged by purchases.
- **S176** invoice uploads: sniffed (JPEG/PNG/WebP/PDF), private disk, never in `/media`, attach only within the tenant.
- **S177** import: CSV formula-safe export of errors, phone normalisation, tenant-scoped matching.
- **S178** audit: every §P88B-18 action by user; impersonation read-only (writes 403).

## 13. Test requirements
**API (Pest; group `purchasing`; RLS also `rls`, security items also `security`)**: every §8.1 route (happy,
validation, authz, isolation); state machine matrix; receipts incl. partial, damaged, over-receive, idempotency,
concurrency (`race` group on Postgres); cost vectors; landed allocation; payments and owed/overdue/due-this-week;
summaries; reorder suggestions from fixtures; quick purchase; PDF (fake driver returns bytes); supplier import; CustomerRisk
alias removal (callers compile/tests green); S167–S178.
**Web (Vitest)**: PO list (chips, KPIs, late flag, receiving bar), new PO form (RHF + Zod, line maths, last-bought hint,
remove line, suggested lines), receive form (left/damaged maths, receive-all, footer totals, adjust-only view without
money), payments dialog, quick purchase dialog, suppliers list + panel + add/edit + import, inventory INCOMING column and
movement reference, reorder card, permission/plan gating, WhatsApp link text, mobile cards.
**QA (Playwright `phase8-8b.*`)**: create supplier → new PO with two lines + transport → send via PDF → receive part with
1 damaged → stock and cost updated (check variant cost and a new order's snapshot) → record payment → owed matches →
receive rest → status received; quick purchase; staff with `inventory.adjust` receives without seeing prices; Free shop
plan note; supplier CSV import; reorder suggestion appears after shipped orders; 390 px screenshots (PO list, receive,
suppliers).
**QA infra**: CI Pest step for group `purchasing` (sqlite, Postgres, RLS) copied from the 8.8a `fraud` steps.

## 14. File ownership for Phase 8.8b

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**` only: `app/Domain/Purchasing/**`, `routes/purchasing.php` + include line, migrations `2026_12_06_*`, `Inventory/**` (incoming, movement filter, presenter reference), `Catalog/**` only where cost is read for "last bought", `Orders/StoreCounter` kind, `Media/MediaPurpose.php` (+ `purchase_invoice`, like `expense_receipt`), `DataTransfer/**` (suppliers import type), `Billing/Feature.php` + `PlanSeeder` + plan data migration, `Tenancy/Authorization/*`, `AuditLogger` subject types, `Audit/Http/Requests/ListAuditLogsRequest.php` whitelist, `Customers/CustomerRisk.php` removal + callers, `RlsTables`, `rls-emergency-off.sql`, `AppServiceProvider`, `resources/views/documents/purchase_order.blade.php`, tests (`tests/Feature/Purchasing/**`, role/permission tests, parity fixture, media tests touched) |
| **WEB** | `apps/merchant-dashboard/**` (`src/purchasing/**` new, `src/inventory/**`, `src/lib/permissions.ts`, `App.tsx`, fixtures/tests), `packages/ui/**` only if a shared piece is needed |
| **ARCH** | `docs/**` except `docs/reviews/**` and TESTING.md; `packages/types/**`, `packages/api-client/**` |
| **QA** | `tests/e2e/**` (`phase8-8b.*`, support helpers), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-8b-qa.md` |

Shared-read rules: API keeps every existing inventory, product and order field and meaning except §6.4. Re-read
`routes/api.php`, `Permission.php`, `InventoryService.php`, `InventoryPage.tsx` before each Edit.

## 15. Order of work
1. ARCH: types + api-client first, then openapi 1.17.0, ADR 0023, docs.
2. API: migrations + RLS + plan feature → permission + routes → suppliers → POs + state machine → receipts (inventory +
   cost) → payments + summaries → quick purchase → PDF → invoices upload → reorder suggestions → import → inventory
   incoming/movement filter → CustomerRisk removal → audit + limiter.
3. WEB: PO list → new PO → detail/receive → suppliers → payments/quick purchase dialogs → inventory additions → mobile.
4. QA: specs + CI group while the others build; gate after all are green.

## 16. Acceptance criteria
1. Suppliers, POs, receipts and payments work end to end; every write audited; staff without the key get 403 (S168).
2. Receiving adds exactly the received (non-damaged) units through the inventory ledger, never more than ordered, once
   per idempotent request (S170, S171).
3. Variant cost becomes the weighted-average landed cost on each receipt; past Profit & loss is unchanged (S172).
4. Owed, overdue and payment status follow §6 exactly; no purchase reaches expenses or Profit & loss (S174, S175).
5. Figma `35:5619`, `35:6210`, `36:6607`, `153:35999` and the Inventory additions match with the documented omissions
   and composed items; loading/empty/error; 375 px usable.
6. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `purchasing`, `rls`, `security`),
   Playwright `phase8-8b.*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

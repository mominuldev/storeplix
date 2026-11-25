# Phase 8.8d contract: POS — point of sale (binding for ARCH, API, WEB, QA)

Status: **Accepted, 2026-11-25 — PO (product owner) set the scope (POS first; Inbox later, Q232) and accepted the
proposed defaults for Q233–Q256**. Branch `feat/phase-8-8d-pos` (from `main` @ 26c818c, after PR #19). "PO" in this
file means **purchase order** (as in 8.8b/8.8c); the product owner is written "PO (product owner)".
Roadmap task **8.8d** is split: this file is **8.8d "POS"**. Inbox (`141:48129`) and AI integrations stay open under
Q1 and are not in this contract.
AC: **"A shop opens a register with a counted float, sells to walk-in customers from that shop's stock with cash,
bKash, card or a split, prints or texts a receipt, parks and resumes sales, takes returns at the till, and closes the
register with a counted drawer whose difference is explained; every till sale is an order that shows in Orders,
reports and Profit & loss, and stock leaves the register's location through the ledger"** (§16).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-8C contracts (and the 8.1 admin-2FA
amendment) and docs/api/API-CONVENTIONS.md still applies. PHASE-4 P4-12 (stock changes only through
`InventoryService`, lock order, append-only ledger), PHASE-5 order placement and ADR 0011, PHASE-5b manual payments
and returns (P5B-67/68), and ADR 0024 (per-location stock, readers classified online / total / location) apply in full.
**Amends** PHASE-5 §2 (`orders.created_via` gains `pos`, `orders.payment_method` gains `pos`), PHASE-5b §2 (`payments`
gains `pos_session_id` and method `card`), PHASE-7 §2.1 (`pos` becomes enforced), PHASE-7 §6.3 (Sales report district
breakdown skips till sales), PHASE-8-3 §2.1 (new key `pos.sell`), PHASE-8-6 (recipes never fire on till sales),
PHASE-8-8 §6 (own-shop record ignores till sales), PHASE-8-8C §5.3 (one new *location* reader). Machine-readable spec:
`docs/api/openapi.yaml` **v1.21.0**. ADR **0025** (new: till sales are orders; registers and cash
sessions). Product defaults: OPEN-QUESTIONS **Q232–Q256**.

### Scope

**Two parts, two PRs, two QA gates** (Q233), as 8.8c. Each part leaves `main` releasable.

| Part | Branch | Ships |
|---|---|---|
| **A — Sell** | `feat/phase-8-8d-pos-sell` (from `main` after this file is accepted) | Registers, open/close register with counted cash, catalog + scan, customer by phone, coupon, cash/bKash/card/split payment, sale = order (delivered + paid at once), stock out at the register's location, receipt print + SMS receipt, cash-in-drawer, close register with variance + Z-report, `pos.sell`, plan `pos` (§2–§8, §10, §11.1–§11.5, §11.8) |
| **B — During the day** | `feat/phase-8-8d-pos-day` (from `main` after A merges) | Held sales (park / resume / delete), sales history with KPIs and receipt detail, reprint / resend SMS, returns at the till with a refund from the drawer (§9, §11.6–§11.7) |

| Area | Owner | Part |
|---|---|---|
| **Registers + sessions** | API/WEB | A: §4 |
| **Sale** | API/WEB | A: `PosSaleService` places an order through `OrderPlacementService`, stock through `InventoryService::sell` (§5–§6) |
| **Payments** | API | A: manual till payments with `pos_session_id`; method `card` (§6.3) |
| **Receipts** | API/WEB | A: receipt JSON from the `receipt_80mm` template config; browser print; SMS receipt (§7) |
| **Held sales, history, returns** | API/WEB | B: §9 |
| **Orders / reports / P&L** | API | A: readers that must treat till sales correctly (§8) |
| **Plan + permission** | API | A: `pos` enforced, `pos.sell` added (§2) |
| **Docs + types** | ARCH | A and B: openapi, `packages/types`, `packages/api-client`, ADR 0025, DATABASE-DESIGN §5.11 (replaces the §6 POS sketch row), SECURITY T42, MULTI-TENANCY count, OPEN-QUESTIONS, FIGMA-INDEX, RUNBOOK, roadmap (§12) |
| **QA** | QA | A: `phase8-8d-a.*`, Pest group `pos`; B: `phase8-8d-b.*` (§14) |

**Out of scope** (hide, never fake): Inbox (`141:48129`, Q232 / Q1); AI integrations (Q1); offline selling and the
local sale queue (Q251); cash-drawer kick and any printer / scanner / card-terminal **hardware integration** — the
"Open drawer" tick, silent printing, the "Scanner ready" tag (Q240, Q225); bKash API verification of till payments and
Nagad (Q239); **Void receipt (manager PIN)** and manager PINs in general (Q250); exchange in one step (Q250); manual
discounts and price overrides (Q243); paid in / paid out of the drawer (Q245); per-person register or location access
(Q119, Q248); stock reservation by held sales (Q242); customer-facing display, tips, loyalty points, gift cards,
e-receipt web page, emailed Z-report (Q256); selling below zero or backorders at the till (Q236).

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- "Register" = one `pos_registers` row (a till at a location). "Session" = one `pos_sessions` row: one register from
  open to close (a shift). "Till sale" = an order with `created_via = 'pos'` plus its `pos_sales` row. "Held sale" = one
  `pos_held_sales` row.
- "Register location" = the register's `location_id` (8.8c location). Stock for a till sale always leaves there.
- "Cash in drawer" (expected) = `opening_cash_amount` + Σ cash charges of the session − Σ cash refunds of the session.
- Money: integer minor units (paisa), store currency; denominations are stored in minor units (`100000` = ৳ 1,000).
  Dates: store timezone. Figma ৳ figures are examples.
- `[S]` = store-scoped table (`BelongsToStore`, composite FK `(tenant_id, store_id) → stores`).
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**, storefront **:3010**.

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§15). Before every Edit of a shared-read file, re-read it.
- New dependencies: **none** (no ESC/POS, no WebUSB, no service worker). Never `migrate:fresh` the local dev DB.
- Stock changes only through `InventoryService` (P4-12); orders only through `OrderPlacementService` / `OrderService`;
  refunds only through `OrderService::refund`; returns only through `ReturnService`.
- **A store without `pos` behaves exactly as before** (every existing Pest test and Playwright spec stays green without
  edits except added enum values in shapes).

---

## 0. Summary and goals
Many Store Plix merchants also run a physical shop. Today a walk-in sale is either not recorded (stock drifts, profit is
wrong) or typed in as a manual order meant for delivery. 8.8d adds a till: open a register with the morning float, sell
by tapping or scanning, take cash / bKash / card, print an 80 mm receipt or text it, and close the register with a
counted drawer. Every till sale is a normal order — already delivered and paid — so Orders, reports, Profit & loss,
customer history and webhooks keep one source of truth. Stock leaves the register's location (8.8c), never the online
pool by accident.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P88D-1 | **Scope** (PO (product owner) 2026-11-25, Q232): POS now; Inbox later. Delivered as **part A** (sell, open/close) and **part B** (held sales, history, returns) (Q233) | Figma sections `27:1025`–`27:1028`; A alone is a usable till |
| P88D-2 | **A till sale is an order** (Q234): `orders` row with `created_via = 'pos'`, `channel = 'walk_in'`, `payment_method = 'pos'`, placed directly in status **`delivered`** with `payment_status = 'paid'`, `paid_amount = total_amount`, and `confirmed_at = shipped_at = delivered_at = placed_at`. A 1:1 `pos_sales` row holds the till facts (register, session, cashier, tendered cash, change). No new sales table for money or lines | Reports, Profit & loss (delivered by `delivered_at`), customer stats, returns, refunds, webhooks and exports already work on orders (ADR 0025) |
| P88D-3 | **Receipt number = order number** (Q235): the receipt prints the store's order number (e.g. `MF-2232`); Figma `R-2232` is an example. Same sequence as online orders (`StoreCounter::ORDERS`) | One number per sale everywhere (as Q50 for invoices) |
| P88D-4 | **Registers** (Q237): per store, name (≤ 40), location (any active 8.8c location; shops listed first), `archived_at`. ≤ **10** active per store. Created from the register picker ("+ Add register", composed) with `settings.manage`. A store's first visit to POS with no register offers "Create Register 1 at {default location}" | Figma "Register 1 · Mirpur shop", "Register 2 · Mirpur shop", "Register 1 · Uttara shop" |
| P88D-5 | **Sessions** (Q245, Q246): open with a counted float (denomination counts or one amount); one open session per register (partial unique); any member with `pos.sell` may sell on or close any open register; sessions stay open until closed (no auto-close); a sale or return on a closed session → 409 `register_closed` | Figma `25:581`, `25:829`; shift handover without PINs |
| P88D-6 | **Stock from the register location** (Q236): a till sale checks and takes stock at the register's location with one new `InventoryService::sell` (lock rows `(variant_id, location_id)`; each tracked line ≤ **available** = `on_hand − committed` there, else 422 `out_of_stock`; `on_hand` −; ledger reason **`pos_sale`**, reference `order`). No commit step, no backorder at the till; untracked variants sell freely. Order lines store `location_id` = register location | Never sells stock already promised to an online order; same lock order as 8.8c |
| P88D-7 | **Prices are the server's**: the client sends variant ids, quantities, an optional coupon code and `expected_total_amount`; the server prices with the existing pricing/coupon code (same rules, usage limits by phone) and refuses a different total with 409 `checkout_changed` (existing code). Coupon codes only; no manual discount or price override (Q243) | ADR 0006 tamper rule; Figma shows "Discount · LOYAL5" |
| P88D-8 | **VAT row** (Q244): printed from the existing tax settings (Q52 `tax_display`, `tax_rate_bps`, `tax_bin`): "VAT {rate}% (included) ৳ x" when `included`, hidden when `none`. Totals unchanged | Figma "VAT 0%"; no new tax maths |
| P88D-9 | **Payments** (Q239): methods **Cash** (`cash`), **bKash** (`bkash_personal`, label "bKash", optional TrxID ≤ 32 as `reference`), **Card** (new `card`, external terminal, optional approval code ≤ 32), **Split** (2–4 parts, any mix, each > 0). One `payments` row per part: `provider = 'manual'`, `type = 'charge'`, `status = 'succeeded'`, `verified_at = now`, `purpose = 'order'`, `pos_session_id`, actor. Σ parts = order total exactly (422 `pos_payment_mismatch`). Cash part: `tendered_cash_amount ≥ cash part` (422 `cash_tendered_short`), change = tendered − cash part, stored on `pos_sales` | Cashier-attested money like 5b manual payments; never a gateway redirect (rule 8 untouched) |
| P88D-10 | **Customer** (Q252): optional. Exact phone lookup (normalised `8801…`) returns `OrderCustomerSummary` (name, counts, spent, own-shop tier; Figma "Loyal" → the tier label). A new phone + name creates/links the customer exactly as manual orders do. **Walk-in** (no phone): `customer_id = null`, `customer_name = 'Walk-in customer'`, `customer_phone = ''`, `shipping_address = {}`, `district_code = ''`, `shipping_zone_name = ''` (sentinels, §3.2) | Figma "Farhana Yasmin · 01711-552211 · 6 orders · ৳ 14,700 spent · Loyal", "Walk-in customer" |
| P88D-11 | **Receipt** (Q240): the API returns a `PosReceipt` JSON (shop name/address/phone, BIN when `show_bin`, logo when `show_logo`, language and footer from the store's `receipt_80mm` template, lines, totals, VAT, payments, tendered, change, cashier, register, time). The SPA renders an 80 mm print layout and calls the browser print dialog. No PDF render on the till path; the order's `receipt_80mm` PDF (5b documents) stays available from Orders | Fast, works with any 80 mm printer installed as a system printer; no hardware code |
| P88D-12 | **SMS receipt** (Q241): tick "SMS receipt" (default on when the sale has a phone) → new transactional SMS template `pos_receipt` (`SmsTemplates::POS_RECEIPT`, in `COUNTED` but **not** in `EVENTS`, so it is no store SMS toggle) through `SendOrderSms`, counted in `sms_per_month`, text only (shop, number, total, method, footer up to the 3-segment cap; no link). Resend from history. Walk-in → tick disabled | Figma "SMS receipt sent to 01711-552211 · Resend" |
| P88D-13 | **Notifications and automations** (Q253): till sales send **no** order-status SMS/email (`notify = false`); 8.6 recipes skip order, shipment and return subjects of `created_via = 'pos'` (as built; stock subjects such as the Low stock alert still fire when a till sale takes a row below its threshold); outbound webhooks `order.created` and `order.paid` **do** fire (payload `created_via: pos`) | A shopper standing at the counter needs no "order received" SMS; integrations want every sale |
| P88D-14 | **Fake-order guard** ignores till sales (Q255): the own-shop record (delivered / returned counts per phone) excludes `created_via = 'pos'`; no risk check runs on a till sale | Staff could otherwise "whitewash" a number with fake till sales (T42) |
| P88D-15 | **Cash drawer and close** (Q245): BDT denomination list **1000, 500, 200, 100, 50, 20, 10, 5, 2, 1** on both screens (non-BDT stores: one amount field). Opening prefilled from the last session's "left in drawer". Close: counted (from counts), expected (server), variance = counted − expected, **tolerance ৳ 50** (`config('pos.variance_tolerance_amount')` = 5000; note required above it: 422 `close_note_required`), "Leave in drawer" (composed, default = this session's opening float), banked = counted − left. Close deletes the register's held sales (warned). No paid in / paid out | Figma `25:581` / `25:829`; "Last session" card shows Banked / Left in drawer |
| P88D-16 | **Held sales** (part B, Q242): stored on the server per register (≤ **20**), lines + customer + coupon + note (≤ 120); they **do not reserve stock**; resuming loads the lines into the cart and re-prices; the sale that completes a resumed held sale deletes it. Figma copy "Stock for held sales is reserved for 30 minutes, then released." → **"Held sales don't hold stock. Items are checked again when you resume."** | Reserving needs commit/release + an expiry job on a shop location; not worth it for a parked sale (alternative in Q242) |
| P88D-17 | **Returns at the till** (part B, Q250): "Return or exchange items" → **Return items** only: lines ≤ sold − already returned; one call creates the return (`ReturnService::create` type `return`, source `merchant`), receives it with full restock at the line's stored location (= register location, P88C-16), and refunds through `OrderService::refund` (method cash from the open session's drawer, or the original non-cash method; `pos_session_id` set). Needs `pos.sell` **and** `orders.refund`. Exchange = a return then a new sale. "Void receipt (manager PIN)" hidden | Existing tested return/refund code; refunds are already `orders.refund` (sensitive) |
| P88D-18 | **Permission** (Q247): new key **`pos.sell`** "Sell at the till (POS)" — group `orders`, after `orders.refund` and before `fraud.manage` in catalogue order, not sensitive, `requires() = []` (a cashier-only custom role is possible), grantable. SystemRole: Owner ✓, Admin ✓, **Staff ✓**. Register writes: `settings.manage`. Every POS read and write except register writes: `pos.sell`. No external-API scope | One key keeps custom roles simple; reading cash totals of a till is part of selling at it |
| P88D-19 | **Plan** (Q249): `pos` (Growth, already seeded) is enforced on every POS write (register create/unarchive, open, sale, hold, return, SMS resend): 402 `feature_not_in_plan`. After a downgrade: history, sessions and receipts stay readable, an open session can still be **closed**, nothing else | Growth card "Multiple warehouses & POS" |
| P88D-20 | **Q119 revisited** (Q248): still no per-role or per-person location/register access. Every `pos.sell` member can use every register; every `inventory.adjust` member every location. Recorded for a later module | No Figma for a per-register picker; access per place needs a membership × location table and UI |
| P88D-21 | **Offline** (Q251): no offline mode. The Figma pill "● Online · stock syncing" shows **Online** (success) or **Offline — reconnect to charge** (danger) from the browser's online state and the last request; **Charge** is disabled while offline. Every write carries an `Idempotency-Key` minted per attempt and reused on retry, so a double tap or a retry after a timeout never makes two sales | Honest state; no local queue to reconcile |
| P88D-22 | **Readers** (amends PHASE-8-8C §5.3, PHASE-7 §6.3): POS catalog availability is a new *location* reader (register location row). Sales report: till sales count in totals and channels (`walk_in`) and are skipped in the district / Dhaka-vs-outside breakdown. Delivery report and courier screens: till sales have no shipment and are excluded. Storefront order tracking: `created_via = 'pos'` → 404 as unknown. Every reader of `customer_phone`, `shipping_address`, `district_code` is listed and tested with a walk-in till sale (§8, S205) | Sentinels must never surface as broken UI or wrong maths |
| P88D-23 | **Audit**: `pos_register.created/updated/archived/unarchived`, `pos_session.opened` (opening amount, counts), `pos_session.closed` (counted, expected, variance, left, banked, note, held sales deleted), `pos_held_sale.deleted`; returns and refunds keep their existing `return.*` / `order.refunded` actions with `meta.pos_session_id` | Cash differences must be explainable |
| P88D-24 | **Mobile** (Q254): POS is designed at 1440 px and is meant for a laptop or tablet. Below `md` it stays usable at 390 px: catalog full width, cart as a bottom sheet behind a sticky "Charge ৳ x · n items" bar, payment and close as full-screen sheets | No mobile frame on `22:1736` or `2:5` |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q232–Q256; **answered 2026-11-25: proposed defaults accepted**)

| Q | Question | Proposed default |
|---|---|---|
| Q232 | Split 8.8d: POS now, Inbox later? | **Answered (product owner, 2026-11-25): yes — POS first; Inbox and AI integrations stay open under Q1** |
| Q233 | Delivery split | Two PRs: A sell + open/close; B held sales, history, returns |
| Q234 | What a till sale is, and where it shows | An order (`walk_in`, `created_via pos`), delivered + paid at once; in Orders with a "POS · {register}" tag, in Sales report, Dashboard and Profit & loss |
| Q235 | Receipt number (Figma "R-2232") | The order number (one sequence with online orders) |
| Q236 | Which stock a till sells; selling what the system says is 0 | The register's location, up to its available; no backorder / below-zero; fix stock with an adjustment first |
| Q237 | Registers: where managed, how many | From the POS register picker ("+ Add register"), `settings.manage`, ≤ 10, name + location |
| Q238 | Cashier (Figma shows a "Cashier" select) | The signed-in member, shown read-only; no user switching or PIN on a shared device |
| Q239 | Payment methods | Cash, bKash (manual, optional TrxID), Card (manual, optional approval code), Split (2–4 parts); no bKash API check, no Nagad |
| Q240 | Printing and the cash drawer | Browser print of an 80 mm receipt (any system printer); "Open drawer" tick and drawer kick hidden; no silent printing |
| Q241 | SMS receipt | Opt-in tick (on by default when there's a phone); text only, no link; counts in `sms_per_month` |
| Q242 | Held sales and stock (Figma "reserved for 30 minutes") | Held on the server per register (≤ 20), **no stock reserved**, copy changed; deleted when the register closes |
| Q243 | Discounts at the till | Coupon codes only; no manual discount or price override |
| Q244 | VAT line | From existing tax settings (included VAT printed); hidden when tax display is off |
| Q245 | Float, denominations, tolerance, banking | BDT 1000…1 on both screens; opening prefilled from last "left in drawer"; tolerance ৳ 50 (note required above); "Leave in drawer" added at close; banked = counted − left; no paid in / out |
| Q246 | Who can close; stale sessions | Anyone with `pos.sell`; sessions stay open until closed; the register list shows "Open · {name} · since {time}" |
| Q247 | Permission | New key `pos.sell` (Staff has it); registers `settings.manage`; returns also need `orders.refund` |
| Q248 | Q119 revisit — warehouse/location (and register) access per role or person | Still deferred: everyone with the key uses every register / location |
| Q249 | Plan | `pos` (Growth) on every POS write; after a downgrade history readable and an open register closable |
| Q250 | Returns, exchanges, void | Return items at the till (refund from drawer or original method, restock at the shop); exchange = return + new sale; Void receipt (manager PIN) hidden |
| Q251 | Offline | Not supported; Online/Offline pill, Charge disabled offline; idempotent retries |
| Q252 | Customer at the till | Optional; exact phone lookup; new phone + name creates the customer; walk-in has none; "Loyal" shows the own-shop tier |
| Q253 | Notifications, automations, webhooks for till sales | No order SMS/email; no 8.6 recipes; webhooks fire |
| Q254 | Phone-size POS | Usable at 390 px (bottom-sheet cart); designed for laptop/tablet |
| Q255 | Fake-order guard and till sales | Till sales don't count in a phone's own-shop record and are never risk-checked |
| Q256 | Later POS features (record only) | Offline mode, drawer kick / printer / scanner / card-terminal integration, silent printing, barcode labels, paid in / out, manual discount and price override, one-step exchange, void with manager PIN, per-person register/location access, user switching by PIN, tips, loyalty, gift cards, customer display, e-receipt page, Nagad, bKash API verification, emailed Z-report |

## 2. Permission and plan

### 2.1 Permission (amends PHASE-8-3 §2.1: 27 grantable keys + owner-only `billing.manage`)
`Permission::PosSell = 'pos.sell'`, group `orders`, catalogue order after `OrdersRefund`, label **"Sell at the till
(POS)"**, description "Open and close registers, sell, hold sales, sales history", `sensitive() = false`,
`requires() = []`, grantable. SystemRole: Owner ✓, Admin ✓, Staff ✓. Route map rows for every §10 route; O/A/S parity
fixture, `roles.fixtures.ts` and catalogue tests (28 cases / 27 grantable). Returns additionally need `orders.refund`;
register writes need `settings.manage`. Non-delegation (P83): a custom role can include `pos.sell` only when the
granter holds it (as every key); not offered as an API-key scope.

### 2.2 Plan (amends PHASE-7 §2.1: the `pos` row becomes enforced)
| Key | Free / Starter / Growth | Checked at | Without it |
|---|---|---|---|
| `pos` | – / – / ✓ | register create / unarchive; open; sale; quote; hold; return; SMS resend | 402 `feature_not_in_plan`; reads, close of an open session, register edit / archive allowed |

Sidebar "POS" stays visible to members with `pos.sell`; without the feature `/pos` shows the plan note (composed from
the 8.4 plan-note pattern `144:41323`, "POS is on the Growth plan" + See plans).

## 3. Data (owner API; forward-only; RLS in each create migration; `database/sql/rls-emergency-off.sql`)

### 3.1 New tables (migrations prefix `2026_12_10_`; `RlsTables::TENANT` docblock "91 after Phase 8.8d")
- **pos_registers** (`000100`, `[S]`, part A): id · tenant_id · store_id · location_id FK3(locations) **RESTRICT** · name
  varchar(40) · position smallint · archived_at null · created_by null FK users SET NULL · timestamps. UNIQUE
  `(tenant_id, store_id, id)`; partial UNIQUE `(store_id, lower(name)) WHERE archived_at IS NULL`; index `(tenant_id,
  store_id, location_id)`.
- **pos_sessions** (`000100`, `[S]`, part A): id · register_id FK3 RESTRICT · location_id FK3 RESTRICT (snapshot) ·
  status varchar(8) CHECK (open, closed) · currency char(3) · opened_by FK users · opened_at · opening_cash_amount
  bigint ≥ 0 · opening_counts jsonb null (`{"100000": 1, "50000": 1, …}`, keys = denominations in minor units, values
  0–10,000) · closed_by null · closed_at null · counted_cash_amount null · closing_counts jsonb null ·
  expected_cash_amount null · variance_amount null (signed) · left_in_drawer_amount null · banked_amount null · close_note
  varchar(300) null · revision int · timestamps. Partial UNIQUE `(register_id) WHERE status = 'open'`; index
  `(tenant_id, store_id, register_id, opened_at desc)`; CHECK closed ⇔ closed_at/counted/expected not null; CHECK
  `0 ≤ left_in_drawer_amount ≤ counted_cash_amount`.
- **pos_sales** (`000200`, `[S]`, part A): id · order_id FK3(orders) **UNIQUE** RESTRICT · session_id FK3 RESTRICT ·
  register_id FK3 RESTRICT · location_id FK3 RESTRICT · cashier_id FK users · tendered_cash_amount bigint null ·
  change_amount bigint default 0 CHECK ≥ 0 · sms_receipt bool · created_at. Index `(tenant_id, store_id, session_id)`,
  `(tenant_id, store_id, register_id, created_at desc)`, `(tenant_id, store_id, created_at desc)`.
- **pos_held_sales** (`000300`, `[S]`, part B): id · register_id FK3 CASCADE · session_id FK3 null SET NULL ·
  customer_id FK3 null SET NULL · customer_name varchar(120) null · customer_phone varchar(13) null · coupon_code
  varchar(32) null · note varchar(120) null · lines jsonb (`[{variant_id, quantity}]`, 1–50) · items_count int ·
  total_amount bigint (at hold time) · currency char(3) · held_by FK users · created_at. Index `(tenant_id, store_id,
  register_id, created_at desc)`.

### 3.2 Changed tables (`2026_12_10_000400`, part A)
- **orders**: `orders_created_via_check` + `pos`; `orders_payment_method_check` + `pos`. Sentinels (P88D-10) allowed
  only for `created_via = 'pos'`: new CHECK `orders_pos_sentinels_check` = `created_via = 'pos' OR (customer_phone <> ''
  AND district_code <> '')` (Postgres; as built — every till sale has `district_code = ''`, also with a customer phone).
  No column change.
- **payments**: add `pos_session_id char(26) null` FK3(pos_sessions) RESTRICT + partial index `(tenant_id, store_id,
  pos_session_id) WHERE pos_session_id IS NOT NULL`; `payments_method_check` + `card` (and `RefundMethod` + `card`).
- **inventory_movements**: reason CHECK + `pos_sale` (`InventoryMovement::REASONS`; not in `MANUAL_REASONS`).
- `SmsTemplates::POS_RECEIPT = 'pos_receipt'`, added to `COUNTED` (allowance) but not to `EVENTS` (store SMS toggles);
  `resources/sms/{bn,en}.php` gain the template.

### 3.3 Locking (amends P4-12, PHASE-8-8C §3.3)
Sale: session row `FOR SHARE` (must be `open`) → store order advisory lock (existing) → stock rows at the register
location in `(variant_id, location_id)` order → coupon → customer → counter (existing placement order). Close: session
row `FOR UPDATE`, then aggregates; a sale waiting on the share lock after close sees `closed` → 409 `register_closed`.
Return: order row `FOR UPDATE` (existing `ReturnService` / `refund`), session `FOR SHARE` for a cash refund.

## 4. Registers and sessions (owner API, part A; `App\Domain\Pos\*`)
- **Registers** CRUD + `archive` / `unarchive`. List sorted by location (shops first), then position, then name; each
  carries `location {id, name, type}`, `open_session` (id, opened_by name, opened_at) or null, `last_session` (closed:
  closed_at, sales total, receipts, counted, variance, banked, left in drawer). Name unique among active (422
  `register_name_taken`); archived location → 422 `location_archived`; archive with an open session → 409
  `register_in_use`; 11th active → 409 `register_limit_reached`. Changing the location only without an open session.
- **Open** `POST …/pos/registers/{register}/open` `{counts?: {denomination: count}, opening_cash_amount?, note?}` →
  exactly one of the two (counts win; amount = Σ). 409 `register_already_open` (details.session_id). 201 `PosSession`.
- **Session** `GET …/pos/sessions/{session}`: header + live totals: `cash_in_drawer_amount` (expected), `cash_sales_amount`,
  `cash_refunds_amount`, `by_method[] {method, amount, count}`, `receipts_count`, `sales_amount` (Σ till-sale totals),
  `returns {count, amount}`, `discounts_amount`, `held_sales_count`, `last_closing_left_amount` (for the open hint
  "Matches last closing (৳ x left on {date})").
- **Close** `POST …/pos/sessions/{session}/close` `{counts | counted_cash_amount, left_in_drawer_amount, note?,
  revision}` → computes expected under the lock, variance, banked; 422 `close_note_required` when |variance| >
  tolerance and no note; deletes held sales of the register (count in the response and audit); → `closed`. Same
  `Idempotency-Key` replays. The response carries the Z-report figures (P88D-15) for printing.

## 5. The sale (owner API, part A)

### 5.1 Quote `POST …/pos/quote`
`{session_id, lines: [{variant_id, quantity}], coupon_code?, customer_phone?}` → `PosQuote` (lines with unit price,
compare-at, line total, available at the register location; subtotal, discount + coupon, VAT line, total, warnings per
line). Read-only, no locks. Used for the cart totals and the payment dialog ("Amount to pay").

### 5.2 Sale `POST …/pos/sales` (Idempotency-Key **required**)
Body `{session_id, lines (1–50), customer?: {phone, name?} | customer_id?, coupon_code?, expected_total_amount,
payments: [{method: cash|bkash_personal|card, amount, reference?}] (1–4), tendered_cash_amount?, sms_receipt,
held_sale_id?, note?}`. One transaction (§3.3):
1. Session open and in this store; register active; plan `pos`.
2. Price lines + coupon (P88D-7); `expected_total_amount` ≠ total → 409 `checkout_changed` with the fresh quote.
3. Payments: Σ = total (`pos_payment_mismatch`), cash part ≤ tendered (`cash_tendered_short`), at most one cash part.
4. `OrderPlacementService::pos(...)` (new entry point beside `manual`): order fields per P88D-2/P88D-10, lines with
   `location_id` = register location and the usual `unit_cost` snapshot, coupon redemption, customer link and counters
   (`orders_count`, `delivered_orders_count`, `total_spent_amount` + total), timeline `placed` (meta register, session)
   and `payment`, `notify = false`.
5. `InventoryService::sell(storeId, locationId, trackedLines, orderId, actorId)` (P88D-6); 422 `out_of_stock` with
   `details["lines.{i}.quantity"] = ["Only n left at {location}."]`.
6. Payments rows (P88D-9) with `pos_session_id`; `pos_sales` row; delete `held_sale_id` when given (same register).
7. After commit: webhooks `order.created`, `order.paid`; SMS receipt job when ticked and a phone exists.
Response 201 `PosSale` (order summary, lines, payments, tendered, change, `receipt: PosReceipt`, `sms_receipt_status`).

### 5.3 Catalog and lookup
- `GET …/pos/catalog?register_id&q&filter[category_id]&cursor` → active products (draft and archived hidden) with
  variants: price, compare-at, SKU, barcode, options, image, `available` at the register location (null = untracked),
  `in_stock`; 40 per page, sorted by name. Category chips = `GET …/categories` (existing).
- `GET …/pos/lookup?register_id&code` → exact, case-insensitive SKU then barcode match (≤ 64 chars, `%`/`_` literal) →
  one variant (added straight to the cart; skips the variant picker) or 404 `pos_code_not_found`.
- `GET …/pos/customers/lookup?phone` → exact normalised phone → `OrderCustomerSummary` or 404 `not_found`. Limiter
  `pos-lookup`. No list or partial search (that stays `customers.view`).

### 5.4 As built in part A (2026-11-25)
- **Coupons**: a free-shipping coupon has nothing to discount at the till → 422 `coupon_invalid` (`details.code`), as
  every other unusable code.
- **409 `checkout_changed`** (sale): `error.details.quote` = a fresh `PosQuote` and `details.expected_total_amount` =
  `["The total changed to ৳ x. …"]` (message list, like validation details). Other POS errors with plain values in
  `details`: `register_already_open` (`session_id`), `pos_payment_mismatch` (`total_amount`, `paid_amount`),
  `close_note_required` (`variance_amount`, `tolerance_amount`), `pos_code_not_found` (`code`). `ApiError.details` is
  widened accordingly (openapi 1.21.0, `packages/types`).
- **Unknown ids**: an id in the **path** that isn't in this store → 404 `not_found`; an id in the **body or query**
  (`register_id`, `session_id`, `variant_id`, `customer_id`, `location_id`, `filter[category_id]`) → 422
  `validation_failed` on that field (S195).
- **Plan limit**: till sales count toward `orders_per_month` (Growth is unlimited, so this only matters after a
  downgrade, where sales are already blocked by `pos`).
- **Part A placeholders until part B**: `held_sale_id` → 422 `validation_failed` for any non-null value;
  `PosSessionTotals.held_sales_count` is always `0`.

## 6. Money

### 6.1 Rules
All amounts integer minor units in the store currency; the till never converts. Totals use the existing order maths
(`total = subtotal − discount + shipping (0) + tax (0)`, VAT is printed as included). Change is never a payment row.

### 6.2 Cash in drawer
`expected = opening + Σ payments(session, method cash, type charge, succeeded) − Σ payments(session, method cash, type
refund, succeeded)`. The POS bar "Cash in drawer" polls the session every 30 s and after each write.

### 6.3 Payment rows
As P88D-9. Refunds at the till set `pos_session_id`; a refund made from the order page sets none and never touches a
drawer. Order detail's payments card shows "Till · Register 1" for rows with a session.

## 7. Receipts
`PosReceipt` (§5.2) is also returned by `GET …/pos/sales/{sale}`. Print layout: 80 mm wide, monospace-free tokens from
`packages/ui`, Figma receipt preview on `22:2241`. Language `en`/`bn` from the template; numbers in Latin digits (Q51).
SMS `pos_receipt` (en): "{shop}: Thank you! Receipt {number}, total {amount}, paid {method}. {footer}" (bn equivalent),
footer cut first when over 3 segments; S13 sanitising applies. Resend: `POST …/pos/sales/{sale}/sms-receipt` (part B
UI; API in A), limiter `pos-sms`, 422 `no_phone` for walk-in, 402 when the allowance is spent (`plan_limit_reached`,
existing).

## 8. Where till sales show (amends readers; every item has a test, S205)
- **Orders list / detail**: shown; tag "POS · {register}" (composed Tag `39:4554`); status Delivered, Paid; no courier,
  label or edit actions (already none for delivered); shipping address card hidden for `created_via = 'pos'`; payments
  card as §6.3. Filter `filter[created_via]=pos` added to the orders list (chip "POS", composed).
- **Dashboard** KPIs and **Sales report**: included (channel "Walk-in"); district / Dhaka-vs-outside breakdown skips
  them (P88D-22). **Profit & loss**: included by `delivered_at`, delivery cost 0, returns via existing return rules.
  **Delivery report**, **Shipments**, **COD settlement**: excluded (no shipment). **Nightly analytics (8.2)**: included
  in GMV and orders.
- **Customers**: counts and spent updated at sale; order history lists till sales with the tag.
- **Fake-order guard**: own-shop record excludes till sales (P88D-14). **Automations**: never triggered (P88D-13).
- **Storefront** order tracking and confirmation: till sales are never found (404). Storefront availability changes only
  when the register location is the online location (expected).
- **Exports / external API**: till sales appear with `created_via: pos`, `channel: walk_in`.
- **Invoices & labels**: label documents (`label_4x6`, single and bulk) refuse till sales with 422; invoice and
  receipt documents are allowed.
- **Returns** (5b flow and part B till returns): an `exchange` return of a till sale → 422 on `type` (P88D-17:
  exchange = return + new sale).
- **Fake-order guard** (as built): `ShopRecord` (a phone's own-shop delivered / returned counts) excludes till sales.

## 9. Part B — held sales, history, returns (owner API)
- **Held**: `GET …/pos/held-sales?register_id` (newest first; customer, items, total, note, held relative time,
  held by), `POST …/pos/held-sales` (201; 409 `held_sales_limit` over 20), `GET` / `DELETE …/pos/held-sales/{held}`.
  Plan on POST.
- **History**: `GET …/pos/sales?filter[date]=today|yesterday|7d|custom&from&to, filter[register_id],
  filter[method]=cash|bkash_personal|card|split, q` (order number or phone, exact) → `PosSaleSummary[]` (number, time,
  customer · items, paid by, total, returned amount) with `meta.summary {sales_amount, receipts_count,
  average_sale_amount, returns_count, returns_amount}` and cursor. `GET …/pos/sales/{sale}` → `PosSale` (+ returns).
  KPI definitions: sales = Σ till-sale totals in range − Σ till refunds in range; receipts = till sales count; average =
  sales ÷ receipts (rounded); returns = count and Σ refunds of till returns in range.
- **Return** `POST …/pos/sales/{sale}/returns` (Idempotency-Key required; `pos.sell` + `orders.refund`):
  `{session_id, lines: [{order_item_id, quantity}], refund_method: cash|bkash_personal|card, reason?, note?}` →
  P88D-17 in one transaction → 201 `PosReturnResult {sale, return_request, refund}`. Cash refund needs the session
  open and ≤ cash in drawer (422 `drawer_short`). Lines beyond sold − returned → 422 `validation_failed` (existing
  ReturnService messages).

## 10. Merchant API (openapi 1.21.0 binding; `routes/pos.php` + include line; merchant group; `{store}` scoped)

| Method | Path (`/api/v1/stores/{store}`) | Perm | Part · notes |
|---|---|---|---|
| GET | `/pos/registers` | `pos.sell` | A |
| POST | `/pos/registers` | `settings.manage` | A · plan; 201 |
| PATCH | `/pos/registers/{register}` | `settings.manage` | A |
| POST | `/pos/registers/{register}/archive` · `/unarchive` | `settings.manage` | A · unarchive plan-checked |
| POST | `/pos/registers/{register}/open` | `pos.sell` | A · plan; Idempotency-Key; 201 |
| GET | `/pos/sessions/{session}` | `pos.sell` | A |
| POST | `/pos/sessions/{session}/close` | `pos.sell` | A · Idempotency-Key; allowed after downgrade |
| GET | `/pos/catalog`, `/pos/lookup` | `pos.sell` | A |
| GET | `/pos/customers/lookup` | `pos.sell` | A · limiter `pos-lookup` |
| POST | `/pos/quote` | `pos.sell` | A · plan |
| POST | `/pos/sales` | `pos.sell` | A · plan; Idempotency-Key; 201 |
| GET | `/pos/sales`, `/pos/sales/{sale}` | `pos.sell` | A (detail, used by Sale complete) · B (list + filters) |
| POST | `/pos/sales/{sale}/sms-receipt` | `pos.sell` | A · plan; limiter `pos-sms` |
| POST | `/pos/sales/{sale}/returns` | `pos.sell` + `orders.refund` | B · plan; Idempotency-Key; 201 |
| GET / POST | `/pos/held-sales` | `pos.sell` | B · POST plan; 201 |
| GET / DELETE | `/pos/held-sales/{held}` | `pos.sell` | B |

Orders list gains `filter[created_via]` (`storefront|dashboard|pos`). Shapes: `PosRegister`, `PosRegisterInput`,
`PosSession`, `PosSessionStatus`, `PosSessionTotals`, `PosDenominationCounts`, `OpenPosSessionInput`,
`ClosePosSessionInput`, `PosCatalogItem`, `PosCatalogVariant`, `PosQuoteInput`, `PosQuote`, `PosSaleInput`,
`PosPaymentInput`, `PosPaymentMethod`, `PosSale`, `PosSaleSummary`, `PosSaleListMeta`, `PosReceipt`, `PosHeldSale`,
`PosHeldSaleInput`, `PosReturnInput`, `PosReturnResult`; `PermissionKey` + `pos.sell`; `StockMovementReason` +
`pos_sale`; `RefundMethod` + `card`; `Payment.method` + `card`, `Payment.pos_session_id`; new `OrderPaymentMethod` (= `PaymentMethod` + `pos`) on
`OrderSummary.payment_method` (checkout's `PaymentMethod` unchanged);
`OrderSummary.created_via` + `pos`, `OrderSummary.pos {register_id, register_name} | null`.
Errors (new): `register_name_taken` (422), `register_limit_reached` (409), `register_in_use` (409),
`register_already_open` (409, details.session_id), `register_closed` (409), `register_archived` (422),
`pos_payment_mismatch` (422, details.total_amount / details.paid_amount), `cash_tendered_short` (422),
`close_note_required` (422, details.variance_amount / details.tolerance_amount), `drawer_short` (422),
`held_sales_limit` (409), `pos_code_not_found` (404, details.code), `no_phone` (422). Existing: `out_of_stock`,
`checkout_changed`, `location_archived`, `feature_not_in_plan`, `plan_limit_reached`, `revision_conflict`,
`idempotency_key_*`, `invalid_state_transition`, `impersonation_read_only`.
Limiters: `pos-write` 120/min per user (every POS write), `pos-lookup` 30/min per user, `pos-sms` 10/min per user.

## 11. Merchant dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`, page `22:1736`
Routes `/pos` (register picker / open register when no session is chosen), `/pos/:sessionId` (sale screen),
`/pos/:sessionId/close`, `/pos/history` (B). The POS uses the app shell with the collapsed 72 px sidebar (`12:799`).
The last chosen register is remembered per browser (`localStorage`, convenience only).

### 11.1 Open register `25:581` (section `27:1025`, part A)
Title "Open register" + "Count the cash in the drawer before the first sale"; Register select (+ "Add register"
composed: dialog name + location, `settings.manage` only), Cashier (signed-in member, read-only — Q238); denomination
table NOTE / COIN · COUNT · AMOUNT with the P88D-15 list; Opening cash total with "Matches last closing (৳ x left on
{date})" (or "Last closing left ৳ x" in warning tone when different); **Open register and start selling**. Side cards:
**Registers** (each: name · location, "Closed · ready" / "Open · {name} · since {time}", pill Closed neutral / Open
success; clicking an open one joins its session) and **Last session · {date}** (Sales "৳ x · n receipts", Counted at
close, Variance, Banked, Left in drawer). Empty: no registers → "Create Register 1 at {default location}" (composed,
`148:34032` empty pattern).

### 11.2 Sale `22:1737` (section `27:1026`, part A; overview copy `26:2147` / `12:798`)
POS bar: "Point of sale", "{register} · {location} · Opened {time} by {name}", status pill (P88D-21), **Cash in
drawer** tile, **Hold sale** (B; hidden in A), **Close register**. Catalog: search box "Search products or scan a
barcode" (Enter = lookup; exact match adds, else filters), barcode icon (focus only), category chips (All + store
categories, horizontal scroll), product tiles (image, name, price, "n in stock" / "Out of stock" disabled — stock at the
register location). Cart "Current sale" + Clear (confirm when > 0 lines); customer row (phone input → lookup card
"{name} · {phone}" / "{n} orders · ৳ x spent · {tier}" + Change; "Add customer" composed; walk-in default); lines with
image, name, "{options} · ৳ price", − qty +; totals card (Subtotal · n items, Discount · {code} with a composed "Add
coupon" link, VAT line per P88D-8, Total); Payment method chips Cash / bKash / Card / Split; quick cash chips (exact,
next two round notes); **Charge ৳ x**; caption "Receipt prints on 80 mm · SMS receipt to customer". **Hidden**: "Scanner
ready" tag.

### 11.3 Variant picker `22:1905` (part A)
Dialog "Choose options" + "Scan a variant barcode to skip this step"; product header (image, name, "SKU {sku} ·
{description first line}", price + struck compare-at, "{options} · n in this shop"); option groups as chips with "n
left" / "Out" (disabled); quantity stepper; **Add to sale · ৳ x**.

### 11.4 Payment `22:2073` (part A)
Dialog "Take payment" + "{customer} · n items · {register}"; Amount to pay + subtotal/discount; method cards Cash
(Drawer) / bKash (QR or number) / Card (POS terminal) / Split (Mix methods); Cash: "Cash received" input, chips Exact /
next round notes, numpad, "Change to give ৳ x" + "Give 1 × 200, 2 × 100, …" (greedy over P88D-15 denominations,
client); bKash / Card: composed reference field ("TrxID (optional)" / "Approval code (optional)"); Split: composed rows
(method + amount, remaining shown, ≤ 4); ticks **Print receipt**, **SMS receipt**; **Complete sale · ৳ x**. **Hidden**:
"Open drawer" tick (Q240).

### 11.5 Sale complete `22:2241` (part A)
"Sale complete", "Receipt {number} · paid in {method}", "Give change ৳ x" (cash), rows "Printed on 80 mm printer ·
Reprint" and "SMS receipt sent to {phone} · Resend" (states: sending / sent / failed / not sent), **New sale** (+ "Press
Enter to start a new sale"); receipt preview (P88D-11) with the template's header, BIN, lines, totals, payment,
change, footer.

### 11.6 Held sales `22:2409` (section `27:1027`, part B)
Drawer "Held sales" + "Park a sale and serve the next customer"; search "Search by customer or note" (client filter);
cards: customer or "Walk-in customer", "{phone} · n items", total, "Held {relative} · “{note}”", **Resume** / **Delete**;
footer note with the P88D-16 copy. "Hold sale" in the POS bar opens a composed note dialog (optional note).

### 11.7 Sales history `27:754` (part B)
Header "Sales history", "{register} · {location} · Today", **Back to sale**; KPI tiles Sales today / Receipts / Average
sale / Returns; filters: "Receipt no. or phone", date (Today / Yesterday / Last 7 days / custom, composed), All
registers, All methods; table RECEIPT · TIME · CUSTOMER · ITEMS · PAID BY · TOTAL (Return rows: Tag "Return", negative
total); detail panel "Receipt {number}", "{date} · {time} · {cashier} · {register}", pill Paid / Partly refunded /
Refunded, customer, lines, totals, Cash received / Change given, **Reprint**, **Send SMS**, **Return items** (dialog
composed: per-line quantity ≤ returnable, refund method, reason; needs `orders.refund`, else hidden). **Hidden**: "Void
receipt (manager PIN)"; "Return or exchange items" relabelled **"Return items"** (Q250).

### 11.8 Close register `25:829` (section `27:1028`, part A)
Header "Close register" + "Count the drawer, check the difference, then print the end-of-day report."; **Back to sale**;
count table (P88D-15 list) + Counted; **Cash check** card: Opening cash, + Cash sales, − Cash refunds, Expected in
drawer, Counted, banner "Short by ৳ x" / "Over by ৳ x" / "Drawer matches" with "Within your ৳ 50 tolerance. Add a note
if you know why." or "Over your ৳ 50 tolerance — add a note to close." (danger); Note (optional / required); **Leave in
drawer** amount (composed) and "Banked ৳ x" line (composed); **Today's sales** card: n receipts, Cash / bKash / Card
(+ Split shown by its parts), Returns, Discounts given, Total sales; warning when held sales exist ("n held sales will be
deleted"); **Print Z-report** (browser print of the session totals, 80 mm), **Close register** (confirm). After close →
`/pos` with the register "Closed · ready".

### 11.9 States, permissions, mobile
Loading / empty ("No sales yet today", "No held sales", "No products match — try another name or scan the barcode") /
error per `148:34032`; out-of-stock and price-changed errors inline on the cart line with "Refresh cart". Members
without `pos.sell` don't see POS in the sidebar or More (`/pos` → 403 page). Free/Starter: plan note (§2.2). Mobile per
P88D-24 (390 px: catalog grid 2 columns, cart bottom sheet, sticky Charge bar, full-screen dialogs).

## 12. ARCH and types (owner ARCH)
**Types first**, per part. Part A: openapi **1.21.0**, `packages/types` (§10 shapes, enum additions, `PERMISSIONS` catalogue + `ORDER_CREATED_VIA`),
`packages/api-client` (`pos.registers.*`, `pos.sessions.*`, `pos.catalog`, `pos.lookup`, `pos.customerLookup`,
`pos.quote`, `pos.sales.create/get/smsReceipt`, orders `created_via` filter), ADR 0025, DATABASE-DESIGN §5.11
(+ replace the §6 POS sketch row), SECURITY T42 (S195–S207), MULTI-TENANCY count 91, PHASE-7 §2.1 `pos` row, PHASE-8-3
catalogue note, FIGMA-INDEX rows for `27:1025`–`27:1028`, RUNBOOK (register won't open: close the stale session; cash
difference investigation; printer setup for 80 mm), roadmap. Part B: openapi 1.22.0 if shapes change, types + client
(`pos.sales.list/returns`, `pos.held.*`).

## 13. Security checklist (S195–S207; each has a test)
Part A:
- **S195** isolation: registers, sessions, till sales, held sales, and every `register_id`, `session_id`, `location_id`,
  `variant_id`, `customer_id`, `held_sale_id`, `order_item_id` in paths, bodies and filters resolve within tenant + store
  → 404 / 422; RLS on the four tables; `assertTenantIsolation` + `assertStoreIsolation` for each resource.
- **S196** permissions: every POS route needs `pos.sell` (register writes `settings.manage`, returns + `orders.refund`);
  O/A/S/C matrix; impersonation writes 403 `impersonation_read_only`; no API-key route reaches POS.
- **S197** plan: Free/Starter → 402 on every write in §2.2; downgrade keeps reads and close working.
- **S198** price integrity: no client price is read; a changed price/coupon between quote and sale → 409
  `checkout_changed`; coupon limits enforced by phone; total maths equals `orders_total_check`.
- **S199** stock integrity: a sale never takes the register location below its available (`on_hand − committed`) — race
  of two till sales and a storefront checkout on the same location (Postgres); never below zero; ledger `pos_sale` per
  stock row; untracked variants skip stock; a sale never touches another location.
- **S200** idempotency: the same `Idempotency-Key` + body on sale / open / close replays the first response (one order,
  one ledger row per line, one set of payments); a different body → 409 `idempotency_key_mismatch`.
- **S201** cash integrity: Σ payments = total; cash ≤ tendered; change = tendered − cash; expected drawer computed only on
  the server; one open session per register (race on open); sale vs close race → sale 409 `register_closed` or
  counted in the close, never lost; variance and tolerance rule; left ≤ counted.
- **S202** session binding: a sale or return must name an open session of an active register of this store; the cashier
  is the actor (not a body field); a session of another register in the same store can be used only by naming it
  (no implicit default).
- **S203** customer lookup: exact normalised phone only, no partial or list search, limiter `pos-lookup`; a 404 for an
  unknown phone is indistinguishable in timing class from a hit (no extra queries); data limited to
  `OrderCustomerSummary`.
- **S204** SMS receipt: sent only to the sale's phone; fixed template, S13 sanitising; counted in `sms_per_month`;
  limiter `pos-sms`; resend never re-sends to a changed number.
- **S205** reader safety: walk-in sentinels never reach courier booking, label printing, storefront tracking, fraud-guard
  records or automations; Sales report district breakdown, Delivery report, Profit & loss and Dashboard tested with a
  walk-in till sale; static test: every `district_code` / `shipping_address` reader is on the allow-list.
Part B:
- **S206** returns: quantity ≤ sold − returned (race: two returns of the same line); restock at the line's stored
  location; refund ≤ paid − refunded; cash refund needs an open session and ≤ cash in drawer; needs `orders.refund`.
- **S207** audit + held sales: every P88D-23 action with the actor; held sales of another register can't be resumed
  into this sale (`held_sale_id` must match the register); held-sale lines re-priced and re-checked on sale; held sales
  deleted on close.

## 14. Test requirements
**API (Pest)**: group `pos` (+ `rls`, `security`, `race`): every §10 route (happy, validation, authz, isolation with
`assertTenantIsolation` / `assertStoreIsolation`); sale vectors (cash with change, bKash with TrxID, card, split
cash+bKash, coupon, walk-in, new customer by phone, existing customer counters); order shape (`delivered`, `paid`,
timestamps, `created_via pos`, lines' `location_id`, `unit_cost`); `InventoryService::sell` (available, untracked,
backorder ignored, lock order); readers matrix (S205); Profit & loss + Sales report with till sales; open/close maths
(denominations, tolerance, note rule, banked/left, held deletion); Postgres races (S199, S201 open, sale vs close; B:
S206); idempotent replays; SMS receipt job (allowance, sanitising, no phone); plan/downgrade; part B held sales,
history KPIs, returns (cash from drawer, non-cash, drawer short, permission). All existing order, inventory, returns,
reports, automations and fraud-guard tests unchanged and green.
**Web (Vitest)**: register picker + add register; open register counts → total; sale screen: catalog paging, chips,
search vs scan (Enter), out-of-stock tile, variant picker, cart qty/clear, customer lookup states, coupon, totals from
quote; payment dialog: numpad, quick cash, change + note breakdown, split remaining, reference fields, disabled while
offline; idempotency key reused on retry and replaced after success; sale complete + receipt render (en/bn, BIN, VAT,
footer) + print call; close register maths, tolerance banner, note required, leave/banked; plan note; permission
gating; B: held sales list/resume/delete, history filters + KPIs + detail, return dialog maths.
**QA (Playwright)**: A `phase8-8d-a.spec.ts`: Growth store opens Register 1 with counts, sells cash with change (stock at
the shop location −2, online location unchanged when different), sells split cash + bKash, walk-in card sale, SMS
receipt queued (fake driver), order appears in Orders with "POS" tag and in Sales report, close with ৳ 20 short + note
→ last session card; double-click Charge makes one order; Starter store sees the plan note; staff without `pos.sell`
has no POS; 390 px screenshots of sale, payment, close. B `phase8-8d-b.spec.ts`: hold two sales, resume one and
complete, delete one; history KPIs and detail; return one item for cash → drawer expected drops, stock back at the
shop; close warns about held sales.
**QA infra**: CI Pest step for group `pos` on sqlite, Postgres, RLS; race test names added to `api-perf` / `api-rls`
lists; E2E keeps the fake SMS driver.

## 15. File ownership

| Agent | Owns (create/edit) |
|---|---|
| **API (Laravel)** | `apps/api/**` only: `app/Domain/Pos/**` (new: registers, sessions, sales, held, returns orchestration, presenters, requests, policies, `PosServiceProvider` with limiters), `routes/pos.php` + include line in `routes/api.php`, migrations `2026_12_10_*`, `config/pos.php`, `Inventory/InventoryService.php` (`sell`) + `InventoryMovement` reasons, `Orders/OrderPlacementService.php` (`pos` entry), `Orders/OrderPresenter.php` (`pos` block), orders list filter, `Orders/Notifications/**` (`pos_receipt`), `resources/sms/*.php`, `Payments` method `card` + `pos_session_id`, `Reports/SalesReport.php` / `DeliveryReport.php` readers, `FraudGuard/**` record exclusion, `Automations/**` trigger exclusion, `Storefront` tracking exclusion, `Documents/**` label exclusion, `Billing/Feature` gate, `Tenancy/Authorization/*` (key, system role, route map), `AuditLogger` subject types, `RlsTables`, `rls-emergency-off.sql`, tests |
| **WEB (React)** | `apps/merchant-dashboard/**`: `src/pos/**` (new), `src/layout/nav.ts` (POS `requires`), `src/pages/MorePage.tsx`, `src/orders/**` (POS tag, created_via chip, hidden address card), `src/staff/**` (catalogue fixture), `App.tsx`, fixtures/tests; `packages/ui/**` only for a shared piece (numpad, denomination table) after ARCH agrees |
| **Next.js (storefront)** | **No change** (`apps/storefront/**` untouched). Till sales never appear on storefront pages; storefront availability already reads the API. Reviews that order tracking returns "not found" for a till order number (API test covers it) |
| **ARCH** | `docs/**` except `docs/reviews/**`, TESTING.md, FIGMA-INDEX.md and AGENT-CONTRACTS.md (proposed edits go to their owners); `packages/types/**`, `packages/api-client/**` (as in 8.8c) |
| **QA** | `tests/e2e/**` (`phase8-8d-a.*`, `phase8-8d-b.*`, helpers), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-8d-{a,b}-qa.md` |

Shared-read rules: re-read `InventoryService.php`, `OrderPlacementService.php`, `OrderService.php`, `ReturnService.php`,
`routes/api.php`, `nav.ts` before each Edit.

## 15.1 Order of work (per part)
1. ARCH: types + api-client, then openapi final, ADR 0025 Accepted, docs.
2. API (A): migrations + RLS → `InventoryService::sell` → `OrderPlacementService::pos` → registers + sessions → quote +
   sale + payments → catalog/lookup/customer lookup → readers (§8) + static test → SMS receipt → plan, permission,
   limiters, audit. API (B): held sales → history + KPIs → returns orchestration → races.
3. WEB (A): register picker + open → sale screen + variant picker → payment → sale complete + receipt print → close +
   Z-report → orders tag. (B): hold + held drawer → history + detail → return dialog.
4. QA: specs + CI group while the others build; gate after all are green, per part.

## 16. Acceptance criteria
1. A store without `pos` (and every existing flow) behaves exactly as before; all pre-existing tests pass unchanged.
2. A register opens with a counted float, sells, and closes with counted cash; expected cash, variance, banked and left
   in drawer are computed on the server and match the ledger of payments (S201).
3. Every till sale is one delivered, paid order with `created_via = 'pos'`; it appears in Orders, Dashboard, Sales
   report and Profit & loss, and never in delivery, courier, storefront-tracking, fraud-guard or automation flows
   (S205).
4. Stock for a till sale leaves only the register's location, never beyond its available, through `InventoryService`
   with reason `pos_sale` (S199); a retried or double-tapped sale makes one order (S200).
5. Payments: cash with change, bKash, card and split are recorded as manual payment rows bound to the session; Σ =
   total (S201).
6. Receipts print at 80 mm from the browser and SMS receipts respect consent tick, allowance and sanitising (S204).
7. Part B: held sales park and resume without reserving stock; sales history KPIs match the orders; returns restock at
   the shop and refund from the drawer with `orders.refund` (S206, S207).
8. Figma `25:581`, `22:1737`, `22:1905`, `22:2073`, `22:2241`, `22:2409`, `27:754`, `25:829` match with the documented
   omissions and composed items; loading/empty/error; 390 px usable.
9. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `pos`, `rls`, `security`, `race`),
   Playwright `phase8-8d-*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

## 17. Figma notes for the PO (product owner)
- Denomination lists differ between Open (`25:581`: no ৳ 200 / ৳ 1) and Close (`25:829`: no ৳ 2 / ৳ 1); one list is used
  (P88D-15).
- Close (`25:829`) has no "left in drawer" input although Open and "Last session" rely on it; composed (Q245).
- Close shows "− Cash refunds ৳ 440" while history shows a ৳ 450 return; example numbers only.
- "Loyal" is not an existing customer label; the own-shop tier is shown (Q252).
- Held sales copy promises a 30-minute stock reservation; changed (Q242).
- Close (`25:829`): the counts shown total ৳ 13,910, not the "Counted ৳ 14,800" printed beside them; the screen sums
  the counts.
- Receipt preview (`22:2241`) shows a barcode; not built (no new dependency allowed).
- Variant picker (`22:1905`) colour dots are not built (variants carry no colour value); colour options show as text
  chips.
- Open register: `PosLastSession` has only the left-in-drawer **amount**, not its counts, so the count table is
  prefilled greedily from that amount (largest notes first) and the cashier corrects it.
- "Open drawer", "Scanner ready", "Void receipt (manager PIN)" and the Cashier select are hidden or read-only
  (Q240, Q225, Q250, Q238).

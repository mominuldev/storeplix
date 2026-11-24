# Phase 8.8a contract: Fake-order guard (binding for ARCH, API, WEB, QA)

Status: **Accepted, 2026-11-24 — PO set the scope (own-shop data only, hold flag, six rules incl. OTP, one risk
everywhere) and accepted the proposed defaults for Q184–Q199**. Branch `feat/phase-8-8-fake-order-guard` (from `feat/phase-8-7-expenses`
@ 04037b7; rebase onto `main` once 8.6 (`chore/dev-ports`, PR #11) and 8.7 merge).
Roadmap task **8.8** is split: this file is **8.8a "fake-order guard"** only. Inbox, POS, multi-location, suppliers,
purchase orders and transfers (8.8b+) are **not** in this contract and still wait for Q1.
AC: **"Every new COD order of a guarded store gets one explained risk check; risky orders are held or asked for an
advance before anyone can book a courier; blocked and over-limit numbers can't place COD orders; new numbers verify by
OTP; nothing about a shopper comes from another shop"** (§16).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-7 contracts and
docs/api/API-CONVENTIONS.md still applies (envelope, snake_case, ULIDs, cookie sessions, `BelongsToTenant` /
`BelongsToStore`, RLS, FeatureGate, `perm:` on every tenant route, audit log, money in minor units). PHASE-5B P5B-22
(payment links) applies in full and is the advance mechanism. **PHASE-8-5 P85-25 (`CustomerRisk`) is replaced** by §3.3
(PO, 2026-11-24: "one risk everywhere"); every changed classification is listed in §6.6. Where this file changes an
earlier rule it says **"amends …"**. Machine-readable spec: `docs/api/openapi.yaml` **v1.16.0**. ADR **0022** (new:
fake-order guard — own-shop signals, hold flag, checkout OTP). Product defaults: OPEN-QUESTIONS
**Q184–Q199**.

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-8-qa.md`). No external call, no new provider, dependency or queue.

| Area | Owner | Ships |
|---|---|---|
| **Delivery record** | API | Per-phone record from this shop's own orders, shipments and returns (§3) |
| **Risk tiers** | API | `good` / `careful` / `risky` / `new` from the record and the store's thresholds; replaces `CustomerRisk` (§3.3) |
| **Order checks** | API | `order_risk_checks` (one per order), decision, reasons, `guard_hold` flag on orders (§4, §5) |
| **Holds + advance** | API | Hold for a call or ask an advance (existing payment link); confirm/booking refused while held; release (§6.1–§6.2) |
| **Checkout rules** | API/SF | Blocklist + repeat returners → COD off for that number; per-phone daily limit; OTP for new numbers on COD (§7) |
| **Duplicates** | API | Same phone + same variant within the window → flagged and held (§5.2) |
| **Settings + log** | API/WEB | Guard settings (8 rules, 6 built), decision log, KPIs, blocklist UI (§6.4, §10.1) |
| **Order UI** | WEB | Risk badge + column + filter, hold banner + actions, Delivery record card, "Ask for an advance" modal (§10.2) |
| **Storefront** | SF | OTP step and the "COD not available" state on checkout (composed; no Figma) (§10.4) |
| **Plan + permission** | API | Enforce the existing `fake_order_guard` feature (Starter, Growth); new key `fraud.manage` (§2) |
| **Docs + types** | ARCH | openapi 1.16.0, `packages/types`, `packages/api-client`, ADR 0022, DATABASE-DESIGN §5.8, SECURITY T38, API-CONVENTIONS, MULTI-TENANCY, PHASE-8-5/8-6 notes, OPEN-QUESTIONS, FIGMA-INDEX, RUNBOOK, roadmap (§11) |
| **QA** | QA | Playwright `phase8-8.*`, CI Pest group `fraud`, TESTING.md, gate report (§13) |

**Out of scope** (hide, never fake): any cross-shop data — "Delivery record across Storeplix" `64:16955`, the
super-admin Risk network `39:13391`, shared blocklists (Q23 stays "not built"); **Steadfast and RedX records** (no
official API; panel-login scraping is refused, Q185); VPN/proxy rule (needs an IP-intelligence provider, Q190); a new
"On hold" order **status** (PO: Pending + flag); Automations recipe "Hold risky COD orders", condition "Courier success
rate", tile "Risky orders held" (stay hidden; the guard is the one source of truth, Q193); outbound webhook events for
holds (Q194); call-outcome log ("Sumi called — no answer"); "Delivery charges saved" KPI (a counterfactual, Q191);
WhatsApp payment links; Settings → Payments "Advance payment rules" `63:14369` (order-total and first-order rules;
Q192); checkout CAPTCHA (T16); merchant health score (Q105); ML scoring; automatic cancellation by the guard itself
(only the existing "cancel if the advance isn't paid" link option cancels).

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- "Phone" = `Phone::bdMsisdn` form `8801XXXXXXXXX` (as stored on orders/customers). Every lookup normalises first.
- "Record" = a phone's parcel outcomes: **delivered** and **returned** counts (cancelled-before-shipping doesn't count).
- "Rate" = delivered ÷ (delivered + returned), whole percent rounded half down; null when the total is 0.
- "Check" = one `order_risk_checks` row (one per order). "Decision" = what the guard did with it (§5.3).
- "Hold" = `orders.guard_hold` not null; the order stays in its status (`pending`) — **no new order status**.
- "Guarded store" = plan has `fake_order_guard` **and** `fraud_guard_settings.enabled`.
- "Today" / "day" = store timezone. Windows in hours are rolling.
- `[S]` = store-scoped table (`BelongsToStore`, composite FK `(tenant_id, store_id) → stores`).
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**, storefront **:3010**.

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§14). Before every Edit of a shared-read file, re-read it (another agent may have
  changed it).
- New dependencies: **none**.
- Never `migrate:fresh` the local dev DB; use Pest or a scratch DB. RLS items run on Postgres with `TENANCY_RLS=true`.
- No real courier or SMS calls in tests: `couriers.fake` and the fake SMS gateway.

---

## 0. Summary and goals
COD fake orders cost Bangladeshi merchants a delivery charge and a return each time. The guard checks every new COD
order against the buyer's delivery record (this shop's own parcels only), then lets it through, holds it for a call, or asks for the delivery charge in advance through
the payment link that already exists (paid → the order confirms itself). At checkout it switches COD off for blocked
numbers and over-limit numbers and verifies new numbers by SMS code. One risk tier is used everywhere (orders,
customers, campaigns, automations). The merchant sees why every decision was made and can override it. Nothing comes
from other Storeplix shops or from any courier.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P88-1 | **Data source** (PO 2026-11-24): the record = this store's **own** orders, shipments and returns only. No courier lookups (Pathao, Steadfast, RedX) and no data from other shops | Q23 (cross-tenant personal data) is undecided; no courier offers an official per-phone API; nothing leaves the platform |
| P88-2 | **Hold = flag, not status** (PO): `orders.guard_hold` ∈ `call_first`, `advance`, `checking`, null. A held order stays `pending`; `confirm`, bulk confirm, courier booking and the `pending → confirmed` path of the external API answer **409 `order_held`** until released. A paid advance link releases and confirms (P5B-22 unchanged) | Figma guard copy "waits in Pending with a Call first tag"; avoids touching the state machine, CHECK, types, reports and webhooks |
| P88-3 | **One risk everywhere** (PO): `App\Domain\FraudGuard\RiskTier` replaces `CustomerRisk` (P85-25). The same own-shop record drives the customer tier (campaigns, automations, customer pages; SQL over counters for audiences) and the order check | One meaning of "risky" in the product |
| P88-4 | **Tier rule** (§3.3): total = 0 → `new`; total < `min_parcels` (default 3) → `careful` if returned ≥ 1 else `good`; else rate < `hold_below` (60) → `risky`; rate < `advance_below` (75) → `careful`; else `good`. Thresholds are the store's guard settings (defaults when the store has none) | Research: no ratio verdict on thin history; Figma lines 60 % / 75 % |
| P88-5 | **Decision order** at check time (first match wins): duplicate → `hold call_first (duplicate)`; `risky` + hold rule on → `hold call_first`; (`risky` with hold off, or `careful`) + advance rule on + connected gateway → `advance` (payment link, `delivery_charge`, expiry 1 440 min, cancel-if-unpaid per setting); advance wanted but no gateway → `hold call_first (no_gateway)`; else `none` | Figma GS-1041 "Held · advance" ambiguity resolved: one action, explained; no gateway never silently passes |
| P88-6 | **When**: storefront **COD** orders of a guarded store get a check **with actions**; manual (dashboard) orders and online-paid orders get a check **without actions** (badge and record only); exchanges are skipped. Placement sets `guard_hold = 'checking'` in the placement transaction; `CheckOrderRisk` (TenantAware, queue `default`, `$timeout` 60) runs after commit and replaces it with the decision | Merchant can't confirm before the check finishes; no external call inside checkout |
| P88-7 | **No courier record** (PO): Figma's per-courier bars (Steadfast / Pathao / RedX), the "Check courier record on every order" rule and the courier "Fraud check" tab are hidden | PO chose own-shop data only |
| P88-8 | **Record by phone, not by customer row**: computed from orders/shipments/returns of this store with that phone (a phone may have no customer yet); the check stores the numbers it used | Explainable, reproducible |
| P88-9 | **Blocklist** `blocked_phones` [S]: manual (reason + note) or automatic (`repeat_returns`). A blocked phone can't place a **COD** order: checkout 422 `cod_unavailable` (neutral message); online payment still works; manual orders by staff are not refused but checked and badged `blocked` | Figma "Cash on delivery is off for these numbers. They can still pay online." |
| P88-10 | **Repeat returners**: when a phone's own-shop returned count reaches `block_after_returns` (default 3) and the rule is on, an automatic block is added (source `auto`, reason `repeat_returns`), once; a merchant unblock is remembered (`unblocked_at`) and the rule never re-adds that phone | Figma rule "Block after 3 returns"; respects the merchant's override |
| P88-11 | **Daily limit**: the (`daily_limit` + 1)-th storefront COD order of a phone in one store day → checkout 422 `order_limit_reached` ("You've reached today's order limit for cash on delivery. Please pay online or try tomorrow."); no permanent block (Q188) | Figma shows auto-blocks for the limit; a permanent block for one busy day is harsh |
| P88-12 | **Duplicates**: a storefront order whose phone has another non-cancelled order in the window (default 24 h) containing the **same variant** → decision `hold call_first`, reason `duplicate`, `duplicate_of` = that order; never auto-cancelled | Figma "flagged as a duplicate, not shipped twice" |
| P88-13 | **Checkout OTP**: when the rule is on and the order is COD and the phone is **new to this store** (no customer with ≥ 1 delivered order), checkout requires a 6-digit code: `POST /storefront/checkout/otp` sends it (SMS template `checkout_otp`, counts against `SmsPerMonth`), `POST /storefront/checkout` carries `otp_code`; missing → 422 `otp_required`, wrong → 422 `otp_invalid`. 5-minute TTL, hashed (HMAC), 5 attempts, resend 60 s, 5 sends per phone per hour per store, 20 per IP per hour. Allowance exhausted or SMS failure → **fail open**: no OTP, the order is placed and held `call_first (otp_unavailable)` | Figma rule "New numbers only", 6 digits (Q186); never lose a sale to an SMS outage |
| P88-14 | **Permission** `fraud.manage` (new, group `orders`, sensitive, O ✓ A ✓ S ✗): guard settings, blocklist, "Check a number", decision log. Releasing a hold, asking an advance and confirming stay `orders.process`; seeing tiers/records on orders and customers stays `orders.view` / `customers.view` | Settings and the lookup oracle are sensitive; daily order work isn't |
| P88-15 | **Plan**: enforce the seeded `fake_order_guard` (Starter, Growth). Without it: no checks with actions, no checkout rules, settings read-only with an upgrade note; **tiers and own-shop records still show** (they replaced the 8.5 rule, which had no plan gate) | Existing seed (PHASE-2 §2, PHASE-7 P7 "when a module lands, its contract adds the gate") |
| P88-16 | **Privacy**: no phone leaves the platform; checkout shows one fixed sentence under the cash-on-delivery note (Q189; the privacy page is merchant-written); no phone in logs (masked) | PDP Act 2026; SECURITY T38 |
| P88-17 | **Audit**: settings changes, block/unblock, release, override confirm, check-a-number are audited (`fraud.*`); automatic decisions write `order_events` type `guard` (actor `system`) and `fraud_guard_events` (§4) | Every hold must be explainable |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q184–Q199; proposed defaults, awaiting the PO)

| Q | Question | Proposed default |
|---|---|---|
| Q184 | Split roadmap 8.8 into 8.8a (this) and 8.8b+ (Inbox, POS, suppliers/POs/transfers)? | Yes; 8.8b+ wait for Q1 |
| Q185 | Courier records (Steadfast / Pathao / RedX) | Not built; PO chose own-shop data only; rows and rule hidden |
| Q186 | OTP length and scope (Figma: guard 6 digits "new numbers only"; Settings 4 digits "COD above ৳ 1,500") | 6 digits; COD orders from numbers with no delivered order at this shop; no amount rule |
| Q187 | Tier thresholds and grace | Hold below 60 %, advance below 75 %, no verdict below 3 parcels (P88-4) |
| Q188 | Daily limit hit: refuse only, or also block permanently (Figma "Auto · Daily limit")? | Refuse that order only (P88-11) |
| Q189 | Storefront privacy sentence | "To prevent fake orders, we check your phone number's delivery record with this shop." |
| Q190 | VPN / proxy rule (Figma, off by default) | Hidden; needs a provider |
| Q191 | "Delivery charges saved" KPI is an estimate | Replaced by "Advance collected" (real, from paid guard links); "Orders checked" and "Fake orders stopped" kept |
| Q192 | Settings → Payments "Advance payment rules" (order-total, first-order rules) and its "If customer is Risky…" rule | Not built in 8.8a; the guard's advance rule is the only automatic advance |
| Q193 | Automations "Hold risky COD orders" recipe and "Risky orders held" tile | Stay hidden; the guard owns holds |
| Q194 | Webhook events for holds (`order.held`) | Not in 8.8a |
| Q195 | Fraud check tab on courier pages `29:2562` | Hidden on every courier (no courier record, P88-7) |
| Q196 | Manual orders on blocked numbers | Allowed (staff decided), badged `Blocked` |
| Q197 | Holds and the "order received" SMS | Unchanged: the order SMS still goes at placement; the advance link SMS follows (P5B-22) |
| Q198 | Free-plan stores | No checks/rules; tiers and own-shop records visible; guard page shows an upgrade note |
| Q199 | Later guard features (record only) | Cross-shop network and super-admin Risk network (Q23), Steadfast/RedX, VPN, Turnstile, call-outcome log, holds webhooks, advance rules by order total, ML score |

## 2. Permission and plan

### 2.1 Permission (amends PHASE-8-3 §2.1 catalogue: 25 grantable keys + owner-only `billing.manage`)
New case `Permission::FraudManage = 'fraud.manage'`, placed after `OrdersRefund` in catalogue order, group `orders`,
label **"Fake order guard"**, description "Guard rules, blocked numbers and number checks", `sensitive() = true`,
`requires() = [OrdersView]`. `SystemRole`: Owner ✓, Admin ✓, Staff ✗. Existing custom roles don't gain it.
`PermissionCatalogueTest` (25 → 26 cases, grantable 24 → 25, sensitive list), `PermissionEnforcementTest`,
`RoutePermissionsTest`, the parity fixture and `roles.fixtures.ts` gain it.

### 2.2 Plan (amends PHASE-7 §2.1 row `fake_order_guard`: "not enforced" → enforced)
| Key | Free / Starter / Growth | Checked at | Without it |
|---|---|---|---|
| `fake_order_guard` | – / ✓ / ✓ | placement hook, checkout rules, OTP, `PATCH …/fraud-guard`, blocklist writes, check-a-number | no checks with actions; settings/blocklist writes 402 `feature_not_in_plan`; reads allowed |

## 3. Record and tiers (code: `App\Domain\FraudGuard\*`)

### 3.1 Own-shop record (`ShopRecord::for($store, $phone)`)
delivered = orders of the store with that phone and status `delivered`; returned = status `returned` **or** a shipment
`returned`. Same definitions as the `customers.delivered_orders_count` / `returned_orders_count` counters, but by phone
(a phone may have no customer row yet). Per provider breakdown kept for P88-8.

### 3.2 Courier record
None (P88-7).

### 3.3 Tiers (`RiskTier`, replaces `CustomerRisk`; amends PHASE-8-5 P85-25)
P88-4 rule. `RiskTier::forCustomer` (own-shop counters, SQL form `RiskTier::sql($tier, $settings)` for audiences);
`RiskTier::forCheck` (the order's own-shop record). Thresholds from the store's `fraud_guard_settings` or the defaults (60, 75, 3)
when absent. `CustomerRisk` becomes a thin deprecated alias to `RiskTier` for one release, then is removed in 8.8b.
**Amended by PHASE-8-8B P88B-17 (Phase 8.8b):** the PHP `App\Domain\Customers\CustomerRisk` alias is removed; every
caller uses `RiskTier`. The `packages/types` `CustomerRisk` interface is the §6.5 response shape (`tier`, `rate`,
`delivered`, `total`), not the alias, and stays.

## 4. Data (owner API; migrations prefix `2026_12_05_`, forward-only; RLS in each create migration; tables added to `RlsTables::TENANT` (docblock count "76 after Phase 8.8a") and `database/sql/rls-emergency-off.sql`)

- **fraud_guard_settings** (`000100`, `[S]`, one row per store, UNIQUE `(tenant_id, store_id)`): enabled bool (default
  true) · hold_enabled bool (true) · hold_below smallint 1–100 (60) · advance_enabled bool
  (true) · advance_below smallint 1–100 (75) · advance_expiry_minutes int CHECK in (120, 360, 1440, 2880) (1440) ·
  advance_cancel_if_unpaid bool (true) · otp_enabled bool (true) · block_returners bool (true) · block_after_returns
  smallint 1–20 (3) · duplicates_enabled bool (true) · duplicate_window_hours smallint CHECK in (6, 12, 24, 48, 72) (24)
  · daily_limit_enabled bool (true) · daily_limit smallint 1–50 (3) · min_parcels smallint 1–20 (3) · updated_by FK users
  null · timestamps. CHECK `advance_below >= hold_below`. Row created lazily with defaults on first read.
- **blocked_phones** (`000100`, `[S]`): id · tenant_id · store_id · phone varchar(13) · customer_id null (composite FK,
  set null) · reason varchar(16) CHECK (`manual`,`repeat_returns`) · note varchar(200) null · source varchar(8) CHECK
  (`staff`,`auto`) · created_by FK users null · unblocked_at timestamptz null · unblocked_by null · timestamps. UNIQUE
  partial `(tenant_id, store_id, phone) WHERE unblocked_at IS NULL`; index `(tenant_id, store_id, phone)`.
- **order_risk_checks** (`000100`, `[S]`): id · tenant_id · store_id · order_id UNIQUE (composite FK, cascade) · phone ·
  tier varchar(8) CHECK (`good`,`careful`,`risky`,`new`) · rate smallint null · delivered int · total int · shop_delivered
  · shop_total · reasons jsonb (list of codes,
  §5.4) · decision varchar(12) CHECK (`none`,`hold`,`advance`,`skipped`) · with_actions bool · duplicate_of null ·
  payment_link_id null · released_at null · released_by null · created_at · updated_at.
- **fraud_guard_events** (`000100`, `[S]`): id · tenant_id · store_id · type varchar(20) CHECK (`held`,`advance_asked`,
  `advance_paid`,`released`,`duplicate`,`blocked_checkout`,`limit_reached`,`auto_blocked`,`otp_failed`) · order_id null ·
  phone · detail jsonb · created_at. Index `(tenant_id, store_id, created_at desc)`. Retention 13 months
  (`fraud:prune-events`).
- **checkout_otps** (`000100`, `[S]`): id · tenant_id · store_id · phone · code_hash char(64) · attempts smallint · sent_at
  · expires_at · verified_at null · ip varchar(45) null. Index `(tenant_id, store_id, phone, sent_at desc)`. Rows pruned
  after 24 h.
- **orders** (`000200`): `guard_hold varchar(12) null CHECK (call_first, advance, checking)`, `guard_hold_at
  timestamptz null`. **order_events** CHECK gains type `guard` (re-create the CHECK, as `2026_06_01_001800`).
- `audit_logs` actions: `fraud.settings_updated`, `fraud.number_blocked`, `fraud.number_unblocked`, `fraud.hold_released`,
  `fraud.number_checked` (meta: masked phone, tier only).

## 5. Checks (owner API; `App\Domain\FraudGuard\*`)

### 5.1 When a check runs (P88-6)
`OrderPlacementService::placeLocked` → `FraudGuard::onPlaced($order)` inside the transaction: guarded store + storefront
+ COD → `guard_hold = 'checking'`; any other order of a store → no hold. After commit `CheckOrderRisk` is dispatched for
**every** new order (checks without actions record tier/record only). Stale `checking` (> 10 min, job lost) → the
5-minute sweep `fraud:resolve-stale` re-runs the check with own-shop data only.

### 5.2 Algorithm (`CheckOrderRisk`, idempotent)
1. Lock the order; if a check exists → stop. Normalise phone.
2. Shop record (§3.1) excluding this order.
3. Tier (§3.3); duplicate search (P88-12); blocked (manual orders only, P88-9).
4. Decision (P88-5) when `with_actions` and the order is still `pending` with `guard_hold = 'checking'`; otherwise
   `skipped` and `guard_hold` cleared.
5. Apply: `hold` → `guard_hold = call_first`; `advance` → create the payment link through `PaymentLinkService` (amount
   kind `delivery_charge`; if `shipping_amount = 0` → `percent` 2 500 bps; settings expiry and cancel-if-unpaid; SMS by
   the link flow) and `guard_hold = advance`; `none` → clear.
6. Write the check, an `order_events` `guard` row (text from reasons), a `fraud_guard_events` row (`held`,
   `advance_asked`, `duplicate`), invalidate the order list counts.

### 5.3 Releases
- Advance link **paid** (P5B-22 webhook path) → `guard_hold = null`, check `released_at`, event `advance_paid`; the link
  flow already confirms the order.
- Advance link **expired / cancelled by merchant** → `guard_hold = call_first` (if the order wasn't cancelled by
  cancel-if-unpaid).
- `POST …/orders/{order}/guard/release` (`orders.process`) → clears the hold (an `advance` hold also cancels the guard's active link), audit `fraud.hold_released`, event
  `released`. "Confirm without advance" in the UI = release then confirm.
- Cancel of a held order works as today (any reason incl. `fake_order`).

### 5.4 Reason codes (stored, rendered by WEB)
`rate_below_hold`, `rate_below_advance`, `few_parcels`, `new_number`, `duplicate`, `blocked_number`, `no_gateway`,
`otp_unavailable`.

### 5.5 Enforcement points (each with a test, S156)
`OrderService::confirm` and `bulk` (held → 409 `order_held`; bulk skips with a per-order failure), `BookingService::book`
and bulk booking (`assertBookable`), external API status → `confirmed`, `OrderService::markReady`. Cancel, edit items,
notes, payment links and contact edits stay allowed.

## 6. Settings, blocklist, number check

### 6.1 Settings — `GET/PATCH …/fraud-guard/settings` (partial, `fraud.manage`; PATCH needs the plan). `POST …/reset` →
recommended defaults. Changes apply to later checks only.

### 6.2 Blocklist — list (search by phone suffix, 50/page), `POST` (phone, note; reason `manual`), `DELETE {entry}`
(unblock: sets `unblocked_at`). Blocking also cancels nothing; open orders of that phone are listed in the response
(`open_orders_count`).

### 6.3 Check a number — `POST …/fraud-guard/check` `{phone}` → `{tier, rate, delivered, total, sources[], blocked,
last_return_on}`; limiter `fraud-check` 30/min per user; audited (masked).

### 6.4 Overview — `GET …/fraud-guard/overview?month=` → `{rules_on, rules_total: 6,
orders_checked, stopped {held, blocked, duplicates, limited}, advance_collected_amount, blocked_count}`; decision log
`GET …/fraud-guard/events` (cursor, 50).

### 6.5 Customer and order payloads (amends PHASE-5 shapes)
`Customer` + `CustomerSummary` (on orders) gain `risk: {tier, rate, delivered, total}` (own-shop). `Order` (detail +
list) gains `guard: {hold, tier, rate, reasons[], decision, record: {total, delivered, sources: [{key: 'shop',
delivered, total}]}, payment_link_id, checked_at} | null`. Order list filters `filter[risk]=good,careful,risky,new` and
`filter[guard_hold]=1`; `meta.counts.held`.

### 6.6 Changed numbers (PO must notice)
- **Risk classification changes for every store** (P88-3): 8.5 "risky" (returned ≥ 2 and ≥ 50 %) / "careful" (≥ 1 and
  ≥ 25 %) → P88-4. Affected: campaign `risk_breakdown` and "Skip risky customers" counts, checkout recovery `skip_risky`,
  automation condition `customer.risk`. Examples: 2 returned / 0 delivered was **risky**, is now **careful** (total < 3);
  3 delivered / 1 returned (75 %) was **careful**, is now **good**; 2 delivered / 2 returned (50 %) stays **risky**;
  6 delivered / 3 returned (67 %) was **careful** (ratio 33 % ≥ 25 %), stays **careful**.
- New value `new` (no parcels) where 8.5 said `good`; campaigns treat `new` like `good`.
- Order responses gain `guard`; held orders return 409 `order_held` on confirm/booking (new).
- A store with the guard off or without the plan: order flow identical to 8.7 except the tier change above.

## 7. Storefront checkout (owner API + WEB storefront)
- `POST /storefront/checkout/otp` `{phone}` → 200 `{required: bool, expires_at|null, resend_after_seconds}`; required
  true for any number when the store's OTP rule applies (checkout alone decides if a code is needed), so it never
  reveals whether the number is blocked or known; false when the rule doesn't apply.
- `POST /storefront/checkout` gains `otp_code?`. Errors: 422 `otp_required`, `otp_invalid` (attempts left in details),
  `cod_unavailable`, `order_limit_reached`. Blocked/limit checks run before stock reservation; only for
  `payment_method = cod`.
- Storefront (`checkout-form.tsx`, `commerce.ts` error switch): OTP step inline under the phone field (6 boxes, resend
  timer), COD option disabled with the neutral message on `cod_unavailable` and online payment preselected; copy in
  §10.4. Composed (no Figma); uses existing theme inputs/buttons.

## 8. Merchant API (openapi 1.16.0 binding)

### 8.1 Endpoints (`routes/fraud-guard.php`, merchant group as 8.7: `auth:sanctum` + `surface:merchant,impersonation` + `tenant` + `throttle:merchant`; `{store}` scoped)
| Method | Path (`/api/v1/stores/{store}`) | Perm | Notes |
|---|---|---|---|
| GET | `/fraud-guard/settings` | `fraud.manage` | `FraudGuardSettings` |
| PATCH | `/fraud-guard/settings` | `fraud.manage` | plan; audited |
| POST | `/fraud-guard/settings/reset` | `fraud.manage` | plan; audited |
| GET | `/fraud-guard/overview` | `fraud.manage` | `month` |
| GET | `/fraud-guard/events` | `fraud.manage` | cursor; `filter[type]` |
| GET | `/fraud-guard/blocked-numbers` | `fraud.manage` | `q`, cursor |
| POST | `/fraud-guard/blocked-numbers` | `fraud.manage` | plan; 201; 409 `already_blocked` |
| DELETE | `/fraud-guard/blocked-numbers/{entry}` | `fraud.manage` | 204; audited |
| POST | `/fraud-guard/check` | `fraud.manage` | plan; limiter `fraud-check` |
| POST | `/orders/{order}/guard/release` | `orders.process` | 409 `order_not_held`; audited |

Storefront (in `routes/fraud-guard.php` storefront group, `storefront` + `throttle:storefront`): `POST
/storefront/checkout/otp` (limiter `checkout-otp`: 5/h per store+phone, 20/h per store+IP).

### 8.2 Shapes (summary; openapi binding)
`FraudGuardSettings` (fields of §4 table minus ids), `BlockedNumber {id, phone_masked, phone (with customers.view),
customer: {id, name}|null, reason, note, source, created_by: {id, name, role_label}|null, created_at}`, `NumberCheck`
(§6.3), `FraudGuardOverview` (§6.4), `FraudGuardEvent {id, type, order: {id, number}|null, phone_masked, detail,
created_at}`, `OrderGuard` and `CustomerRisk` (§6.5), `RiskTier = 'good'|'careful'|'risky'|'new'`.

### 8.3 Validation
Settings: integers in the §4 ranges, `advance_below ≥ hold_below`, `advance_expiry_minutes` in set. Phone: `PhoneRule::bdMobile`.
Note ≤ 200, control chars rejected. Never `$request->all()`.

### 8.4 Error codes (API-CONVENTIONS §3)
`order_held` (409), `order_not_held` (409), `already_blocked` (409), `cod_unavailable` (422), `order_limit_reached`
(422), `otp_required` (422), `otp_invalid` (422), `feature_not_in_plan` (402, existing). Limiters (§8): `fraud-check`
30/min per user, `checkout-otp` as above.

## 9. Scheduler and ops (owner API)
`fraud:resolve-stale` every 5 min (cross-tenant discovery of `guard_hold = 'checking'` older than 10 min, work per
tenant); `fraud:prune` daily (OTPs > 24 h, events > 13 months). RUNBOOK: both commands.

## 10. Merchant dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`

`can.manageFraudGuard` (`fraud.manage`). Nav: Orders › **Fake order guard** (`/orders/fraud-guard`) shown with
`fraud.manage` (amends `nav.ts` "stay hidden" note and `phase5.screens.test.tsx` L356).

### 10.1 Fake order guard `/orders/fraud-guard` — section `41:12365`, frame `39:11233`
| Figma element | id | Build / hidden / composed |
|---|---|---|
| Title + Tag "Protection on" | `41:11440` | build (Tag "Protection off" neutral when disabled; plan note when no plan) |
| Buttons "Check a number" / "Block a number" | header | build; **composed** dialogs (no frames): phone input → `NumberCheck` result card styled as `29:3104` / phone + note |
| Shield hero "Your shop is protected" + "n of 8 rules on · checking …" | `41:11448` | build with **"n of 6 rules on · checking your own orders"** |
| KPI "Orders protected this month" | `41:11456` | build (`orders_checked`, subtitle "Every new order checked") |
| KPI "Fake orders stopped" + split | `41:11461` | build ("n held · n blocked · n duplicates") |
| KPI "Delivery charges saved" | `41:11466` | **composed** → "Advance collected" (`advance_collected_amount`, Q191) |
| Rules header + "Reset to recommended" | `41:11470` | build (autosave per change, toast) |
| Rule "Check courier record on every order" | card | **hidden** (P88-7) |
| Rule "Hold risky orders for a call" (60 %) | card | build |
| Rule "Ask for delivery charge in advance" (75 %) | card | build (note when no gateway connected) |
| Rule "Verify new numbers with OTP" | card | build (copy "First-time numbers confirm a 6-digit code at checkout…"; "Uses SMS credits") |
| Rule "Block repeat returners" (3) | card | build |
| Rule "Catch duplicate orders" (24 h) | card | build |
| Rule "Limit orders per phone" (3) | card | build |
| Rule "Block VPN and proxy checkouts" | card | **hidden** (Q190) |
| Blocked numbers card + table + "View all" | `41:11630` | build; reason detail for auto = "n returns at your shop"; "BLOCKED BY" Auto + rule / staff + role; "Steadfast 2 · Pathao 2" detail **hidden**; "View all" → `/orders/fraud-guard/blocked` (composed list page) |
| Recent decisions + "View all" | `41:11740` | build (types: Held for a call, Advance asked, Advance paid, Blocked, Duplicate caught, Limit reached); "View all" → composed log page |
| Privacy note "Your data stays yours" | `41:11808` | build (copy as designed; "Read how checks work" → help anchor, Q189) |

### 10.2 Orders (amends PHASE-5 order UI) — list `7:276`, detail `33:3676`, modal `144:46570`
| Figma element | id | Change |
|---|---|---|
| List "RISK" column + RiskBadge | `7:276` | build (`guard.tier`, else `customer.risk.tier`) |
| List filter "Risk" + chip "Waiting for advance" | `7:276` | build; **composed** chip "On hold · n" (`filter[guard_hold]`) |
| Detail StatusBadge "On hold" | `33:3676` | **composed**: status stays "Pending"; a warning Tag "Call first" / "Waiting for advance" / "Checking…" beside it (P88-2) |
| RiskBadge | `33:3890` | build |
| Next-step banner + "Confirm without advance" / "Resend link" / "Copy payment link" | `33:3923` | build for `advance`; **composed** banner for `call_first` ("Held for a call — {reason}" + "Release and confirm" / "Cancel as fake") |
| Delivery record card (bars Steadfast / Pathao / Your shop) | `33:4122` | build with the **"Your shop" bar only**; "Block this number" link (with `fraud.manage`) |
| Courier choice "Buyer: 3 of 5 delivered" | shipping card | **hidden** (P88-7) |
| Timeline "Fraud check: Risky (58% delivered)" | timeline | build (`guard` event renderer) |
| Call-outcome entries | timeline | **hidden** |
| Modal "Ask for an advance" | `144:46570` | build on the existing payment-link dialog (amount kinds, expiry, cancel-if-unpaid already exist) + the "why" box |

### 10.3 Customers (amends PHASE-4 UI)
Customer list Risk column + filter, customer detail RiskBadge and "Block this number" card `64:16887` (build, with
`fraud.manage`); "Delivery record across Storeplix" `64:16955` **hidden** (Q23). Courier "Fraud check" tabs `29:2562` **hidden** (Q195).

### 10.4 Storefront checkout (composed)
OTP: label "Verification code", help "We sent a 6-digit code to {phone}.", button "Resend code" (timer "Resend in 0:42"),
errors "That code isn't right. {n} tries left." / "Enter the code we sent." COD unavailable: "Cash on delivery isn't
available for this number. Please pay online." Daily limit: P88-11 copy. Bangla strings provided by ARCH in the
storefront dictionary.

### 10.5 States and mobile
Loading/empty ("No decisions yet — new orders will appear here.")/error per `148:34032`; plan note (Free) "Fake order
guard is on Starter and Growth." + "See plans". Below `lg`: rule cards 1-up, tables become cards; 375 px usable.

## 11. ARCH and types (owner ARCH)
openapi **1.16.0** (§8 paths, storefront OTP + checkout errors, `Order.guard`, `Customer.risk`, `RiskTier`, order list
filters/counts, error codes), `packages/types` (`RiskTier`, `OrderGuard`, `CustomerRisk` (shape), `FraudGuardSettings`,
`BlockedNumber`, `NumberCheck`, `FraudGuardOverview`, `FraudGuardEvent`, `PermissionKey` + `fraud.manage`, order event
type `guard`, `CheckoutOtpResponse`), `packages/api-client` (`fraudGuard.*`, `orders.releaseHold`), ADR 0022,
DATABASE-DESIGN §5.8 (replaces the §6 sketch row; fixes stale L252 `risk_flags` and L489 cancel reasons), SECURITY T38
(S154–S166; T16/T27 updated; "52 tables" fixed), API-CONVENTIONS (§3 codes, §8 limiters), MULTI-TENANCY (guard signals are
per-tenant only; no cross-tenant signal), PHASE-8-5 P85-25 and PHASE-8-6 condition notes → this file,
PHASE-7 §2.1 row, PHASE-8-3 §2.1, OPEN-QUESTIONS Q184–Q199, FIGMA-INDEX rows, RUNBOOK, roadmap 8.8 split. **Types first.**

## 12. Security checklist (S154–S166; each has a test)
- **S154** isolation: settings, blocklist, checks, events, OTPs → cross-tenant/cross-store 404; RLS on all five tables;
  a phone's record never includes another store's orders (fixture with the same phone in two tenants).
- **S155** permissions: staff/custom roles without `fraud.manage` → 403 on §8.1 guard routes; release needs
  `orders.process`; impersonation read-only (writes 403) and "check a number" 403 under impersonation.
- **S156** hold enforcement: a held order can't be confirmed (single, bulk, external API) or booked (single, bulk) —
  every path 409 `order_held`; release → all work.
- **S157** check idempotency: duplicate jobs / retries → one check, one event, one payment link; stale `checking` resolved
  once.
- **S158** advance: link created only with a connected gateway; paid → released + confirmed once; expired → back to
  `call_first`; amounts per P5B-22.
- **S159** checkout rules: blocked phone COD → 422 `cod_unavailable`, online payment allowed; limit → 422 on the
  (n+1)-th; normalisation (`017…`, `+88017…`, `88017…` all match).
- **S160** OTP: hashed, 5-min TTL, 5 attempts then a new code is needed, resend 60 s, per-phone/IP limiters → 429, the
  `/otp` response is identical for blocked, known and unknown numbers (no oracle), fail-open on SMS failure → held.
- **S161** no external call: the record is computed from this store's rows only (test asserts `Http::preventStrayRequests`
  and a fixture with the same phone in another tenant and another store of the platform).
- **S162** check-a-number oracle: limiter 30/min, audited with masked phone, plan + permission required.
- **S163** tiers: P88-4 vectors (0, < min_parcels, thresholds ±1), SQL form equals PHP form for random fixtures
  (campaign audiences use it).
- **S164** repeat-returners: auto block once at the threshold; a merchant unblock is never re-added.
- **S165** audit: settings, block/unblock, release, check-a-number by user; automatic decisions by `system`.
- **S166** plan: Free store → no checks with actions, checkout rules off, writes 402, reads OK.

## 13. Test requirements
**API (Pest; group `fraud`; RLS and scheduled commands also `rls`, security items also `security`, order-flow items
also `orders`)**: every §8.1 route (happy, validation, authz, isolation); tier vectors; decision matrix (duplicate,
risky × hold on/off, careful × advance on/off × gateway); enforcement on every path (S156); storefront OTP + checkout errors; repeat-returner auto block;
existing order, courier, campaign and automation suites green with the tier change (update the 8.5 risk fixtures
`AudienceTest::test_risk_classes`, `EngineSafetyTest` L65, `AutomationsApiTest` L107 to P88-4); S154–S166.
**Web (Vitest)**: guard page from fixtures (VPN rule absent, "Advance collected" tile, 6 rules), dialogs, blocked list,
decision log, order list column/filter/chip, order detail banners (advance, call_first, checking), Delivery record card
(no Steadfast/RedX bars), customer Risk + block card, nav item by permission, plan note, query
invalidation `[tenantId, storeId, 'orders']` after release; storefront: OTP step, COD-unavailable state, limit message.
**QA (Playwright `tests/e2e/specs/phase8-8.*.spec.ts`; fake courier/SMS/gateway)**: a phone with 1 delivered / 2
returned at the shop (33 %, below the repeat-returner threshold) places a storefront COD order → held "Call first" with reasons → booking refused → release →
booking works; a careful buyer → advance link sent → fake gateway pays → order confirmed; blocked number → COD disabled,
online works; 4th COD order of a phone today → limit message; new number → OTP via the message sink → order placed;
duplicate order → held as duplicate; staff can't open the guard page; Free shop shows the plan note; 390 px screenshots
(guard page, order detail held, storefront OTP).
**QA infra**: CI Pest step for group `fraud` (sqlite, Postgres, RLS) copied from `phase 8.7 group (expenses)`.

## 14. File ownership for Phase 8.8a

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**` only: `app/Domain/FraudGuard/**`, `routes/fraud-guard.php` + its include line in `routes/api.php`, migrations `2026_12_05_000100`/`000200`, hooks in `Orders/OrderPlacementService.php`, `Orders/OrderService.php`, `Couriers/BookingService.php`, `Payments/**` payment-link paid/expired hook (one call each), `Orders/OrderPresenter.php`, `Orders/Http/OrderController.php` (filters/counts), `Customers/CustomerRisk.php` → alias, `Customers/Http/Resources/CustomerPresenter.php`, `Marketing/Audience/**` + `Automations/Engine/Conditions.php` + `Automations/Recipes/CheckoutRecovery.php` (switch to `RiskTier`), `Orders/StorefrontOrderController.php` + checkout request (otp_code, errors), `Developer/External/**` confirm path, `Orders/Notifications/SmsTemplates.php` + `resources/sms/*` (`checkout_otp`), `Tenancy/Authorization/Permission.php`, `SystemRole.php`, `Tenancy/Support/AuditLogger.php` subject types, `RlsTables` + `rls-emergency-off.sql`, `AppServiceProvider` provider registration, `routes/console.php`, `config/fraud_guard.php`, `tests/Feature/FraudGuard/**`, `tests/Unit/FraudGuard/**`, the role/permission tests and parity fixture, the 8.5/8.6 tests named in §13 |
| **WEB** | `apps/merchant-dashboard/**` (`src/fraud/**` new, `src/orders/**`, `src/customers/**`, `src/commerce/format.ts`, `src/lib/permissions.ts`, `App.tsx`, `src/layout/nav.ts`, fixtures/tests), `apps/storefront/**` checkout files (`themes/modern-commerce/commerce/checkout-form.tsx`, `lib/checkout-form.ts`, `app/actions/commerce.ts`, dictionary), `packages/ui/**` (RiskBadge if missing) |
| **ARCH** | `docs/**` except `docs/reviews/**` and TESTING.md; `packages/types/**`, `packages/api-client/**` |
| **QA** | `tests/e2e/**` (`phase8-8.*`; affected `phase5*`, `phase8-5.*`, `phase8-6.*` risk expectations), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-8-qa.md` |

Shared-read rules: API keeps every existing `Order` / `Customer` field and meaning except §6.5–§6.6. Re-read
`routes/api.php`, `Permission.php`, `OrderService.php`, `OrderPlacementService.php`, `BookingService.php`,
`OrderDetailPage.tsx`, `checkout-form.tsx` before each Edit.

## 15. Order of work
1. ARCH: types + api-client (§11), then openapi 1.16.0, ADR 0022, docs.
2. API: migrations + RlsTables → permission + route map → `RiskTier` (+ switch 8.5/8.6 callers) → own-shop record → placement hook + `CheckOrderRisk` → enforcement (S156) → advance + release hooks → blocklist +
   repeat returners → checkout rules + OTP → settings/overview/events/check → limiters + schedule.
3. WEB: guard page against §8.2 fixtures → order list/detail → customers → storefront OTP/COD states → mobile.
4. QA: specs + CI group while the others build; gate after all are green.

## 16. Acceptance criteria
Roadmap AC (8.8a): see the header.
1. Every new order gets exactly one check; storefront COD orders of guarded stores get a decision with reasons (S157).
2. A held order can't be confirmed or booked by any path until released or its advance is paid (S156, S158).
3. Blocked and over-limit numbers can't place COD orders; online payment still works; new numbers verify by OTP, and an
   SMS failure never loses the order (S159, S160).
4. The record uses only this shop's own orders; no external call and no cross-tenant signal (S154, S161).
5. One risk tier everywhere; every changed classification in §6.6 is covered by updated tests (S163).
6. Fake order guard `39:11233` and the §10.2–§10.4 items match Figma with the documented omissions and composed items;
   loading/empty/error; 375 px usable.
7. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `fraud`, `orders`, `rls`,
   `security`), Playwright `phase8-8.*` and affected `phase5*` / `phase8-5.*` / `phase8-6.*` green;
   `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

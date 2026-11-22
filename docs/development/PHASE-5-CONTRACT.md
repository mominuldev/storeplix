# Phase 5 contract: Commerce (binding for API, WEB, SF, QA)

Status: **Binding for Phase 5a** from 2026-11-22. **Phase 5b is an outline** (§16): it becomes binding only after its
own contract revision, once the Phase 5a review passes and the PO answers the 5b questions.

Scope: roadmap tasks 5.1–5.13 (DEVELOPMENT-ROADMAP.md, Phase 5), **split into two build cycles** (P5-1):

| Cycle | Roadmap tasks | Ships |
|---|---|---|
| **5a — Sell with cash on delivery** (this contract, full detail) | 5.1 storefront catalog, PLP/PDP/search · 5.2 cart · 5.3 shipping zones · 5.4 coupons · 5.5 checkout (idempotent, stock commitment, COD) · 5.7 orders (state machine, manual refunds) · 5.11 order email/SMS · 5.12 onboarding 06 (delivery part) and 07 (COD part) · 5.13 onboarding 08 + go-live | A merchant can publish the shop and take, confirm, ship, deliver, cancel and refund COD orders, with coupons and zone-based delivery charges |
| **5b — Online money and couriers** (§16, outline) | 5.10 Postgres RLS (first) · 5.6 payments (bKash, SSLCommerz, webhooks, advance payment links, gateway refunds) · 5.8 couriers (Steadfast, Pathao, RedX) · 5.9 invoice and label PDFs · onboarding 06 courier cards and 07 gateway cards · the 5a "Edit items" and post-delivery returns | Online and advance payments, courier booking and sync, printable documents, database-level isolation |

**Out of scope for 5a** (show disabled with "Coming soon", or hide; never fake): online payments, advance payment
requests, courier booking and sync, shipments list, invoices and labels, returns and exchanges after delivery,
unfinished orders, fake-order guard and risk badges, customer accounts and saved addresses, product reviews,
wishlists, campaigns, abandoned-cart SMS. The full list of deferred Figma features is in §11.

Everything in AGENT-CONTRACTS.md, PHASE-2/3/4-CONTRACT.md and docs/api/API-CONVENTIONS.md still applies: envelope,
snake_case, ULIDs, roles, error codes, cookie sessions (PHASE-4 §7). The machine-readable spec is
`docs/api/openapi.yaml` (**v1.5.0**; **v1.5.1** (amended 2026-11-22, QA 5a F-L6) documents the accepted 5a deviations, no shape changes).

Conventions in this file:
- **Headers.** `T` = `X-Tenant-Id`. Merchant auth is the Sanctum session cookie plus `X-XSRF-TOKEN` on writes.
  Storefront routes are server-to-server: `X-Storefront-Key` + `X-Storefront-Host`, optional `X-Storefront-Preview`,
  and `X-Storefront-Client-Ip` (the shopper IP, trusted only with a valid key). Cart routes add `X-Cart-Token`.
- **Foreign ids.** A `{store}`, `{order}`, `{coupon}`, `{zone}`, `{location}`, `{item}` (cart item) from another tenant
  **or another store** → 404 `not_found`. An id inside a request body that isn't in this store (variant, product,
  category, customer, coupon, zone) → 422 `validation_failed` with the field path in `details`. Never 403 for a
  foreign id, so existence never leaks. Storefront slugs of another store → 404 `not_found`.
- **Roles** (ADR 0005): O = owner, A = admin, S = staff. Policies use the `Permission` enum. New cases in P5-21.
- **Errors.** Every endpoint can also return 401, 422 `validation_failed` (with `details`) and 429 `rate_limited`;
  merchant writes can return 419 `csrf_token_mismatch`. New codes are listed in §3.0.
- **Money.** Every `*_amount` is an integer in **paisa** (1 ৳ = 100). Floats → 422. Currency = `stores.currency` (BDT).
  Percentages are **basis points** (`percent_bps`, 1 500 = 15 %).
- **Phone.** BD mobile only, normalised by `Phone::bdMsisdn` to `8801XXXXXXXXX`
  ("Enter a Bangladeshi mobile number (01XXXXXXXXX).").
- **"default, pending PO"** marks a product decision taken by Architecture so the build can proceed. All of them are
  listed in §1.1 and in OPEN-QUESTIONS.md (Q31–Q44).

### Standing rules for every agent
- **Browser checks:** Playwright only (`tests/e2e`, or a one-off Playwright script). Never the Claude in Chrome
  extension or the user's own Chrome.
- **Shared working tree:** never run `git stash`, `git reset`, `git checkout -- <path>` or commit. Only touch files you
  own (§13).
- **Dependencies:** every new dependency must be at least 14 days old, pinned exactly, `minimumReleaseAge` respected.
- **Postgres:** the race and money tests in §12 are Postgres-only. Run them locally against the compose Postgres
  (`docker compose up postgres`) before handing over; sqlite passing is not evidence (phase-4 QA A8/A16).

---

## 0. Summary and goals (5a)

1. **Storefront catalog.** PDP `/products/{slug}`, category PLP `/c/{slug}` (Q24 default), search `/search?q=`,
   category tree, client-side availability. Prices, images and options only: **never cost, SKU, barcode or exact stock**
   (exact stock only as "Only N left" when at or below the low-stock threshold, P5-6).
2. **Cart.** Server-side cart (ADR 0006): opaque token in the storefront's httpOnly `sp_cart` cookie, stored as
   `sha256` in the DB, variant ids and quantities only, prices recomputed on every read, coupon preview, free-delivery
   progress. Guest only (Q14 default).
3. **Shipping zones** (Settings 60:14364): zones of districts and thanas, one charge and delivery time per zone, an
   undeletable **Outside Dhaka** fallback so checkout is never blocked, a store-wide free-delivery threshold, and
   pickup locations (used by couriers in 5b).
4. **Coupons** (Marketing 67:18689, 68:19255): percentage (with cap), fixed amount, free delivery; all products,
   categories or products; minimum order, total uses, uses per customer (by phone), first order only, active dates.
   Usage is enforced **inside the checkout transaction** under a row lock.
5. **Checkout.** One `POST /storefront/checkout` with a required `Idempotency-Key`: re-price, validate coupon and zone,
   **commit stock atomically** (`inventories.committed`), upsert the customer by phone, create the order with
   snapshots, convert the cart. COD only. A replay returns the same order. No oversell under concurrency.
6. **Orders.** List, detail, manual create (from chats/calls), edit contact and address, notes, tags, bulk confirm,
   a strict state machine (`pending → confirmed → ready_to_ship → shipped → delivered`, plus `cancelled` and
   `returned`), manual shipping details, COD payment tracking and **manual refunds**. Stock leaves `on_hand` only when
   shipped (ledger `order_shipped`) and comes back on return (`order_returned`).
7. **Notifications.** Queued, tenant-branded order email (shopper, if email given) and SMS through the existing REVE
   SMS gateway (shopper), plus a new-order email to the merchant. Per-event toggles. Monthly SMS allowance per plan.
8. **Onboarding 06, 07, 08 and go-live.** Delivery charges and pickup address (06), cash on delivery (07), then a
   go-live check and `POST /stores/{store}/publish` (draft → active) leading to "You're live" (08).
9. **Dashboard.** The `orders` block of `DashboardSummary` is filled; the order KPI tiles, "Needs you today" and best
   sellers become real. Customers get delivered/returned counts and an orders table.

---

## 1. Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| P5-1 | **Split Phase 5 into 5a (COD commerce) and 5b (online payments, couriers, PDFs, RLS).** 5a is fully specified here; 5b is outlined in §16. The platform has no public launch before Phase 9, so 5a's real orders never run in production before 5b's RLS lands. **RLS is the first task of 5b**, before any online payment code merges. | 13 tasks is ~2× Phase 4. 5a has no external dependencies (no sandbox accounts), so it can start now; 5b is blocked on sandbox credentials (bKash, SSLCommerz, Steadfast, Pathao, RedX), a PDF engine with Bangla shaping and PO answers. 5a alone is a sellable product: ~90 % of BD orders are COD (Figma 52:564 "9 in 10 shoppers"). Default, pending PO (Q31) |
| P5-2 | **Guest checkout only in 5a** (Q14 default kept). Phone is required; email optional. Customers are deduplicated by normalised phone within the store. No shopper login, saved addresses or "merge cart on login"; the roadmap AC "merge on login" moves to whenever accounts ship (5b at the earliest, after Q14). | Matches the Figma checkout (no sign-in step), avoids OTP cost per order, keeps PII surface small |
| P5-3 | **Cart identity = opaque token.** 32 random bytes, base64url (43 chars). The API returns it **once** (`meta.cart_token`, on the request that creates the cart); the storefront stores it in cookie `sp_cart` (HttpOnly, Secure in prod, SameSite=Lax, host-only, Path=/, Max-Age 30 days) and forwards it as `X-Cart-Token`. The DB stores `sha256(token)` only. The browser never sees the API or the token in JS. | ADR 0006. A DB leak doesn't yield usable tokens; the token is scoped to one host because the cookie is host-only and the cart row is bound to the store resolved from the host |
| P5-4 | **Carts hold variant ids and quantities only.** Quantity 1–99 per line, ≤ 50 lines. Prices, discounts and availability are recomputed on every read and at checkout. Adding to the cart **does not reserve stock**; it only checks `available` (unless backorder or untracked). Carts expire 30 days after `last_activity_at` (daily prune). | Tamper-proof totals (T6). Reserving on add lets bots lock a shop's stock |
| P5-5 | **Stock commitment at order placement, decrement at shipping.** Placing an order (storefront or manual) adds the quantity to `inventories.committed` for tracked variants in one transaction, under `SELECT … FOR UPDATE` in `variant_id` order. It succeeds only when `on_hand − committed ≥ qty`, or the variant has `allow_backorder`. Cancelling an unshipped order releases `committed`. **Shipping** decrements `on_hand` and `committed` together and writes ledger reason `order_shipped`. A return restocks `on_hand` (ledger `order_returned`) only for lines the merchant marks restock. Committing writes no ledger row (the ledger tracks `on_hand`; the order timeline explains `committed`). Untracked variants are never touched. ADR 0011 | One stock path through `InventoryService` (P4-12). No TTL is needed for COD: the order itself is the reservation. The TTL question only exists for unpaid online orders (5b, Q35) |
| P5-6 | **Storefront stock exposure.** The PDP HTML never carries stock. `GET /storefront/products/{slug}/availability` (no-store) returns per variant `available: boolean` and `low_stock: int|null`, where `low_stock` = available units **only when** `0 < available ≤ effective_threshold` (Figma "Only 4 left in 2–3 years"), else `null`. Untracked or backorder variants: `available: true, low_stock: null`. Default, pending PO (Q39) | Shows urgency the design asks for without letting competitors read exact stock levels |
| P5-7 | **Shipping zones follow Settings 60:14364, not the theme checkout's Standard/Express pair.** A zone = name + areas (whole districts and/or single thanas) + one charge + delivery time (min/max days) + active flag. Exactly one **fallback zone** ("Outside Dhaka", `kind = fallback`) exists per store: no areas, can't be deleted or deactivated, and catches every address no active zone covers ("so no order is ever blocked at checkout"). Resolution: active zone with that **thana** → active zone with the whole **district** → fallback. An area belongs to at most one zone (DB unique). Express/second rates per zone, weight-based charges, COD charge, packaging fee and per-zone default courier are deferred (§11). | The merchant settings screen is the source of truth for rules; one rate per zone is what Figma shows. A guaranteed fallback means a misconfigured zone can't lose a sale |
| P5-8 | **"Inside Dhaka" default = the Dhaka city (metropolitan) thanas** of the geo dataset: the **50** Dhaka Metropolitan Police thanas of district `dhaka` (amended 2026-11-22, QA 5a F-L6); Figma's "Dhaka city · 41 thanas" is an older count. ৳ 70, 1–2 days; fallback "Outside Dhaka" ৳ 130, 2–4 days (onboarding 06 values). Both are created when the merchant first saves onboarding 06 or Settings → Shipping; `DemoSeeder` and a backfill command create them for existing stores. Default, pending PO (Q37) | Matches the onboarding copy and how BD couriers price "inside Dhaka" |
| P5-9 | **Free delivery threshold is store-wide** (`store_settings.free_delivery_over_amount`, null = off). It applies when the **merchandise subtotal after discount** ≥ threshold, to every zone. Shown as the cart progress bar ("Add ৳ 450 more for free delivery") and in onboarding 06. | Figma has one threshold (60:14364 "Free delivery" card, 50:604 toggle) |
| P5-10 | **BD geography is a static, versioned dataset in the API** (`resources/geo/bd.json`: 8 divisions, 64 districts, upazilas/thanas incl. city thanas, with stable lowercase codes and English + Bangla names), served by `GET /geo/bd` (public, cacheable 24 h). Addresses store codes **and** names (snapshots). The API agent sources it from an openly licensed list (candidate: `nuhil/bangladesh-geocode`, MIT; confirm the licence, add Dhaka/Chattogram metropolitan thanas by hand, record the source in `resources/geo/README.md`). The checkout "Area" field is free text in 5a; the courier area mapping (Figma "Map area") is 5b. | Checkout (1:11591) needs Division → District → Upazila/Thana selects, and zones need stable codes. One copy of the data for API, SPA and storefront |
| P5-11 | **Coupons** (68:19255): `percentage` (1–100 %, as `percent_bps`, optional `max_discount_amount` cap), `fixed` (`amount`), `free_shipping` (shipping charge → 0; always whole order). `applies_to`: `all`, `categories` (incl. descendants), `products`. Conditions: `min_subtotal_amount`, `usage_limit`, `usage_per_customer` (by normalised phone; default 1), `first_order_only` (no non-cancelled order with that phone in this store), `starts_at`/`ends_at` in store time. **One coupon per order**; the "Combine with other coupons" toggle is hidden. "Only customers with a Good delivery record" is deferred (needs courier fraud data, 5b/Phase 8). Code: `^[A-Z0-9][A-Z0-9_-]{2,31}$`, uppercased, unique per store. Status `draft` / `active` / `disabled`; `expired` and `used_up` are **derived** for display. A coupon with redemptions can't be deleted (409 `coupon_in_use`); disable it instead. | Matches the create screen; derived states avoid cron jobs flipping rows |
| P5-12 | **Discount math is integer and deterministic.** Eligible subtotal `E` = Σ eligible line subtotals. Percentage: `floor(E × percent_bps / 10 000)`, then `min(cap)`, then `min(E)`. Fixed: `min(amount, E)`. The discount is allocated to eligible lines proportionally with the largest-remainder method (ties → lower line index), so `Σ order_items.discount_amount = orders.discount_amount` exactly. Free shipping sets `shipping_amount = 0` and records `shipping_discount_amount`. | Refunds and reports need per-line discounts; no rounding drift |
| P5-13 | **Coupon usage is enforced transactionally.** In the checkout transaction the coupon row is locked (`FOR UPDATE`) **after** the inventory rows (fixed lock order: inventories by `variant_id`, then coupon, then counter) and re-validated: status, dates, `used_count < usage_limit`, per-phone count from `coupon_redemptions` (status `active`), first-order rule. Success inserts a redemption and increments `used_count`. Cancelling an order releases its redemption (`status = released`, `used_count − 1`); a returned order keeps it. Any failure → 422 `coupon_invalid` with a reason message; nothing is written. | Roadmap AC "usage limits enforced transactionally". A fixed lock order prevents deadlocks |
| P5-14 | **Checkout is one idempotent request** (ADR 0006). `Idempotency-Key` header required: 8–64 characters of `[A-Za-z0-9_-]` (a UUID or ULID fits); missing **or malformed** → 400 `idempotency_key_required` (amended 2026-11-22, QA 5a F-L6). Stored in `idempotency_keys` (scope `storefront.checkout`, per store) with `request_hash = sha256(canonical body + cart token hash)`. Same key + same hash → the stored 201 with `Idempotent-Replayed: true`; different hash → 409 `idempotency_key_mismatch`; in flight → 409 `idempotency_key_in_use`. `orders` also has `U(store_id, idempotency_key)` as the final guard. The stored response body is encrypted (it contains the confirmation token). Keys live 24 h. | "Replay returns the same order" AC; safe retries on flaky mobile networks |
| P5-15 | **Price-change guard.** The checkout body carries `expected_total_amount` (what the shopper saw). If the recomputed total differs → 409 `checkout_changed` with `details.expected_total_amount = ["The total changed to ৳ 3,900. Check your order and place it again."]` and nothing is written. | Never charge a COD buyer more than they agreed to at the door |
| P5-16 | **Order numbers.** `{prefix}-{sequence}`, e.g. `GS-1042`. Sequence per store from `store_counters` (`orders` key, starts at 1001), incremented in the order transaction (`INSERT … ON CONFLICT DO UPDATE SET value = value + 1 RETURNING value`), so a rolled-back checkout leaves no gap. Prefix `store_settings.order_prefix` `^[A-Z]{1,6}$`; default = first two ASCII letters of the store slug uppercased (`demo` → `DE`), editable in Settings → Taxes & invoices ("Invoice numbering", 60:16858). A changed prefix applies to new orders only. Default, pending PO (Q40) | Figma GS-1042; one number for shopper, merchant and courier |
| P5-17 | **Order state machine** (ADR 0011; enforced by `OrderStateMachine`, every transition writes an `order_events` row). Statuses: `pending` (new, awaiting confirmation call), `confirmed`, `ready_to_ship` (packed), `shipped` (Figma "In transit"), `delivered`, `returned` (came back undelivered), `cancelled`. `pending_payment` is reserved for 5b. Allowed: `pending → confirmed \| cancelled`; `confirmed → ready_to_ship \| shipped \| cancelled`; `ready_to_ship → shipped \| confirmed \| cancelled`; `shipped → delivered \| returned`. `delivered`, `returned`, `cancelled` are final in 5a (post-delivery returns and exchanges are 5b, §16). Anything else → 409 `invalid_state_transition`. | Figma 7:276 tabs (Pending, Confirmed, Ready to ship, In transit, Delivered, Returned, Cancelled). A small, explicit graph is testable |
| P5-18 | **Payments in 5a.** `payment_method` is `cod`. On placement a `payments` row `{provider: cod, type: charge, status: pending, amount: total}` is created; on `delivered` it becomes `succeeded` and the order's `payment_status` → `paid`, `paid_amount = total`. **Refunds are manual records** (`provider: manual`, `type: refund`, method `cash` / `bkash_personal` / `nagad_personal` / `bank` / `other`, optional reference, note), O A only, `Idempotency-Key` required, amount ≤ `paid_amount − refunded_amount` (else 422 `refund_exceeds_paid`). `payment_status` → `partially_refunded` / `refunded`. No money moves through Storeplix. Gateway refunds are 5b. | Roadmap 5.7 "refunds" without a gateway; Figma "Storeplix never holds money" |
| P5-19 | **Manual orders** (Create order 39:14382) use the **same** `OrderPlacementService` as checkout (pricing, coupon, zone, commitment, customer upsert, numbering). The merchant may override the delivery charge (`shipping_amount_override`, 0–1 000 000 paisa, audited in the timeline). `channel` = `facebook`, `instagram`, `whatsapp`, `phone`, `walk_in`, `landing_page` or `other`. Draft saving, "Paste chat message" (AI) and barcode scan are deferred. | One pricing path for both entry points; BD F-commerce sellers take most orders from chats |
| P5-20 | **Order edits in 5a** are limited to contact (name, phone, email), shipping address, customer note, tags and the internal note timeline (PATCH with `revision`). Editing items ("Edit items", 144:46654) is 5b because it must re-commit stock and re-price against a coupon. Allowed while status ∈ `pending`, `confirmed`, `ready_to_ship`. A changed address does **not** re-price automatically; the response carries `meta.shipping_hint` with the zone/charge the new address would get, and the UI shows it. | Keeps the money path immutable after placement in 5a |
| P5-21 | **Permissions.** `Operate` (O A S): view orders, create manual orders, transition (except below), edit, notes, tags, bulk confirm/ready. **Cancel a paid or partially paid order** and **refunds**: `ManageRefunds` (O A, exists). **Shipping zones, pickup locations, checkout/notification settings, publish**: `ManageSettings` (O A, exists). **Coupons** write: new `ManageMarketing` (O A); read: `Operate`. Staff may cancel unpaid orders (they run the confirmation calls). Default, pending PO (Q43) | ADR 0005 matrix ("refunds, cancel paid" O A; "shipping" O A) |
| P5-22 | **Customer counters.** `orders_count` = non-cancelled orders (+1 on placement, −1 on cancel); `last_order_at` = placement time; `delivered_orders_count` and `returned_orders_count` (new) on those transitions; `total_spent_amount` += order total on `delivered`, −= refunds. Written only by `OrderService` (never mass-assignable). The customer list and detail (61:12478, 64:16382) show these for **this shop only** (Q23 unchanged). | P4-16 left the columns for Phase 5. "3/3 delivered" in the Figma order list needs them |
| P5-23 | **Shopper access to an order without accounts.** (a) Confirmation: checkout returns `confirmation_token` (32 random bytes, stored as sha256, valid 24 h); the storefront puts it in httpOnly cookie `sp_order` and renders `/checkout/thank-you` from `GET /storefront/orders/confirmation`. (b) Tracking `/track`: `POST /storefront/orders/track {number, phone}` → a limited view (status timeline, items, totals, district and thana only, no street address, no email). Wrong pair → 404 `not_found` (same body and timing as unknown). Throttle 10/min per IP. Default, pending PO (Q42) | Figma Order confirmed 1:11788 and Track order 1:11959 without accounts; POST keeps phone numbers out of URLs and logs |
| P5-24 | **Draft stores.** Coming soon still applies to every commerce route for the public. In **preview**, PDP, PLP, search and cart work (draft products are visible on the PDP in preview only), but checkout → 409 `store_not_live` ("Your shop isn't live yet. Orders open after you go live."). Manual orders work for draft stores (merchants take chat orders before launch). | No real storefront orders before go-live; merchants can still try the flow |
| P5-25 | **Go-live** (5.13). `GET /stores/{store}/launch-checklist` and `POST /stores/{store}/publish` (O A). **Hard requirements**: ≥ 1 active product with ≥ 1 enabled variant; the fallback shipping zone exists (onboarding 06 or Settings saved once); ≥ 1 payment method enabled (COD); store contact phone set (shown on the storefront and used in SMS). Missing → 409 `launch_blocked` with `details.<item_key>`. Publish sets `stores.status = active`, `published_at` (first time), audits `store.published`, and the existing observer revalidates the host (Coming soon disappears). Publishing an active store → 200, no-op. Unpublish is not built (Settings has no frame). **COD-only go-live is allowed** (Q36 default). Soft items shown on 08: policy pages published (Q17), first order received; Meta Pixel is hidden (deferred). | Roadmap 5.13 AC. Hard checks prevent a live shop that can't sell |
| P5-26 | **Notifications** (5.11, Settings → Notifications 60:15863). Queued (`notifications` queue, TenantAware), after commit. **Shopper SMS** via the existing `SmsGateway` (REVE): events `order_placed` (on), `order_confirmed` (off), `order_shipped` (on), `order_cancelled` (on), toggled per store; fixed templates in Bangla (default) or English (`sms_language`), no template editing in 5a. Sender = platform sender ID (masked per-shop sender is 5b/Phase 7). **Shopper email** (`order_placed` only, if the shopper gave an email): Laravel Mailable, store name as From display name, platform address `orders@{PLATFORM_DOMAIN}`, Reply-To = store contact email. **Merchant email** on every new order to the store contact email (fallback: owner's email), toggle `notify_new_order_email`. SMS is capped by a new plan limit `sms_per_month` (Free 200, Starter 2 000, Growth null; default, pending PO Q33); over the cap the SMS is skipped and the order timeline says "SMS not sent: monthly SMS allowance used". Every send writes `sms_messages` (template name, never body) and an `order_events` row. Manual cancel and manual orders have a "Send SMS" checkbox that overrides the toggle for that action. | Figma customer messages; cost control without blocking orders |
| P5-27 | **Plan limit `orders_per_month`** (Free 50, Starter 500, Growth unlimited; seeded since Phase 2). Usage = orders placed this calendar month in the store timezone (all statuses). **Storefront orders are always accepted** (never lose a shopper's order); **manual orders over the limit** → 402 `plan_limit_reached`. At ≥ 80 % and ≥ 100 % the dashboard shows the existing plan banner. Default, pending PO (Q34) | Figma footer "Free plan · 38 of 50 orders" implies the meter; refusing a buyer at the door hurts the merchant more than us |
| P5-28 | **Storefront catalog API = extension of the Phase 4 feed**, same server-to-server auth, same `store:{host}` revalidation tag (P3-18): product create/update/delete and category changes already revalidate it. New public pages cache with `revalidate: 300`. Cart, checkout, thank-you, track and availability are `no-store` and never tagged. | No new invalidation machinery; correctness from Phase 4 |
| P5-29 | **Storefront mutations use Server Actions only** (Next.js origin check) and read through two route handlers (`GET /api/cart-summary`, `GET /api/availability/[slug]`) that proxy to the API with the server-side key. The browser never calls `api.storeplix.com` and never sees `STOREFRONT_API_KEY` or `sp_cart`. | T17: Server Actions are CSRF-safe by origin check; route handlers are read-only |
| P5-30 | **Bestsellers** (Q27 resolved): `sort=bestsellers` = units sold in non-cancelled orders placed in the last 30 days, ties by `published_at desc`; products with no sales follow in `latest` order. | Real data now exists |
| P5-31 | **Order item snapshots** carry product name, variant title, option values, SKU, image media id, unit price, compare-at, **unit cost** (for profit reports; never exposed to staff or storefront), quantity, discount and total. `order_items.product_id` / `variant_id` are **soft references** (indexed, no FK) so a hard purge of catalog rows never breaks history; all reads go through the order. | DATABASE-DESIGN "snapshots so deletes never break history"; composite `SET NULL` would also null `tenant_id` |
| P5-32 | **Tax is zero in 5a.** `tax_amount` exists (always 0) so VAT (Settings 60:16858 "Prices already include VAT / Add VAT on top") can arrive with invoices in 5b without a breaking change. | Keeps the total formula stable |

### 1.1 Product-owner questions (appended to OPEN-QUESTIONS.md as Q31–Q44)

**All defaults below were accepted by the PO on 2026-11-22**, so they are decisions now, not defaults.

| # | Question | Default |
|---|---|---|
| Q31 | Split Phase 5 into 5a (COD commerce) and 5b (online payments, couriers, PDFs, RLS)? | Yes (P5-1) |
| Q14 | (existing) Guest checkout vs phone-OTP accounts | Guest only in 5a; accounts not before 5b (P5-2) |
| Q32 | Payment gateways at launch, and merchant-owned credentials vs a platform aggregator | Merchant-owned accounts (Figma "Money goes straight to your bKash merchant account"; ADR 0007). bKash Tokenized Checkout + SSLCommerz first; EPS, Nagad, aamarPay, PayStation later (5b) |
| Q33 | Who pays for order SMS, and the monthly allowance | Platform pays, REVE SMS platform sender; Free 200 / Starter 2 000 / Growth unlimited per month; SMS credits purchase (Figma) is Phase 7 |
| Q34 | Orders above the monthly plan limit | Storefront orders always accepted; manual orders blocked with 402 |
| Q35 | Stock hold for unpaid online orders (5b) | 30 min for checkout payments; 2 h for merchant-sent payment links (Figma "expires 15:21" for a 13:21 link) |
| Q36 | Is COD-only acceptable for go-live? | Yes |
| Q37 | "Inside Dhaka" definition | Dhaka metropolitan thanas (50 in the dataset; Figma says "41 thanas") (amended 2026-11-22, QA 5a F-L6); merchant can edit areas |
| Q24 | (existing) Category URL | `/c/{slug}` |
| Q38 | Coupon share link: Figma shows `/c/WINTER15`, which collides with category `/c/{slug}` | Share link `/discount/{CODE}` (applies the coupon to the cart and redirects to `/`) |
| Q39 | Show "Only N left" on PDP and cart | Yes, only when at or below the low-stock threshold (P5-6) |
| Q40 | Order number prefix default | Two letters from the store slug, editable |
| Q41 | Which courier first (5b) | Steadfast (most complete Figma), then Pathao, then RedX (Q11) |
| Q42 | Order tracking by order number + phone, no login | Yes; street address hidden on the tracking view |
| Q43 | Who manages coupons; may staff cancel unpaid orders? | Coupons O A; staff may cancel unpaid orders |
| Q44 | Customer SMS language default | Bangla templates (Figma 60:15863), English selectable |

---

## 2. Data (migrations, owner API)

Conventions as PHASE-4 §2: Postgres in CI and prod, local sqlite keeps working; every table has `id ulid pk` (except
pivots and counters), `tenant_id` FK tenants cascade, `store_id`; `FK(s)` = `(tenant_id, store_id) → stores` cascade;
every parent has `U(tenant_id, id)` and `U(tenant_id, store_id, id)`; `FK3(parent)` = triple FK
`(tenant_id, store_id, parent_id) → parent(tenant_id, store_id, id)`. Models use `BelongsToTenant` + `BelongsToStore`
+ `HasUlids`; `tenant_id` / `store_id` never fillable. **Every new table carries `tenant_id NOT NULL`** so 5b RLS can be
enabled on it without a schema change. Money columns are `bigint`, CHECK `>= 0` unless stated.

New migrations (file prefix `2026_05_01_`):

| Table / change | Columns / constraints |
|---|---|
| `stores` (000100) | add `published_at timestamptz null`. Backfill: stores already `active` get `published_at = updated_at` |
| `store_settings` (000200) | add `cod_enabled boolean not null default true`; `free_delivery_over_amount bigint null` CHECK `BETWEEN 100 AND 1000000000`; `order_prefix varchar(6) null` CHECK `~ '^[A-Z]{1,6}$'` (pgsql only; app validates on both); `notify_new_order_email boolean not null default true`; `customer_sms jsonb not null default '{"order_placed":true,"order_confirmed":false,"order_shipped":true,"order_cancelled":true}'`; `sms_language varchar(2) not null default 'bn'` CHECK IN (`bn`,`en`) |
| `store_counters` (000300) | `tenant_id`; `store_id` FK(s); `key varchar(32)`; `value bigint not null`; timestamps. **PK(store_id, key)**. Only written by `StoreCounter::next($key)` |
| `pickup_locations` (000400) | `id`; `tenant_id`; `store_id` FK(s); `name varchar(60)`; `contact_name varchar(80) null`; `contact_phone varchar(13) null`; `district_code varchar(32)`; `thana_code varchar(48)`; `address_line varchar(255)`; `is_default boolean not null default false`; timestamps. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(store_id) WHERE is_default` |
| `shipping_zones` (000500) | `id`; `tenant_id`; `store_id` FK(s); `name varchar(60)`; `kind varchar(16)` CHECK IN (`custom`,`fallback`); `charge_amount bigint not null` CHECK `BETWEEN 0 AND 1000000`; `min_days smallint not null` CHECK `BETWEEN 0 AND 30`; `max_days smallint not null` CHECK `max_days >= min_days AND max_days <= 30`; `is_active boolean not null default true` (CHECK `kind <> 'fallback' OR is_active`); `position smallint not null default 0`; `pickup_location_id ulid null` FK3(pickup_locations) RESTRICT (5b courier routing; unused in 5a UI); timestamps. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(store_id) WHERE kind = 'fallback'`; `IX(tenant_id, store_id, position)` |
| `shipping_zone_areas` (000600) | `tenant_id`; `store_id`; `zone_id` FK3(shipping_zones) CASCADE; `district_code varchar(32) not null`; `thana_code varchar(48) not null default ''` (`''` = whole district). **PK(zone_id, district_code, thana_code)**; **`U(store_id, district_code, thana_code)`** (an area is in at most one zone); `IX(tenant_id, store_id, district_code)` |
| `coupons` (000700) | `id`; `tenant_id`; `store_id` FK(s); `code varchar(32)` (uppercase); `type varchar(16)` CHECK IN (`percentage`,`fixed`,`free_shipping`); `percent_bps int null` CHECK `BETWEEN 1 AND 10000`; `amount bigint null` CHECK `BETWEEN 1 AND 1000000000`; `max_discount_amount bigint null` CHECK `>= 1`; `applies_to varchar(16) not null default 'all'` CHECK IN (`all`,`categories`,`products`); `min_subtotal_amount bigint null`; `usage_limit int null` CHECK `>= 1`; `usage_per_customer int null` CHECK `>= 1`; `first_order_only boolean not null default false`; `starts_at timestamptz not null`; `ends_at timestamptz null` CHECK `ends_at IS NULL OR ends_at > starts_at`; `status varchar(16) not null default 'draft'` CHECK IN (`draft`,`active`,`disabled`); `used_count int not null default 0` CHECK `>= 0`; `revision int not null default 1`; `created_by` FK users nullOnDelete; timestamps. Type CHECKs: `percentage` ⇒ `percent_bps NOT NULL AND amount IS NULL`; `fixed` ⇒ `amount NOT NULL AND percent_bps IS NULL AND max_discount_amount IS NULL`; `free_shipping` ⇒ all three null and `applies_to = 'all'`. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; `U(store_id, code)` (code stored uppercase); `IX(tenant_id, store_id, status, created_at)` |
| `coupon_categories` (000800) | `tenant_id`; `store_id`; `coupon_id` FK3(coupons) CASCADE; `category_id` FK3(categories) CASCADE. **PK(coupon_id, category_id)** |
| `coupon_products` (000900) | `tenant_id`; `store_id`; `coupon_id` FK3(coupons) CASCADE; `product_id` FK3(products) CASCADE. **PK(coupon_id, product_id)** |
| `carts` (001000) | `id`; `tenant_id`; `store_id` FK(s); `token_hash char(64)` **U**; `status varchar(16) not null default 'active'` CHECK IN (`active`,`converted`,`abandoned`); `coupon_code varchar(32) null`; `currency char(3)`; `last_activity_at timestamptz not null`; `converted_order_id char(26) null` (soft ref); `ip varchar(45) null`; timestamps. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; `IX(tenant_id, store_id, status, last_activity_at)` |
| `cart_items` (001100) | `id`; `tenant_id`; `store_id`; `cart_id` FK3(carts) CASCADE; `variant_id` FK3(product_variants) CASCADE; `quantity smallint not null` CHECK `BETWEEN 1 AND 99`; timestamps. `U(tenant_id,id)`; `U(cart_id, variant_id)`; `IX(tenant_id, store_id, cart_id)` |
| `orders` (001200) | `id`; `tenant_id`; `store_id` FK(s); `number varchar(24)`; `sequence bigint`; `status varchar(24)` CHECK IN (`pending_payment`,`pending`,`confirmed`,`ready_to_ship`,`shipped`,`delivered`,`returned`,`cancelled`); `payment_status varchar(24) not null default 'unpaid'` CHECK IN (`unpaid`,`partially_paid`,`paid`,`partially_refunded`,`refunded`); `payment_method varchar(24)` CHECK IN (`cod`,`bkash`,`sslcommerz`); `created_via varchar(16)` CHECK IN (`storefront`,`dashboard`); `channel varchar(16)` CHECK IN (`website`,`facebook`,`instagram`,`whatsapp`,`phone`,`walk_in`,`landing_page`,`other`); `customer_id ulid null` FK3(customers) **NO ACTION**; `customer_name varchar(120)`; `customer_phone varchar(13)`; `customer_email varchar(254) null`; `shipping_address jsonb not null` (§2.1); `district_code varchar(32)`; `currency char(3)`; `subtotal_amount`, `discount_amount`, `shipping_amount`, `shipping_discount_amount`, `tax_amount`, `total_amount`, `paid_amount`, `refunded_amount` (all `bigint not null default 0`, ≥ 0); CHECK `total_amount = subtotal_amount - discount_amount + shipping_amount + tax_amount`; CHECK `discount_amount <= subtotal_amount`; CHECK `refunded_amount <= paid_amount`; `coupon_id ulid null` FK3(coupons) NO ACTION; `coupon_code varchar(32) null`; `shipping_zone_id char(26) null` (soft ref); `shipping_zone_name varchar(60)`; `delivery_min_days`, `delivery_max_days smallint null`; `shipping_overridden boolean not null default false`; `customer_note varchar(500) null`; `tags jsonb not null default '[]'`; `revision int not null default 1`; `idempotency_key varchar(64) null`; `confirmation_token_hash char(64) null`; `confirmation_expires_at timestamptz null`; `cancel_reason varchar(32) null` CHECK IN (`customer_request`,`fake_order`,`unreachable`,`out_of_stock`,`duplicate`,`other`); `placed_at timestamptz not null`; `confirmed_at`, `shipped_at`, `delivered_at`, `returned_at`, `cancelled_at timestamptz null`; `created_by` FK users nullOnDelete (manual orders); `ip varchar(45) null`; `user_agent varchar(255) null`; timestamps. **No soft delete.** `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; `U(store_id, number)`; `U(store_id, sequence)`; partial `U(store_id, idempotency_key) WHERE idempotency_key IS NOT NULL`; `U(confirmation_token_hash)` partial not null; `IX(tenant_id, store_id, status, placed_at)`; `IX(tenant_id, store_id, placed_at)`; `IX(tenant_id, store_id, customer_id)`; `IX(tenant_id, store_id, customer_phone)`; pgsql `GIN(customer_name gin_trgm_ops)` |
| `order_items` (001300) | `id`; `tenant_id`; `store_id`; `order_id` FK3(orders) CASCADE; `product_id char(26) null`, `variant_id char(26) null` (soft refs, indexed); `product_name varchar(200)`; `variant_title varchar(130)`; `option_values jsonb not null default '[]'`; `sku varchar(64) null`; `image_media_id char(26) null` (soft ref); `unit_price_amount`, `compare_at_amount null`, `unit_cost_amount null`, `subtotal_amount`, `discount_amount`, `total_amount` (bigint); CHECK `total_amount = subtotal_amount - discount_amount`; `quantity smallint not null` CHECK `BETWEEN 1 AND 99`; `tracked boolean not null` (inventory tracked at placement); `restocked_quantity smallint not null default 0`; `position smallint`; timestamps. `U(tenant_id,id)`; `IX(tenant_id, store_id, order_id)`; `IX(tenant_id, store_id, variant_id)`; `IX(tenant_id, store_id, product_id)` |
| `order_events` (001400) | `id`; `tenant_id`; `store_id`; `order_id` FK3(orders) CASCADE; `type varchar(24)` CHECK IN (`placed`,`status_changed`,`note`,`edited`,`payment`,`refund`,`shipment`,`notification`,`coupon_released`); `from_status`, `to_status varchar(24) null`; `actor_type varchar(16)` CHECK IN (`user`,`customer`,`system`); `actor_user_id` FK users nullOnDelete; `body varchar(1000) null`; `meta jsonb not null default '{}'`; `created_at timestamptz not null default now()` (**no `updated_at`; append-only**, like `inventory_movements`). `IX(tenant_id, store_id, order_id, created_at)` |
| `shipments` (001500) | `id`; `tenant_id`; `store_id`; `order_id` FK3(orders) CASCADE; `provider varchar(16) not null default 'manual'` CHECK IN (`manual`,`steadfast`,`pathao`,`redx`); `carrier_name varchar(60) null`; `tracking_code varchar(64) null`; `tracking_url varchar(500) null`; `status varchar(24)` CHECK IN (`shipped`,`delivered`,`returned`,`cancelled`) (5b widens); `cod_amount bigint not null default 0`; `shipped_at`, `delivered_at`, `returned_at timestamptz null`; `created_by` FK users nullOnDelete; timestamps. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(order_id) WHERE status <> 'cancelled'` |
| `payments` (001600) | `id`; `tenant_id`; `store_id`; `order_id` FK3(orders) NO ACTION; `provider varchar(16)` CHECK IN (`cod`,`manual`,`bkash`,`sslcommerz`); `type varchar(8)` CHECK IN (`charge`,`refund`); `status varchar(16)` CHECK IN (`pending`,`succeeded`,`failed`,`cancelled`); `amount bigint not null` CHECK `> 0`; `currency char(3)`; `method varchar(24) null` (refund: `cash`,`bkash_personal`,`nagad_personal`,`bank`,`other`); `reference varchar(64) null` (merchant-typed TrxID); `note varchar(255) null`; `parent_payment_id ulid null` FK3(payments) NO ACTION; `idempotency_key varchar(64) null`; `provider_payment_id varchar(128) null`; `raw jsonb null` (5b, secrets stripped); `verified_at timestamptz null`; `actor_user_id` FK users nullOnDelete; timestamps. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(store_id, idempotency_key) WHERE idempotency_key IS NOT NULL`; `IX(tenant_id, store_id, order_id)` |
| `coupon_redemptions` (001700) | `id`; `tenant_id`; `store_id`; `coupon_id` FK3(coupons) NO ACTION; `order_id` FK3(orders) CASCADE, **U(order_id)**; `customer_phone varchar(13)`; `discount_amount bigint` (incl. shipping discount); `status varchar(16) not null default 'active'` CHECK IN (`active`,`released`); timestamps. `IX(tenant_id, store_id, coupon_id, customer_phone, status)` |
| `idempotency_keys` (001800) | `id`; `tenant_id`; `store_id` FK(s); `scope varchar(64)`; `key varchar(64)`; `request_hash char(64)`; `status varchar(16)` CHECK IN (`processing`,`completed`); `response_status smallint null`; `response_body text null` (**encrypted** cast); `locked_until timestamptz`; `created_at timestamptz`; `expires_at timestamptz`. `U(store_id, scope, key)`; `IX(expires_at)` |
| `customers` (001900) | add `delivered_orders_count int not null default 0`, `returned_orders_count int not null default 0` |
| `inventory_movements` (002000) | widen reason CHECK: + `order_shipped`, `order_returned`; `reference_type` gains `order`. Drop and re-add the CHECK (pgsql); sqlite rebuild via Laravel's `change()` |

### 2.1 `shipping_address` jsonb (orders) — validated by `AddressValidator`
```json
{ "division_code": "dhaka", "division": "Dhaka", "district_code": "dhaka", "district": "Dhaka",
  "thana_code": "dhaka-dhanmondi", "thana": "Dhanmondi", "area": "Road 7A area",
  "address_line": "House 12, Road 7A, Flat 4B", "landmark": "Opposite Dhanmondi Lake", "label": "home" }
```
Names are snapshots from the geo dataset at placement. `area` ≤ 120 (optional), `address_line` 5–255, `landmark`
≤ 160 (optional), `label` `home` | `office` | null. Control characters stripped.

### 2.2 Models and services (API)
- Models: `ShippingZone`, `ShippingZoneArea`, `PickupLocation`, `Coupon`, `CouponRedemption`, `Cart`, `CartItem`,
  `Order`, `OrderItem`, `OrderEvent` (append-only guard like `InventoryMovement`), `Shipment`, `Payment`,
  `IdempotencyKey`, `StoreCounter`. `Store` gets `hasMany` for zones, pickup locations, coupons, orders (for
  `scopeBindings()`).
- Services: `Geo\BdGeo` (dataset lookup), `Shipping\ZoneResolver`, `Pricing\CartPricer` (lines, eligibility,
  discount allocation, shipping, totals; pure and unit-tested), `Coupons\CouponValidator`,
  `Orders\OrderPlacementService` (checkout + manual), `Orders\OrderStateMachine`, `Orders\OrderService`
  (transitions, edits, refunds, customer counters), `Idempotency\IdempotencyGuard` (middleware `idempotent:{scope}`),
  `Notifications\OrderNotifier`, `Stores\LaunchChecklist`.
- `InventoryService` gains `commit(storeId, lines, orderRef)`, `release(...)`, `ship(...)`, `restock(...)`; it stays the
  **only** writer of `inventories` (arch test extended to `committed`).
- `FeatureGate::usage(Limit::OrdersPerMonth)` = orders with `placed_at` in the current month (store timezone);
  new `Limit::SmsPerMonth` usage = `sms_messages` with purpose `order_*` this month. `PlanSeeder` adds
  `sms_per_month` (P5-26).
- `assertTenantIsolation` **and** `assertStoreIsolation` for every new model.

Retention and schedules:
- `carts:prune` daily: `active` carts with `last_activity_at` older than 30 days → `abandoned`; `abandoned` and
  `converted` carts older than 90 days are deleted (items cascade).
- `idempotency:prune` hourly: delete rows past `expires_at`.
- `orders:expire-confirmation-tokens` daily: null `confirmation_token_hash` past expiry.

---

## 3. API endpoints

### 3.0 New error codes (add to API-CONVENTIONS §3)
| HTTP | code | When |
|---|---|---|
| 404 | `cart_not_found` | `X-Cart-Token` missing, unknown, expired or not `active` (storefront clears `sp_cart`) |
| 409 | `checkout_changed` | recomputed total ≠ `expected_total_amount` (P5-15) |
| 409 | `store_not_live` | checkout on a draft store (P5-24) |
| 409 | `launch_blocked` | publish with unmet hard requirements (P5-25) |
| 409 | `coupon_in_use` | delete a coupon with redemptions |
| 422 | `out_of_stock` (exists) | add-to-cart or checkout beyond `available` (`details["items.N.quantity"] = ["Only 2 left."]`); also a storefront checkout line that is no longer purchasable ("This item is no longer available.") (amended 2026-11-22, QA 5a F-L6) |
| 422 | `coupon_invalid` (exists) | coupon unknown, inactive, expired, used up, below minimum, not eligible, per-customer or first-order rule (`details.code = [reason]`) |
| 422 | `cart_empty` | checkout with no purchasable lines |
| 422 | `payment_method_unavailable` | method not enabled for the store |
| 422 | `refund_exceeds_paid` | refund > `paid_amount − refunded_amount` |

Amendments (amended 2026-11-22, QA 5a F-L6): there is **no** `zone_area_taken` code; an area in two zones is 422 `validation_failed` on
`zones.N.areas.M` (§3.5). A missing **or malformed** `Idempotency-Key` (not 8–64 characters of `[A-Za-z0-9_-]`) is 400
`idempotency_key_required`.

Coupon reason messages (exact): "This code doesn't exist.", "This code isn't active yet.", "This code has expired.",
"This code has been fully used.", "Spend ৳ {min} or more to use this code.", "This code doesn't apply to the items in
your bag.", "You've already used this code.", "This code is for first orders only.".

### 3.1 Geo (public)
`GET /geo/bd` (no auth, `throttle:60,1` per IP) → 200 `{ data: BdGeo }`, `Cache-Control: public, max-age=86400`,
`ETag` = dataset version. `BdGeo = { version, divisions[], districts[], thanas[] }` (§6).

### 3.2 Storefront catalog (server-to-server; `throttle:storefront` = 1 200/min per store host (amended 2026-11-22, QA 5a F-L6))

| Method & path | Query / body | Success | Errors |
|---|---|---|---|
| `GET /storefront/products` (**extended**) | Phase 4 params (`sort`, `limit`, `on_sale`, `category`) **plus**: `page` (≥ 1) and `per_page` (1–48, default 24) — mutually exclusive with `limit`; `q` (≤ 100, name or tag contains; trigram on pgsql); `price_min`, `price_max` (paisa, on the card price); `in_stock=1` (≥ 1 enabled variant available, from inventories, tracked-and-available or untracked or backorder); `exclude` (product id, for "Pairs well with"); `sort` adds `price_asc`, `price_desc` (`bestsellers` per P5-30) | 200 `StorefrontProductCard[]`; `meta: { has_products }` plus `PaginationMeta` fields when `page` is sent | 404 `store_not_found` (draft without preview); 422 bad params |
| `GET /storefront/products/{slug}` | — | 200 `StorefrontProduct`. Public: `active`, non-deleted, ≥ 1 enabled variant. Preview: also `draft` (`is_preview_only: true`). `Cache-Control: public, max-age=0, s-maxage=60` (preview: `private, no-store`) | 404 `not_found` |
| `GET /storefront/products/{slug}/availability` | — | 200 `{ data: StorefrontAvailability }` (P5-6); `private, no-store` | 404 |
| `GET /storefront/categories` | — | 200 `StorefrontCategory[]`: visible (`is_visible`) non-deleted categories as a nested tree (depth ≤ 3), ordered by `position` | 404 `store_not_found` |
| `GET /storefront/categories/{slug}` | — | 200 `StorefrontCategoryDetail` (breadcrumb ancestors, children, image, description). Hidden categories still resolve by slug (merchant links) but aren't in the tree | 404 |

Card and product key sets are **exact** (resource tests): never `cost_amount`, `sku`, `barcode`, `on_hand`,
`committed`, `tenant_id`, `store_id`, `revision`, `created_by`.

`StorefrontConfig` gains (additive) `commerce: StorefrontCommerce` = `{ checkout_enabled (store active),
payment_methods: ['cod'] (enabled ones), free_delivery_over_amount, delivery: [{ name, charge_amount, min_days,
max_days }] (active zones by position, fallback last) }` for the PDP delivery box, cart and footer "Pay with".

### 3.3 Cart (storefront; `X-Cart-Token`; `throttle:cart` = tenant + client IP 60/min; all responses `private, no-store`)

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /storefront/cart` | — | 200 `{ data: Cart }` | 404 `cart_not_found` |
| `POST /storefront/cart/items` | `{ variant_id, quantity 1–99 }` | 200 `Cart` (quantity **added** to an existing line, capped at 99). **No/unknown token** → creates a cart: **201** `Cart` with `meta.cart_token` | 422 (`variant_id`: "This item isn't available." for unknown/disabled/foreign/draft variant; `out_of_stock` `details.quantity = ["Only 3 left."]`; `lines`: "Your bag can hold 50 different items.") |
| `PATCH /storefront/cart/items/{item}` | `{ quantity 1–99 }` | 200 `Cart` | 404 (`cart_not_found`, or item not in this cart → `not_found`); 422 `out_of_stock` |
| `DELETE /storefront/cart/items/{item}` | — | 200 `Cart` | 404 |
| `PUT /storefront/cart/coupon` | `{ code }` | 200 `Cart` with `coupon` applied | 422 `coupon_invalid` (cart unchanged). Phone-dependent rules (per customer, first order) are checked at checkout only |
| `DELETE /storefront/cart/coupon` | — | 200 `Cart` | 404 |
| `GET /storefront/cart/shipping-options` | `?district_code=&thana_code=` | 200 `{ data: ShippingQuote }` (the one resolved zone, charge after free-delivery rule) | 422 unknown codes |

**Cart pricing on read** (`CartPricer`): each line → current variant price; a line becomes `issue: 'unavailable'`
(product not active, variant disabled/deleted) or `issue: 'insufficient_stock'` (`available < quantity`, with
`max_quantity`); issue lines are excluded from totals and block checkout until changed. Coupon re-validated on every
read (invalid → removed, `meta.notices = ["Code GALLERY100 was removed: This code has expired."]`). Totals:
`subtotal_amount`, `discount_amount`, `savings_amount` (compare-at savings + discount, "You save ৳ 750"),
`estimated_total_amount` (without shipping), `free_delivery: { threshold_amount, remaining_amount }`.
Every write bumps `last_activity_at`.

### 3.4 Checkout (storefront)

`POST /storefront/checkout` — headers `Idempotency-Key` (required, 8–64 characters of `[A-Za-z0-9_-]`; missing or malformed → 400 `idempotency_key_required` (amended 2026-11-22, QA 5a F-L6)),
`X-Cart-Token`; throttle `checkout` (tenant + client IP 10/min; tenant + phone 5 per 10 min, keyed after phone
normalisation). Body `CheckoutInput`:

| Field | Rule |
|---|---|
| `contact.name` | 2–120, no control characters |
| `contact.phone` | BD mobile → `8801…` |
| `contact.email` | optional, `email:rfc`, ≤ 254, lowercased |
| `shipping_address` | §2.1 input: `district_code` and `thana_code` must exist and match; `division_code` derived (ignored if sent) |
| `payment_method` | `cod` (else 422 `payment_method_unavailable`; also when COD is disabled) |
| `customer_note` | optional ≤ 500 |
| `accepts_marketing` | optional bool (stored on a **new** customer only) |
| `expected_total_amount` | required integer (P5-15) |

Responses: **201** `{ data: CheckoutResult }` = `{ order: StorefrontOrder, confirmation_token }`;
replay → same 201 + `Idempotent-Replayed: true`. Errors: 400 `idempotency_key_required`; 404 `cart_not_found`;
409 `store_not_live`, `checkout_changed`, `idempotency_key_mismatch`, `idempotency_key_in_use`;
422 `cart_empty`, `out_of_stock` (`details["items.N.quantity"]`, N = cart line index), `coupon_invalid`,
`payment_method_unavailable`, `validation_failed`.

**Transaction** (`OrderPlacementService::place`, one DB transaction; lock order fixed):
1. Lock the cart row (`FOR UPDATE`), require `active`.
2. Price lines with `CartPricer` (any issue line → 422 with its `details`).
3. `InventoryService::commit`: lock inventories of tracked variants `ORDER BY variant_id FOR UPDATE`; check
   `on_hand − committed ≥ qty` unless `allow_backorder`; `UPDATE inventories SET committed = committed + qty`.
4. Coupon: lock row, validate fully (incl. phone rules), compute and allocate discount (P5-12/13).
5. Resolve zone (P5-7), apply free delivery (P5-9) and free-shipping coupon.
6. Recompute total; compare with `expected_total_amount` (P5-15).
7. Upsert customer by phone (`source = storefront`; existing: fill empty email/district/area only; never overwrite
   name); bump counters (P5-22).
8. `StoreCounter::next('orders')`; insert order, items (snapshots incl. `unit_cost_amount`), `placed` event,
   COD `payments` row, coupon redemption.
9. Cart → `converted`, `converted_order_id`.
10. After commit: `OrderPlaced` event → notifications (P5-26); audit nothing (orders are their own record).

Plan limit is **not** checked for storefront orders (P5-27).

`GET /storefront/orders/confirmation` (header `X-Order-Token`) → 200 `{ data: StorefrontOrder }` while the token is
valid; else 404. `private, no-store`.

`POST /storefront/orders/track` `{ number, phone }` (throttle `order-track` 10/min per tenant + IP) → 200
`{ data: StorefrontOrderTracking }`; mismatch → 404 `not_found`. Number match is case-insensitive and accepts the
number with or without prefix.

### 3.5 Shipping settings (merchant; `T`; reads O A S, writes O A `ManageSettings`)

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /stores/{store}/shipping` | — | 200 `ShippingSettings` = `{ zones: ShippingZone[], pickup_locations: PickupLocation[], free_delivery_over_amount, configured: boolean }` (`configured` = fallback zone exists) | 404 |
| `PUT /stores/{store}/shipping` | `SaveShippingInput` = `{ zones: ShippingZoneInput[], free_delivery_over_amount }` — **full replacement** of zones (ids keep rows; missing custom zones deleted; exactly one `kind: fallback` entry required) | 200 `ShippingSettings`. Creates the fallback zone on first save | 422 (`zones`: "Keep one fallback zone for everywhere else."; `zones.N.areas.M`: "Mirpur is already in Inside Dhaka." (within payload); unknown codes; > 30 zones; > 500 areas per zone) |
| `POST /stores/{store}/pickup-locations` | `PickupLocationInput` | 201 `PickupLocation` (first one becomes default) | 422; 409 when 10 exist (`conflict`, "You can add up to 10 pickup addresses.") |
| `PATCH /stores/{store}/pickup-locations/{location}` | partial; `is_default: true` moves the default | 200 | 404; 422 |
| `DELETE /stores/{store}/pickup-locations/{location}` | — | 204; deleting the default promotes the oldest remaining | 404; 409 `conflict` when a zone references it |

Zone rules (amended 2026-11-22, QA 5a F-L6): an area clash (two zones, within the payload or against the unique index) is always 422 on
`zones.N.areas.M`, never 409. `name` 1–60; `charge_amount` 0–1 000 000; `min_days` ≤ `max_days` ≤ 30; `areas` = `[{ district_code,
thana_code? }]` (`thana_code` omitted = whole district; a whole district and a thana of the same district may sit in
different zones — the thana wins); fallback has no areas and `is_active: true`. One full-replace transaction;
`U(store_id, district_code, thana_code)` violation maps to 422. Audit `shipping.updated` (meta: zone count).

Settings additions on `PATCH /stores/{store}/settings` (Phase 2 endpoint, O A): `checkout.cod_enabled`,
`order_prefix`, `notifications.new_order_email`, `notifications.customer_sms.{order_placed|order_confirmed|order_shipped|order_cancelled}`,
`notifications.sms_language`. `StoreSettings` returns them (§6).

### 3.6 Coupons (merchant; reads O A S, writes O A `ManageMarketing`)

| Method & path | Query / body | Success | Errors |
|---|---|---|---|
| `GET /stores/{store}/coupons` | `q` (code contains), `filter[type]`, `filter[status]=draft,active,disabled,expired,used_up` (derived states resolved in SQL), `sort=-created_at` (default) \| `-revenue` \| `-used_count`; `page`, `per_page` | 200 `Coupon[]` + `meta: CouponListMeta` (`counts`, `PaginationMeta`) | 422 |
| `POST /stores/{store}/coupons` | `CreateCouponInput` | 201 `Coupon` | 422 (`code`: "This code is already used." / pattern; type field rules; `category_ids.N` / `product_ids.N`: "Unknown category." / "Unknown product.") |
| `GET /stores/{store}/coupons/{coupon}` | — | 200 `Coupon` | 404 |
| `PATCH /stores/{store}/coupons/{coupon}` | `UpdateCouponInput` (`revision` required). `code` and `type` are **immutable** once `used_count > 0` (422 "Create a new code instead.") | 200 | 404; 409 `revision_conflict`; 422 |
| `DELETE /stores/{store}/coupons/{coupon}` | — | 204 (hard delete; never redeemed only) | 404; 409 `coupon_in_use` |

`Coupon.stats` = `{ used_count, orders_count, revenue_amount (Σ total of non-cancelled orders with it),
discount_amount (Σ redemption discount, active) }`. Audit `coupon.created`, `coupon.updated` (status/value changes),
`coupon.deleted`.

### 3.7 Orders (merchant; `T`; throttle `merchant` = 300/min per user + tenant (amended 2026-11-22, QA 5a F-L6))

| Method & path | Roles | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /stores/{store}/orders` | O A S | `filter[status]=…` (comma list), `filter[payment_status]`, `filter[channel]`, `filter[district_code]`, `filter[customer_id]`, `filter[coupon_id]`, `filter[placed_at][gte\|lte]`, `q` (number prefix, customer name contains, phone per P4 search rules), `sort=-placed_at` (default) \| `placed_at` \| `-total`; `page`, `per_page` ≤ 100 | 200 `OrderSummary[]` + `meta: OrderListMeta` (`counts` per status for the current non-status filters, `PaginationMeta`) | 422 |
| `POST /stores/{store}/orders/quote` | O A S | `ManualOrderInput` without `idempotency` (no writes) | 200 `{ data: OrderQuote }` (lines, totals, zone, coupon result or `coupon_error`, stock issues as data, not errors) | 422 shape errors only |
| `POST /stores/{store}/orders` | O A S | `ManualOrderInput`; `Idempotency-Key` **required** | 201 `Order` | **402 `plan_limit_reached`** (P5-27); 409 idempotency; 422 like checkout (`items.N.variant_id` "Unknown variant.", `out_of_stock`, `coupon_invalid`) |
| `GET /stores/{store}/orders/{order}` | O A S | — | 200 `Order` (items, events newest first ≤ 200, payments, shipment, customer summary) | 404 |
| `PATCH /stores/{store}/orders/{order}` | O A S | `UpdateOrderInput` (`revision` required): `contact`, `shipping_address`, `customer_note`, `tags` | 200 `Order` + `meta.shipping_hint` (P5-20); `edited` event lists changed fields (values not logged) | 404; 409 `revision_conflict`, `invalid_state_transition` (status not editable) |
| `POST /stores/{store}/orders/{order}/confirm` | O A S | `{ notify_customer?: bool }` | 200 `Order`. Also the **un-pack** path `ready_to_ship → confirmed` (P5-17); the `order_confirmed` SMS is only considered on `pending → confirmed` (amended 2026-11-22, QA 5a F-L6) | 404; 409 `invalid_state_transition` |
| `POST /stores/{store}/orders/{order}/ready` | O A S | — | 200 | 404; 409 |
| `POST /stores/{store}/orders/{order}/ship` | O A S | `ShipOrderInput` `{ carrier_name? ≤ 60, tracking_code? ≤ 64, tracking_url? (https only, ≤ 500), notify_customer?: bool }` | 200 (creates `shipments` row `manual`, `cod_amount = total − paid`; `InventoryService::ship`) | 404; 409; 422 |
| `POST /stores/{store}/orders/{order}/deliver` | O A S | — | 200 (COD payment succeeded, `paid`, customer counters) | 404; 409 |
| `POST /stores/{store}/orders/{order}/return` | O A S | `{ restock: [{ item_id, quantity }], note? }` (default UI: all lines) | 200 (`returned`; restock via ledger `order_returned`; COD payment → `cancelled` if never collected) | 404; 409; 422 (`restock.N.quantity` > shipped) |
| `POST /stores/{store}/orders/{order}/cancel` | O A S (unpaid); O A (`paid_amount > 0`) | `{ reason, note? ≤ 500, notify_customer?: bool }` | 200 (`cancelled`; `committed` released; coupon released; customer `orders_count − 1`; COD payment `cancelled`) | 403 `forbidden` (staff, paid); 404; 409 |
| `POST /stores/{store}/orders/bulk` | O A S | `{ action: 'confirm' \| 'ready', ids: 1–100 }` | 200 `{ data: { action, updated: n, skipped: [{ id, reason: 'invalid_state_transition' }] } }` — each order is its own transaction; invalid states are skipped, not fatal | 422 (`ids.N` = "Unknown order." for foreign ids; nothing applied) |
| `POST /stores/{store}/orders/{order}/notes` | O A S | `{ body: 1–1000 }` | 201 `OrderEvent` (`type: note`) | 404 |
| `POST /stores/{store}/orders/{order}/refunds` | O A (`ManageRefunds`) | `RefundInput` `{ amount, method, reference? ≤ 64, note? ≤ 255 }`; `Idempotency-Key` required | 201 `Payment` (refund) | 403; 404; 409 idempotency; 422 `refund_exceeds_paid` |

Every transition: lock the order row `FOR UPDATE`, check `OrderStateMachine::can(from, to)`, apply side effects,
set the `*_at` column, write `order_events` (`status_changed`, actor), bump `revision`, dispatch notifications after
commit. Audit: `order.cancelled` (paid only), `order.refunded`, `order.shipping_overridden`.

`ManualOrderInput` = `CheckoutInput` fields minus `expected_total_amount`, plus `items: [{ variant_id, quantity 1–99 }]`
(1–50, distinct variants of **this store**, product active or draft — archived refused), `channel` (required, not
`website`), `coupon_code?`, `shipping_amount_override?`, `customer_id?` (must be this store's; else matched by phone),
`notify_customer?` (default true). Cost and stock rules are identical to checkout; `out_of_stock` can be bypassed only by
variants with `allow_backorder`.

As built (amended 2026-11-22, QA 5a F-L6): manual orders are accepted while `checkout.cod_enabled` is off (the toggle governs storefront checkout;
the merchant collects however they like). A manual line with an unknown, disabled or archived variant is 422
`validation_failed` on `items.N.variant_id` (not `out_of_stock`). With no shipping zones configured (only possible
before go-live, since publish requires the fallback zone) the delivery charge is ৳ 0 unless overridden; the UI offers
"Change".

**Example** `POST /stores/01J…/orders/01JORD…/cancel` `{ "reason": "unreachable", "note": "No answer 3 times", "notify_customer": true }`
→ 200 `{ "data": { "id": "01JORD…", "number": "GS-1041", "status": "cancelled", "payment_status": "unpaid", "revision": 4, … } }`.
The same call by staff on an order with `paid_amount > 0` → 403 `{"error":{"code":"forbidden","message":"Only owners and managers can cancel paid orders."}}`.

### 3.8 Go-live (merchant; O A `ManageSettings`)

| Method & path | Success | Errors |
|---|---|---|
| `GET /stores/{store}/launch-checklist` (O A S read) | 200 `LaunchChecklist` `{ status, can_publish, items: [{ key, required, done, href }] }`; keys: `products` (req), `shipping` (req), `payments` (req), `contact_phone` (req), `policy_pages`, `first_order` | 404 |
| `POST /stores/{store}/publish` | 200 `Store` (`status: active`, `published_at`) | 404; 409 `launch_blocked` (`details.products = ["Add at least one active product."]`, `shipping = ["Set your delivery charges."]`, `payments = ["Turn on at least one way to pay."]`, `contact_phone = ["Add a phone number customers can call."]`) |

### 3.9 Dashboard and customers (changes)
- `DashboardSummary.orders` (was always `null`) = `OrderDashboard` (§6): this month (store timezone) `count`,
  `sales_amount` (Σ total of delivered orders), `delivered_count`, `returned_count`, `cancelled_count`,
  `delivery_success_rate` (delivered / (delivered + returned), null when 0), `waiting` `{ pending, confirmed,
  ready_to_ship }`, `best_sellers` (top 5 products by units, 30 days, non-cancelled), `plan { used, limit }`.
  `null` only when the store has never had an order. Month rule (amended 2026-11-22, QA 5a F-L6): each figure is grouped by the month of its own
  timestamp in the store timezone: `count` by `placed_at`, `delivered_count` and `sales_amount` by `delivered_at`,
  `returned_count` by `returned_at`, `cancelled_count` by `cancelled_at`.
- `Customer` gains `delivered_orders_count`, `returned_orders_count`. `source` can now be `storefront`.

---

## 4. Shipping, coupons, orders UI rules (owner WEB) — summary
- **Money inputs** reuse the Phase 4 `MoneyInput` (৳ major units → paisa). Percent input 1–100 with up to 2 decimals →
  bps.
- **Order "Next step"** column (7:276) is derived client-side: pending → "Confirm", confirmed → "Mark packed",
  ready_to_ship → "Mark shipped", shipped → "Mark delivered", final states → none. The risk/advance texts ("Ask ৳ 130
  advance") are 5b.
- **Customer line** in the list: "{phone} · {nth} order · {delivered}/{orders} delivered" from the customer counters
  (this shop only).
- **Cancel dialog** (41:9687): reason select (6 reasons), note, "Send SMS to customer" (default from the store toggle).
  "Restock items" is not shown (unshipped orders always release stock; P5-5). "Block this number" and gateway
  voiding are hidden (5b/Phase 8).
- **Ship dialog** (no frame; reuse the cancel dialog layout): courier name (free text with suggestions Steadfast,
  Pathao, RedX, Sundarban, Other), tracking code, tracking link, "Send SMS with tracking".
- **Return dialog**: lines with restock quantity steppers (default full), note.
- **Refund dialog** (O A): amount (≤ refundable), method select, TrxID/reference, note.
- **Zone editor** (66:17755): area picker = district list with expandable thanas, search; whole-district checkbox;
  areas taken by another zone are shown disabled with that zone's name.

---

## 5. Storefront (owner SF) — routes and rules

Theme Gallery (`modern-commerce`). Desktop frames on page 1:9207, mobile on 2:6. Every page uses existing theme
components and tokens; no new visual styles. All prices are paisa formatted by `formatBdt`.

| Route | Figma | Build | Defer / hide |
|---|---|---|---|
| `/products/[slug]` PDP | desktop `1:11034`, mobile `1:11250` | Breadcrumb (Home › first category › name); gallery with thumbnails (product images, variant image switches main); title; price + compare-at struck + "Save ৳ N" chip; option selectors as chips (colour values as text chips); "Only N left" from availability; qty stepper; **Add to cart**; **Buy now — cash on delivery** (adds then goes to `/checkout`); delivery box from `config.commerce.delivery` ("Inside Dhaka ৳ 70 · 1–2 days …", free-delivery line) + "Cash on delivery available"; accordions **Description** (RichText) and **Delivery & returns** (link to the store's delivery policy page if published); "Ask about this on WhatsApp" (`https://wa.me/{whatsapp}?text=…`, `rel="noopener noreferrer"`), Share (Web Share API, copy fallback); **Pairs well with** = 4 cards from the same first category (`exclude` this product), hidden when empty. Unavailable variant → button "Sold out" disabled. JSON-LD `Product` (offers price/currency/`availability` InStock when any enabled variant is untracked/backorder or the product had stock at render) + `BreadcrumbList` | Vendor line, Bestseller badge, rating/reviews block, size guide, colour swatches, wishlist heart, "Frequently bought together" bundle, "Size & fit" and "Materials & care" accordions, "7-day easy returns" claim (only if the policy page exists), mobile order-form layout `16:2` |
| `/c/[slug]` PLP | desktop `1:10821`, mobile `1:10946` | Breadcrumb; title + total count ("380 pieces"); description; category image; child-category chips; **Filters: Price (min/max inputs) and In stock only**; active filter chips + "Clear all"; sort (Most popular = bestsellers, Newest, Price low→high, high→low); grid of cards (sale badge `−N%` from compare-at); card "Add to cart" adds the cheapest enabled variant for simple products, links to the PDP ("Choose options") for variable ones; numbered pagination + "Load 24 more" (appends next page client-side). Empty category → "Nothing here yet" + link home | Age/Material/Colour/Brand/Size facets, promo tile (Gallery Club), wishlist heart, ratings on cards |
| `/search?q=` | `1:12443` | Same grid and pagination as PLP over `q`; header search submits here; `noindex` | Suggestions/autocomplete |
| `/cart` | desktop `1:11378`, mobile `1:11506` / `31:6473` | Lines (image, name, variant, issue text "Only 4 left in this size" / "No longer available", price + compare-at, stepper, Remove); free-delivery progress bar ("Add ৳ 450 more for free delivery" / "Free delivery unlocked!"); summary: items, coupon line, "Delivery — Calculated at next step", estimated total, "You save ৳ N"; coupon field (Apply/Remove, error text from API); Checkout button (disabled while issue lines exist); trust list ("Cash on delivery available", "Totals confirmed by our server"); "Pay with" badges from `payment_methods`; WhatsApp help card if the store has WhatsApp. Empty bag state with "Continue shopping" | Save for later, "Often added" rail, "7-day easy returns" unless policy published, gift card field |
| `/checkout` | desktop `1:11591`, mobile `1:11690` / `32:5087` | One page: Contact (name, mobile "Order updates by SMS", email optional); Delivery address (Division → District → Upazila/Thana selects from `/geo/bd`, Area text, House/road/flat, Landmark, Home/Office chips); Delivery (the resolved zone as one selected option: name, days, charge or "Free"; refreshed on thana change; note "Delivery charge is set by your area"); Payment (**Cash on delivery** only); order note; "Your order" summary + **Place order — ৳ N** (sends `expected_total_amount` and a per-attempt `Idempotency-Key` generated server-side and kept in a hidden field so double-clicks and retries reuse it). Errors map to fields; 409 `checkout_changed` → refresh summary and show the message; `out_of_stock` → back to the cart with notices | Stepper is decorative (Bag/Delivery/Payment/Confirm, current = Delivery); bKash/Nagad/Card options (5b); gift wrap; Express option; phone OTP |
| `/checkout/thank-you` | `1:11788`, mobile `33:5751` | From `sp_order` cookie: "Thank you, {first name}!", number, "Pay ৳ N in cash when it arrives", **Track this order** (→ `/track` prefilled number), Continue shopping, "What happens next" timeline (placed → confirming → packed → with the courier → delivered), Delivering to, order summary, WhatsApp help. No cookie/expired → redirect `/` | Hero photo is the theme's static image |
| `/track` | `1:11959`, mobile `33:5864` | Form (order number, phone) → status timeline from events (placed, confirmed, packed, shipped with courier name/tracking link, delivered/returned/cancelled), items and totals; district/thana only | Live courier map/tracking (5b) |
| `/discount/[code]` | (Q38; Figma share link) | Server Action: create/attach cart, `PUT /storefront/cart/coupon`, redirect to `/` with a toast "Code {CODE} will apply at checkout" (or the error message) | — |
| Header/footer | chrome `1:10644` | Cart icon badge = line count from `GET /api/cart-summary` (client fetch, no-store); "Track order" link in the top bar → `/track`; footer "Pay with" from `payment_methods`; product cards site-wide now link to the PDP (Phase 4 rendered them without links) | Account/sign-in, wishlist icons are hidden |

Rules:
- **Caching:** PDP, PLP, search, categories: public fetches `next: { tags: [storeTag(host)], revalidate: 300 }`,
  preview `no-store` (Phase 4 pattern, `config-request.ts`). `/cart`, `/checkout`, `/checkout/thank-you`, `/track`,
  `/discount/*`: `dynamic = 'force-dynamic'`, `Cache-Control: private, no-store`, never tagged. The PDP HTML never
  includes availability or cart data.
- **Cookies:** `sp_cart` (P5-3), `sp_order` (confirmation token, HttpOnly, Secure, SameSite=Lax, Max-Age 86400).
  Both set only from Server Actions. `sp_cart` is cleared on 404 `cart_not_found` and after a successful checkout.
- **Server Actions:** `addToCart`, `updateLine`, `removeLine`, `applyCoupon`, `removeCoupon`, `placeOrder`,
  `trackOrder`. Each validates input with Zod before calling the API and returns typed results; API `details` map to
  form fields. Route handlers (read-only, GET): `/api/cart-summary`, `/api/availability/[slug]`,
  `/api/shipping-quote?district_code&thana_code` (checkout zone refresh). They return `Cache-Control: no-store`.
- **Client IP:** the storefront forwards the shopper IP as `X-Storefront-Client-Ip` (from the trusted proxy header
  only) on cart, checkout and track calls.
- **SEO:** `generateMetadata` for PDP (`seo.title || name`, `seo.description || first 160 chars of description text`,
  OG image = cover) and PLP (category name/description, image). Canonical on the primary host. Sitemap adds every
  public product (`/products/{slug}`, `lastmod = updated_at`) and visible category (`/c/{slug}`), capped at 5 000
  URLs. robots `Disallow: /cart, /checkout, /track, /search, /discount`.
- **Draft store:** Coming soon unchanged for the public. Preview: catalog, cart work; "Place order" shows the
  `store_not_live` message.
- **Product links:** `/products/{slug}` everywhere (cards, hero, flash sale). Category nav items of type `category`
  (Phase 3 navigation) now resolve to `/c/{slug}`.

---

## 6. § Types (orchestrator applies) — `packages/types/src/index.ts`

```ts
// ---------- Geo ----------
export interface BdDivision { code: string; name: string; name_bn: string }
export interface BdDistrict { code: string; division_code: string; name: string; name_bn: string }
export interface BdThana { code: string; district_code: string; name: string; name_bn: string; is_city: boolean }
export interface BdGeo { version: string; divisions: BdDivision[]; districts: BdDistrict[]; thanas: BdThana[] }

export type AddressLabel = 'home' | 'office';
export interface AddressInput {
  district_code: string; thana_code: string; area?: string | null;
  address_line: string; landmark?: string | null; label?: AddressLabel | null;
}
export interface Address extends Required<Omit<AddressInput, 'label'>> {
  division_code: string; division: string; district: string; thana: string; label: AddressLabel | null;
}

// ---------- Permissions (P5-21) ----------
// ROLE_CAN gains:
//   manage_marketing: ['owner','admin'], manage_refunds: ['owner','admin'], manage_settings: ['owner','admin']

// ---------- Shipping ----------
export interface ShippingZoneArea { district_code: string; thana_code: string | null; label: string }
export interface ShippingZone {
  id: string; name: string; kind: 'custom' | 'fallback'; charge_amount: number;
  min_days: number; max_days: number; is_active: boolean; position: number;
  areas: ShippingZoneArea[]; area_summary: string;        // "Dhaka city · 50 thanas"
}
export interface ShippingZoneInput {
  id?: string; name: string; kind: 'custom' | 'fallback'; charge_amount: number;
  min_days: number; max_days: number; is_active?: boolean;
  areas?: { district_code: string; thana_code?: string | null }[];
}
export interface PickupLocation {
  id: string; name: string; contact_name: string | null; contact_phone: string | null;
  district_code: string; thana_code: string; district: string; thana: string;
  address_line: string; is_default: boolean; created_at: string; updated_at: string;
}
export interface PickupLocationInput {
  name: string; contact_name?: string | null; contact_phone?: string | null;
  district_code: string; thana_code: string; address_line: string; is_default?: boolean;
}
export interface ShippingSettings {
  zones: ShippingZone[]; pickup_locations: PickupLocation[];
  free_delivery_over_amount: number | null; configured: boolean;
}
export interface SaveShippingInput { zones: ShippingZoneInput[]; free_delivery_over_amount: number | null }
export interface ShippingQuote {
  zone_id: string; zone_name: string; min_days: number; max_days: number;
  charge_amount: number;          // before free delivery
  amount: number;                 // what the shopper pays
  is_free: boolean;
}

// ---------- Store settings additions ----------
export type CustomerSmsEvent = 'order_placed' | 'order_confirmed' | 'order_shipped' | 'order_cancelled';
export interface StoreCommerceSettings {
  checkout: { cod_enabled: boolean };
  order_prefix: string;                      // effective prefix
  next_order_number: string;                 // "GS-1049"
  notifications: {
    new_order_email: boolean; sms_language: 'bn' | 'en';
    customer_sms: Record<CustomerSmsEvent, boolean>;
  };
}
// StoreSettings gains: commerce: StoreCommerceSettings
// UpdateStoreSettingsInput gains: checkout?: { cod_enabled?: boolean }; order_prefix?: string;
//   notifications?: { new_order_email?: boolean; sms_language?: 'bn'|'en'; customer_sms?: Partial<Record<CustomerSmsEvent, boolean>> }
// LimitKey gains 'sms_per_month'

// ---------- Coupons ----------
export type CouponType = 'percentage' | 'fixed' | 'free_shipping';
export type CouponStatus = 'draft' | 'active' | 'disabled';
export type CouponDisplayStatus = CouponStatus | 'scheduled' | 'expired' | 'used_up';
export type CouponAppliesTo = 'all' | 'categories' | 'products';
export interface Coupon {
  id: string; code: string; type: CouponType;
  percent_bps: number | null; amount: number | null; max_discount_amount: number | null;
  applies_to: CouponAppliesTo; categories: CategoryRef[];
  products: { id: string; name: string; image: MediaRef | null; price_min_amount: number }[];
  min_subtotal_amount: number | null; usage_limit: number | null; usage_per_customer: number | null;
  first_order_only: boolean; starts_at: string; ends_at: string | null;
  status: CouponStatus; display_status: CouponDisplayStatus;
  stats: { used_count: number; orders_count: number; revenue_amount: number; discount_amount: number };
  share_path: string;                        // "/discount/WINTER15"
  revision: number; created_by: UserRef | null; created_at: string; updated_at: string;
}
export interface CreateCouponInput {
  code: string; type: CouponType; percent_bps?: number | null; amount?: number | null;
  max_discount_amount?: number | null; applies_to?: CouponAppliesTo;
  category_ids?: string[]; product_ids?: string[];          // ≤ 100 each
  min_subtotal_amount?: number | null; usage_limit?: number | null; usage_per_customer?: number | null;
  first_order_only?: boolean; starts_at?: string; ends_at?: string | null; status?: CouponStatus;
}
export interface UpdateCouponInput extends Partial<CreateCouponInput> { revision: number }
export interface CouponListFilters {
  q?: string; type?: CouponType[]; status?: CouponDisplayStatus[];
  sort?: '-created_at' | '-revenue' | '-used_count'; page?: number; per_page?: number;
}
export interface CouponListMeta extends PaginationMeta { counts: Record<'all' | 'active' | 'scheduled' | 'expired', number> }

// ---------- Storefront catalog ----------
export interface StorefrontProductQuery {
  sort?: 'latest' | 'bestsellers' | 'price_asc' | 'price_desc'; limit?: number; page?: number; per_page?: number;
  on_sale?: boolean; category?: string; q?: string; price_min?: number; price_max?: number;
  in_stock?: boolean; exclude?: string;
}   // replaces the Phase 4 StorefrontProductQuery (superset)
export interface StorefrontProductListMeta extends Partial<PaginationMeta> { has_products: boolean }
export interface StorefrontVariant {
  id: string; title: string; option_values: string[];
  price_amount: number; compare_at_amount: number | null; image_media_id: string | null;
}
export interface StorefrontProduct {
  id: string; slug: string; name: string; description: RichTextDoc | null;
  options: ProductOption[]; variants: StorefrontVariant[];      // enabled variants only
  images: { media_id: string; alt: string | null; media: StorefrontMedia }[];
  price_min_amount: number; price_max_amount: number; currency: string;
  categories: { slug: string; name: string }[];                 // first = primary for breadcrumb
  seo: { title: string | null; description: string | null };
  url_path: string; is_preview_only: boolean; updated_at: string;
}
export interface StorefrontAvailability {
  variants: { id: string; available: boolean; low_stock: number | null }[];
}
export interface StorefrontCategory {
  slug: string; name: string; image: StorefrontMedia | null; url_path: string;   // "/c/{slug}"
  children: StorefrontCategory[];
}
export interface StorefrontCategoryDetail extends Omit<StorefrontCategory, 'children'> {
  description: string | null; ancestors: { slug: string; name: string }[];
  children: { slug: string; name: string; url_path: string }[];
}
export interface StorefrontCommerce {
  checkout_enabled: boolean; payment_methods: PaymentMethod[];
  free_delivery_over_amount: number | null;
  delivery: { name: string; charge_amount: number; min_days: number; max_days: number }[];
}
// StorefrontConfig gains: commerce?: StorefrontCommerce   (optional on the wire for rolling deploys)

// ---------- Cart ----------
export type CartLineIssue = 'unavailable' | 'insufficient_stock';
export interface CartLine {
  id: string; variant_id: string; product_slug: string; product_name: string; variant_title: string;
  option_values: string[]; image: StorefrontMedia | null; quantity: number;
  unit_price_amount: number; compare_at_amount: number | null; line_amount: number;
  issue: CartLineIssue | null; max_quantity: number | null; low_stock: number | null;
}
export interface Cart {
  lines: CartLine[]; lines_count: number; items_count: number; currency: string;
  coupon: { code: string; type: CouponType; discount_amount: number; free_shipping: boolean } | null;
  subtotal_amount: number; discount_amount: number; savings_amount: number; estimated_total_amount: number;
  free_delivery: { threshold_amount: number; remaining_amount: number } | null;
  can_checkout: boolean;
}
export interface CartMeta { cart_token?: string; notices?: string[] }

// ---------- Checkout / storefront orders ----------
export type PaymentMethod = 'cod' | 'bkash' | 'sslcommerz';   // 5a: 'cod' only
export interface CheckoutInput {
  contact: { name: string; phone: string; email?: string | null };
  shipping_address: AddressInput; payment_method: PaymentMethod;
  customer_note?: string | null; accepts_marketing?: boolean; expected_total_amount: number;
}
export interface StorefrontOrderLine {
  product_name: string; variant_title: string; quantity: number; image: StorefrontMedia | null;
  unit_price_amount: number; total_amount: number;
}
export interface StorefrontOrder {
  number: string; status: OrderStatus; payment_method: PaymentMethod; placed_at: string;
  customer_name: string; customer_phone: string; shipping_address: Address;
  lines: StorefrontOrderLine[]; coupon_code: string | null;
  subtotal_amount: number; discount_amount: number; shipping_amount: number; total_amount: number;
  due_amount: number; currency: string; delivery: { zone_name: string; min_days: number | null; max_days: number | null };
}
export interface CheckoutResult { order: StorefrontOrder; confirmation_token: string }
export interface TrackOrderInput { number: string; phone: string }
export interface StorefrontOrderTracking {
  number: string; status: OrderStatus; placed_at: string;
  shipping: { district: string; thana: string };
  lines: StorefrontOrderLine[]; total_amount: number; due_amount: number; currency: string;
  timeline: { status: OrderStatus; at: string }[];
  shipment: { carrier_name: string | null; tracking_code: string | null; tracking_url: string | null } | null;
}

// ---------- Orders (merchant) ----------
export type OrderStatus = 'pending_payment' | 'pending' | 'confirmed' | 'ready_to_ship' | 'shipped' | 'delivered' | 'returned' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded';
export type OrderChannel = 'website' | 'facebook' | 'instagram' | 'whatsapp' | 'phone' | 'walk_in' | 'landing_page' | 'other';
export type CancelReason = 'customer_request' | 'fake_order' | 'unreachable' | 'out_of_stock' | 'duplicate' | 'other';
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: [], pending: ['confirmed', 'cancelled'], confirmed: ['ready_to_ship', 'shipped', 'cancelled'],
  ready_to_ship: ['shipped', 'confirmed', 'cancelled'], shipped: ['delivered', 'returned'],
  delivered: [], returned: [], cancelled: [],
};
export interface OrderCustomerSummary {
  id: string | null; name: string; phone: string; email: string | null;
  orders_count: number; delivered_orders_count: number; returned_orders_count: number;
  total_spent_amount: number;
}
export interface OrderSummary {
  id: string; number: string; status: OrderStatus; payment_status: PaymentStatus; payment_method: PaymentMethod;
  channel: OrderChannel; created_via: 'storefront' | 'dashboard';
  customer: OrderCustomerSummary; district: string; thana: string;
  items_count: number; total_amount: number; paid_amount: number; due_amount: number; currency: string;
  coupon_code: string | null; tags: string[]; placed_at: string; updated_at: string;
}
export interface OrderItem {
  id: string; product_id: string | null; variant_id: string | null;
  product_name: string; variant_title: string; option_values: string[]; sku: string | null;
  image: MediaRef | null; unit_price_amount: number; compare_at_amount: number | null;
  unit_cost_amount: number | null;                         // null for staff (ViewCosts)
  quantity: number; subtotal_amount: number; discount_amount: number; total_amount: number;
  restocked_quantity: number;
  current_stock: { available: number; tracked: boolean } | null;   // "43 in stock"; null when variant deleted
}
export interface OrderEvent {
  id: string; type: 'placed' | 'status_changed' | 'note' | 'edited' | 'payment' | 'refund' | 'shipment' | 'notification' | 'coupon_released';
  from_status: OrderStatus | null; to_status: OrderStatus | null;
  actor: { type: 'user' | 'customer' | 'system'; user: UserRef | null };
  body: string | null; meta: Record<string, unknown>; created_at: string;
}
export interface Payment {
  id: string; provider: 'cod' | 'manual' | 'bkash' | 'sslcommerz'; type: 'charge' | 'refund';
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled'; amount: number; currency: string;
  method: RefundMethod | null; reference: string | null; note: string | null;
  actor: UserRef | null; created_at: string;
}
export interface Shipment {
  id: string; provider: 'manual' | 'steadfast' | 'pathao' | 'redx'; carrier_name: string | null;
  tracking_code: string | null; tracking_url: string | null; status: 'shipped' | 'delivered' | 'returned' | 'cancelled';
  cod_amount: number; shipped_at: string | null; delivered_at: string | null; returned_at: string | null;
}
export interface Order extends OrderSummary {
  contact: { name: string; phone: string; email: string | null };
  shipping_address: Address; customer_note: string | null;
  items: OrderItem[]; events: OrderEvent[]; payments: Payment[]; shipment: Shipment | null;
  subtotal_amount: number; discount_amount: number; shipping_amount: number; shipping_discount_amount: number;
  tax_amount: number; refunded_amount: number;
  shipping_zone_name: string; delivery_min_days: number | null; delivery_max_days: number | null; shipping_overridden: boolean;
  cancel_reason: CancelReason | null;
  timestamps: Partial<Record<'confirmed_at' | 'shipped_at' | 'delivered_at' | 'returned_at' | 'cancelled_at', string>>;
  allowed_transitions: OrderStatus[];                      // already filtered by role
  can: { edit: boolean; cancel: boolean; refund: boolean };
  revision: number; created_by: UserRef | null;
}
export interface OrderListFilters {
  status?: OrderStatus[]; payment_status?: PaymentStatus[]; channel?: OrderChannel[]; district_code?: string;
  customer_id?: string; coupon_id?: string; placed_from?: string; placed_to?: string; q?: string;
  sort?: '-placed_at' | 'placed_at' | '-total'; page?: number; per_page?: number;
}
export interface OrderListMeta extends PaginationMeta { counts: Record<'all' | OrderStatus, number> }
export interface ManualOrderInput extends Omit<CheckoutInput, 'expected_total_amount' | 'payment_method'> {
  items: { variant_id: string; quantity: number }[]; channel: Exclude<OrderChannel, 'website'>;
  payment_method?: 'cod'; coupon_code?: string | null; shipping_amount_override?: number | null;
  customer_id?: string | null; notify_customer?: boolean;
}
export interface OrderQuote {
  lines: (Omit<OrderItem, 'id' | 'restocked_quantity'> & { issue: CartLineIssue | null })[];
  zone: ShippingQuote | null; coupon_error: string | null;
  subtotal_amount: number; discount_amount: number; shipping_amount: number; total_amount: number;
  customer: OrderCustomerSummary | null;                   // matched by phone in this store
}
export interface UpdateOrderInput {
  revision: number; contact?: { name?: string; phone?: string; email?: string | null };
  shipping_address?: AddressInput; customer_note?: string | null; tags?: string[];
}
export interface ShipOrderInput { carrier_name?: string | null; tracking_code?: string | null; tracking_url?: string | null; notify_customer?: boolean }
export interface ReturnOrderInput { restock: { item_id: string; quantity: number }[]; note?: string | null }
export interface CancelOrderInput { reason: CancelReason; note?: string | null; notify_customer?: boolean }
export type RefundMethod = 'cash' | 'bkash_personal' | 'nagad_personal' | 'bank' | 'other';
export interface RefundInput { amount: number; method: RefundMethod; reference?: string | null; note?: string | null }
export interface OrderBulkInput { action: 'confirm' | 'ready'; ids: string[] }
export interface OrderBulkResult { action: 'confirm' | 'ready'; updated: number; skipped: { id: string; reason: string }[] }

// ---------- Go-live ----------
export type LaunchItemKey = 'products' | 'shipping' | 'payments' | 'contact_phone' | 'policy_pages' | 'first_order';
export interface LaunchChecklist {
  status: 'draft' | 'active'; can_publish: boolean; published_at: string | null; shop_url: string;
  items: { key: LaunchItemKey; required: boolean; done: boolean; href: string }[];
}

// ---------- Dashboard ----------
export interface OrderDashboard {
  this_month: {
    count: number; sales_amount: number; delivered_count: number; returned_count: number;
    cancelled_count: number; delivery_success_rate: number | null;   // 0..1
  };
  waiting: { pending: number; confirmed: number; ready_to_ship: number };
  best_sellers: { product_id: string; name: string; image: MediaRef | null; units: number }[];
  plan: { used: number; limit: number | null };
}
// DashboardSummary.orders: null → OrderDashboard | null
// Customer gains: delivered_orders_count: number; returned_orders_count: number
// StockMovementReason gains 'order_shipped' | 'order_returned'; StockMovement.reference type gains 'order'
```
Notes:
- `AuditLogFilters.subject_type` allowlist gains `order`, `coupon`, `shipping`, `store`.
- Everything is additive; `StorefrontProductQuery` becomes a superset. `OrderStatus` includes `pending_payment` so 5b
  needs no type change.

---

## 7. Checkout and stock: concurrency rules (owner API)
- **Lock order everywhere** (checkout, manual order, cancel, ship, return): order row (if any) → inventories by
  `variant_id` ascending → coupon → store counter. Never lock a product row in these paths.
- `InventoryService::commit` on Postgres uses the existing `lockForUpdate` read followed by an `UPDATE … SET committed
  = committed + :q WHERE id = :id`; on sqlite the transaction is serialised by the database.
- `InventoryService::ship`: `on_hand -= q`, `committed -= q` (never below 0; a negative result is a bug and throws),
  one ledger row per variant (`order_shipped`, `reference = order`).
- Merchant adjustments (Phase 4) may set `on_hand` below `committed`; `available` then shows negative → "Out of stock"
  with the inventory row reading "Held for orders N". This is allowed and documented in the UI tooltip.
- Idempotency (`IdempotencyGuard`): insert the key row with `status = processing`, `locked_until = now + 30 s`, in its
  **own** short transaction before the business transaction; on success store the response and `completed`; on an
  exception delete the row so the client can retry with the same key. A `processing` row past `locked_until` is taken
  over.
- Job retries never re-run placement; notifications are separate queued jobs keyed by `(order_id, event)` so a retry
  sends at most one SMS per event. As built (amended 2026-11-22, QA 5a F-L6): the dedupe reads the order's `notification` rows in `order_events`
  (`meta.channel = sms`, `meta.event`) under the order row lock, since `sms_messages` has no `order_id`.

---

## 8. Notifications (owner API)

| Event | Shopper SMS (bn default) | Shopper email | Merchant email |
|---|---|---|---|
| `order_placed` | "প্রিয় {first_name}, {shop} এ আপনার অর্ডার {number} পেয়েছি। মোট {total} টাকা, ডেলিভারির সময় পরিশোধ করবেন। ট্র্যাক: {track_url}" / en "{shop}: Order {number} received. Total Tk {total}, pay on delivery. Track: {track_url}" | "Your order {number} at {shop}" (items, totals, address, track link) | "New order {number} · Tk {total}" (link to dashboard order) |
| `order_confirmed` | "{shop}: আপনার অর্ডার {number} কনফার্ম হয়েছে।" / "Order {number} is confirmed." | — | — |
| `order_shipped` | "{shop}: অর্ডার {number} {carrier} এর মাধ্যমে পাঠানো হয়েছে। {due} টাকা প্রস্তুত রাখুন। ট্র্যাক: {track_url}" / en equivalent | — | — |
| `order_cancelled` | "{shop}: অর্ডার {number} বাতিল করা হয়েছে।" / "Order {number} has been cancelled." | — | — |

- Amounts in SMS use "Tk"/"টাকা" (৳ is not GSM-7). `{track_url}` = `https://{primary_host}/track` (no token).
- Templates live in `resources/sms/{bn,en}.php`; a unit test asserts every template renders ≤ 3 UCS-2 segments
  (201 chars) for a 40-char shop name.
- Mail: `OrderPlacedMail`, `NewOrderMerchantMail` (Markdown mailables, store logo from media, no remote images except
  the CDN). Queued on `notifications`; failures logged with `order_id` only.
- Store has no contact email and owner email unverified → merchant email skipped (logged).

---

## 9. Dashboard screens (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`

Every screen ships loading, error and no-results states (`148:35302`, `148:35336`, `148:35352`); empty Orders uses
`148:34033`. `packages/ui` components and tokens only.

| Screen / route | Figma frame ids | Build | Skip / disable |
|---|---|---|---|
| Orders `/orders` | `7:276` | Header "Confirm, ship and collect…". Status tabs with counts: All, Pending, Confirmed, Ready to ship, In transit (= `shipped`), Delivered, Returned, Cancelled. Search "Order no, name or phone"; filters Payment, Source (= channel), District, date range ("Last 30 days" default). Table: Order (number, "{time ago} · {channel}"), Customer (name; phone · nth order · x/y delivered), District, Total · Due, Status badge, Next step button (§4). Bulk bar: Confirm, Mark packed. "+ Create order" | Courier problems tab, Risk column/filter, Quick chips (advance), bulk "Book courier" `39:18808`, print |
| Order detail `/orders/:id` | `33:3676`; cancel `41:9687`; edit `144:46654` | Header: number, placed time, channel; status badge; actions by `allowed_transitions` (Confirm / Mark packed / Mark shipped / Mark delivered / Returned / Cancel). Items card (variant, SKU, "N in stock" from `current_stock`, qty × price), totals (Subtotal, Delivery · zone, Discount · code, Total, Paid, Due on delivery). Payments card (COD row; refunds list; "Record refund" O A). Shipping card (zone, manual shipment details or "Not shipped yet"). Timeline (events, newest first) with "Add a note for your team…". Customer card (initials, name, phone with Call `tel:` and WhatsApp, "{n}th order", Delivered/Returned/Spent tiles, **this shop only**), Delivery address with Edit (dialog, P5-20 shipping hint). Order details (source, payment) and tags. Edit order page (`144:46654`) = contact + address + note only, "Why the change?" saved as a note, "Send updated total by SMS" hidden | Assigned to, Invoice button, advance payment `144:46081`, fraud banner and Delivery record (Q23), Block this number, "Edit items", courier booking card, campaign field |
| Create order `/orders/new` | `39:14382` | "Where did this order come from?" = channel chips. Phone first → `OrderQuote.customer` ("Returning · 3rd order", delivered x/y, this shop). Name, address (same selects as checkout). Products: search picker (`GET /products?q=`), variant select, qty, stock hint. Delivery charge auto from address with "Change" (override, O A S). Coupon field. Order summary from `POST /orders/quote` (debounced 300 ms). Payment: COD. Note. "Send order SMS to buyer" (default on). Submit with an `Idempotency-Key` per form session | Paste chat message (AI), barcode scan, "Draft saved", payment links, "Print on courier label" |
| Customers `/customers`, detail | `63:14972`, `64:16382` | Delivered and Returns columns/tiles now show counts; detail gains an **Orders** table (`GET /orders?filter[customer_id]=`) and Avg order (`total_spent / delivered`) | Risk, Delivery record across Storeplix (Q23), "Create order" button → links to `/orders/new?phone=` (allowed) |
| Coupons `/marketing/coupons` | `67:18689` | Title "Discounts & coupons"; tabs All / Active / Scheduled / Expired (counts); stat tiles hidden except "Active coupons"; search code; Type and Status dropdowns; sort Most revenue; table: code (+ value line), type, min order, usage "used / limit", revenue, valid (dates), status badge; row → edit. "+ Create coupon" (O A) | Tip card ("PUJA20 sold out…"), Marketing overview `66:19179`, campaigns `70:19774`, abandoned cart `71:20614` |
| Create/edit coupon `/marketing/coupons/new`, `/:id` | `68:19255` | Code + Generate (client: 8 chars `A–Z2–9`), share link `/discount/{CODE}` with copy; Discount type cards (Percentage + max discount, Fixed amount, Free delivery); Applies to (All / Specific categories / Specific products) with chips and product thumbnails; Conditions: Minimum order, Total uses, Uses per customer, First order only; Active dates (store time, "No end date"); Live preview card + "At checkout" example (client-side computation mirroring P5-12 over 2 sample products). Save draft / Publish coupon (`status`) | "Only customers with a Good delivery record", "Combine with other coupons", Estimated impact |
| Settings → Shipping & delivery `/settings/shipping` | `60:14364`; edit zone `66:17755` | Delivery zones table: zone, areas summary, charge, delivery time, active toggle; fallback row labelled "Everywhere else" and not deletable; footnote "Areas not covered by any zone fall back to Outside Dhaka…". Edit zone drawer: name, areas picker, charge, delivery time (min–max days). Free delivery card (toggle + amount; preview line "Add ৳ 450 more for free delivery"). Pickup addresses card (list, add/edit dialog, default) | Default courier column and field, "You keep ৳ 10 per parcel", Weight-based charge, More options (COD charge, packaging, rounding, return charge), Courier accounts card |
| Settings → Payments & checkout `/settings/payments` | `60:14865` | Checkout payment methods: Cash on delivery toggle (only active control); Advance delivery charge and Full online payment shown disabled "Coming soon" | Advance payment rules, Connected gateways, Order form fields, Phone verification (OTP), 2 % online discount |
| Settings → Notifications `/settings/notifications` | `60:15863` | Alerts: "New order" row with the **Email** column toggle only. Customer messages: toggles for Order received, Order confirmed, Shipped with tracking, Order cancelled; language switch বাংলা/English; read-only template preview with a sample order | In-app/Push/SMS alert columns, other alerts (big order, low stock, …), template editing, sender ID, credits, "Send test SMS" |
| Settings → Taxes, invoices `/settings/invoices` | `60:16858` | Invoice numbering: prefix input + "Next invoice will be GS-1049" | VAT, invoice footer (5b) |
| Onboarding 06 `/onboarding/delivery` | desktop `50:604`; connect card `45:8086` | Step 6 of 7. Pickup address (District, Thana/Upazila, Full address → default pickup location). Delivery charges: Inside Dhaka and Outside Dhaka cards prefilled ৳ 70 / ৳ 130 with Edit; "Free delivery on orders over ৳ 3,000" toggle (amount editable); "+ Add a zone" (zone dialog). Connect a courier: Steadfast/Pathao/RedX cards with **disabled** Connect ("Coming soon"); "Connect later" link. Right: Checkout preview (zone radio + totals from the merchant's first product or a sample). Back → `/onboarding/products`; Continue → `PUT /shipping` + pickup location, then `/onboarding/payments` | Courier connect (5b) |
| Onboarding 07 `/onboarding/payments` | desktop `52:564` | Step 7 of 7. Cash on delivery card with toggle (`checkout.cod_enabled`); "Collect delivery charge in advance" disabled; Online & advance payments: bKash, SSLCommerz, EPS cards with **disabled** Connect ("Coming soon"); "Connect later"; "Money goes straight to your account" note. Right: Payment method preview (COD selected). **Finish setup** → `POST /publish`; 409 `launch_blocked` → inline list of blockers with links; success → `/onboarding/live` | Gateway connect (5b) |
| Onboarding 08 `/onboarding/live` | desktop `52:765`; mobile `54:941` | "You're live" + Bangla line; shop link with Copy; Share to Facebook (`https://www.facebook.com/sharer/sharer.php?u=`), Share on WhatsApp (`https://wa.me/?text=`); QR code (client-side, pinned `qrcode` package) with Download QR (PNG); "Finish setting up" from `launch-checklist` (create shop, first product, delivery charges, Bangla policy pages → `/online-store/pages`, first order); Go to dashboard / View my shop; phone preview (existing `PhonePreview`) | Connect Meta Pixel item |
| Dashboard `/` | `10:600`; mobile `31:4281` | KPI tiles `13:964`: Orders (this month), Delivery success (%), Sales (delivered ৳), Returns (count). "Needs you today" `10:958` gains Confirm N orders (pending) and Pack N orders (confirmed) tasks. Orders waiting `10:1115` (pending/confirmed/ready counts → links). Best sellers `10:1168` (top 5). Plan meter in the sidebar footer ("Free plan · 38 of 50 orders") | Range toggle, Sales chart `10:890`, Orders by source `10:1024`, Courier performance `10:1061`, Money flow `10:1085`, Net profit tile (Phase 7.4), Book/Call/Advance tasks |
| Mobile | Orders `31:4886`, Order detail `32:309`, Create order `32:6124`, OrderCard `30:3171`, tab bar Orders `30:3059` | The Orders tab becomes real: card list (number, customer, total · due, status, next-step button), detail stacked, create order single column; the Orders tab badge shows `waiting.pending` | Swipe actions, call-from-card shortcuts |

Sidebar: Orders children = All orders `/orders`, Create order `/orders/new`. Unfinished orders, Returns, Shipments,
Invoices & labels and Fake order guard are **hidden**. Marketing → Coupons only. Settings gains Shipping & delivery,
Payments & checkout, Notifications, Taxes & invoices. Checklist (`SetupChecklist`) gains "Delivery", "Get paid" and
"Go live" items. Onboarding 05 "Save & continue" now goes to `/onboarding/delivery` (P4-27 said `/`).

### 9.1 Client rules
- Query keys: `[tenantId, storeId, 'orders', filters]`, `[…, 'order', id]`, `[…, 'coupons', filters]`,
  `[…, 'coupon', id]`, `[…, 'shipping']`, `[…, 'launch-checklist']`, `['geo', 'bd']` (staleTime ∞).
- After any order mutation invalidate the order, orders lists, dashboard, inventory (ship/return/cancel) and the
  customer. After coupon writes invalidate coupons.
- Transitions are optimistic only for the button spinner; state comes from the response. 409 → refetch + toast
  "This order changed. We reloaded it."
- `Idempotency-Key` = `crypto.randomUUID()` created when the Create order form (or refund dialog) opens and reused
  for every retry of that submission.

---

## 10. Security checklist (each item has a test in §12)

| # | Threat | Control | Test |
|---|---|---|---|
| S1 | **Price / discount tampering** (T6) | Checkout and manual order accept only variant ids, quantities, coupon code; any `price`, `*_amount` (except `expected_total_amount`, `shipping_amount_override` for merchants) is ignored; totals from DB; `expected_total_amount` mismatch → 409 | `CheckoutPriceTampering`: body with `unit_price_amount: 1`, `discount_amount`, `total_amount` → order uses DB prices; tampered expected total → 409 and nothing written |
| S2 | **Oversell / stock race** (T7) | `commit` under ordered row locks, conditional on `on_hand − committed ≥ q`; all-or-nothing | `ConcurrentStockReservation` (Postgres, group `perf`): stock 5, 20 parallel checkouts of 1 → exactly 5 orders, `committed = 5`, 15 × 422 `out_of_stock`; mixed-cart deadlock test (A+B vs B+A, 20 pairs) → no deadlock errors |
| S3 | **Coupon over-redemption** | Coupon row lock in the order transaction, per-phone count, redemptions table | Postgres parallel test: `usage_limit 3`, 10 parallel checkouts → 3 redemptions, `used_count 3`; same phone twice with `usage_per_customer 1` → second 422 |
| S4 | **Duplicate orders on retry** | `Idempotency-Key` required, request hash, `U(store_id, idempotency_key)` | Replay → same order id + `Idempotent-Replayed`; different body same key → 409 mismatch; two concurrent same-key requests → one 201, one 409 `idempotency_key_in_use` or replay; missing or malformed key → 400 (amended 2026-11-22, QA 5a F-L6) |
| S5 | **Cart hijack / cross-store cart** | 256-bit token, sha256 at rest, httpOnly host-only cookie, cart bound to the host's store; token never logged | Token of store A sent with host B → 404 `cart_not_found`; DB contains no raw token; log scan after a cart flow has no token |
| S6 | **Cross-tenant ids in storefront and merchant payloads** (T1) | Storefront variant ids resolved within the host's store (`StoreRule::exists`), FK3 on `cart_items`; merchant `scopeBindings` + store rules; triple FKs | Variant of B added on A's host → 422; A's merchant routes with B's order/coupon/zone ids → 404; B's variant/category/product/customer ids in A's payloads → 422 |
| S7 | **Cost / stock leakage on storefront** | Exact key-set resource tests; availability exposes boolean + low count only | Key-set tests for card, product, availability, cart, order; `unit_cost_amount` null for staff in merchant order resource |
| S8 | **Order data enumeration by shoppers** | Confirmation token (24 h, hashed), track needs number **and** phone, identical 404, throttle, address minimised | Wrong phone → 404 same body as unknown number; 11th track request/min → 429; tracking view has no street/email; expired token → 404 |
| S9 | **Checkout spam / fake orders** (T16) | `checkout` limiter per IP and per phone; cart line/qty caps; `store_not_live` on drafts | 11th checkout/min from one IP → 429; 6th per phone in 10 min → 429; draft store → 409 |
| S10 | **Invalid state transitions / staff privilege** (T10) | `OrderStateMachine` + policies; paid cancel and refunds O A | Matrix test of every (from, to) pair; staff cancel paid → 403; staff refund → 403; refund > paid → 422 |
| S11 | **Mass assignment** | DTO mapping only; non-writable: `status`, `payment_status`, `*_amount` (except inputs named above), `number`, `sequence`, `revision`, `customer_id` from the storefront, `used_count`, counters | `MassAssignment` probes on checkout, manual order, PATCH order, coupon |
| S12 | **CSRF on storefront mutations** (T17) | Server Actions only (origin check); route handlers GET-only; `sp_cart` SameSite=Lax | SF test: route handlers reject non-GET (405); Playwright: cross-origin form POST to a Server Action is rejected |
| S13 | **SMS/email injection and cost abuse** | Templates are fixed; variables are escaped/stripped of control chars and truncated (name ≤ 40, shop ≤ 40); monthly allowance; per-order-event dedupe | Name with newlines/URLs → rendered single line, truncated; allowance exhausted → SMS skipped + timeline note; retry of job → one `sms_messages` row |
| S14 | **Open redirect / unsafe links** | `tracking_url` https only, stored as-is but rendered with `rel="noopener noreferrer nofollow"`; `/discount/[code]` redirects only to `/` | `tracking_url: "javascript:…"` / `http://…` → 422; discount route ignores `?next=` |
| S15 | **PII in logs** | Phone, address, email never logged; jobs log ids only; `order_events.edited` lists field names, not values | Log scan after checkout + edit contains no phone/address |
| S16 | **Draft store exposure** (T22) | PDP/PLP/categories → 404 for draft without preview; preview responses `private, no-store`; checkout 409 | Draft host: catalog 404; preview 200 `no-store`; draft products never on a public PDP |
| S17 | **Plan limit bypass** | Manual orders: `assertWithin(OrdersPerMonth)` inside the transaction under the per-store advisory lock | Parallel manual creates at limit − 1 → one 201, one 402 |
| S18 | **Queue tenant leaks** (T19) | Notification jobs `TenantAware`; order loaded inside the restored context | Job for B's order dispatched under A → not found, nothing sent |

SECURITY.md updates (ARCH follow-up once this contract is accepted; not yet applied): T5 notes "5b"; T6/T7 point to S1/S2; new **T26 "Shopper order
enumeration"** (S8) and **T27 "Checkout abuse and SMS cost"** (S9, S13).

---

## 11. Figma features deferred (record, don't build)

| Area | Deferred (frame) | Where it goes |
|---|---|---|
| Orders | Risk column/filter, fraud banner, Delivery record (33:3676, Q23) · Request advance payment (144:46081) · Bulk book courier (39:18808) · Edit items (144:46654) · Assigned to · Invoice button · Courier problems tab · Paste chat message (AI), barcode scan, draft save (39:14382) · Unfinished orders (39:9461) · Returns & exchanges, return detail (39:9900, 146:32329) | 5b (advance, courier, edit items, invoice, returns), Phase 8 (AI, risk, unfinished/recovery, assignment) |
| Shipments & printing | Shipments (39:10347), Shipment detail (146:33100), Invoices & labels (39:10790), all templates (44:16156: A4 `42:11175`, 80 mm `42:12238`, A5 `42:13193`, packing slip `44:12097`, Pathao `44:13094`, RedX `44:14203`, Steadfast `137:30097`), Fake order guard (39:11233) | 5b (shipments, documents), Phase 8 (guard) |
| Integrations | List (14:980), Connect bKash (32:3770), Steadfast disconnect (32:4182), courier detail tabs (22:1181, 29:1814, 29:2562, 31:2231, 31:2905, 31:3581), Pathao (152:34534) | 5b (payments, couriers); marketing/messaging/AI integrations Phase 8 |
| Marketing | Overview (66:19179), SMS & WhatsApp campaigns (70:19774), Abandoned cart recovery (71:20614), coupon "Good delivery record" and "Combine" options, Estimated impact | Phase 8 (8.5) / 5b+ |
| Settings | Default courier per zone, weight-based charge, COD/packaging/return charges, rounding (60:14364) · Advance payment rules, connected gateways, order form fields, checkout OTP, 2 % online discount (60:14865) · In-app/push/SMS alerts, template editing, sender ID, SMS credits (60:15863) · VAT and invoice footer (60:16858) · Policies & legal pages extras (87:25694) | 5b (couriers, gateways, VAT/invoice), Phase 7 (credits), Phase 8 (alerts, templates) |
| Storefront | Reviews, ratings, vendor, badges, size guide, swatches, wishlist, bundles, "Often added", Gallery Club tile, facet filters (age, material, colour, brand, size), account/sign-in, bKash/Nagad/card payment options, Express delivery, gift wrap, landing page COD offer (149:1009), product + order form mobile (16:2), Flash sale page (1:12628) | Phase 8 (reviews, wishlist, club, facets need attributes), 5b (online payments), Q14 (accounts) |
| Dashboard | Range toggle, sales chart, orders by source, courier performance, money flow, net profit | Phase 7.4 reports / 5b (courier) |

---

## 12. Test requirements

### API (Pest; groups `tenancy`, `security`, `perf` as noted; **`perf` and the race tests run on Postgres in CI**)
- **Geo:** dataset loads; every thana's district exists; codes unique; `GET /geo/bd` ETag + cache headers.
- **Shipping:** full-replace save (ids kept, missing deleted); exactly one fallback; area in two zones → 422; thana
  beats district beats fallback; inactive zone falls through; free-delivery threshold after discount; pickup default
  promotion; staff write → 403.
- **Catalog storefront:** product by slug (active only; preview shows draft with `is_preview_only`); variants enabled
  only; availability rules (tracked, untracked, backorder, low threshold); PLP pagination/filters/sorts incl.
  `bestsellers` after seeded orders; `in_stock`; `exclude`; categories tree hides invisible; exact key sets (S7);
  draft store 404 (S16).
- **Cart:** create on first add with token once; sha256 at rest; add merges qty, caps 99 and 50 lines; out of stock;
  foreign/disabled variant 422; price change reflected on read; issue lines; coupon apply/remove/auto-removal notice;
  shipping quote; token of another store 404 (S5); prune command.
- **Coupons:** CRUD + type CHECK rules; code uniqueness case-insensitive; derived statuses; eligibility by category
  incl. descendants and by product; percentage floor + cap; fixed capped at eligible subtotal; free shipping;
  allocation sums exactly (property test, 1 000 random carts); usage limit, per-customer, first-order, dates in
  Asia/Dhaka; delete with redemption 409; code/type immutable after use; staff write 403.
- **Checkout:** happy path (order, items snapshots incl. cost, COD payment row, customer upsert, counters, cart
  converted, `placed` event, notifications queued); every error in §3.4; idempotency (S4); price tampering (S1);
  `checkout_changed`; draft store 409; COD disabled 422; order number sequence and prefix, no gaps on rollback.
- **Orders:** list filters/search/counts; state-machine matrix (S10); cancel releases committed and coupon and
  decrements `orders_count`; ship decrements on_hand/committed with ledger rows; return restocks selected quantities;
  deliver marks COD paid and updates counters; refunds partial/full/over → 422 and idempotent; bulk with mixed states
  (skips) and foreign ids (422, nothing applied); PATCH revision 409 and non-editable states; manual order uses the
  same pricing (shared fixtures with checkout), override audited, 402 at limit (S17); staff cost null.
- **Notifications:** per-event toggles; language; allowance exhaustion note; dedupe on retry (S13); template segment
  test; merchant email recipient fallback.
- **Go-live:** checklist items; publish blocked per item (409 details); publish sets status/published_at, audits,
  dispatches revalidation (Bus fake); idempotent re-publish.
- **Dashboard:** order block numbers in store timezone; best sellers; `null` before first order.
- **tenancy group:** `assertTenantIsolation` + `assertStoreIsolation` for ShippingZone, PickupLocation, Coupon, Cart,
  CartItem, Order, OrderItem, OrderEvent, Shipment, Payment, CouponRedemption, IdempotencyKey; S6 payload/route
  probes; storefront host A never returns B's products, categories, carts or orders; notification job isolation (S18).
- **security group:** S1, S4, S5, S8, S9, S10, S11, S13, S14, S15, S16, S17; `OrderEvent` and ledger append-only.
- **perf group (Postgres):** S2 and S3 race tests; checkout p95 < 300 ms with a 10-line cart on CI Postgres (50
  sequential runs).

### Storefront (Vitest)
- Zod schemas for every new response; `formatBdt` with discounts; cart server actions set/clear `sp_cart` correctly
  (mock API); checkout action keeps the idempotency key across retries; `checkout_changed` handling; address selects
  cascade from geo data; PDP variant selection → price/image/availability; card links; JSON-LD escaping; route
  handlers reject non-GET (S12); preview checkout shows the not-live message; sitemap includes products/categories
  only when live.

### Dashboard (Vitest + Testing Library)
- Order next-step derivation; status tabs counts; transitions buttons from `allowed_transitions`; cancel dialog
  payload; refund dialog bounds; create-order quote debounce and idempotency key reuse; zone editor area conflicts;
  coupon form type rules and live preview math equals API allocation fixtures; onboarding 06 → 07 → publish flow
  incl. `launch_blocked` list; staff hides refund/coupon writes/settings.

### QA (Playwright, `tests/e2e/specs/phase5.*.spec.ts`)
- **storefront-buy:** PLP → PDP (variant) → cart (coupon) → checkout COD → thank-you → track by number + phone.
- **merchant-orders:** the order appears; confirm → pack → ship (tracking) → deliver; inventory shows ledger
  `order_shipped`; customer counters; cancel another order releases stock.
- **manual-order:** create from dashboard with override; 402 banner on a Free-plan throwaway tenant at 50.
- **coupons:** create percentage-capped coupon; usage limit 1 → second checkout gets the error text.
- **shipping:** zones + free delivery reflected at checkout.
- **onboarding-golive:** throwaway tenant: 05 → 06 → 07 → publish → 08; Coming soon disappears < 5 s; blocked
  publish without products.
- **security:** replayed checkout (same key) returns the same order; cross-host cart token; draft checkout 409;
  tracking enumeration returns identical 404s.
- **mobile:** PDP, cart, checkout, orders list at 390 px, no horizontal overflow.
- CI: `api-perf` and `security (postgres)` jobs include the new race tests; they must **not** be skipped
  (fail on an empty group, as in Phase 4).

---

## 13. File ownership for Phase 5a

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: migrations §2; models; `Domain/Geo` (+ `resources/geo/bd.json`, README with source/licence); `Domain/Shipping`; `Domain/Coupons`; `Domain/Cart`; `Domain/Orders` (placement, state machine, service, notifier, controllers, presenters); `Domain/Inventory` (commit/release/ship/restock); `Domain/Stores` (launch checklist, publish, storefront catalog/cart/checkout/order controllers, `StorefrontConfig.commerce`); `Domain/Shared` (`IdempotencyGuard`, `StoreCounter`); `Permission::ManageMarketing`; `FeatureGate` usages + `Limit::SmsPerMonth` + PlanSeeder; settings additions; SMS templates and mailables; throttles `cart`, `checkout`, `order-track`; schedules; `DemoSeeder` (zones, pickup location, 2 coupons, 6 orders across statuses; idempotent); backfill command `shipping:provision-defaults` |
| **WEB** | `apps/merchant-dashboard/**` (§9 routes, nav, settings pages, onboarding 06–08, dashboard widgets, mobile Orders tab), `packages/api-client/**` (orders, coupons, shipping, geo, launch, settings), `packages/ui/**` (StatusBadge variants for order/payment, Timeline, AreaPicker, PercentInput, QR component wrapper, StepRail 7 steps) |
| **SF** | `apps/storefront/**` (§5 routes, server actions, route handlers, cart/checkout/track components, PDP/PLP/search, sitemap/robots, product links, Zod schemas), `packages/themes/**` only if a section needs a product link setting |
| **QA** | `tests/e2e/**` (§12), `.github/**` (Postgres race jobs), `docker-compose.yml` (`notifications` queue worker), `docs/development/TESTING.md`, `docs/reviews/phase-5a-qa.md` |
| **Orchestrator** | `packages/types/src/index.ts` (§6) |
| **ARCH** | Done with this contract: this file, `docs/api/openapi.yaml` (1.5.0), ADR 0006/0007 amendments, ADR 0011, OPEN-QUESTIONS.md (Q31–Q44). Follow-ups after acceptance: API-CONVENTIONS.md (§3.0 codes, `cart`/`checkout`/`order-track` limits), SECURITY.md (T26, T27), DATABASE-DESIGN.md (Phase 5 tables), FIGMA-INDEX.md (Phase 5 frames), DEVELOPMENT-ROADMAP.md (5a/5b split) |

---

## 14. Order of work (5a)

1. **Orchestrator** applies §6 types (additive).
2. **API step 1:** migrations, models, geo dataset, shipping zones + settings, coupons CRUD, `InventoryService`
   commit/release/ship/restock, storefront catalog endpoints. **WEB** starts settings (shipping, payments,
   notifications, invoices), coupons and onboarding 06/07 against openapi 1.5.0 + MSW. **SF** builds PDP/PLP/search
   against mocks.
3. **API step 2:** cart, `CartPricer`, checkout with idempotency, orders (state machine, transitions, manual orders,
   refunds), notifications, launch checklist + publish, dashboard block, DemoSeeder. **WEB**: orders list/detail/create,
   onboarding 08, dashboard, mobile Orders. **SF**: cart, checkout, thank-you, track, discount route.
4. **QA:** Postgres race jobs first (they gate the merge of step 3), then Playwright specs.
5. QA review → `docs/reviews/phase-5a-qa.md`.
6. ARCH writes the binding 5b contract revision (§16) with PO answers and sandbox access in hand.

---

## 15. Acceptance criteria (5a)

1. A shopper on the demo store browses a category (`/c/{slug}`), filters by price, opens a PDP, picks a variant, adds
   to cart, applies a coupon and places a **COD order**; the thank-you page shows the number and the tracking page
   finds it by number + phone. Cost, SKU and exact stock never appear in any storefront response.
2. **No oversell:** the Postgres race test (stock 5, 20 parallel checkouts) yields exactly 5 orders. **Replay** of a
   checkout with the same `Idempotency-Key` returns the same order. Coupon usage limits hold under parallel load.
3. Shipping: zones with thanas and districts resolve correctly, the fallback always applies, free delivery triggers
   at the threshold; rules are unit-tested.
4. Coupons: all three types, eligibility, limits and dates behave as P5-11–P5-13; the merchant list shows usage and
   revenue.
5. Orders: the merchant confirms, packs, ships (with tracking), delivers, returns and cancels; invalid transitions
   get 409; stock and ledger follow P5-5; staff can't cancel paid orders or refund; manual refunds are recorded;
   the timeline shows every change; manual orders use the same pricing and are blocked at the plan limit.
6. Notifications: placing an order queues the shopper SMS (Bangla by default) and merchant email; toggles and the
   monthly allowance work; no duplicate SMS on job retry.
7. Onboarding 06 → 07 → publish → 08 works for a new tenant; publish is refused with clear blockers; after publish
   the Coming soon page disappears within 5 s.
8. The dashboard shows real order KPIs, waiting counts and best sellers; customers show delivered/returned counts
   and an orders table.
9. Mobile: PDP, cart, checkout and the dashboard Orders tab work at 390 px with no horizontal scroll.
10. `pnpm -r test`, `pnpm -r typecheck`, `php artisan test --group=tenancy,security`, the Postgres `perf`/race jobs
    and the Playwright suite are green. openapi.yaml 1.5.0 parses and matches §6.

---

## 16. Phase 5b outline (non-binding until revised)

Order: **5.10 RLS → 5.6 payments → 5.8 couriers → 5.9 documents → onboarding connect cards → order item edits and
returns.** Each item below lists the decisions already taken and what the binding revision must add.

### 16.1 Postgres RLS (5.10) — first, before any online payment merges
- Per MULTI-TENANCY §9: app role `storeplix_app` (no BYPASSRLS), migrations as `storeplix_owner`, `pgsql_admin`
  (`storeplix_admin`, BYPASSRLS) for admin and platform jobs only; `ENABLE` + `FORCE ROW LEVEL SECURITY` and policy
  `tenant_id = current_setting('app.tenant_id', true)` on every tenant table (all Phase 5 tables already carry
  `tenant_id`).
- `TenantContext::set/forget` call `set_config('app.tenant_id', …, false)`; reset at every request and job start.
  No PgBouncer transaction pooling.
- **Pre-tenant lookups need an explicit path:** storefront host resolution (`store_domains`), invitation acceptance by
  token, password reset, webhook tenant resolution (`webhook_events`) and the scheduler's tenant iteration run on
  `pgsql_admin` or through narrow `SECURITY DEFINER` functions. The revision must enumerate them from code.
- CI runs the tenancy + security suites with `TENANCY_RLS=true` and `false`; a raw-SQL test proves `storeplix_app`
  can't read B's rows. Rollout table by table behind the flag.
- Prerequisite: Postgres locally for every agent (docker compose), since sqlite can't exercise RLS.

### 16.2 Payments (5.6)
- ADR 0007 drivers `BkashGateway` (Tokenized Checkout: grant token, create, execute, query, refund) and
  `SslCommerzGateway` (session init, IPN, Order Validation API, refund API). **Merchant-owned credentials** (Q32) in
  `payment_gateway_accounts` (encrypted, sandbox/live mode, connect wizard 32:3770 with a test payment step).
- Order flow: online checkout creates `pending_payment` with stock committed and a hold TTL (Q35); paid only after a
  server-side verify or verified IPN with amount, currency and our reference matching; redirects only trigger
  verification; `webhook_events U(provider, event_id)`; idempotent initiation/refund. TTL job cancels unpaid orders and
  releases stock.
- **Advance payment links** (144:46081, Settings 60:14865 rules): hosted pay page `pay.{PLATFORM_DOMAIN}/m/{token}`,
  delivery-charge / 25 % / full / custom amounts, auto-confirm on payment, optional auto-cancel; `partially_paid`.
- Gateway refunds through the original gateway; cancel of a paid online order refunds automatically.
- Needs: bKash and SSLCommerz **sandbox merchant accounts**, recorded fixtures for CI, the storefront CSP gaining the
  gateway hosts, and PO answers Q32/Q35.

### 16.3 Couriers (5.8)
- `CourierGateway` interface (`quote`, `createConsignment`, `bulkCreate`, `status`, `cancel`, `handleWebhook`,
  `fraudCheck?`); drivers **Steadfast first** (Q41), then Pathao (OAuth token, city/zone/area lookup), then RedX.
- `shipments` gains provider statuses (`pending_pickup`, `picked_up`, `in_transit`, `on_hold`, `partial_delivered`,
  `delivery_failed`), `consignment_id`, `attempts`, `last_synced_at`, raw payloads; status mapping per Figma 31:2905;
  webhook with per-store bearer secret (`/webhooks/steadfast/{store-slug}` as in Figma) plus a 15-minute poll;
  auto-booking rules (29:1814), area mapping, pickup locations (already in 5a), bulk booking (39:18808), Shipments
  page (39:10347, 146:33100), COD payouts view (31:2231).
- Plan: `courier_connections` limit (Free 1) and `all_couriers` / `bulk_courier_booking` features already seeded.
- Fraud check badges (29:2562) and "Delivery record" stay Phase 8 + Q23.
- Needs: courier sandbox/test accounts and API docs access for all three.

### 16.4 Invoices and labels (5.9)
- `document_templates` (JSON config only, no merchant HTML): A4 invoice, 80 mm receipt, A5 two-up, packing slip,
  4×6 courier labels (44:16156). VAT and footer settings (60:16858).
- **PDF engine must shape Bangla** (conjuncts, vowel signs): dompdf/TCPDF do not. Decision for the revision:
  headless Chromium (Gotenberg container or Browsershot) rendering server-side Blade/HTML from the JSON config; PDFs on
  the private disk, 5-minute signed URLs. Barcode/QR generation for labels.
- Needs: Bangla font licensing (Noto Sans Bengali / Hind Siliguri, OFL) and the container in compose and prod.

### 16.5 Also in 5b
- Onboarding 06 courier connect and 07 gateway connect (enable the 5a disabled cards).
- Order "Edit items" with re-commit and re-pricing; post-delivery returns and exchanges (39:9900, 146:32329).
- Customer accounts and cart merge **only if** Q14 is answered "accounts".

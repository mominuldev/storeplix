# Phase 5b contract: Online money, couriers, documents, isolation (binding for API, WEB, SF, QA)

Status: **Binding for Phase 5b** from 2026-11-22. Revises the outline in PHASE-5-CONTRACT §16. Branch
`phase-5b-online-money` (from `main` @ ffc3bf0, 5a shipped, CI green on Postgres).

Everything in AGENT-CONTRACTS.md, PHASE-2/3/4-CONTRACT.md, **PHASE-5-CONTRACT.md (5a)** and
docs/api/API-CONVENTIONS.md still applies (envelope, snake_case, ULIDs, roles, cookie sessions, idempotency, foreign-id
rules, paisa, BD phone rules, storefront headers). Where this file changes a 5a rule it says **"amends P5-…"**.
Machine-readable spec: `docs/api/openapi.yaml` **v1.6.0** (all 5b endpoints and schemas).
ADRs: **0012** (RLS, new), **0013** (couriers, new), **0014** (PDFs, new), **0007** and **0011** (amended).

### Scope and increments

5b is one contract, built and reviewed in **five increments**, each with its own QA gate and merge. 5b-1 goes first and
gates everything that touches money. 5b-4 and 5b-5 need no external accounts, so they can run in parallel with
5b-2/5b-3 while sandbox credentials are pending (§19).

| Increment | Roadmap | Ships | External prerequisites |
|---|---|---|---|
| **5b-1 Isolation** | 5.10 + rate limit | Postgres RLS on every tenant table, explicit bypass paths, GUC handling for requests and jobs, CI with RLS on; per-shopper `storefront` limit | Docker Postgres locally (§17) |
| **5b-2 Payments** | 5.6 | Gateway connect (bKash, SSLCommerz), online checkout (`pending_payment`, 30-min hold), advance delivery charge at checkout, merchant payment links (2-h default), IPN/return verification, gateway refunds, onboarding 07 cards, Settings → Payments | bKash + SSLCommerz sandbox credentials; public HTTPS tunnel |
| **5b-3 Couriers** | 5.8 | Courier connect (Steadfast → Pathao → RedX), booking (single + bulk), status sync (webhook + 15-min poll), Shipments list + detail, onboarding 06 cards, Integrations pages | Steadfast/Pathao/RedX test accounts; tunnel |
| **5b-4 Documents** | 5.9 | Invoice/receipt/packing slip/4×6 label PDFs with Bangla, JSON templates, Invoices & labels page, VAT display + BIN | Gotenberg container |
| **5b-5 Order changes** | §16.5 | Edit items (re-commit + re-price), post-delivery returns and exchanges, restock after courier return | none |

**Out of scope for 5b** (hide or "Coming soon", never fake): Nagad/EPS/aamarPay/PayStation drivers, 2 % online
discount, the advance-payment **rules engine** (60:14865 rules list), checkout OTP, order form field toggles,
auto-booking rules (29:1814 "Book automatically"), courier fraud check and risk badges (29:2562, Q23, Phase 8),
COD payout import and reconciliation (31:2231), Activity log tab (31:3581), shopper-initiated returns with photos,
return-pickup booking through courier APIs, customer accounts (Q14 → Q58), VAT added on top of prices, the
Developer API/outbound webhooks. Full list with frames in §14.

### Conventions in this file
- All 5a conventions (PHASE-5-CONTRACT header). `T` = `X-Tenant-Id`. O / A / S = owner / admin / staff.
- **Foreign ids** (unchanged rule): a `{shipment}`, `{return}`, `{link}`, `{document}`, `{batch}` or `{order}` of another
  tenant or store → 404 `not_found`; an id inside a body that isn't in this store (`order_ids.N`, `payment_id`,
  `pickup_location_id`, `items.N.variant_id`, `lines.N.order_item_id`) → 422 `validation_failed` on that path. Never 403.
- **Provider names** in paths: `{provider}` ∈ `bkash`, `sslcommerz` (gateways) and `steadfast`, `pathao`, `redx`
  (couriers). Any other value → 404.
- **"VERIFY against sandbox"** marks an external-API detail that the public docs don't state. The driver must be
  written behind its interface with that detail isolated in one method, and certified against the sandbox before the
  increment's QA gate. **"default, pending PO"** marks a product decision (listed in §1.1 and OPEN-QUESTIONS Q45–Q63).
- Money stays integer paisa. Gateways take decimal taka strings: convert with `Money::toDecimal(int): string`
  (`"1770.00"`) and parse provider amounts with `Money::fromDecimal(string): int` (string/bcmath, **never float**); a
  provider amount with more than 2 decimals is a mismatch.

### Standing rules for every agent
- Browser checks: Playwright only. Never the Claude in Chrome extension or the user's Chrome.
- Shared working tree: never run `git stash`, `git reset`, `git checkout -- <path>` or commit. Touch only owned files (§18).
- New dependencies: at least 14 days old, pinned exactly (`minimumReleaseAge`). This includes the Gotenberg image tag.
- **Postgres is mandatory from 5b-1** for API work: `docker compose up postgres` with the role init script (§2.9).
  sqlite still runs the unit suite but proves nothing about RLS, locks or races. The Homebrew Postgres on the dev
  machine belongs to another project: don't use it.
- No real money in tests. Live gateway/courier calls only with sandbox or merchant test accounts, never from CI.

---

## 0. Summary and goals

1. **Database-level isolation (5.10).** RLS on every table with `tenant_id`; the app connects as a non-owner role;
   `app.tenant_id` / `app.user_id` GUCs follow `TenantContext`; every pre-tenant lookup is an explicit, narrow path;
   the tenancy and security suites pass with RLS on in CI; a test fails if any tenant table lacks a forced policy.
2. **Per-shopper storefront limit.** `throttle:storefront` becomes 300/min per store host + shopper IP **and**
   3 000/min per store host.
3. **Online payments (5.6).** Merchants connect their own bKash Tokenized Checkout and SSLCommerz accounts. Shoppers
   pay in full online, or pay only the delivery charge in advance (when the shop requires it). Orders wait in
   `pending_payment` with stock held 30 min, become `confirmed` when the payment is verified, and are cancelled
   (stock released) when the hold expires. Merchants send **payment links** for advances on COD orders (2-h default).
   Refunds go back through the gateway (partial where allowed). Nothing is marked paid from a redirect alone.
4. **Couriers (5.8).** Merchants connect Steadfast (then Pathao, then RedX), book one parcel or up to 500 at once,
   and statuses sync by webhook plus a 15-minute poll. Orders move to shipped/delivered/returned from courier events.
   New Shipments list (39:10347) and detail (146:33100); Integrations list and courier detail (14:980, 22:1181,
   31:2905, 152:34534); onboarding 06 courier cards (45:8086).
5. **Documents (5.9).** A4 invoice, 80 mm receipt, A5 two-up, packing slip and 4×6 courier label PDFs with correct
   Bangla shaping, from JSON-configured templates (44:16156), printed from the Invoices & labels page (39:10790).
6. **Order changes (§16.5).** Edit items on unshipped orders (144:46654) with stock re-commit and re-pricing;
   post-delivery returns and exchanges (39:9900, 146:32329); restocking after a courier return.

---

## 1. Decisions (with rationale)

### 1.A Isolation and limits (5b-1)

| # | Decision | Rationale |
|---|---|---|
| P5B-1 | **RLS lands first** and gates every 5b-2/5b-3 merge (P5-1). Tenant-level policies only (MULTI-TENANCY §9.6). ADR 0012 | Defence in depth before money moves; one store per tenant makes store-level policies redundant |
| P5B-2 | **Roles and connections.** `storeplix_owner` (schema owner, migrations, `BYPASSRLS`), `storeplix_app` (web + queue workers, `NOBYPASSRLS`, DML), `storeplix_admin` (`BYPASSRLS`, DML; platform jobs, scheduler, future `/admin/*`). Connections `pgsql` (default, app), `pgsql_owner`, `pgsql_admin`. `TENANCY_RLS=true` turns on GUC syncing **and** requires `DB_USERNAME` ≠ the owner (boot check throws). With `TENANCY_RLS=false` all three connections may point at one user (local sqlite/dev) | Superusers and owners without FORCE bypass RLS; an app connected as owner would make RLS decorative |
| P5B-3 | **GUCs.** `app.tenant_id` follows `TenantContext` (`set`, `run`, `clear`) via `select set_config('app.tenant_id', ?, false)`; `app.user_id` is set for authenticated merchant requests. Both are reset at request start (global middleware, first in the stack), at job start (`Queue::before`), after each job (`Queue::after`/`failing`) and re-applied on `ConnectionEstablished`. `TenantContext::set()` with a **different** tenant while `DB::transactionLevel() > 0` throws `TenantSwitchInTransaction` (a rollback would revert the GUC silently) | One source of truth (`TenantContext`); no leaks across worker jobs or Octane requests |
| P5B-4 | **Pre-tenant paths** are enumerated from the code (§2.4) and use either a `SECURITY DEFINER` function (request paths) or `pgsql_admin` (console, scheduler, platform jobs). `Model::withoutTenancy()` returns a query on `pgsql_admin`; an arch test allowlists its call sites | Request paths never hold a `BYPASSRLS` connection; every bypass is greppable |
| P5B-5 | **Policy shape.** `FOR ALL TO storeplix_app USING (tenant_id = app_current_tenant()) WITH CHECK (same)` on every table with `tenant_id`; special policies for `tenant_users`, `audit_logs`, `sms_messages` (§2.3). Every 5b table is created with RLS in its own migration | Fail closed when the GUC is unset (no rows, inserts rejected) |
| P5B-6 | **Rollout and rollback.** Order: (1) app code with GUC syncing behind `TENANCY_RLS` (no effect without policies); (2) helper functions + policy migration; (3) switch `DB_USERNAME` to `storeplix_app`. Rollback: `migrate:rollback --step=1` on the policy migration (drops policies, `NO FORCE`, `DISABLE`), or `database/sql/rls-emergency-off.sql`; then switch the user back | Each step is reversible on its own |
| P5B-7 | **CI** runs tenancy + security on Postgres twice: `api-postgres` (owner, RLS bypassed) and a new `api-rls` job (app role, `TENANCY_RLS=true`), plus the raw-SQL RLS probes and the "every tenant table is forced" check. The 5a race tests also run once with RLS on | Proves isolation holds with and without the app layer |
| P5B-8 | **Global uniqueness checks** that must look across tenants use definer functions: `sp_store_slug_taken(slug)`; a DB unique violation (`23505`) on such columns maps to 422, never 500 | Under RLS, `Rule::unique('stores','slug')` sees only the current tenant |
| P5B-9 | **Per-shopper storefront limit** (amends API-CONVENTIONS §8). `storefront` = `Limit::perMinute(300)->by(host + shopper IP)` **and** `Limit::perMinute(3000)->by(host)`. Shopper IP = `X-Storefront-Client-Ip` (trusted only with a valid key); IPv6 keyed by its /64. When the header is absent (ISR revalidation, server-only fetches) only the host limit applies and a `storefront.client_ip_missing` counter is logged. The storefront forwards the header on **every** per-request (no-store) API call, including availability, cart summary, shipping quote and the pay pages | One shopper can't exhaust a shop's budget; cached revalidations don't share one IP bucket |

### 1.B Payments (5b-2)

| # | Decision | Rationale |
|---|---|---|
| P5B-10 | **Merchant-owned gateway accounts** (Q32) in `payment_gateway_accounts`, one per store and provider, `mode` `sandbox` \| `live`. Credentials are encrypted with a dedicated `INTEGRATION_CREDENTIALS_KEY` (separate `Encrypter`, `INTEGRATION_CREDENTIALS_PREVIOUS_KEYS` for rotation), never returned or logged; responses show `credentials_hint` (last 4 of the app key / store id). Base URLs come from config by mode, never from input. Writes need new `Permission::ManageIntegrations` (O A, ADR 0005 "payment/courier credentials") | Merchants keep their own money and terms; secrets are isolated from `APP_KEY` rotation |
| P5B-11 | **Connect flow** (32:3770): save credentials (`PUT`) → API checks them (bKash Grant Token; SSLCommerz session init for ৳ 10 marked test, discarded) → `connected`; optional **test payment** (৳ 10 sandbox / ৳ 1 live, refunded where supported) → `verified_at`; **enable for checkout** (`PATCH enabled`) makes it a payment method. Live mode can't be enabled without a passed credential check. Disconnect is refused (409 `gateway_busy`) while the account has pending charges or refunds | Mirrors the 4-step wizard; a typo can't break live checkout |
| P5B-12 | **Checkout payment methods** = `cod` (if `cod_enabled`) plus each connected and enabled gateway (`bkash`, `sslcommerz`). The storefront shows bKash as "bKash" and SSLCommerz as "Card or mobile banking" (52:564 preview) | Matches onboarding 07 and the checkout preview |
| P5B-13 | **Advance delivery charge at checkout** (store setting `checkout.cod_advance`: `none` \| `delivery_charge`; default `none`). When `delivery_charge`, a COD order with `shipping_amount > 0` must pay the delivery charge online first: body `advance_gateway` required (else 422 `advance_required`), order `pending_payment`, advance payment `purpose: advance`. Percent advances at checkout and the rules engine are deferred | Figma 52:564 "Collect delivery charge in advance", 60:14865; the simplest rule that cuts fake orders |
| P5B-14 | **`pending_payment` flow** (amends P5-17, ADR 0011). Online checkout or required advance → order `pending_payment`, stock committed as in 5a, `payment_expires_at = placed_at + 30 min` (Q35), one `payments` charge `pending`. Transitions: `pending_payment → confirmed` (verified payment, `confirmed_at` set, actor `system`), `→ pending` (shopper switches to COD, P5B-17), `→ cancelled` (hold expired: reason `payment_timeout`; or merchant cancel). Shopper SMS `order_placed` is sent only when the order leaves `pending_payment` (confirmed or pending), so unpaid abandoned orders cost no SMS | Figma 60:14865 "Paid orders move to Confirmed on their own"; stock can't be locked forever |
| P5B-15 | **Initiation happens after the order commits.** `OrderPlacementService::checkout` commits the order and the pending payment, then calls `initiate()` outside the transaction. Success → `CheckoutResult.payment = { status: 'redirect', redirect_url, expires_at }`; gateway error/timeout → `payment.status = 'initiation_failed'` (the order exists; the shopper retries from the thank-you page via `POST /storefront/orders/pay`). Never hold row locks across an HTTP call | A gateway outage must not roll back stock commitment silently or double-commit on retry |
| P5B-16 | **Verification is server-side only** (ADR 0007). bKash: the return triggers **Execute Payment**; on timeout or unclear result, **Query Payment** (and retry Execute only while `Initiated`). SSLCommerz: success URL or IPN triggers the **Order Validation API** with `val_id`. Paid only if provider status is final-success (`Completed`; `VALID`/`VALIDATED`) **and** `Money::fromDecimal(amount) == payments.amount` **and** currency `BDT` **and** reference (`merchantInvoiceNumber` / `tran_id`) == our payment id. Mismatch → payment `failed` (`failure_code: amount_mismatch` etc.), order untouched, audit `payment.mismatch`, merchant email | T5; redirects and IPNs are forgeable |
| P5B-17 | **Shopper retry or switch to COD.** From the thank-you page (cookie `sp_order`), `POST /storefront/orders/pay` `{payment_method}` while the order is `pending_payment` and the hold hasn't expired: an online method re-initiates (previous pending attempt first verified, then `cancelled`); `cod` (only if COD is enabled and no advance is required) moves the order to `pending` and cancels the pending charge. Default, pending PO (Q54) | Bangladesh shoppers often fail a bKash OTP; losing the order costs the merchant more |
| P5B-18 | **Return URLs live on the API** and are signed: bKash `callbackURL` and SSLCommerz `success_url`/`fail_url`/`cancel_url` = `GET|POST /api/v1/payments/return/{provider}/{payment}?expires=…&signature=…` (Laravel signed route, 26 h). The handler verifies (P5B-16) and **303-redirects only to the store's primary host** (from the DB): `/checkout/payment-result?payment={id}`. Never to a URL from the query. Storefront route handlers stay GET-only (S12) | Avoids cross-site POSTs into Next.js; no open redirect |
| P5B-19 | **Webhooks/IPN.** SSLCommerz `ipn_url` = `/api/v1/webhooks/sslcommerz/{route_key}` (route key = 32 random base62 chars per account, resolved by definer function). Steps: resolve account → store the event in `webhook_events` (`U(tenant_id, provider, event_id)`, `event_id` = `val_id`) → respond 200 → queued job verifies with the Validation API → state change. `verify_sign` (md5 scheme from the SSLCommerz PHP SDK) is a cheap pre-filter only. bKash: the documented IPN is AWS-SNS-style, success-only and configured by bKash support (**VERIFY against sandbox** whether it covers tokenized checkout); 5b does not depend on it: `payments:reconcile` queries every pending online payment older than 2 min every 5 min | Duplicates and replays become no-ops; a lost IPN can't lose a payment |
| P5B-20 | **Idempotent state changes.** Every payment transition is `UPDATE payments SET status=? WHERE id=? AND status='pending'` inside a transaction that first locks the order row (lock order: order → payments → inventories → coupon → counter, amends §7 of 5a). Affected rows = 0 → already handled, return the current state. `U(store_id, provider, provider_trx_id)` partial unique stops one gateway transaction from paying two orders | Replays, concurrent IPN + return, and double clicks can't double-apply |
| P5B-21 | **Hold expiry.** `payments:expire` every minute: for `pending_payment` orders past `payment_expires_at`, query the provider first; paid → apply; else cancel the charge (`failure_code: expired`), cancel the order (`payment_timeout`, releases `committed` and coupon), no SMS. **Late payment** (verified after the order was cancelled): never revive the order; refund the full amount through the gateway automatically, timeline + merchant email "Paid after the order expired — refunded". Default, pending PO (Q61) | Stock may already be sold; an automatic refund is the honest default |
| P5B-22 | **Payment links** (144:46081) for orders in `pending`, `confirmed`, `ready_to_ship` with `due_amount > 0`. Amount kinds: `delivery_charge` (= `shipping_amount`), `percent` (`percent_bps`, default 2 500), `full` (= due), `custom` (1 ≤ amount ≤ due). Gateway: a connected+enabled one. Expiry: 120 (default, Q35), 360, 1 440 or 2 880 minutes. `cancel_if_unpaid` (default on, 144:46081 toggle): on expiry the order is cancelled (`payment_link_expired`) and stock released. One active link per order (409 `payment_link_active`). Token = 12 random base62 characters (~71 bits), stored as sha256 **and** encrypted (so "Copy link"/"Resend" work); URL = `https://{primary_host}/pay/{token}` (Q55 default, pending PO; Figma shows `pay.storeplix.com/m/…`). A paid link: payment `succeeded`, `paid_amount += amount`, `payment_status` `partially_paid`/`paid`, order `pending → confirmed` (the order "confirms itself"), shipment COD = due | Merchant-sent advance is the most common BD fake-order defence |
| P5B-23 | **Pay page** `/pay/[token]` on the store host (SF): shop name/logo, order number, amount, expiry, gateway button; then the same return flow (P5B-18). Unknown/expired/used token → one identical "This payment link isn't valid any more" page (404 from the API). Throttle `pay-link` 20/min per host + IP | Token enumeration can't distinguish states |
| P5B-24 | **Gateway refunds** (amends P5-18). `RefundInput.method` gains `gateway`, with `payment_id` = a succeeded online charge of this order. Amount ≤ charge amount − its refunded amount, ≤ order refundable, and ≥ ৳ 1. bKash: `refundAmount` up to `maxRefundableAmount`, ≤ 10 partial refunds within 60 days, no identical refund within 10 min (bKash docs). SSLCommerz: refund API with `bank_tran_id` (live requires the platform's public IP registered with SSLCommerz); partial support **VERIFY against sandbox** (Q48 default: allowed; a provider refusal → 422 `gateway_refund_rejected` and the merchant records a manual refund). The refund row starts `pending`; `refunded_amount` and `payment_status` change only on provider success (sync for bKash; `payments:refund-status` every 10 min for SSLCommerz `processing`). Idempotency-Key required (existing) and the provider idempotency reference = our refund payment id | ADR 0007; money only moves when the provider confirms |
| P5B-25 | **Cancelling a paid online order** (O A, existing rule) shows "Refund ৳ N to {gateway}" (default on): `CancelOrderInput.refund_to_gateway` (default `true` when online paid). The cancel commits first; the refund is then requested; a refund failure leaves a timeline event and a "Refund failed — retry" action | Shoppers expect their money back automatically |
| P5B-26 | **Fees.** Storeplix never adds a gateway or COD surcharge to the shopper and doesn't display gateway fees (they're the merchant's contract). Default, pending PO (Q45, Q47) | Simple, honest checkout |
| P5B-27 | **Plans.** Online payments are on every plan (merchant-owned accounts cost us nothing). No new plan limits for gateways. Default, pending PO (Q60) | Matches "Money goes straight to you" |
| P5B-28 | **Notifications.** New shopper SMS event `payment_link` (always sent when the merchant chooses SMS; counts toward `sms_per_month`): bn "{shop}: অর্ডার {number} নিশ্চিত করতে {amount} টাকা পরিশোধ করুন: {url}" / en "{shop}: Pay Tk {amount} to confirm order {number}: {url}". Merchant email on `payment.mismatch`, late-payment refund and refund failure | Figma 144:46081 SMS preview |
| P5B-29 | **Fake drivers.** `PAYMENTS_FAKE=true` (local, testing; refused in production by a boot check) binds `FakeGateway` for both providers: `initiate` returns `{APP_URL}/api/v1/dev/fake-gateway/{payment}` (a plain HTML page with Pay / Fail / Cancel buttons; route registered only when the flag is on); outcomes are deterministic for automation (amount ending in 13 paisa → failed; 17 → amount mismatch; 19 → execute timeout then Query `Completed`). Recorded JSON fixtures (from the public docs now, replaced by sandbox recordings at certification) drive `Http::fake` tests of the real drivers | Local dev and CI run end to end with no accounts |

### 1.C Couriers (5b-3)

| # | Decision | Rationale |
|---|---|---|
| P5B-30 | **Driver order:** Steadfast (Q41) → Pathao → RedX, each certified against a test account before its QA gate. ADR 0013 | Most complete Figma and simplest API first |
| P5B-31 | **Courier accounts** in `courier_accounts` (per store × provider; encrypted credentials as P5B-10; `ManageIntegrations`). Credential check: Steadfast `GET /get_balance`; Pathao issue-token; RedX `GET /areas` (**VERIFY**). Plan limit `courier_connections` (Free 1, Starter/Growth unlimited) → 402 `plan_limit_reached` on the second connect. Bulk booking needs feature `bulk_courier_booking` (Starter+) → 402 `feature_not_in_plan` | Limits already seeded in Phase 2 |
| P5B-32 | **Settings per account** (22:1181 "Booking rules"): `pickup_location_id` (5a pickup locations; required), `cod_source` = `due` (fixed in 5b), `parcel_description` template (`{items}`, `{order_no}`, ≤ 120 chars after render), `default_weight_grams` (500), `is_default`. Pathao adds `pathao_store_id` (from their stores API), `delivery_type` 48 \| 12, `item_type` 2; RedX adds `redx_pickup_store_id`. "Book automatically", "Print label after booking" and fraud-check toggles are deferred (§14) | Needed for a valid booking; automation later |
| P5B-33 | **Booking** (`POST /orders/{order}/shipments`, Idempotency-Key required). Order must be `confirmed` or `ready_to_ship`, with no active shipment (`U(order_id) WHERE status NOT IN ('cancelled','booking_failed')`). Steps: transaction 1 locks the order, writes `shipments` `{status: booking, provider, cod_amount = due unless override}`; then the courier is called **outside** any transaction; transaction 2 writes `booked` + `consignment_id`, `tracking_code`, `tracking_url`, fee/charge if returned, and moves `confirmed → ready_to_ship`. Courier validation error → `booking_failed` + 422 `courier_rejected` (message from the courier, sanitised); timeout → stays `booking`, 202-style 201 with `status: booking`, and `couriers:reconcile-bookings` (every 2 min) looks the parcel up by our invoice (Steadfast `trackings_by_invoice` — **VERIFY**; Pathao/RedX by merchant order id — **VERIFY**) before marking `booking_failed` after 10 min | No double booking; no locks across HTTP |
| P5B-34 | **Invoice reference** sent to couriers = shipment id (Steadfast `invoice`, Pathao `merchant_order_id`, RedX `merchant_invoice_id`); the order number goes into the note/description | Unique per attempt, so a retry is matchable |
| P5B-35 | **COD amount** = order `due_amount` (total − paid). Override (`cod_amount`) allowed for O A only, 0 ≤ override ≤ total, audited `shipment.cod_overridden` | Prevents staff under-collecting |
| P5B-36 | **Normalised statuses and order effects** (ADR 0013). `booked` (= pending pickup; Steadfast `in_review`/`pending`), `picked_up`, `in_transit`, `out_for_delivery`, `on_hold`, `delivery_failed`, `delivered`, `partially_delivered`, `returning`, `returned`, `cancelled`, `booking_failed`. Effects: first of `picked_up`/`in_transit`/`out_for_delivery` → order `shipped` via `InventoryService::ship` (if not already); `delivered` → order `delivered`, COD charge `succeeded` with `amount = cod_collected` (re-queried), counters as 5a; `partially_delivered` → order `delivered` with `paid_amount` = what was collected and a **return request** auto-created (`type: return`, `source: courier`, no lines yet); `returned` → order `returned` (no automatic restock; COD charge `cancelled`) and "Parcel back — restock" task; `cancelled` before pickup → shipment `cancelled`, order back to `ready_to_ship`. Mapping tables per courier in §6 | One effect path for webhooks and polls |
| P5B-37 | **Webhooks.** `/api/v1/webhooks/{steadfast\|pathao\|redx}/{route_key}`. Steadfast: we generate a 40-char bearer secret (shown once, "Rotate" issues a new one), the merchant pastes URL + token into the Steadfast panel; requests must carry `Authorization: Bearer {secret}` (payload and header from the Steadfast Laravel package, not the official Postman doc: **VERIFY against sandbox**). Pathao: the merchant sets URL + our secret in the Pathao panel; Pathao sends the secret in `X-PATHAO-Signature` (plain value, compared with `hash_equals`); our endpoint must answer **202** within 10 s, and the `webhook_integration` test event is acknowledged. RedX: webhook payload and auth **VERIFY**; until verified RedX relies on polling only. All: store in `webhook_events` → respond (200/202) → queued processing. Money-relevant statuses are **re-queried** from the courier status API before effects | Figma 31:2905; payloads aren't trusted |
| P5B-38 | **Polling.** `couriers:sync` every 15 min dispatches one tenant-aware job per account with non-final shipments; each job refreshes shipments not updated in 15 min (batch ≤ 100, provider rate limits respected, back-off on 429). `POST /shipments/sync` (manual "Sync now") throttled 1/min per store | Figma "We retry 5 times over 30 minutes and also poll every 15 minutes" |
| P5B-39 | **Area mapping** (Pathao city/zone/area, RedX area). The booking dialog shows the courier's area selects pre-selected by a name match on our district/thana; the chosen ids are saved in `courier_area_mappings` (per store × provider × district/thana) and reused. Area lists are proxied by `GET /couriers/{provider}/areas` and cached 24 h per account (`TenantCache`). Steadfast needs no mapping (free-text address) | Pathao/RedX reject free text; one confirmation per area |
| P5B-40 | **Bulk booking** (39:18808): `POST /shipments/bulk` `{provider, order_ids 1–500}` → 202 `ShipmentBatch`; a `bulk` queue job books orders (Steadfast bulk endpoint 500/request; Pathao bulk is async 202 — **VERIFY** result retrieval; RedX one by one). Orders needing an unmapped area are skipped with reason `area_unmapped`. Result per order in the batch | Figma "Book up to 500 parcels" |
| P5B-41 | **Cancel a parcel.** Only while `booked`; drivers without a cancel API (Steadfast: none in the official collection; Pathao/RedX: **VERIFY**) return 409 `courier_cancel_unsupported` with "Cancel it in the {courier} panel, then mark it cancelled here"; `POST /shipments/{shipment}/mark-cancelled` records it | Never pretend a parcel was cancelled |
| P5B-42 | **Manual shipments stay** (5a ship dialog) for couriers without an integration; the ship dialog gains "Book with {courier}" when connected | Sundarban and others are still manual |
| P5B-43 | **COD with couriers** (39:10347 tile): `cod_held_amount` = Σ `cod_collected_amount` of delivered shipments with `settled_at IS NULL` in the last 60 days, per provider. No payout import or reconciliation in 5b; "Mark settled" per shipment batch is deferred (Q49) | The figure is useful even before reconciliation |

### 1.D Documents (5b-4)

| # | Decision | Rationale |
|---|---|---|
| P5B-50 | **Engine: Gotenberg 9 (headless Chromium)** confirmed over the 5a proposal's alternatives (ADR 0014). Image pinned to an exact 9.x tag ≥ 14 days old (not 9.9.2, released 2026-11-21); internal network only; basic auth (`GOTENBERG_USERNAME`/`PASSWORD`); JS disabled; no network (assets sent with each request); 30 s timeout; max 4 concurrent renders per API node | Chromium/HarfBuzz shapes Bengali; dompdf/TCPDF don't |
| P5B-51 | **Fonts** shipped in `apps/api/resources/fonts/`: Noto Sans Bengali (OFL, regular + bold) and Inter (OFL). `@font-face` with local file URLs inside the Gotenberg request. No CDN fonts | Deterministic output, licence clean |
| P5B-52 | **Templates are JSON config, not HTML.** Kinds: `invoice_a4` (42:11175), `receipt_80mm` (42:12238), `invoice_a5_two_up` (42:13193), `packing_slip` (44:12097), `label_4x6` (one layout; header shows the courier brand of the shipment: Steadfast 137:30097, Pathao 44:13094, RedX 44:14203). Options: `show_logo`, `show_bin`, `show_product_names`, `show_prices` (not for labels), `show_sku`, `language` `en` \| `bn`, `footer_text` ≤ 300, `paper` (fixed per kind; label 4×6 in = 100×150 mm, Q51). One row per store × kind (defaults when absent) | No merchant HTML (XSS/SSRF surface); Figma print settings |
| P5B-53 | **Generation is queued** (`documents` queue): `POST /documents` `{kind, order_ids 1–100}` → 202; dashboard polls every 1 s; p95 < 6 s for 12 labels. Output on the private disk `tenants/{t}/invoices/{ulid}.pdf`, served by a 5-minute signed URL after a policy check, deleted after 24 h. Printing marks `orders.invoice_printed_at` / `label_printed_at` ("Printed today" tab) | Long batches don't block PHP-FPM |
| P5B-54 | **Barcodes and QR** generated in PHP as inline SVG: Code 128 of the consignment id (else the order number), QR of the tracking URL (`https://{primary_host}/track`). Libraries: `picqer/php-barcode-generator` and `chillerlan/php-qrcode` (exact pins, ≥ 14 days) | No network in Chromium |
| P5B-55 | **Invoice number = order number** (P5-16, Q50); invoice date = `placed_at` in store time | One number for shopper, merchant and courier |
| P5B-56 | **VAT and BIN** (60:16858): `tax.display` `none` \| `included` (default `none`), `tax.rate_bps` (0–2 500), `tax.bin` (`^[0-9]{9}(-[0-9]{4})?$`), `invoice.footer`. With `included`, invoices print "Prices include VAT {rate}%: ৳ x" where x = `floor(total × rate/(10 000 + rate))`; **order totals and `tax_amount` stay unchanged** (P5-32). VAT added on top is deferred (Q52) | Prints what BD invoices need without touching the money path |
| P5B-57 | **Local/CI without Docker:** `DOCUMENTS_DRIVER=html` stores the rendered HTML (`.html`) instead of a PDF, so template tests and the UI flow work; `gotenberg` is the default in compose and production | 5b-4 can be built before the container is everywhere |
| P5B-58 | **Escaping.** Templates use Blade `{{ }}` only; product names, notes and addresses are plain text (control characters stripped, length-capped); the logo is the store's media file read from storage and inlined as a data URI | PDF/HTML injection, SSRF |

### 1.E Order changes (5b-5)

| # | Decision | Rationale |
|---|---|---|
| P5B-60 | **Edit items** (144:46654; amends P5-20). `PUT /orders/{order}/items` with the full desired line set (`id` for existing lines, `variant_id` for new ones, quantity 0 removes), `revision`, `reason`, `notify_customer`. Allowed in `pending`, `confirmed`, `ready_to_ship` with **no active courier booking** (409 `shipment_booked`: "Cancel the parcel first", Q56) | Re-booking a courier on a changed parcel isn't supported by every courier API |
| P5B-61 | **Re-pricing:** unchanged and quantity-changed lines keep their snapshot unit price, cost and discount base; new lines use the current price (same eligibility rules as manual orders: active or draft, not archived). The coupon is re-applied to the new eligible subtotal (no new redemption; limits not re-checked); if its minimum is no longer met the coupon is removed and its redemption released (response `meta.notices`). Shipping stays unless `recalculate_shipping: true` or `shipping_amount_override` (P5-19 rules). New total must stay ≥ `paid_amount − refunded_amount`, else 422 `total_below_paid` ("Refund first"). `POST /orders/{order}/items/quote` returns the same math without writes | Keeps the agreed price for what the shopper already accepted |
| P5B-62 | **Stock by difference** under the 5a lock order: release decreased/removed tracked lines, commit increased/new ones (`out_of_stock` per line as 5a). One `edited` event lists line changes (product name, from → to quantity; no prices); the reason is saved as a note. "Send updated total by SMS" sends event `order_updated` (new template, counts toward the allowance) | Same stock invariants as placement |
| P5B-63 | **Return requests** (39:9900, 146:32329) for orders in `delivered` (and `partially_delivered` auto-requests). Numbered `RT-{n}` per store (`store_counters` key `returns`, from 1). Type `return` \| `exchange`. Reasons `wrong_size`, `damaged`, `wrong_item`, `changed_mind`, `refused_at_door`, `other`. Lines: order item + quantity (≤ delivered − already returned), exchange variant for exchanges. Created by merchants only in 5b (shopper self-service with photos deferred, Q57) | Merchants already take returns by phone/chat |
| P5B-64 | **Return state machine:** `requested → approved \| rejected`; `approved → received \| closed`; `received → refunded \| exchanged \| closed`; `refunded`, `exchanged`, `rejected`, `closed` final. (`pickup_booked` in Figma needs courier return APIs: deferred; the merchant may store a free-text pickup tracking code on approve.) Every transition writes a `return_events` row | Small, testable graph |
| P5B-65 | **Receive** records the check list (tags intact, unused, original packaging) and per-line restock quantities → `InventoryService::restock` (ledger `order_returned`, reference = return). Customer counters: `returned_orders_count` +1 on first received return of the order | Same ledger as 5a returns |
| P5B-66 | **Refund for a return** uses the refunds endpoint with `return_id` (gateway or manual, P5B-24); the return becomes `refunded` when the refunded amount for it is > 0 and the merchant closes it, or immediately when the refund equals the requested amount | One refund path |
| P5B-67 | **Exchange** (`POST /returns/{return}/exchange-order`): creates a **new manual order** through `OrderPlacementService` (`channel` = the original's, `created_via` `dashboard`, new field `source_order_id`), lines = the exchange variants at current price, an **exchange credit** discount = the returned lines' paid value (allocated as a fixed discount, not a coupon), shipping = the zone charge or override. Positive difference → optional payment link (P5B-22) on the new order; negative difference → merchant refunds via the original order. Return → `exchanged` | Reuses placement, stock and numbering |
| P5B-68 | **Order fields:** `orders.return_status` `none` \| `requested` \| `partially_returned` \| `returned` (derived on return transitions). A delivered order stays `delivered` | The 5a `returned` status means "came back undelivered"; keep it unambiguous |
| P5B-69 | **Restock after courier return:** `POST /orders/{order}/restock` `{lines:[{item_id, quantity}]}` for `returned` orders, cumulative up to the shipped quantity (`restocked_quantity`) | P5B-36 sets `returned` without restock |
| P5B-70 | **Permissions:** edit items, returns create/approve/reject/receive, restock: `Operate` (O A S). Refunds and exchange orders with a negative difference: `ManageRefunds` (O A) | Same split as 5a |
| P5B-71 | **Customer accounts (Q14) are not in 5b** (Q58). Q14's "optional phone-OTP account" remains future work | Scope; OTP cost |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q45–Q63)

**All defaults below were accepted by the PO on 2026-11-22**, so they are decisions now.

| # | Question | Default |
|---|---|---|
| Q45 | Show bKash/gateway fees to merchant or shopper; add a surcharge? | No display, no surcharge (P5B-26) |
| Q46 | Advance payment: percentage or fixed? | Both on payment links (delivery charge, % default 25, full, custom); checkout advance = delivery charge only |
| Q47 | COD charge to the shopper? | None. Courier COD fees are shown on the shipment when the courier returns them |
| Q48 | Partial refunds through the gateway? | Allowed (bKash documents ≤ 10 partials in 60 days); SSLCommerz if its API accepts (VERIFY), else manual |
| Q49 | Courier COD settlement reconciliation in 5b? | Show "COD held by couriers" only; payout import/reconcile (31:2231) in Phase 7 |
| Q50 | Separate invoice numbering? | No: invoice number = order number |
| Q51 | PDF paper sizes | A4 invoice and packing slip, 80 mm roll, A5 two-up on A4, label 4×6 in (100×150 mm). No 3×4 labels |
| Q52 | VAT on invoices | Display only ("Prices include VAT x %") + BIN; VAT on top deferred |
| Q53 | Paid online orders confirm themselves? | Yes (Figma 60:14865) |
| Q54 | Can a shopper switch an unpaid online order to COD? | Yes, while the hold is open, if COD is enabled and no advance is required |
| Q55 | Payment link host | Store's own host `/pay/{token}` instead of `pay.storeplix.com/m/…` |
| Q56 | Edit items after a courier booking | Not allowed in 5b (cancel the parcel first) |
| Q57 | Shopper-initiated returns from the tracking page (with photos) | Deferred; merchants create returns |
| Q58 | Customer accounts (Q14) in 5b? | No |
| Q59 | Booking moves the order to "Ready to ship"; courier pickup moves it to "In transit" | Yes |
| Q60 | Online payments and courier features by plan | Gateways on all plans; couriers: Free 1 connection, bulk booking Starter+ |
| Q61 | Payment arrives after the 30-min hold expired | Automatic full refund through the gateway; order stays cancelled |
| Q62 | "Book automatically" on confirm (29:1814) in 5b? | Deferred (manual and bulk booking only) |
| Q63 | Payment-link expiry options | 2 h default; 6 h, 24 h, 48 h selectable |

---

## 2. Postgres RLS (5.10, increment 5b-1) — owner API (+ QA for CI)

### 2.1 Roles (created outside migrations; superuser needed)
`infrastructure/docker/postgres/initdb/01-roles.sql` (compose mounts it into `/docker-entrypoint-initdb.d`; CI runs it
with `psql`; production runbook in `docs/deployment/`):
```sql
CREATE ROLE storeplix_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER BYPASSRLS;
CREATE ROLE storeplix_app   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOBYPASSRLS;
CREATE ROLE storeplix_admin LOGIN PASSWORD :'admin_pw' NOSUPERUSER BYPASSRLS;
ALTER DATABASE :db OWNER TO storeplix_owner;
GRANT USAGE ON SCHEMA public TO storeplix_app, storeplix_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE storeplix_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO storeplix_app, storeplix_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE storeplix_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO storeplix_app, storeplix_admin;
```
The policy migration additionally runs `REVOKE UPDATE, DELETE ON audit_logs FROM storeplix_app` (append-only, SECURITY.md
T18) and re-grants on existing tables (`GRANT … ON ALL TABLES IN SCHEMA public`), so pre-5b tables are covered.
`pg_trgm` stays created by the owner (Phase 4 migration).

### 2.2 Connections and config (`config/database.php`, `config/tenancy.php`)
| Connection | User env | Used by |
|---|---|---|
| `pgsql` (default) | `DB_USERNAME` / `DB_PASSWORD` (`storeplix_app` when RLS is on) | web, queue workers |
| `pgsql_owner` | `DB_OWNER_USERNAME` / `DB_OWNER_PASSWORD` (default: `DB_USERNAME`) | `php artisan migrate --database=pgsql_owner`, `db:seed --database=pgsql_owner` |
| `pgsql_admin` | `DB_ADMIN_USERNAME` / `DB_ADMIN_PASSWORD` (default: `DB_USERNAME`) | `withoutTenancy()`, console commands, scheduler, platform jobs, future `/admin/*` |

`TENANCY_RLS` (bool, default `false` until the production switch, `true` in the `api-rls` CI job and compose once
5b-1 merges). Boot check: `TENANCY_RLS=true` and `DB_USERNAME` equal to `DB_OWNER_USERNAME` (or a superuser, checked
with `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`) → exception at boot outside
`testing`, and a failing test inside `api-rls`.

### 2.3 Helper functions and policies (migration `2026_06_01_000100_enable_row_level_security`, pgsql only; no-op on sqlite)
```sql
CREATE FUNCTION app_current_tenant() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '') $$;
CREATE FUNCTION app_current_user() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;
-- per table T in RlsTables::TENANT:
ALTER TABLE T ENABLE ROW LEVEL SECURITY; ALTER TABLE T FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON T FOR ALL TO storeplix_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
```
Special policies (replace `tenant_isolation` on these tables):
| Table | Policy |
|---|---|
| `tenant_users` | `USING (tenant_id = app_current_tenant() OR user_id = app_current_user())` `WITH CHECK (tenant_id = app_current_tenant())` (membership list for `/auth/me`, `ResolveTenant` lookup before the tenant is set) |
| `audit_logs` | `FOR SELECT USING (tenant_id = app_current_tenant())`; `FOR INSERT WITH CHECK (tenant_id IS NULL OR tenant_id = app_current_tenant())` (platform events insertable, readable only via `pgsql_admin`) |
| `sms_messages` | same as `audit_logs` plus `FOR UPDATE USING (tenant_id = app_current_tenant() OR (tenant_id IS NULL AND app_current_tenant() IS NULL))` (OTP SMS status updates) |

`RlsTables::TENANT` (PHP constant, the single list the migration, the rollback and the coverage test use) — every
table with a `tenant_id` column today (40) plus every 5b table:
`tenant_users, audit_logs, stores, store_domains, store_settings, media, staff_invitations, subscriptions,
sms_messages, store_themes, store_pages, store_navigation, categories, products, product_variants, product_images,
product_categories, inventories, inventory_movements, customers, customer_notes, data_imports, data_import_rows,
data_exports, store_counters, pickup_locations, shipping_zones, shipping_zone_areas, coupons, coupon_categories,
coupon_products, carts, cart_items, orders, order_items, order_events, shipments, payments, coupon_redemptions,
idempotency_keys` + 5b: `payment_gateway_accounts, payment_links, webhook_events, courier_accounts,
courier_area_mappings, shipment_events, shipment_batches, document_templates, documents, return_requests,
return_items, return_events`.

**Platform tables (no RLS, no `tenant_id`):** `users, password_reset_tokens, sessions, cache, cache_locks, jobs,
job_batches, failed_jobs, personal_access_tokens, tenants, plans, otp_codes, migrations`.

**Definer functions** (owned by `storeplix_owner`, `SECURITY DEFINER`, `SET search_path = public, pg_temp`,
`REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO storeplix_app`), ids only:
| Function | Returns | Replaces |
|---|---|---|
| `sp_resolve_host(p_host text)` | `(tenant_id, store_id)` for an `active` domain of a non-suspended store | `StorefrontResolver::lookup` (`StoreDomain::withoutTenancy`, `Store::withoutTenancy`) |
| `sp_invitation_by_token(p_hash char(64))` | `(invitation_id, tenant_id)` | `InvitationAcceptanceController` lines 80, 119 |
| `sp_store_slug_taken(p_slug text)` | `boolean` | `StoreStoreRequest` `Rule::unique('stores','slug')` |
| `sp_route_key_owner(p_kind text, p_key text)` | `(tenant_id, store_id, account_id)` from `payment_gateway_accounts` or `courier_accounts` (`p_kind` ∈ `gateway`, `courier`) | webhook tenant resolution |
| `sp_payment_owner(p_payment char(26))` | `(tenant_id, store_id)` | signed payment-return URLs (P5B-18) |

Down migration: drop policies, `NO FORCE`, `DISABLE ROW LEVEL SECURITY`, drop functions, re-grant `audit_logs`
UPDATE/DELETE as before. CI's "rollback is reversible" step covers it. `database/sql/rls-emergency-off.sql` does the same
as plain SQL for an incident.

### 2.4 Pre-tenant and cross-tenant paths (enumerated from the 5a code)
| # | Path (file) | Today | 5b-1 |
|---|---|---|---|
| B1 | Storefront host resolution (`Stores/Services/StorefrontResolver.php:72,81`) | `withoutTenancy()` | `sp_resolve_host()`; cache unchanged |
| B2 | Merchant tenant membership (`Tenancy/Middleware/ResolveTenant.php:44`), `/auth/me` tenants (`User::tenants`), `roleIn()` | `tenant_users` query without context | `app.user_id` set after auth (listener on `Authenticated`/`Login` + middleware `SetDatabaseUser` after `auth:sanctum`); policy B on `tenant_users` |
| B3 | Registration creates tenant + owner membership (`Identity/Http/Controllers/AuthController.php:52-57`) | no context | wrap in `TenantContext::run($tenant)` |
| B4 | Invitation show/accept (`Staff/Http/Controllers/InvitationAcceptanceController.php:38-119`) | `withoutTenancy()` by token | `sp_invitation_by_token()` then `TenantContext::run()`; the row lock uses the scoped query |
| B5 | Store slug uniqueness (`Stores/Http/Requests/StoreStoreRequest.php:46`) | `Rule::unique` | `sp_store_slug_taken()`; 23505 on `stores.slug` → 422 |
| B6 | `StoreObserver` (`:28`), `StoreProvisioner` (`:36,44`) | `withoutTenancy()` inside a tenant context | plain scoped queries (same tenant filter) |
| B7 | Password reset (`password_reset_tokens`), OTP (`otp_codes`), sessions | platform tables | unchanged |
| B8 | Export download (`DataTransfer/.../ExportController::download`, signed `?tenant=`) | `TenantContext::run` | unchanged (GUC follows `run`) |
| B9 | Queue jobs (`RestoreTenantContext`) | `TenantContext::run` | unchanged + GUC reset in `Queue::before/after/failing` |
| B10 | Console/scheduler: `carts:prune`, `idempotency:prune`, `orders:expire-confirmation-tokens`, `data:prune-imports`, `data:expire-exports`, `subscriptions:end-trials`, `shipping:provision-defaults`, `store:ensure-content`, `sanctum:prune-expired` | `withoutTenancy()` | `pgsql_admin` (via rerouted `withoutTenancy()`); commands that write tenant rows (provision defaults, ensure content) iterate stores on admin and write inside `TenantContext::run()` on `pgsql` |
| B11 | 5b schedulers: `payments:expire`, `payments:reconcile`, `payments:refund-status`, `payment-links:expire`, `couriers:sync`, `couriers:reconcile-bookings`, `documents:prune`, `webhooks:prune` | — | admin to find work, then one tenant-aware job per tenant |
| B12 | Webhooks `/webhooks/{provider}/{route_key}` | — | `sp_route_key_owner()` → `TenantContext::run()` for the insert and the job |
| B13 | Payment return `/payments/return/{provider}/{payment}` | — | signed URL → `sp_payment_owner()` → `TenantContext::run()` |
| B14 | Seeders (`DemoSeeder`, `DemoCatalogSeeder`, `DemoCommerceSeeder`) | `withoutTenancy()` | run with `--database=pgsql_owner` (owner bypasses); keep `TenantContext::run()` around tenant writes |
| B15 | Super admin `/admin/*` (not built yet) | — | must use `pgsql_admin`; documented in MULTI-TENANCY §9 follow-up |
| B16 | `SendOrderMail` owner lookup (`Orders/Notifications/SendOrderMail.php:72`) | in tenant context | unchanged |

Arch tests: `withoutTenancy` only in `app/Console`, `app/Domain/*/Console`, `Domain/Tenancy`, `database/seeders`;
`DB::connection('pgsql_admin')` only in the same places plus `Domain/Tenancy/Support/PlatformDb.php`.

### 2.5 Request and job lifecycle
1. Global middleware `ResetDatabaseTenant` (first): `set_config('app.tenant_id','',false)`, same for `app.user_id`.
2. `auth:sanctum` → `SetDatabaseUser` sets `app.user_id`.
3. `tenant` / `storefront` middleware → `TenantContext::set()` → GUC. `finally` → `clear()` → GUC reset.
4. Jobs: `Queue::before` resets; `RestoreTenantContext` → `run()` → GUC; `Queue::after`/`failing` reset.
5. `ConnectionEstablished` (reconnect, forked race-test children) → re-apply the current `TenantContext`.
6. `TenantContext::run()` always restores the previous GUC in `finally`.

### 2.6 Tests (group `tenancy`, `rls`; Postgres only, skip on sqlite but **fail** on skip in `api-rls`)
- **Raw-SQL probes** (`RlsRawSqlTest`) on `pgsql` as `storeplix_app`: GUC = A → `select count(*) from orders` counts A only;
  GUC unset → 0 rows from every table in `RlsTables::TENANT` (loop); insert with `tenant_id` B under GUC A → SQLSTATE
  42501; `update orders set note…` on B's id → 0 rows; `delete` B's row → 0 rows; `update audit_logs` → 42501.
- **Coverage** (`RlsCoverageTest`): every table with a `tenant_id` column has `relrowsecurity AND relforcerowsecurity`
  and is in `RlsTables::TENANT`; every table in the list has a policy; `current_user` is not superuser/bypassrls.
- **Definer functions:** return ids only; unknown input → empty; `storeplix_app` cannot `select` the base rows
  directly without the GUC.
- **Lifecycle:** a worker running job(A) then job(B) never sees A's GUC in B (assert `current_setting` inside the job);
  a request after an exception still starts with an empty GUC; `TenantSwitchInTransaction` thrown.
- The whole existing `tenancy` and `security` groups pass under `api-rls` (fixtures updated to create tenant rows
  inside `TenantContext::run()`; helper `inTenant($tenant, fn)` in `tests/Support`). `RefreshDatabase` migrates on
  `pgsql_owner` (`migrateFreshUsing()` override) and transacts on `pgsql`.
- 5a race tests (S2, S3, S4, S17) run once more in `api-rls`.

### 2.7 CI (owner QA)
New job **`api-rls`** (Postgres 16 service): run `01-roles.sql` with the service superuser; `migrate:fresh --seed
--database=pgsql_owner` as `storeplix_owner`; then with `DB_USERNAME=storeplix_app TENANCY_RLS=true`: `--group=rls`
(must not be empty or skipped), `--group=tenancy`, `--group=security --exclude-group perf --exclude-group race`, then
the race tests one by one (same loop as `api-perf`). `api-postgres` keeps running as the owner (app-level isolation).

### 2.8 Performance
Policies compare `tenant_id` with a `STABLE` function evaluated once per statement; every tenant table already leads
its indexes with `tenant_id`. Budget: the 5a checkout p95 test (40 ms today) must stay < 300 ms with RLS on (it runs in
`api-rls`); `EXPLAIN` of the orders list keeps an index scan.

### 2.9 Local
`docker compose up -d postgres redis` (the initdb script creates the roles on a fresh volume; existing volumes: run
`docker compose exec postgres psql -U storeplix -f /docker-entrypoint-initdb.d/01-roles.sql`). `apps/api/.env`:
`DB_CONNECTION=pgsql DB_USERNAME=storeplix_app DB_OWNER_USERNAME=storeplix_owner DB_ADMIN_USERNAME=storeplix_admin
TENANCY_RLS=true`; migrate with `php artisan migrate --database=pgsql_owner`. `composer dev` keeps working on sqlite
with `TENANCY_RLS=false`.

### 2.10 Per-shopper storefront limit (P5B-9)
`AppServiceProvider` `storefront` limiter returns two limits: `perMinute(300)->by('sf-ip:'.$host.'|'.$ipKey)` (only
when the client-IP header is present and valid) and `perMinute(3000)->by('sf:'.$host)`. `$ipKey` = the IPv4 address
or the IPv6 /64 prefix. Env overrides `THROTTLE_STOREFRONT_PER_IP`, `THROTTLE_STOREFRONT_PER_HOST` (e2e raises them).
429 body and headers unchanged. SF forwards `X-Storefront-Client-Ip` on every no-store call (P5B-9 list).
Tests: 301st request/min from IP X → 429 while IP Y on the same host → 200; 3 001st/min across IPs → 429; no header
→ only the host limit; a spoofed header without the key is ignored (key check first); IPv6 addresses in one /64 share
a bucket.

---

## 3. Data (migrations, owner API)

Conventions as PHASE-5-CONTRACT §2 (ULIDs, `tenant_id NOT NULL`, `store_id`, FK(s), FK3, `U(tenant_id,id)`,
`U(tenant_id,store_id,id)`, bigint paisa ≥ 0, models with `BelongsToTenant` + `BelongsToStore`). **Every new table
enables RLS in its own migration** (`Rls::enable($table)` helper; pgsql only) and is added to `RlsTables::TENANT`.
Secrets use the `IntegrationCredentials` cast (dedicated encrypter, P5B-10). Prefix `2026_06_01_`.

| Migration | Table / change |
|---|---|
| 000100 | RLS helpers, policies, definer functions (§2.3) |
| 000200 `payment_gateway_accounts` | `id`; `tenant_id`; `store_id` FK(s); `provider varchar(16)` CHECK IN (`bkash`,`sslcommerz`); `mode varchar(8)` CHECK IN (`sandbox`,`live`); `status varchar(16)` CHECK IN (`connected`,`error`,`disconnected`); `credentials text not null` (encrypted JSON: bkash `{app_key, app_secret, username, password}`, sslcommerz `{store_id, store_passwd}`); `credentials_hint varchar(16)`; `enabled boolean not null default false`; `is_default boolean not null default false`; `route_key char(32)` **U** (global); `verified_at`, `last_checked_at timestamptz null`; `last_error_code varchar(48) null`; `connected_by` FK users nullOnDelete; `revision int not null default 1`; timestamps. `U(store_id, provider)`; partial `U(store_id) WHERE is_default`; CHECK `status = 'connected' OR NOT enabled` |
| 000300 `payments` (alter) | add `purpose varchar(16) not null default 'order'` CHECK IN (`order`,`advance`,`link`,`exchange`,`test`); `gateway_account_id ulid null` FK3(payment_gateway_accounts) NO ACTION; `payment_link_id ulid null` (FK added in 000500); `provider_trx_id varchar(64) null`; `refunded_amount bigint not null default 0` (on charges) CHECK `refunded_amount <= amount`; `expires_at timestamptz null`; `failure_code varchar(48) null`; `attempt smallint not null default 1`; `return_request_id ulid null` (refunds for returns; FK added in 001200). `order_id` becomes nullable with CHECK `purpose = 'test' OR order_id IS NOT NULL`. Partial `U(store_id, provider, provider_trx_id) WHERE provider_trx_id IS NOT NULL AND type = 'charge'`; partial `U(order_id) WHERE type = 'charge' AND status = 'pending' AND provider IN ('bkash','sslcommerz')` (one open online attempt); `IX(tenant_id, status, expires_at)`. `raw jsonb` keeps provider responses with secrets, tokens, card masks and customer PII removed (`PayloadScrubber`) |
| 000400 `orders` (alter) | add `payment_expires_at timestamptz null`; `return_status varchar(24) not null default 'none'` CHECK IN (`none`,`requested`,`partially_returned`,`returned`); `source_order_id ulid null` FK3(orders) NO ACTION (exchanges); `invoice_printed_at`, `label_printed_at timestamptz null`. Widen `cancel_reason` CHECK + `payment_timeout`, `payment_link_expired`. `IX(tenant_id, status, payment_expires_at) WHERE status = 'pending_payment'` |
| 000500 `payment_links` | `id`; `tenant_id`; `store_id`; `order_id` FK3(orders) CASCADE; `token_hash char(64)` **U**; `token_encrypted text`; `amount_kind varchar(16)` CHECK IN (`delivery_charge`,`percent`,`full`,`custom`); `percent_bps int null`; `amount bigint not null` CHECK `> 0`; `provider varchar(16)`; `status varchar(16)` CHECK IN (`active`,`paid`,`expired`,`cancelled`); `expires_at timestamptz not null`; `cancel_if_unpaid boolean not null`; `sent_via jsonb not null default '[]'` (`sms`); `paid_at`, `cancelled_at timestamptz null`; `created_by` FK users nullOnDelete; timestamps. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(order_id) WHERE status = 'active'`; `IX(tenant_id, status, expires_at)`. Add FK `payments.payment_link_id` → FK3(payment_links) |
| 000600 `webhook_events` | `id`; `tenant_id`; `store_id`; `provider varchar(16)`; `account_id char(26)` (soft ref to gateway/courier account); `event_id varchar(128)`; `event_type varchar(64) null`; `payload jsonb not null` (scrubbed); `status varchar(16)` CHECK IN (`received`,`processed`,`ignored`,`failed`); `attempts smallint not null default 0`; `error_code varchar(48) null`; `received_at timestamptz not null`; `processed_at timestamptz null`. **`U(tenant_id, provider, event_id)`**; `IX(tenant_id, provider, received_at)`. Retention 90 days (`webhooks:prune`) |
| 000700 `courier_accounts` | `id`; `tenant_id`; `store_id` FK(s); `provider varchar(16)` CHECK IN (`steadfast`,`pathao`,`redx`); `mode varchar(8)` CHECK IN (`sandbox`,`live`); `status varchar(16)` CHECK IN (`connected`,`error`,`disconnected`); `credentials text` (encrypted: steadfast `{api_key, secret_key}`, pathao `{client_id, client_secret, username, password}`, redx `{access_token}`); `credentials_hint varchar(16)`; `webhook_secret_hash char(64) null` (sha256 of the secret we issue or the merchant-set Pathao secret) **and** `webhook_secret_encrypted text null` (Pathao compares plain values); `route_key char(32)` **U**; `settings jsonb not null default '{}'` (P5B-32); `pickup_location_id ulid null` FK3(pickup_locations) RESTRICT; `is_default boolean not null default false`; `last_synced_at`, `last_webhook_at`, `last_checked_at timestamptz null`; `last_error_code varchar(48) null`; `connected_by` FK users nullOnDelete; `revision int`; timestamps. `U(store_id, provider)`; partial `U(store_id) WHERE is_default` |
| 000800 `shipments` (alter) | add `courier_account_id ulid null` FK3(courier_accounts) NO ACTION; `consignment_id varchar(64) null`; `provider_status varchar(48) null`; `attempts smallint not null default 0`; `weight_grams int null` CHECK `BETWEEN 1 AND 100000`; `delivery_fee_amount`, `cod_charge_amount`, `cod_collected_amount bigint null`; `cod_overridden boolean not null default false`; `last_event_at`, `last_synced_at`, `booked_at`, `picked_up_at`, `cancelled_at`, `settled_at timestamptz null`; `last_location varchar(120) null`; `failure_reason varchar(255) null`; `problem varchar(24) null` CHECK IN (`delivery_failed`,`on_hold`,`returning`,`unknown`); `idempotency_key varchar(64) null`; `raw jsonb null` (scrubbed); `batch_id char(26) null` (soft ref to `shipment_batches`; composite FKs can't `SET NULL`). Widen `status` CHECK to `booking, booked, picked_up, in_transit, out_for_delivery, on_hold, delivery_failed, delivered, partially_delivered, returning, returned, cancelled, booking_failed, shipped`. Replace partial unique with `U(order_id) WHERE status NOT IN ('cancelled','booking_failed')`; partial `U(store_id, provider, consignment_id) WHERE consignment_id IS NOT NULL`; partial `U(store_id, idempotency_key) WHERE idempotency_key IS NOT NULL`; `IX(tenant_id, store_id, status, booked_at)`; `IX(tenant_id, provider, last_synced_at)` |
| 000900 `shipment_events` | `id`; `tenant_id`; `store_id`; `shipment_id` FK3(shipments) CASCADE; `status varchar(24)`; `provider_status varchar(48) null`; `description varchar(255) null`; `location varchar(120) null`; `source varchar(8)` CHECK IN (`webhook`,`poll`,`user`,`system`); `occurred_at timestamptz not null`; `created_at timestamptz not null default now()` (append-only, no `updated_at`). `IX(tenant_id, store_id, shipment_id, occurred_at)`; partial `U(shipment_id, provider_status, occurred_at)` (dedupe) |
| 001000 `courier_area_mappings` | `tenant_id`; `store_id`; `provider varchar(16)`; `district_code varchar(32)`; `thana_code varchar(48) not null default ''`; `provider_city_id`, `provider_zone_id`, `provider_area_id varchar(32) null`; `label varchar(160)`; timestamps. **PK(store_id, provider, district_code, thana_code)** |
| 001100 `shipment_batches` | `id`; `tenant_id`; `store_id`; `provider`; `status varchar(16)` CHECK IN (`queued`,`running`,`completed`,`failed`); `total`, `booked`, `skipped`, `failed smallint`; `results jsonb not null default '[]'` (`[{order_id, shipment_id?, status, reason?}]`); `created_by` FK users; `started_at`, `finished_at timestamptz null`; timestamps. `IX(tenant_id, store_id, created_at)` |
| 001200 `return_requests` | `id`; `tenant_id`; `store_id`; `order_id` FK3(orders) NO ACTION; `number varchar(24)` (`RT-0031`); `sequence bigint`; `type varchar(16)` CHECK IN (`return`,`exchange`); `status varchar(16)` CHECK IN (`requested`,`approved`,`received`,`refunded`,`exchanged`,`rejected`,`closed`); `reason varchar(24)` CHECK IN (`wrong_size`,`damaged`,`wrong_item`,`changed_mind`,`refused_at_door`,`other`); `source varchar(16)` CHECK IN (`merchant`,`courier`); `customer_note varchar(500) null`; `pickup_tracking_code varchar(64) null`; `checks jsonb not null default '{}'`; `requested_amount bigint not null default 0`; `refunded_amount bigint not null default 0`; `exchange_order_id ulid null` FK3(orders) NO ACTION; `reject_reason varchar(255) null`; `approved_at`, `received_at`, `closed_at timestamptz null`; `created_by` FK users nullOnDelete; `revision int`; timestamps. `U(store_id, number)`, `U(store_id, sequence)`; `IX(tenant_id, store_id, status, created_at)`; `IX(tenant_id, store_id, order_id)`. Add FK `payments.return_request_id` → FK3 |
| 001300 `return_items` | `id`; `tenant_id`; `store_id`; `return_request_id` FK3 CASCADE; `order_item_id` FK3(order_items) NO ACTION; `quantity smallint` CHECK `BETWEEN 1 AND 99`; `exchange_variant_id char(26) null` (soft ref); `exchange_variant_title varchar(130) null`; `restocked_quantity smallint not null default 0`; `amount bigint not null` (paid value of the returned units: (line total / qty) × quantity, floor); timestamps |
| 001400 `return_events` | append-only like `order_events`: `return_request_id` FK3 CASCADE; `type` CHECK IN (`created`,`status_changed`,`note`,`refund`,`restock`); `from_status`, `to_status`; `actor_type`; `actor_user_id`; `body varchar(1000) null`; `meta jsonb`; `created_at` |
| 001500 `document_templates` | `id`; `tenant_id`; `store_id`; `kind varchar(24)` CHECK IN (`invoice_a4`,`receipt_80mm`,`invoice_a5_two_up`,`packing_slip`,`label_4x6`); `config jsonb not null` (validated by `DocumentTemplateConfig`); `revision int`; `updated_by` FK users; timestamps. `U(store_id, kind)` |
| 001600 `documents` | `id`; `tenant_id`; `store_id`; `kind`; `order_ids jsonb not null` (≤ 100 ULIDs); `language varchar(2)`; `status varchar(16)` CHECK IN (`queued`,`rendering`,`ready`,`failed`,`expired`); `pages smallint null`; `file_path varchar(255) null` (TenantStorage `invoices` area); `bytes int null`; `error_code varchar(48) null`; `expires_at timestamptz null` (24 h); `created_by` FK users; timestamps. `IX(tenant_id, store_id, created_at)`; `IX(status, expires_at)` |
| 001700 `store_settings` (alter) | add `cod_advance varchar(16) not null default 'none'` CHECK IN (`none`,`delivery_charge`); `tax_display varchar(16) not null default 'none'` CHECK IN (`none`,`included`); `tax_rate_bps int not null default 0` CHECK `BETWEEN 0 AND 2500`; `tax_bin varchar(16) null`; `invoice_footer varchar(300) null`; `customer_sms` jsonb gains keys `payment_link` (true) and `order_updated` (true) (backfill) |
| 001800 `order_events` (alter) | widen `type` CHECK + `payment_link`, `items_edited`, `return`, `document` |
| 001900 `store_counters` | no schema change; new key `returns` |
| 002000 `plans` data | no new limits; `PlanSeeder` unchanged (features exist) |

`Order` model: `EDITABLE` unchanged; `OrderStateMachine::TRANSITIONS[PENDING_PAYMENT] = [CONFIRMED, PENDING, CANCELLED]`.
New models: `PaymentGatewayAccount`, `PaymentLink`, `WebhookEvent`, `CourierAccount`, `CourierAreaMapping`,
`ShipmentEvent` (append-only guard), `ShipmentBatch`, `DocumentTemplate`, `Document`, `ReturnRequest`, `ReturnItem`,
`ReturnEvent` (append-only guard). `assertTenantIsolation` + `assertStoreIsolation` for each.

New services: `Payments\PaymentManager`, `Payments\Drivers\{BkashGateway, SslCommerzGateway, FakeGateway}`,
`Payments\PaymentService` (initiate, complete, verify, apply, expire, refund), `Payments\PaymentStateMachine`,
`Payments\PaymentLinkService`, `Payments\PayloadScrubber`, `Couriers\CourierManager`,
`Couriers\Drivers\{SteadfastCourier, PathaoCourier, RedxCourier, FakeCourier}`, `Couriers\BookingService`,
`Couriers\ShipmentSync`, `Couriers\AreaMapper`, `Webhooks\WebhookIngestor`, `Documents\DocumentRenderer`,
`Documents\GotenbergClient`, `Documents\TemplateConfig`, `Orders\OrderItemEditor`, `Returns\ReturnService`,
`Returns\ReturnStateMachine`, `Integrations\IntegrationCredentials` (encrypter + cast), `Tenancy\PlatformDb`.
Outbound HTTP for all drivers goes through `SafeHttpClient` (T14) with the provider's fixed base URL, 10 s connect /
30 s total timeout (bKash documents 30 s), no redirects, and logs that carry ids and status codes only.

Schedules (all via `pgsql_admin` discovery + per-tenant jobs, §2.4 B11):
| Command | Every | Does |
|---|---|---|
| `payments:expire` | 1 min | P5B-21 hold expiry (query first) |
| `payments:reconcile` | 5 min | verify pending online charges older than 2 min (bKash safety net) |
| `payments:refund-status` | 10 min | SSLCommerz refunds in `processing` |
| `payment-links:expire` | 1 min | expire links; cancel orders when `cancel_if_unpaid` |
| `couriers:sync` | 15 min | P5B-38 |
| `couriers:reconcile-bookings` | 2 min | P5B-33 stuck `booking` rows |
| `documents:prune` | hourly | delete files of `documents` past `expires_at` |
| `webhooks:prune` | daily | delete `webhook_events` older than 90 days |
| `gateway-tokens:refresh` | — | none: bKash tokens are fetched lazily and cached per account in `TenantCache` for `expires_in − 600 s`; grant + refresh are limited to 2 calls/hour by bKash, so a failed grant is cached as an error for 5 min |

---

## 4. API endpoints

### 4.0 New error codes (add to API-CONVENTIONS §3)
| HTTP | code | When |
|---|---|---|
| 409 | `gateway_busy` | disconnect a gateway with pending charges/refunds |
| 409 | `courier_busy` | disconnect a courier with non-final shipments |
| 409 | `payment_link_active` | a second active link for one order |
| 409 | `payment_not_pending` | pay/retry on an order that isn't `pending_payment` or whose hold expired |
| 409 | `shipment_booked` | edit items / book again while an active courier shipment exists |
| 409 | `courier_cancel_unsupported` | the courier API can't cancel; cancel in the courier panel |
| 409 | `return_not_allowed` | return on an order that isn't delivered, or quantities already returned |
| 422 | `advance_required` | checkout COD in a shop requiring the delivery charge in advance, without `advance_gateway` |
| 422 | `gateway_not_connected` | gateway/courier not connected or not enabled |
| 422 | `credentials_invalid` | the provider rejected the credentials on connect/test (`details` names the field when known) |
| 422 | `courier_rejected` | the courier refused the booking (sanitised courier message) |
| 422 | `gateway_refund_rejected` | the gateway refused a refund (amount, window, partial not allowed) |
| 422 | `total_below_paid` | edited items would make the total lower than the net paid amount |
| 502 | `provider_unavailable` | gateway/courier timeout or 5xx on a synchronous call (retry later; nothing changed, or the reconcile job will finish it) |
Existing codes reused: `out_of_stock`, `coupon_invalid`, `refund_exceeds_paid`, `plan_limit_reached`,
`feature_not_in_plan`, `invalid_state_transition`, `revision_conflict`, `idempotency_key_*`.

### 4.1 Payment gateways (merchant; `T`; reads O A S, writes O A `ManageIntegrations`)
| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /stores/{store}/payment-gateways` | — | 200 `PaymentGatewayAccount[]` for both providers (absent ones `status: not_connected`) | 404 |
| `PUT /stores/{store}/payment-gateways/{provider}` | `ConnectGatewayInput` `{ mode, credentials }` (bkash: `app_key` ≤ 64, `app_secret` ≤ 128, `username` ≤ 64, `password` ≤ 128; sslcommerz: `store_id` ≤ 64, `store_passwd` ≤ 128) | 200 `PaymentGatewayAccount` (`connected`) after a live credential check; replaces credentials; audit `integration.connected` (no secrets) | 403; 404; 422 `credentials_invalid`; 502 `provider_unavailable` |
| `PATCH /stores/{store}/payment-gateways/{provider}` | `{ revision, enabled?, is_default? }` | 200 | 404; 409 `revision_conflict`; 422 `gateway_not_connected` (enable when not connected; enable live without `last_checked_at`) |
| `POST /stores/{store}/payment-gateways/{provider}/test-payment` | — (`Idempotency-Key` required) | 201 `{ payment_id, redirect_url }` (৳ 10 sandbox / ৳ 1 live, `purpose: test`); on success `verified_at` set; test charges are refunded automatically where the gateway supports it | 404; 422 `gateway_not_connected`; 502 |
| `DELETE /stores/{store}/payment-gateways/{provider}` | — | 204 (credentials wiped, `disconnected`, `enabled=false`); audit `integration.disconnected` | 404; 409 `gateway_busy` |

Settings additions on `PATCH /stores/{store}/settings` (O A `ManageSettings`): `checkout.cod_advance`,
`tax.display`, `tax.rate_bps`, `tax.bin`, `invoice.footer`, `notifications.customer_sms.{payment_link,order_updated}`.
`StoreSettings.commerce` returns them (§9). `StorefrontCommerce.payment_methods` lists `cod` (if enabled) + enabled
gateways; new `cod_advance`.

### 4.2 Storefront payments (server-to-server; `throttle:storefront` + named limits)
| Method & path | Headers / body | Success | Errors |
|---|---|---|---|
| `POST /storefront/checkout` (**extended**) | 5a headers; body adds `payment_method: 'bkash' \| 'sslcommerz'` and `advance_gateway?` (P5B-13) | 201 `CheckoutResult` + `payment: PaymentInitiation \| null` (`null` for plain COD) | 5a errors; 422 `payment_method_unavailable`, `advance_required` |
| `POST /storefront/orders/pay` | `X-Order-Token`, `Idempotency-Key` (scope `storefront.pay`); `{ payment_method }` | 200 `{ data: { order: StorefrontOrder, payment: PaymentInitiation \| null } }` (COD switch → `payment: null`, order `pending`) | 404 (token); 409 `payment_not_pending`; 422 `payment_method_unavailable`; throttle `checkout` |
| `GET /storefront/orders/confirmation` (**extended**) | `X-Order-Token` | 200 `StorefrontOrder` + `payment: StorefrontPaymentState \| null` | 404 |
| `GET /storefront/payments/{payment}/result` | — | 200 `{ data: StorefrontPaymentResult }` = `{ status, order_number, amount, purpose, shop_name }` (no PII); `private, no-store` | 404 (other store, unknown) |
| `GET /storefront/payment-links/{token}` | throttle `pay-link` (20/min host + IP) | 200 `PaymentLinkView` `{ order_number, amount, currency, expires_at, provider, status: 'active' }` | 404 `not_found` (unknown, expired, paid, cancelled: identical body) |
| `POST /storefront/payment-links/{token}/pay` | `Idempotency-Key` (scope `storefront.link-pay`) | 200 `{ data: PaymentInitiation }` | 404; 502 |

### 4.3 Payment returns and webhooks (public, no tenant header; tenant from route key or signed id)
| Method & path | Auth | Behaviour |
|---|---|---|
| `GET /payments/return/bkash/{payment}` | Laravel signed URL (`signature`, `expires`) | Query `paymentID`, `status`, `signature` (bKash). Resolve via `sp_payment_owner`; `status=success` → Execute (then Query on doubt); `failure`/`cancel` → Query once, then payment `failed`/`cancelled` if still not completed. Always 303 → `https://{primary_host}/checkout/payment-result?payment={id}` (or `/pay/result?payment=` for links). Invalid signature → 403 page with no redirect |
| `GET\|POST /payments/return/sslcommerz/{payment}` | signed URL | Browser POST from SSLCommerz (`tran_id`, `val_id`, `status`). Validation API with `val_id`; same 303 rule. The path carries `?r=success\|fail\|cancel` inside the signed URL |
| `POST /webhooks/sslcommerz/{route_key}` | route key + Validation API | IPN (P5B-19). 200 `{ received: true }` immediately after storing; unknown key → 404; throttle `webhooks` |
| `POST /webhooks/bkash/{route_key}` | SNS message signature (**VERIFY**) | Accepts SNS `SubscriptionConfirmation` (confirms by fetching `SubscribeURL` only if its host matches `sns.*.amazonaws.com`) and `Notification`; treated as a trigger for Query Payment. Optional in 5b |
| `POST /webhooks/steadfast/{route_key}` | `Authorization: Bearer {secret}` (`hash_equals` on sha256) | Courier event (P5B-37). 200 |
| `POST /webhooks/pathao/{route_key}` | `X-PATHAO-Signature` = secret | 202 within 10 s; `webhook_integration` test event acknowledged |
| `POST /webhooks/redx/{route_key}` | **VERIFY** | Accepted only when the driver declares webhook support |
| `GET /dev/fake-gateway/{payment}` + `POST …/{outcome}` | only when `PAYMENTS_FAKE=true` and env ≠ production | Fake hosted page (P5B-29) |

All webhook responses carry no tenant data. Bad bearer/secret → 401 (event not stored, `webhook.rejected` metric).
Duplicate `event_id` → 200/202 with no effect.

### 4.4 Payment links (merchant; O A S create/resend/cancel — `Operate`)
| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /stores/{store}/orders/{order}/payment-links` | — | 200 `PaymentLink[]` (newest first) | 404 |
| `POST /stores/{store}/orders/{order}/payment-links` | `CreatePaymentLinkInput` `{ amount_kind, percent_bps?, amount?, provider, expires_in_minutes: 120\|360\|1440\|2880, cancel_if_unpaid, send_sms }`; `Idempotency-Key` required | 201 `PaymentLink` (with `url`); timeline `payment_link`; SMS if `send_sms` | 404; 409 `payment_link_active`, `invalid_state_transition` (wrong status); 422 (`amount` > due, `provider` not enabled → `gateway_not_connected`) |
| `POST /stores/{store}/orders/{order}/payment-links/{link}/resend` | — | 200 (SMS again; throttle 3 per link per hour) | 404; 409 (not active) |
| `DELETE /stores/{store}/orders/{order}/payment-links/{link}` | — | 204 (`cancelled`; order unaffected) | 404; 409 (paid) |

### 4.5 Refunds (extended)
`POST /stores/{store}/orders/{order}/refunds` (O A `ManageRefunds`, Idempotency-Key): `RefundInput` gains
`method: 'gateway'`, `payment_id` (required with `gateway`; a succeeded online charge of this order, else 422
`payment_id`), `return_id?` (this order's return). Response 201 `Payment` (`status` `succeeded` or `pending`).
Errors: 422 `refund_exceeds_paid`, `gateway_refund_rejected`; 502 `provider_unavailable` (refund row `failed`,
retry allowed with a new key). `POST /stores/{store}/orders/{order}/cancel` gains `refund_to_gateway?: boolean`.

### 4.6 Couriers (merchant; `T`; reads O A S, writes O A `ManageIntegrations`)
| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /stores/{store}/couriers` | — | 200 `CourierAccount[]` (all three, `not_connected` when absent) | 404 |
| `PUT /stores/{store}/couriers/{provider}` | `ConnectCourierInput` `{ mode, credentials, settings? }` (steadfast `{api_key, secret_key}`; pathao `{client_id, client_secret, username, password}`; redx `{access_token}`) | 200 `CourierAccount` + `meta.webhook_secret` (**shown once**, Steadfast/Pathao) | 402 `plan_limit_reached`; 403; 404; 422 `credentials_invalid`; 502 |
| `PATCH /stores/{store}/couriers/{provider}` | `{ revision, settings?, is_default? }` (`pickup_location_id` must be this store's → 422) | 200 | 404; 409; 422 |
| `POST /stores/{store}/couriers/{provider}/test` | — | 200 `{ data: { ok, checked_at, balance_amount? } }` | 404; 422 `credentials_invalid`; 502 |
| `POST /stores/{store}/couriers/{provider}/webhook-secret` | — | 200 `{ data: { webhook_url, webhook_secret } }` (rotate; old secret invalid at once) | 404 |
| `DELETE /stores/{store}/couriers/{provider}` | — | 204 | 404; 409 `courier_busy` |
| `GET /stores/{store}/couriers/{provider}/areas` | `?level=city\|zone\|area&parent_id=` | 200 `CourierArea[]` (cached 24 h) + `meta.suggested` for `?district_code&thana_code` | 404; 422 (`level`); 502 |
| `GET /stores/{store}/couriers/{provider}/pickup-stores` | — | 200 `{ id, name, address }[]` (Pathao stores / RedX pickup stores) | 404; 502 |

### 4.7 Shipments (merchant; O A S `Operate` unless stated)
| Method & path | Body / query | Success | Errors |
|---|---|---|---|
| `POST /stores/{store}/orders/{order}/shipments` | `BookShipmentInput` `{ provider, pickup_location_id?, cod_amount? (O A), weight_grams?, item_description? ≤ 120, note? ≤ 255, delivery_type?, area?: { city_id, zone_id, area_id }, remember_area? }`; Idempotency-Key | 201 `Shipment` (`booked`, or `booking` on timeout) | 402 (n/a); 403 (staff `cod_amount`); 404; 409 `shipment_booked`, `invalid_state_transition`; 422 `gateway_not_connected`, `courier_rejected`, (`area` required for pathao/redx without a mapping) |
| `POST /stores/{store}/shipments/bulk` | `{ provider, order_ids: 1–500 }` | 202 `ShipmentBatch` | 402 `feature_not_in_plan`; 422 (`order_ids.N` "Unknown order."; nothing queued) |
| `GET /stores/{store}/shipment-batches/{batch}` | — | 200 `ShipmentBatch` | 404 |
| `GET /stores/{store}/shipments` | `filter[provider]`, `filter[status]` (comma list or group `problems`, `active`, `final`), `filter[booked_at][gte\|lte]`, `q` (consignment, order number, phone), `sort=-booked_at` (default) \| `-cod`; `page`, `per_page` ≤ 100 | 200 `ShipmentSummary[]` + `meta: ShipmentListMeta` (`counts` per provider, `kpis`, `PaginationMeta`) | 422 |
| `GET /stores/{store}/shipments/{shipment}` | — | 200 `ShipmentDetail` (events, order summary, money breakdown) | 404 |
| `POST /stores/{store}/shipments/{shipment}/refresh` | — | 200 `ShipmentDetail` (throttle 6/min per shipment) | 404; 502 |
| `POST /stores/{store}/shipments/sync` | — | 202 `{ data: { queued: n } }` (throttle 1/min per store) | — |
| `POST /stores/{store}/shipments/{shipment}/cancel` | `{ reason? }` | 200 (`cancelled`) | 404; 409 `courier_cancel_unsupported`, `invalid_state_transition` |
| `POST /stores/{store}/shipments/{shipment}/mark-cancelled` | `{ note? }` | 200 (after cancelling in the courier panel; only from `booked`) | 404; 409 |

`Order.shipment` returns the active shipment (the newest non-cancelled); `Order.shipments` (new) lists all.

### 4.8 Documents (merchant; O A S print, O A `ManageSettings` template writes)
| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /stores/{store}/document-templates` | — | 200 `DocumentTemplate[]` (5 kinds, defaults filled) | 404 |
| `PUT /stores/{store}/document-templates/{kind}` | `{ revision?, config: DocumentTemplateConfig }` | 200 | 403; 404 (unknown kind); 409; 422 |
| `POST /stores/{store}/documents` | `{ kind, order_ids: 1–100, language? }` | 202 `Document` (`queued`) | 404; 422 (`order_ids.N`, label for an order without address is fine; `label_4x6` for unbooked orders uses the order number barcode) |
| `GET /stores/{store}/documents/{document}` | — | 200 `Document` (`download_url` when `ready`, 5-min signed) | 404 |
| `POST /stores/{store}/documents/preview` | `{ kind, config?, order_id? }` | 200 `{ data: { html } }` (sanitised HTML for the Live preview; sample order when absent; throttle 30/min) | 404; 422 |
| `GET /documents/{document}/download` | signed (`tenant`, `expires`, `signature`) | `application/pdf`, `Content-Disposition: inline; filename="GS-1042-label.pdf"`, `private, no-store` | 404 (expired/foreign) |

Orders list gains `filter[printed]=invoice|label` / `filter[not_printed]=invoice|label` for "Not printed · Printed today".

### 4.9 Order changes (merchant)
| Method & path | Roles | Body | Success | Errors |
|---|---|---|---|---|
| `POST /stores/{store}/orders/{order}/items/quote` | O A S | `EditOrderItemsInput` (no writes) | 200 `OrderItemsQuote` | 404; 422 shape |
| `PUT /stores/{store}/orders/{order}/items` | O A S | `EditOrderItemsInput` `{ revision, items: [{ id?, variant_id?, quantity 0–99 }] (1–50 non-zero), reason: customer_request\|out_of_stock\|wrong_item\|other, note? ≤ 500, recalculate_shipping?, shipping_amount_override?, notify_customer? }` | 200 `Order` + `meta.notices` | 404; 409 `revision_conflict`, `invalid_state_transition`, `shipment_booked`; 422 `out_of_stock`, `total_below_paid`, `items.N.variant_id` |
| `POST /stores/{store}/orders/{order}/restock` | O A S | `{ lines: [{ item_id, quantity }], note? }` | 200 `Order` | 404; 409 (not `returned`); 422 (`lines.N.quantity` > shipped − restocked) |
| `GET /stores/{store}/returns` | O A S | `filter[status]`, `filter[type]`, `filter[reason]`, `filter[provider]`, `q` (RT number, order number, phone), `sort=-created_at`; `page`, `per_page` | 200 `ReturnSummary[]` + `meta: ReturnListMeta` (`counts`, `kpis` `{ open, return_rate_30d, money_lost_amount, restocked_units_month }`) | 422 |
| `POST /stores/{store}/orders/{order}/returns` | O A S | `CreateReturnInput` `{ type, reason, customer_note?, lines: [{ order_item_id, quantity, exchange_variant_id? }] (1–50) }` | 201 `ReturnRequest` | 404; 409 `return_not_allowed`; 422 |
| `GET /stores/{store}/returns/{return}` | O A S | — | 200 `ReturnRequest` | 404 |
| `POST /stores/{store}/returns/{return}/approve` | O A S | `{ pickup_tracking_code?, note? }` | 200 | 404; 409 |
| `POST /stores/{store}/returns/{return}/reject` | O A S | `{ reason ≤ 255 }` | 200 | 404; 409 |
| `POST /stores/{store}/returns/{return}/receive` | O A S | `{ checks: { tags_intact, unused, original_packaging }, lines: [{ return_item_id, restock_quantity }] }` | 200 (restock ledger) | 404; 409; 422 |
| `POST /stores/{store}/returns/{return}/exchange-order` | O A S (O A if the difference is negative) | `{ shipping_amount_override?, send_payment_link?: { provider, expires_in_minutes } }`; Idempotency-Key | 201 `{ data: { return: ReturnRequest, order: Order, payment_link: PaymentLink \| null } }` | 402 `plan_limit_reached` (manual-order limit applies); 404; 409; 422 `out_of_stock` |
| `POST /stores/{store}/returns/{return}/close` | O A S | `{ note? }` | 200 | 404; 409 |
| `POST /stores/{store}/returns/{return}/notes` | O A S | `{ body 1–1000 }` | 201 `ReturnEvent` | 404 |

Every write locks the order row (then the return row), checks the state machine, writes events and bumps `revision`.
Audit: `integration.*`, `payment.mismatch`, `payment.late_refund`, `order.refunded` (gateway), `shipment.cod_overridden`,
`order.items_edited`, `return.exchange_created`.

---

## 5. Payment providers (owner API) — public documentation, checked 2026-11-22

### 5.1 bKash Tokenized Checkout (v2)
Sources: https://developer.bka.sh/docs/grant-token (updated 2026-09-29), `/docs/refresh-token`,
`/docs/token-managment-v2`, `/docs/create-payment-3`, `/docs/execute-payment-4`, `/docs/query-payment`,
`/docs/search-transaction`, `/docs/refund`, `/docs/refund-status`, `/page/instant-payment-notification`; index
https://developer.bka.sh/llms.txt. The older v1.2.0-beta reference returns 404.

| Step | Call (POST, JSON) | Our use |
|---|---|---|
| Token | `{base}/auth/grant-token` — headers `username`, `password`; body `app_key`, `app_secret` → `id_token`, `refresh_token` (30 days), `expires_in` (3 600) | Cached per account for `expires_in − 600 s`; refresh at 50–55 min via `/auth/refresh-token`. **Grant + refresh are limited to 2 calls/hour** (over → 1-hour block): never grant per request; a failed grant is cached 5 min |
| Create | `{base}/payment/create` — headers `Authorization: {id_token}` (the docs' tables say "Bearer"; the samples send the raw token: **VERIFY**), `X-App-Key`; body `payerReference` (shopper phone `01…`), `callbackURL` (signed API return URL), `amount` (`Money::toDecimal`), `currency` `BDT`, `intent` `sale`, `merchantInvoiceNumber` (= our payment id, ≤ 255) → `paymentId` (24 h, executable once), `bkashURL`, `transactionStatus: Initiated` | `payments.provider_payment_id = paymentId`; redirect the shopper to `bkashURL` |
| Callback | browser → `callbackURL?paymentID=…&status=success\|failure\|cancel&signature=…` | The `signature` algorithm is **not documented (VERIFY)**; we never rely on it: only Execute/Query decide |
| Execute | `{base}/payment/execute` `{ paymentId }` → `trxId`, `transactionStatus: Completed`, `amount`, `merchantInvoiceNumber`, `maxRefundableAmount` | 30 s timeout; on timeout → Query; retry Execute only while `Initiated` |
| Query | `{base}/query/payment` `{ paymentId }` → `transactionStatus` (documented: `Completed`, `Initiated`; others such as `Cancelled`/`Failed` **VERIFY**) | Reconcile job, expiry check |
| Refund | `{base}/refund/payment/transaction` `{ paymentId, trxId, refundAmount (≤ 2 decimals, ≤ maxRefundableAmount), sku (≤ 255: our refund payment id), reason (≤ 255) }`; ≤ 10 partial refunds within 60 days; no duplicate within 10 min | P5B-24 |
| Refund status | `{base}/refund/payment/status` `{ paymentId, trxId }` → `refundTransactions[]` | Recovery after a refund timeout |
| IPN | AWS-SNS-style POST (`Type`, `MessageId`, `TopicArn`, `Message`, `Signature`, `SigningCertURL`, `SubscriptionConfirmation`), success only, URL registered by bKash support | Optional trigger; coverage of tokenized checkout and signature steps **VERIFY** |

Base URLs: sandbox `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout`; **live: not published (VERIFY with bKash;
config `BKASH_LIVE_BASE_URL` must be set before live mode can be enabled)**. Per-transaction fees: not public (Q45).

### 5.2 SSLCommerz v4
Sources: https://developer.sslcommerz.com/doc/v4/ (Version 4.00, updated 2019-05-12); sandbox registration
https://developer.sslcommerz.com/registration/; `verify_sign` scheme from the official PHP SDK
https://github.com/sslcommerz/SSLCommerz-PHP (`lib/SslCommerzNotification.php`).

| Step | Call | Our use |
|---|---|---|
| Session | `POST {base}/gwprocess/v4/api.php` form: `store_id`, `store_passwd`, `total_amount`, `currency` `BDT`, `tran_id` (= our payment id, 26 chars), `success_url`/`fail_url`/`cancel_url` (signed API returns), `ipn_url` (`/webhooks/sslcommerz/{route_key}`), `cus_name`, `cus_email` (shopper email or `noreply+{order}@{PLATFORM_DOMAIN}`), `cus_add1`, `cus_city` (district), `cus_postcode` (`1000` placeholder; **VERIFY** if required), `cus_country` `Bangladesh`, `cus_phone`, `shipping_method` `Courier`, `num_of_item`, `product_name` (first item, ≤ 255), `product_category` `general`, `product_profile` `physical-goods`, `value_a` = order number → `status` `SUCCESS`, `GatewayPageURL`, `sessionkey` | redirect to `GatewayPageURL` |
| Return / IPN | browser POST to success/fail/cancel; server IPN POST with `tran_id`, `val_id`, `amount`, `currency`, `status` (`VALID`, `FAILED`, `CANCELLED`, `UNATTEMPTED`, `EXPIRED`), `bank_tran_id`, `verify_sign`, `verify_key`, `risk_level` | Trigger only. `verify_sign`: md5 over the `verify_key` fields plus `store_passwd = md5(store_passwd)`, sorted by key, joined `k=v&`; mismatch → event `ignored` |
| Validate | `GET {base}/validator/api/validationserverAPI.php?val_id&store_id&store_passwd&format=json` → `status` `VALID`\|`VALIDATED`\|`INVALID_TRANSACTION`, `tran_id`, `amount`, `currency_type`, `bank_tran_id`, `risk_level` | Paid only on VALID/VALIDATED + P5B-16 checks. `risk_level = 1` → payment succeeds but the order gets tag `payment-risk` and a timeline warning |
| Query | `GET {base}/validator/api/merchantTransIDvalidationAPI.php?tran_id&store_id&store_passwd&format=json` → `element[]` (`VALID`, `VALIDATED`, `PENDING`, `FAILED`) | Reconcile / expiry |
| Refund | same endpoint with `bank_tran_id`, `refund_trans_id` (our refund id), `refund_amount`, `refund_remarks`, `refe_id` → `status` `success`\|`failed`\|`processing`, `refund_ref_id` | Live needs the platform's public egress IP registered with SSLCommerz (infra, §17). Partial refunds **VERIFY** |
| Refund status | same endpoint with `refund_ref_id` → `refunded`\|`processing`\|`cancelled` | `payments:refund-status` |

Base: sandbox `https://sandbox.sslcommerz.com`, live `https://securepay.sslcommerz.com`.

### 5.3 Checkout sequence (online)
1. `POST /storefront/checkout` (5a transaction + `status = pending_payment`, `payment_expires_at`, charge `pending`
   with `expires_at`) → commit → `initiate()` → 201 with `payment.redirect_url`.
2. SF Server Action `placeOrder` sets `sp_order` and `redirect()`s the browser to `redirect_url`.
3. Gateway → signed API return → verify → 303 → `/checkout/payment-result?payment=…` (SF): `succeeded` →
   thank-you ("Paid ৳ N with bKash"); `pending` (verification still running) → polling page (2 s, max 30 s, then
   "We're confirming your payment"); `failed`/`cancelled` → "Payment didn't go through" + Retry / Pay on delivery.
4. Meanwhile IPN/reconcile may arrive first: whichever verifies first applies; the other is a no-op (P5B-20).
5. Applying success (one transaction, lock order → payment): payment `succeeded`, `provider_trx_id`, `verified_at`;
   order `paid_amount += amount`, `payment_status` (`paid` when ≥ total, else `partially_paid`), status
   `pending_payment → confirmed`, events `payment` + `status_changed`; after commit: SMS `order_placed`, merchant
   email, `OrderPaid` event.

---

## 6. Courier providers (owner API) — public documentation, checked 2026-11-22

Normalised status mapping (P5B-36) per provider; unknown raw values → `problem: unknown`, status unchanged, timeline
"Courier problem · needs you" (Figma 31:2905).

### 6.1 Steadfast (first)
Source: official Postman collection "SteadFast API Documentation",
https://documenter.getpostman.com/view/26211192/2sAYJ1mhpk (published 2024-12-26). Secondary (not official):
the `steadfast-it` Laravel package for status lists and webhooks. No sandbox documented (**VERIFY**; test with a real
merchant account and cancel parcels in the panel).
- Base `https://portal.packzy.com/api/v1`; headers `Api-Key`, `Secret-Key`.
- `POST /create_order` (`invoice` = shipment id, `recipient_name`, `recipient_phone` (`01…`), `recipient_address`
  (address line, thana, district; ≤ 250), `cod_amount` (taka, integer when whole), `note`, `item_description`,
  `recipient_email?`, `alternative_phone?`) → `consignment.consignment_id`, `tracking_code`, `status` (`in_review`).
- `POST /create_order/bulk-order` (≤ 500 per request). `GET /status_by_cid/{id}`; `GET /trackings_by_invoice/{invoice}`
  (`status_by_invoice` / `status_by_trackingcode` exist only in the package: **VERIFY**). `GET /get_balance`
  (credential check). `POST /create_return_request` (not used in 5b). `GET /payments` (not used in 5b).
- Webhook (package, **VERIFY**): JSON `{ consignment_id, invoice, status, cod_amount, updated_at }` with
  `Authorization: Bearer {token}` set by the merchant in the Steadfast panel.
- Mapping (Figma 31:2905 + package list): `in_review`, `pending` → `booked` until the first pickup signal, then
  `in_transit`; `hold` → `on_hold`; `delivered_approval_pending`, `delivered` → `delivered`;
  `partial_delivered_approval_pending`, `partial_delivered` → `partially_delivered`; `cancelled_approval_pending`,
  `cancelled` → `returning` if picked up, else `cancelled`; `unknown_approval_pending`, `unknown` → problem `unknown`.
  Steadfast has no explicit "picked up" status in the public list (**VERIFY**): until verified, `in_transit` is set
  when status `pending` is first seen **after** `in_review`, which also triggers order `shipped`.
- Cancel: no API → 409 `courier_cancel_unsupported`.

### 6.2 Pathao (second)
Source: Pathao Merchant Developer API, shown in the merchant panel https://merchant.pathao.com/courier/developer-api
(login required; read from the panel's public JS bundle; no version or date shown — **VERIFY each call in sandbox**).
- Base sandbox `https://courier-api-sandbox.pathao.com`, live `https://api-hermes.pathao.com`.
- Token `POST /aladdin/api/v1/issue-token` (`client_id`, `client_secret`, `username` (email), `password`,
  `grant_type=password`; refresh with `grant_type=refresh_token`) → `access_token`, `refresh_token`, `expires_in`
  (sample 5 days). Cached per account.
- `GET /aladdin/api/v1/stores`; `GET /city-list`; `GET /cities/{city_id}/zone-list`; `GET /zones/{zone_id}/area-list`;
  `POST /merchant/price-plan` (quote, shown in the booking dialog when available).
- `POST /aladdin/api/v1/orders` (`store_id`, `merchant_order_id` = shipment id, `recipient_name`, `recipient_phone`,
  `recipient_address`, `recipient_city`, `recipient_zone`, `recipient_area?`, `delivery_type` 48, `item_type` 2,
  `item_quantity`, `item_weight` kg 0.5–10, `amount_to_collect` (integer taka), `item_description?`,
  `special_instruction?`) → 14-character `consignment_id`. `POST /orders/bulk` (async 202; result retrieval **VERIFY**).
  `GET /orders/{consignment_id}/info`.
- Webhook: secret in `X-PATHAO-Signature`; respond **202** within 10 s; events `order.created`, `order.updated`,
  `order.pickup-requested`, `order.assigned-for-pickup`, `order.picked`, `order.pickup-failed`,
  `order.pickup-cancelled`, `order.at-the-sorting-hub`, `order.in-transit`, `order.received-at-last-mile-hub`,
  `order.assigned-for-delivery`, `order.delivered`, `order.partial-delivery`, `order.returned`,
  `order.delivery-failed`, `order.on-hold`, `order.paid`, `order.paid-return`, `order.exchanged`,
  `order.return-id-created`, `order.return-in-transit`, `order.returned-to-merchant`, `store.*`;
  payload `consignment_id`, `merchant_order_id`, `updated_at`, `timestamp`, `store_id`, `event`, `delivery_fee`,
  `total_fee`. Event id = `sha256(consignment_id|event|timestamp)`.
- Mapping: created/pickup-requested/assigned-for-pickup → `booked`; `picked` → `picked_up`; sorting-hub, in-transit,
  received-at-last-mile-hub → `in_transit`; assigned-for-delivery → `out_for_delivery`; `delivered` → `delivered`;
  `partial-delivery` → `partially_delivered`; `delivery-failed` → `delivery_failed`; `on-hold` → `on_hold`;
  `returned`, return-id-created, return-in-transit → `returning`; `returned-to-merchant` → `returned`;
  pickup-cancelled → `cancelled`; pickup-failed → problem; `paid`/`paid-return` → `settled_at`; `exchanged` → event only.
- Weight 0.5–10 kg; outside → 422 on `weight_grams`.

### 6.3 RedX (third)
Sources (secondary — the official page https://redx.com.bd/developer-api/ blocked automated reading): the RedX OpenAPI
mirrored on apis.io (`shopup-parcels-api-openapi.yml`, `shopup-areas-api-openapi.yml`,
`shopup-pickup-stores-api-openapi.yml`), version `v1.0.0-beta`. **Everything VERIFY against sandbox.**
- Base live `https://openapi.redx.com.bd/v1.0.0-beta`, sandbox `https://sandbox.redx.com.bd/v1.0.0-beta`; header
  `API-ACCESS-TOKEN: Bearer {token}`.
- `POST /parcel` (`customer_name`, `customer_phone`, `delivery_area`, `delivery_area_id`, `customer_address`,
  `merchant_invoice_id` = shipment id, `cash_collection_amount` (string taka), `parcel_weight` (grams), `value`,
  `instruction?`, `pickup_store_id?`); `GET /parcel/track/{trackingId}`; `GET /parcel/info/{trackingId}`;
  `GET /areas`; `GET /pickup/stores`, `POST /pickup/store`.
- Webhook payload, statuses and auth: unknown → poll only until verified. Expected status words (to confirm):
  `ready-for-delivery`, `delivery-in-progress`, `delivered`, `agent-hold`, `agent-returning`, `returned`,
  `agent-area-change`.

### 6.4 Booking and sync sequence
Book (P5B-33) → `booked` → webhook/poll events → `ShipmentSync::apply(shipment, CourierStatus, source)`:
lock order → lock shipment → dedupe on (`provider_status`, `occurred_at`) → append `shipment_events` → update
shipment → apply the order effect if the normalised status changed (money states re-queried first) → order events
→ after commit: SMS `order_shipped` on the transition to `shipped` (5a template with courier name and tracking link),
dashboard invalidation.

---

## 7. Documents (owner API, WEB for the page)

- **Renderer:** `DocumentRenderer::render(kind, orders, template, language)` → Blade view
  `resources/views/documents/{kind}.blade.php` → `GotenbergClient::html(index.html + fonts + css)` with
  `paperWidth/paperHeight` per kind (A4 8.27×11.7 in; 80 mm = 3.15 in × auto (single long page per receipt); A5 two-up
  = A4 with two A5 blocks; label 4×6 in), margins 0 for labels, `printBackground=true`, `preferCssPageSize=true`.
  Gotenberg route `POST /forms/chromium/convert/html` (https://gotenberg.dev/docs, OpenAPI version 9); the
  multipart field rules (an `index.html` file) **VERIFY** at implementation.
- **Content per kind** (Figma 44:16156): invoice — shop block (logo, name, address = default pickup location,
  phone, BIN when on), invoice no. = order no., date, bill-to/ship-to, lines (name, variant, qty, unit, total; SKU
  optional), subtotal, discount (code), delivery, VAT line (P5B-56), total, paid, **due (COD)**, payment method,
  footer; receipt — same compressed to 72 mm printable width; packing slip — lines with qty and checkboxes, no prices;
  label — shop + courier brand, **COLLECT CASH ৳ due** (or "PAID"), order no., date, weight, Code 128 of the
  consignment, deliver-to (name, phone, address, district/thana), courier hub/zone when known, items summary (when
  `show_product_names`), QR "Scan to track", return address.
- **Bangla:** `language = bn` switches static labels to Bangla strings (`resources/lang/bn/documents.php`), digits
  stay Latin (courier scanners and riders read Latin digits; default, pending PO under Q51). Data (names, addresses)
  prints as entered in either script.
- **Limits:** ≤ 100 orders per document; ≤ 10 queued documents per store (409 `conflict` beyond); job timeout 120 s.
- **Tests:** HTML snapshot per kind/language (driver `html`); in the `api-documents` CI job with a real Gotenberg
  service: render a label with "রহিম উদ্দিন, মিরপুর ১০, ঢাকা" → PDF fonts list includes NotoSansBengali (`pdffonts`)
  and `pdftotext` returns the same string; 100-label batch < 20 s.

---

## 8. Order changes (owner API) — rules beyond §1.E

- **Edit items transaction:** lock order → load lines → compute diff → lock inventories of affected variants by
  `variant_id` → release/commit → coupon re-application (lock coupon only if a redemption is released) → recompute
  totals with `CartPricer` (same allocation rules, P5-12) → write items (removed lines are deleted; `order_items` of
  removed lines are kept only in the `items_edited` event meta: name, variant, from/to qty) → events → `revision++`.
  COD charge row amount = new total − paid (pending COD charge updated in place).
- **Return amount** per line = floor(line `total_amount` × qty_returned / line qty); `requested_amount` = Σ.
  Refundable for a return = min(`requested_amount` − its refunds, order refundable).
- **Return lines** can't exceed delivered quantity minus quantities in other non-rejected returns (409
  `return_not_allowed` with `details.lines.N.quantity`).
- **Exchange credit:** a fixed discount line on the new order = Σ returned line amounts (capped at the new subtotal);
  if credit > new subtotal + shipping, the remainder is shown as "Refund ৳ x" (merchant refunds through the original
  order). The new order carries tag `exchange` and `source_order_id`.
- **Courier `partially_delivered`** creates a return in `requested` with `source: courier` and no lines; the merchant
  adds lines on receive (the receive input may include `lines` for a courier-sourced return).

---

## 9. § Types (orchestrator applies) — `packages/types/src/index.ts` (additive)

```ts
// ---------- Integrations (shared) ----------
export type GatewayProvider = 'bkash' | 'sslcommerz';
export type CourierProvider = 'steadfast' | 'pathao' | 'redx';
export type IntegrationMode = 'sandbox' | 'live';
export type IntegrationStatus = 'not_connected' | 'connected' | 'error' | 'disconnected';
// ROLE_CAN gains: manage_integrations: ['owner','admin']

// ---------- Payment gateways ----------
export interface PaymentGatewayAccount {
  provider: GatewayProvider; status: IntegrationStatus; mode: IntegrationMode | null;
  credentials_hint: string | null;            // "••••3f9a"; never the secret
  enabled: boolean; is_default: boolean;
  verified_at: string | null; last_checked_at: string | null; last_error_code: string | null;
  connected_by: UserRef | null; connected_at: string | null; revision: number;
}
export type BkashCredentialsInput = { app_key: string; app_secret: string; username: string; password: string };
export type SslcommerzCredentialsInput = { store_id: string; store_passwd: string };
export interface ConnectGatewayInput { mode: IntegrationMode; credentials: BkashCredentialsInput | SslcommerzCredentialsInput }
export interface UpdateGatewayInput { revision: number; enabled?: boolean; is_default?: boolean }
export interface GatewayTestPayment { payment_id: string; redirect_url: string }

// ---------- Payments (extends 5a) ----------
export type PaymentProvider = 'cod' | 'manual' | GatewayProvider;
export type PaymentPurpose = 'order' | 'advance' | 'link' | 'exchange' | 'test';
// Payment gains:
//   purpose: PaymentPurpose; provider_trx_id: string | null; refunded_amount: number;
//   expires_at: string | null; failure_code: string | null; payment_link_id: string | null;
//   return_request_id: string | null; can_refund: boolean;   // succeeded online charge with refundable balance (O A)
// RefundMethod gains 'gateway'
// RefundInput gains: payment_id?: string | null; return_id?: string | null
// CancelOrderInput gains: refund_to_gateway?: boolean
export interface PaymentInitiation {
  payment_id: string; provider: GatewayProvider;
  status: 'redirect' | 'initiation_failed';
  redirect_url: string | null; amount: number; expires_at: string;
}
export interface StorefrontPaymentState {
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  provider: GatewayProvider; purpose: PaymentPurpose; amount: number;
  expires_at: string | null;                  // order hold end (pending_payment only)
  can_retry: boolean; can_switch_to_cod: boolean;
}
export interface StorefrontPaymentResult {
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  order_number: string; amount: number; currency: string; purpose: PaymentPurpose; shop_name: string;
}
// CheckoutInput gains: advance_gateway?: GatewayProvider | null   (payment_method may now be 'bkash' | 'sslcommerz')
// CheckoutResult gains: payment: PaymentInitiation | null
// StorefrontOrder gains: payment: StorefrontPaymentState | null; paid_amount: number
// StorefrontCommerce gains: cod_advance: 'none' | 'delivery_charge'
export interface StorefrontPayInput { payment_method: PaymentMethod }

// ---------- Payment links ----------
export type PaymentLinkAmountKind = 'delivery_charge' | 'percent' | 'full' | 'custom';
export interface PaymentLink {
  id: string; order_id: string; amount_kind: PaymentLinkAmountKind; percent_bps: number | null;
  amount: number; currency: string; provider: GatewayProvider;
  status: 'active' | 'paid' | 'expired' | 'cancelled';
  url: string;                                // https://{primary_host}/pay/{token}
  expires_at: string; cancel_if_unpaid: boolean; sent_via: ('sms')[];
  paid_at: string | null; created_by: UserRef | null; created_at: string;
}
export interface CreatePaymentLinkInput {
  amount_kind: PaymentLinkAmountKind; percent_bps?: number | null; amount?: number | null;
  provider: GatewayProvider; expires_in_minutes: 120 | 360 | 1440 | 2880;
  cancel_if_unpaid: boolean; send_sms: boolean;
}
export interface PaymentLinkView {
  order_number: string; shop_name: string; amount: number; currency: string;
  provider: GatewayProvider; expires_at: string; status: 'active';
}

// ---------- Couriers ----------
export interface CourierSettings {
  pickup_location_id: string | null; parcel_description: string; default_weight_grams: number;
  pathao_store_id?: string | null; delivery_type?: 48 | 12; redx_pickup_store_id?: string | null;
}
export interface CourierAccount {
  provider: CourierProvider; status: IntegrationStatus; mode: IntegrationMode | null;
  credentials_hint: string | null; is_default: boolean; settings: CourierSettings;
  webhook_url: string | null; webhook_secret_hint: string | null;
  capabilities: ('bulk' | 'cancel' | 'areas' | 'quote' | 'webhook')[];
  last_synced_at: string | null; last_webhook_at: string | null; last_error_code: string | null;
  connected_by: UserRef | null; connected_at: string | null; revision: number;
}
export interface ConnectCourierInput {
  mode: IntegrationMode;
  credentials: { api_key: string; secret_key: string }
    | { client_id: string; client_secret: string; username: string; password: string }
    | { access_token: string };
  settings?: Partial<CourierSettings>;
}
export interface UpdateCourierInput { revision: number; settings?: Partial<CourierSettings>; is_default?: boolean }
export interface CourierArea { id: string; name: string; level: 'city' | 'zone' | 'area'; parent_id: string | null }

// ---------- Shipments (extends 5a Shipment) ----------
export type ShipmentStatus =
  | 'booking' | 'booked' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'on_hold' | 'delivery_failed'
  | 'delivered' | 'partially_delivered' | 'returning' | 'returned' | 'cancelled' | 'booking_failed' | 'shipped';
export type ShipmentProblem = 'delivery_failed' | 'on_hold' | 'returning' | 'unknown';
// Shipment: provider stays 'manual' | CourierProvider; status widens to ShipmentStatus; gains
//   consignment_id: string | null; provider_status: string | null; attempts: number; problem: ShipmentProblem | null;
//   weight_grams: number | null; delivery_fee_amount: number | null; cod_charge_amount: number | null;
//   cod_collected_amount: number | null; last_location: string | null; last_event_at: string | null;
//   booked_at: string | null; picked_up_at: string | null; cancelled_at: string | null; failure_reason: string | null
// Order gains: shipments: Shipment[]; payment_expires_at: string | null; return_status: OrderReturnStatus;
//   payment_links: PaymentLink[]; invoice_printed_at: string | null; label_printed_at: string | null;
//   source_order_id: string | null
// OrderSummary gains: shipment: { provider: Shipment['provider']; status: ShipmentStatus; consignment_id: string | null } | null;
//   return_status: OrderReturnStatus
// OrderListFilters gains: printed?: 'invoice' | 'label'; not_printed?: 'invoice' | 'label'
// CancelReason gains 'payment_timeout' | 'payment_link_expired'
// ORDER_TRANSITIONS.pending_payment = ['confirmed', 'pending', 'cancelled']
export type OrderReturnStatus = 'none' | 'requested' | 'partially_returned' | 'returned';
export interface ShipmentEvent {
  id: string; status: ShipmentStatus; provider_status: string | null; description: string | null;
  location: string | null; source: 'webhook' | 'poll' | 'user' | 'system'; occurred_at: string;
}
export interface ShipmentSummary extends Shipment {
  order: { id: string; number: string; customer_name: string; customer_phone: string; district: string; thana: string };
  age_days: number;
}
export interface ShipmentDetail extends ShipmentSummary {
  events: ShipmentEvent[];
  money: { collect_amount: number; delivery_fee_amount: number | null; cod_charge_amount: number | null; net_amount: number | null };
  parcel: { items_summary: string; weight_grams: number | null; pickup_location: string | null };
  can: { cancel: boolean; mark_cancelled: boolean; refresh: boolean };
}
export interface ShipmentListMeta extends PaginationMeta {
  counts: Record<'all' | CourierProvider | 'manual', number>;
  kpis: {
    in_transit: number; out_for_delivery_today: number; delivered_7d: number; delivery_rate_7d: number | null;
    problems: { total: number; delivery_failed: number; on_hold: number; returning: number };
    cod_held: { total_amount: number; by_provider: { provider: CourierProvider; amount: number; parcels: number }[] };
  };
  last_synced_at: string | null;
}
export interface ShipmentListFilters {
  provider?: (CourierProvider | 'manual')[]; status?: (ShipmentStatus | 'problems' | 'active' | 'final')[];
  booked_from?: string; booked_to?: string; q?: string; sort?: '-booked_at' | '-cod'; page?: number; per_page?: number;
}
export interface BookShipmentInput {
  provider: CourierProvider; pickup_location_id?: string | null; cod_amount?: number | null;
  weight_grams?: number | null; item_description?: string | null; note?: string | null; delivery_type?: 48 | 12;
  area?: { city_id: string | null; zone_id: string | null; area_id: string | null } | null; remember_area?: boolean;
}
export interface ShipmentBatch {
  id: string; provider: CourierProvider; status: 'queued' | 'running' | 'completed' | 'failed';
  total: number; booked: number; skipped: number; failed: number;
  results: { order_id: string; order_number: string; shipment_id: string | null; status: 'booked' | 'skipped' | 'failed'; reason: string | null }[];
  created_at: string; finished_at: string | null;
}

// ---------- Documents ----------
export type DocumentKind = 'invoice_a4' | 'receipt_80mm' | 'invoice_a5_two_up' | 'packing_slip' | 'label_4x6';
export interface DocumentTemplateConfig {
  show_logo: boolean; show_bin: boolean; show_product_names: boolean; show_prices: boolean; show_sku: boolean;
  language: 'en' | 'bn'; footer_text: string | null;
}
export interface DocumentTemplate {
  kind: DocumentKind; config: DocumentTemplateConfig; paper: { width_mm: number; height_mm: number | null; label: string };
  is_default: boolean; revision: number; updated_at: string | null;
}
export interface CreateDocumentInput { kind: DocumentKind; order_ids: string[]; language?: 'en' | 'bn' }
export interface StoreDocument {
  id: string; kind: DocumentKind; status: 'queued' | 'rendering' | 'ready' | 'failed' | 'expired';
  orders_count: number; pages: number | null; download_url: string | null; expires_at: string | null;
  error_code: string | null; created_at: string;
}
// StoreCommerceSettings gains:
//   checkout.cod_advance: 'none' | 'delivery_charge';
//   tax: { display: 'none' | 'included'; rate_bps: number; bin: string | null }; invoice: { footer: string | null };
// CustomerSmsEvent gains 'payment_link' | 'order_updated'

// ---------- Order changes ----------
export type EditItemsReason = 'customer_request' | 'out_of_stock' | 'wrong_item' | 'other';
export interface EditOrderItemsInput {
  revision: number; items: { id?: string | null; variant_id?: string | null; quantity: number }[];
  reason: EditItemsReason; note?: string | null; recalculate_shipping?: boolean;
  shipping_amount_override?: number | null; notify_customer?: boolean;
}
export interface OrderItemsQuote {
  lines: (Omit<OrderItem, 'id' | 'restocked_quantity'> & { id: string | null; change: 'unchanged' | 'changed' | 'added' | 'removed'; issue: CartLineIssue | null })[];
  subtotal_amount: number; discount_amount: number; shipping_amount: number; total_amount: number;
  previous_total_amount: number; due_amount: number; due_delta_amount: number; notices: string[];
}
export interface RestockInput { lines: { item_id: string; quantity: number }[]; note?: string | null }
export type ReturnType = 'return' | 'exchange';
export type ReturnStatus = 'requested' | 'approved' | 'received' | 'refunded' | 'exchanged' | 'rejected' | 'closed';
export type ReturnReason = 'wrong_size' | 'damaged' | 'wrong_item' | 'changed_mind' | 'refused_at_door' | 'other';
export interface ReturnItem {
  id: string; order_item_id: string; product_name: string; variant_title: string; image: MediaRef | null;
  quantity: number; amount: number; restocked_quantity: number;
  exchange_variant: { id: string; title: string; price_amount: number; available: number | null } | null;
}
export interface ReturnSummary {
  id: string; number: string; type: ReturnType; status: ReturnStatus; reason: ReturnReason; source: 'merchant' | 'courier';
  order: { id: string; number: string }; customer: { name: string; phone: string };
  items_preview: { product_name: string; variant_title: string; quantity: number }[];
  requested_amount: number; refunded_amount: number; courier: CourierProvider | 'manual' | null; created_at: string;
}
export interface ReturnEvent {
  id: string; type: 'created' | 'status_changed' | 'note' | 'refund' | 'restock';
  from_status: ReturnStatus | null; to_status: ReturnStatus | null;
  actor: { type: 'user' | 'customer' | 'system'; user: UserRef | null }; body: string | null; meta: Record<string, unknown>; created_at: string;
}
export interface ReturnRequest extends ReturnSummary {
  customer_note: string | null; pickup_tracking_code: string | null;
  checks: { tags_intact?: boolean; unused?: boolean; original_packaging?: boolean };
  items: ReturnItem[]; events: ReturnEvent[]; exchange_order: { id: string; number: string } | null;
  price_difference_amount: number | null;     // exchange: new total − credit
  allowed_transitions: ReturnStatus[]; revision: number;
}
export interface CreateReturnInput {
  type: ReturnType; reason: ReturnReason; customer_note?: string | null;
  lines: { order_item_id: string; quantity: number; exchange_variant_id?: string | null }[];
}
export interface ReceiveReturnInput {
  checks: { tags_intact: boolean; unused: boolean; original_packaging: boolean };
  lines: { return_item_id?: string; order_item_id?: string; restock_quantity: number; quantity?: number }[];
}
export interface ReturnListMeta extends PaginationMeta {
  counts: Record<'open' | ReturnStatus, number>;
  kpis: { open: number; return_rate_30d: number | null; money_lost_amount: number; restocked_units_month: number };
}
export interface ExchangeOrderInput {
  shipping_amount_override?: number | null;
  send_payment_link?: { provider: GatewayProvider; expires_in_minutes: 120 | 360 | 1440 | 2880 } | null;
}
// OrderEvent.type gains 'payment_link' | 'items_edited' | 'return' | 'document'
// AuditLogFilters.subject_type allowlist gains 'payment_gateway', 'courier', 'shipment', 'return'
```
Notes: all additive; enums widened (clients must tolerate unknown values, API-CONVENTIONS §1). `Shipment` and
`Payment` keep their 5a fields.

---

## 10. Dashboard screens (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`

Frames confirmed in Figma on 2026-11-22 by metadata or screenshot: sections `41:12365` (39:10347, 39:10790,
39:11233, 146:33100), `32:5329` (14:980, 32:3770, 32:4182), `32:5330` (22:1181, 29:1814, 29:2562, 31:2231, 31:2905,
31:3581, 152:34534), `44:16156` (42:11175, 42:12238, 42:13193, 44:12097, 44:13094, 44:14203, 137:30097), and frames
45:8086, 52:564, 60:14865, 144:46081, 144:46654, 39:9900. Taken from FIGMA-INDEX without a fresh check: 146:32329,
60:16858, 33:3676, 10:600. Loading/error/empty states `148:35302`, `148:35336`,
`148:35352`; `packages/ui` components and tokens only. Staff (S) see integration pages read-only (no Connect/Edit).

| Screen / route | Figma | Build | Skip / disable |
|---|---|---|---|
| Integrations `/integrations` | `14:980` | Filter chips All / Connected / Couriers / Payments (counts); **Couriers**: Steadfast, Pathao, RedX cards (status badge, one-line capability text, "Synced 2 min ago", Manage/Connect); **Payments**: bKash Payment Gateway, SSLCommerz (status, "Live mode"/"Sandbox", Manage/Connect). Header "Connect your own accounts. Money always goes straight to you — Storeplix never holds it." | Paperfly, CarryBee, Nagad, EPS, aamarPay, PayStation, Marketing & tracking, Messaging, AI, Developer banner: hidden (not "Coming soon" cards, to keep the page honest) |
| Connect bKash / SSLCommerz (dialog) | `32:3770` | 4-step rail: Before you start (what you need, "Apply at bKash…" note) → Enter credentials (Sandbox/Live switch, fields per provider, "Encrypted and used only to start payments…") → Test payment (opens `redirect_url` in a new tab, polls the payment, ✓) → Go live (enable for checkout, default gateway). "Save and test" = `PUT` | Setup guide link → docs page later (link hidden) |
| Courier detail `/integrations/couriers/:provider` | `22:1181` (Overview), `31:2905` (Webhooks), Pathao `152:34534` | Header (logo, Connected badge, "Your own {courier} account", Test connection, Disconnect O A). **Overview**: Connection card (masked keys + Edit keys, webhook URL with Copy, account label), Booking rules card limited to: Pickup from (pickup location select), Cash to collect (fixed "Order due amount", read-only), Parcel description template, Default weight; Recent shipments (5, link to Shipments filtered). **Webhooks tab**: URL + Copy, Bearer token / secret masked with **Rotate** (shows the new value once), "Send test event" hidden, Last 24 h counts (received/succeeded/failed from `webhook_events`), Status mapping (static table of §6 mapping), Events received (last 20 `webhook_events` of this account: time, event, consignment, order, result). Right column "This month" (parcels, delivered %, returned %) from shipments | Booking rules toggles Book automatically, Bulk booking switch (bulk is plan-gated, always on when allowed), Print label after booking; Fraud check tab `29:2562`; COD & payouts tab `31:2231` (tile "COD money" shows only "Held by {courier}"); Activity log `31:3581`; Connection health sparkline; Need help card |
| Shipments `/shipments` | `39:10347` | Title + "Synced with couriers N min ago", **Sync now**, **Book parcels** (→ orders filtered `confirmed,ready_to_ship` without shipment, bulk book). KPI tiles: In transit, Out for delivery today, Delivered this week (+ rate), Problems (failed · on hold · returning), COD held by couriers. **Needs attention** card: shipments with `problem`, with Call customer (`tel:`) and "Reschedule" **hidden** (no courier API). COD with couriers card (per provider). Courier chips with counts, status select, date range, search. Table: consignment (+ booked date), order (link), customer (name, thana, district), courier, status · last scan, attempts, COD (to collect / collected / won't collect / paid online), age. Row → shipment detail. Bulk bar: Print labels (→ documents `label_4x6`), Download manifest = CSV of selected (client-side) | Request return, Reschedule, View payouts |
| Shipment detail `/shipments/:id` | `146:33100` | Consignment no., courier, order link, booked time; stepper Booked → Picked up → At hub (in_transit) → Out for delivery → Delivered (or Returned/Cancelled); Tracking timeline (`events`, Refresh); Parcel card (items, weight, delivery zone, booked from); Cash on delivery card (collect, delivery charge, COD charge, "You'll receive" when known); buyer card (name, phone, orders count, this shop only); actions: Print label, Open in {courier} (tracking URL), Cancel the parcel (or "Mark cancelled" instructions) | Call rider, rider card, "Good" risk badge, Change address or COD, Ask to hold |
| Order detail additions `/orders/:id` | `33:3676`, advance `144:46081` | Courier card: "Book with {default courier}" (dialog: courier select among connected, pickup, COD (O A editable), weight, description, area selects for Pathao/RedX with remembered mapping) or the shipment summary + link; Payments card shows online charges (bKash TrxID), links, refunds (gateway refund via "Refund" on a charge row, O A); **Ask for an advance** dialog (144:46081): amount radio (Delivery charge, Part payment 25 % (editable %), Full payment, Custom), Collect with (connected gateways), Link expires in (2 h default, 6 h, 24 h, 48 h), SMS preview, "Cancel if not paid in time" toggle, "Copy link instead" (creates with `send_sms: false` and copies), Send payment link; active link banner with Copy/Resend/Cancel; "Invoice" button → documents `invoice_a4`; "Edit items" link → `/orders/:id/edit` | Risky banner and Delivery record (Phase 8, Q23) |
| Edit order `/orders/:id/edit` | `144:46654` | Products card: lines with variant select, stepper, remove (Removed state greyed), "+ Add product" (product picker as Create order); Customer & delivery (5a fields) with Delivery select (zone charge or override); **What changes** card from `items/quote` (old→new subtotal, delivery, discount, collect on delivery delta); Why the change? (reason select + note), "Send updated total by SMS" toggle. Banner when booked: "This order is booked with {courier}. Cancel the parcel to edit items." (and the editor is read-only) | Scan barcode; "Saving will update the COD amount on the parcel" (Figma banner) — not supported in 5b (Q56) |
| Returns & exchanges `/returns` | `39:9900`, detail panel `146:32329` | KPI tiles: Open returns, Return rate 30 days, Money lost to returns, Restocked units. Tabs All open / Requested / Approved / Received / Refunded / Closed / Rejected with counts; search; reason and courier selects. Table: return (RT no., order link, age), customer, item, reason · type, status. Side panel: what's changing (exchange: sending back → wants instead with stock), why (reason + note), price difference (exchange), refund/payment link action, Return pickup = free-text tracking on approve, Check when it arrives (3 checkboxes) + Put back in stock toggle per line, Timeline; actions Reject / Approve (exchange: "Approve exchange" then "Create exchange order") / Mark received / Refund / Close. "+ Create return" from a delivered order detail | Customer photo, "Booked automatically after you approve" (courier return pickup), Return policy button |
| Invoices & labels `/orders/print` | `39:10790` | Ready to print list (tabs Not printed / Printed today from `filter[not_printed]`/`filter[printed]`, select all with COD sum, product thumbs, courier icon); Template cards (A4 invoice, Thermal receipt, Courier label 4×6, A5 two-up, Packing slip); Live preview (`documents/preview` HTML in a sandboxed `iframe srcdoc` with `sandbox=""`, pager Label 1 of N); Print settings (Show shop logo, Show BIN/VAT number, Show product names, Language English/বাংলা, paper size read-only per kind); **Print N** (creates the document, opens the PDF in a new tab when ready) and **Download PDF** | Printer select (browser print dialog instead), Edit templates link (settings toggles cover it) |
| Settings → Payments & checkout `/settings/payments` | `60:14865` | Checkout payment methods: Cash on delivery toggle; **Advance delivery charge** toggle (= `cod_advance`), enabled only when a gateway is connected; **Full online payment** = enabled gateways (toggle per gateway via `PATCH enabled`); info "Paid orders move to Confirmed on their own…". Connected gateways list (status, mode, default) + "Manage in Integrations" | 2 % online discount, Advance payment rules list, "Send payment link by WhatsApp", Order form fields, Phone verification (OTP), settlement text ("settles T+1 to …") |
| Settings → Taxes & invoices `/settings/invoices` | `60:16858` | 5a prefix + VAT display (None / Prices include VAT) with rate %, BIN, invoice footer text | VAT added on top |
| Onboarding 06 `/onboarding/delivery` | `50:604`; card `45:8086` (component: Connect / Connected states) | Steadfast/Pathao/RedX cards become real: Connect opens the courier connect dialog (credentials fields + Test); Connected state with ✓ badge. "Connect later" unchanged | Card copy "COD settled in 48 h" kept as static marketing text only if PO agrees; default: replaced by "Book parcels and track them here" |
| Onboarding 07 `/onboarding/payments` | `52:564` | "Collect delivery charge in advance" toggle enabled once a gateway is connected; bKash and SSLCommerz Connect open the gateway dialog (32:3770); checkout preview shows connected methods | EPS card hidden |
| Dashboard `/` | `10:600` | "Needs you today" gains: Book N parcels (confirmed/ready without shipment), N delivery problems, N unpaid online orders expiring; Orders waiting gains "Awaiting payment" | Courier performance `10:1061`, Money flow `10:1085` |
| Mobile | Orders `31:4886`, Order detail `32:309` | Order detail shows courier/payment cards stacked; Shipments/Returns pages responsive at 390 px (table → cards) | Mobile-specific frames for shipments/returns don't exist: reuse OrderCard pattern `30:3171` |

Sidebar: Orders children gain **Returns**, **Shipments**, **Invoices & labels** (visible; Unfinished orders and Fake
order guard stay hidden). **Integrations** becomes a top-level item. Settings → Payments & checkout and Taxes &
invoices gain the new sections. Client rules as 5a §9.1; new query keys `[…, 'payment-gateways']`, `[…, 'couriers']`,
`[…, 'shipments', filters]`, `[…, 'shipment', id]`, `[…, 'returns', filters]`, `[…, 'return', id]`,
`[…, 'document', id]`. A shipment or payment mutation invalidates the order, orders list, shipments, dashboard.

---

## 11. Storefront (owner SF)

| Route | Figma | Build |
|---|---|---|
| `/checkout` (extended) | `1:11591`, mobile `1:11690` | Payment section: Cash on delivery; bKash ("Pay now from your bKash app", logo); "Card or mobile banking" (SSLCommerz). With `cod_advance = delivery_charge`: COD option text "Pay the ৳ 70 delivery charge now, the rest on delivery" with a gateway choice. **Place order** → Server Action → for online: set `sp_order`, `redirect(payment.redirect_url)`; `initiation_failed` → thank-you with Retry |
| `/checkout/payment-result` (new, no-store) | reuse thank-you `1:11788` | `?payment=` → with `sp_order`: `GET /storefront/orders/confirmation` → paid → thank-you ("Paid ৳ N with bKash"; "Pay ৳ due in cash when it arrives" when partly paid); pending → spinner page polling `/api/payment-status?payment=` (route handler, GET) every 2 s up to 30 s; failed/cancelled → "Payment didn't go through" + Try again (`payOrder` action) + "Pay on delivery instead" when `can_switch_to_cod`; hold countdown. Without `sp_order` → minimal `StorefrontPaymentResult` card |
| `/checkout/thank-you` | `1:11788` | Shows payment status line; unpaid `pending_payment` → Retry / switch to COD buttons |
| `/pay/[token]` (new, no-store, `noindex`) | Figma pay page doesn't exist: compose from thank-you/checkout components | Shop header, "Pay ৳ 130 to confirm order GS-1041", expiry, gateway button (`payLink` action → redirect). Invalid → "This payment link isn't valid any more" |
| `/track` | `1:11959` | Shipment block gains courier status and tracking link (courier events: status + time only, no rider data) |

Rules: Server Actions `payOrder`, `payLink`; route handler `/api/payment-status` (GET only); all forward
`X-Storefront-Client-Ip`; robots `Disallow: /pay`; CSP: no change needed (redirects, no gateway SDK); if a
`form-action` directive is added later it must include the gateway hosts. `sp_order` cookie unchanged.
Zod schemas for every new response.

---

## 12. Security checklist (5b; numbering continues 5a S1–S18; each item has a test in §13)

| # | Threat | Control | Test |
|---|---|---|---|
| S19 | **Cross-tenant read/write below the app layer** (T1) | RLS forced on every tenant table; app role without BYPASSRLS | `RlsRawSqlTest` (GUC A sees only A; unset sees nothing; cross-tenant insert 42501; update/delete 0 rows) |
| S20 | **Silent RLS gaps** | `RlsTables::TENANT` coverage test vs catalog; arch tests on `withoutTenancy` / `pgsql_admin` call sites; boot check on DB role | `RlsCoverageTest`; arch tests; role check fails when app connects as owner |
| S21 | **GUC leaks across jobs/requests** (T19) | Reset at request/job start and end; restore in `run()`; switch-in-transaction guard | Worker runs job(A) then job(B): B sees no A rows; request after exception starts clean |
| S22 | **Payment redirect forgery** (T5) | Paid only after Execute/Query/Validation; return query params ignored for status | `PaymentRedirectForgery`: `status=success` with provider `Initiated`/`FAILED` → order stays `pending_payment`, payment `pending`/`failed` |
| S23 | **Amount / currency / reference mismatch** (T5) | Exact paisa compare via `Money::fromDecimal`, `BDT`, reference = payment id | `PaymentAmountMismatch`: provider amount 1 paisa off, `USD`, other invoice number → `failed` + audit; order untouched |
| S24 | **Webhook replay and races** (T5) | `U(tenant_id, provider, event_id)`, conditional `pending` updates, order lock, `U(store_id, provider, provider_trx_id)` | `WebhookReplay`: same IPN twice → one effect; IPN + return concurrently (Postgres fork) → one `succeeded`, `paid_amount` once; one trxId on two payments → second rejected |
| S25 | **Forged webhooks** | Route key lookup, bearer/secret `hash_equals`, SSLCommerz Validation API, SNS signature (when enabled) | `WebhookSignatureInvalid`: wrong bearer → 401 nothing stored; unknown key → 404; forged IPN with valid `verify_sign` but validation `INVALID_TRANSACTION` → unpaid |
| S26 | **Credential leakage** (T15) | Dedicated encrypter, never in resources/logs/`raw`/`webhook_events`; `PayloadScrubber`; hints only; audit without values | Resource key-set tests; DB column not plaintext; log scan after connect + payment has no secret, token, `id_token` |
| S27 | **SSRF via integrations** (T14) | Provider base URLs from config by mode; `SafeHttpClient`; SNS `SubscribeURL` host allowlist; Gotenberg internal and network-less | Credential/settings inputs can't change hosts (no such field); SNS URL `http://169.254.169.254` refused |
| S28 | **Payment link enumeration** | 71-bit token, sha256 lookup, identical 404 for unknown/expired/paid, `pay-link` throttle, `noindex` | Byte-identical 404s; 21st request/min → 429; DB has no raw token |
| S29 | **Open redirect / tampering on returns** | Signed return URLs; redirect only to the store's primary host from the DB | Unsigned/expired → 403 page, no redirect; extra `?next=` ignored |
| S30 | **Refund abuse** (T10) | O A only; ≤ refundable per charge and order; Idempotency-Key; provider `maxRefundableAmount`; refund applied only on provider success | Staff → 403; over-refund → 422; replay → same refund; provider reject → 422 and amounts unchanged |
| S31 | **Late payment double effects** | Never revive cancelled orders; automatic refund once | Payment verified after expiry → order stays cancelled, one refund row, one email |
| S32 | **Courier status spoofing** | Secrets per account; money-relevant statuses re-queried from the courier API; shipment looked up by consignment **within** the resolved tenant | Webhook "delivered" while the API says `in_review` → no order change; Steadfast webhook for B's consignment on A's route key → ignored |
| S33 | **COD under-collection** | COD = due by default; override O A only, ≤ total, audited | Staff `cod_amount` → 403; owner override audited |
| S34 | **PDF/HTML injection** (T8) | Blade escaping, plain-text fields, preview iframe `sandbox=""`, Chromium JS off, no network | Product name `<img src=http://…>` renders as text; Gotenberg request contains no remote URLs |
| S35 | **Document access** (T25) | Private disk, signed 5-min URL bound to tenant, policy check on `GET documents/{id}`, 24 h expiry | Foreign tenant id → 404; expired URL → 403/404; file deleted after prune |
| S36 | **Edit-items and return stock/price integrity** (T6/T7) | One pricing path, lock order, revision, total ≥ paid | Concurrent edit + checkout on the last unit (Postgres) → no oversell; stale revision → 409; tampered `unit_price_amount` ignored |
| S37 | **Storefront budget exhaustion by one client** (T16) | Per-IP + per-host `storefront` limits | §2.10 tests |
| S38 | **Privilege on integrations** (T10) | `ManageIntegrations` O A; staff read-only; disconnect guards | Staff connect/rotate/disconnect → 403; staff GET shows no secrets |
| S39 | **Mass assignment on new inputs** | DTO mapping; `status`, `amount` of payments/links, `consignment_id`, `cod_collected_amount`, `refunded_amount`, `route_key` never writable | `MassAssignment` probes on checkout (online), link create, booking, edit items, return create |

SECURITY.md follow-ups (ARCH, after acceptance): T5 points to S22–S25/S30–S31; T1 adds RLS done (S19–S21); new
**T28 "Integration credential and webhook abuse"** (S25–S27, S32, S38) and **T29 "Document generation"** (S34–S35).

---

## 13. Test requirements

### API (Pest; groups as noted; `rls`, `perf`, `race` run on Postgres in CI)
- **RLS (5b-1):** §2.6 in full (`rls`, `tenancy`); storefront limiter §2.10 (`security`).
- **Gateways:** connect with fake + `Http::fake` fixtures for both providers (valid, invalid credentials, timeout);
  hint masking; enable rules; disconnect busy; test payment; staff 403 (`security`).
- **bKash driver:** grant caching (one grant for N payments), refresh, 2-calls/hour guard; create → execute →
  completed; execute timeout → query → completed; status `Initiated` after callback `cancel` → cancelled; refund full,
  partial, over `maxRefundableAmount` → rejected; refund timeout → refund status.
- **SSLCommerz driver:** session fields (no PII beyond the listed fields), IPN `verify_sign` pre-filter, Validation API
  VALID/VALIDATED/INVALID, risk tagging, query by tran_id, refund success/processing/failed.
- **Checkout online:** `pending_payment` + hold + commit; initiation failure → `initiation_failed` with the order
  kept; return success → confirmed, SMS once; failure → retry; switch to COD; expiry job cancels and releases stock
  and coupon; late payment → auto refund (S31); advance delivery charge flow; `advance_required`.
- **Security group:** S22–S26, S28–S30, S33, S38, S39; replay/races S24 (Postgres `race`).
- **Payment links:** create per amount kind, bounds, one active, expiry with/without cancel, resend throttle, paid →
  `partially_paid` + confirmed, token stored hashed + encrypted, SMS template ≤ 3 UCS-2 segments.
- **Refunds:** gateway partial/full, manual unchanged, return-linked refunds, cancel with `refund_to_gateway`.
- **Couriers (per driver with fixtures):** connect/verify, plan limit, booking happy path, courier rejection, timeout
  → reconcile by invoice, idempotent booking, bulk (500 Steadfast chunk, skipped `area_unmapped`), webhook auth and
  dedupe, mapping table per provider (data-driven test over every raw status), order effects (shipped with ledger,
  delivered with COD collected, returned without restock, partially delivered creates a return), poll job, cancel
  unsupported, area mapping remembered, S32, S33.
- **Documents:** template config validation; HTML snapshots per kind × language (`html` driver); signed download;
  prune; printed flags; S34, S35; `api-documents` CI job with a real Gotenberg (Bangla font embedded, text
  round-trip, 100 labels < 20 s).
- **Order changes:** edit items (add, remove, qty up/down, coupon kept/removed, shipping recalculated/overridden,
  `total_below_paid`, booked → 409, revision); concurrent edit vs checkout (Postgres `race`); restock after courier
  return; returns state machine matrix; receive restock ledger; exchange order (credit, difference link, negative
  difference staff 403); return quantity bounds.
- **tenancy group:** `assertTenantIsolation` + `assertStoreIsolation` for every new model; webhook route key of store A
  can't touch B; payment return for B's payment id with A's signature → 403.
- **perf:** checkout (online, fake gateway) p95 < 300 ms excluding the gateway call; shipments list with 10 000 rows
  < 200 ms p95; RLS on.

### Storefront (Vitest)
Zod schemas for new responses; `placeOrder` redirect for online methods and `initiation_failed`; payment-result
states (succeeded, pending polling stop at 30 s, failed with retry/COD switch); `/pay/[token]` valid/invalid;
`/api/payment-status` rejects non-GET; client IP forwarded on every no-store call.

### Dashboard (Vitest + Testing Library)
Connect dialogs (fields per provider, secrets never re-rendered, steps); courier settings; booking dialog (area selects
for Pathao/RedX, COD field hidden for staff); shipments table/filters/KPIs; ask-for-advance amounts (25 % of due,
delivery charge, custom bounds); edit items quote debounce and read-only when booked; returns panel transitions;
print page selection and preview iframe sandbox; staff hides integration writes and refunds.

### QA (Playwright, `tests/e2e/specs/phase5b.*.spec.ts`, fake drivers unless a sandbox run is requested)
- **rls:** the Phase 5a security spec re-run against an API with `TENANCY_RLS=true`.
- **online-checkout:** COD vs bKash (fake page Pay) → thank-you "Paid"; Fail → retry → Pay; switch to COD; expiry
  (time-travel endpoint in testing only) releases stock.
- **payment-link:** merchant sends advance link → shopper pays on `/pay/{token}` → order confirmed, due reduced.
- **refund:** gateway partial refund from order detail.
- **couriers:** connect fake Steadfast → book → webhook (signed test call) → shipped → delivered; Shipments page KPIs;
  bulk book 3 orders.
- **documents:** print 2 labels (html driver in e2e) → printed tab.
- **edit-and-return:** edit items on a confirmed order; deliver; create exchange; receive; exchange order with link.
- **mobile:** shipments, returns, payment result at 390 px.
- **sandbox certification (manual dispatch only, never in CI):** `phase5b.sandbox.spec.ts` per provider with real
  sandbox credentials from the environment and the public tunnel URL; records fixtures for CI.

---

## 14. Figma features deferred (record, don't build)

| Area | Deferred (frame) | Where it goes |
|---|---|---|
| Payments | Nagad, EPS, aamarPay, PayStation cards (14:980, 52:564 EPS); 2 % online discount, advance payment rules engine, WhatsApp link delivery, order form fields, checkout OTP (60:14865); settlement schedule text | Later 5.x drivers; Phase 8 (rules, OTP) |
| Couriers | Paperfly, CarryBee (14:980); Booking rules "Book automatically", "Print label after booking" (22:1181, 29:1814, Q62); Fraud check tab (29:2562) and risk badges; COD & payouts tab, payout import, Reconcile, charge audit (31:2231); Activity log (31:3581); Connection health; "Send test event"; Reschedule, Call rider, rider card, Ask to hold, Change address or COD (146:33100); Request return (39:10347) | Phase 7 (payouts), Phase 8 (automation, fraud, Q23) |
| Orders | Risk banner, Delivery record (33:3676, Q23); Edit items after booking / courier COD update (144:46654, Q56); Scan barcode; Unfinished orders (39:9461); Fake order guard (39:11233) | Phase 8 |
| Returns | Shopper-initiated returns with photos (146:32329, Q57); courier return pickup booking; Return policy editor | Phase 8 |
| Documents | Printer selection; Edit templates (free layout); VAT on top (60:16858, Q52) | Later |
| Integrations | Marketing & tracking, Messaging (masked SMS sender), AI, Developer API keys/webhooks (14:980, 144:40725) | Phase 7/8 |
| Dashboard | Courier performance (10:1061), Money flow (10:1085) | Phase 7.4 |

---

## 15. Configuration and fake drivers

| Key | Where | Notes |
|---|---|---|
| `TENANCY_RLS`, `DB_OWNER_USERNAME/PASSWORD`, `DB_ADMIN_USERNAME/PASSWORD` | env | §2.2 |
| `INTEGRATION_CREDENTIALS_KEY`, `INTEGRATION_CREDENTIALS_PREVIOUS_KEYS` | env (secret manager in prod) | 32-byte base64; rotation re-encrypts via `integrations:rotate-key` |
| `PAYMENTS_FAKE` | env | `true` in local/testing/e2e; boot refuses in production |
| `BKASH_SANDBOX_BASE_URL` (default `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout`), `BKASH_LIVE_BASE_URL` (no default; live mode disabled until set) | config `payments.php` | |
| `SSLCOMMERZ_SANDBOX_BASE_URL` (`https://sandbox.sslcommerz.com`), `SSLCOMMERZ_LIVE_BASE_URL` (`https://securepay.sslcommerz.com`) | config | |
| `PAYMENT_HOLD_MINUTES` (30), `PAYMENT_LINK_DEFAULT_MINUTES` (120) | config | Q35 |
| `COURIERS_FAKE` | env | binds `FakeCourier` for all three; `php artisan couriers:fake-advance {shipment} {status}` and a testing-only endpoint move fake parcels |
| `STEADFAST_BASE_URL` (`https://portal.packzy.com/api/v1`), `PATHAO_SANDBOX_BASE_URL` (`https://courier-api-sandbox.pathao.com`), `PATHAO_LIVE_BASE_URL` (`https://api-hermes.pathao.com`), `REDX_SANDBOX_BASE_URL` (`https://sandbox.redx.com.bd/v1.0.0-beta`), `REDX_LIVE_BASE_URL` (`https://openapi.redx.com.bd/v1.0.0-beta`) | config `couriers.php` | |
| `COURIER_SYNC_MINUTES` (15), `COURIER_SYNC_BATCH` (100) | config | |
| `PUBLIC_API_URL` | env | Base for signed return URLs and webhook URLs shown to merchants (the tunnel URL in sandbox work) |
| `DOCUMENTS_DRIVER` (`gotenberg` \| `html`), `GOTENBERG_URL` (`http://gotenberg:3000`), `GOTENBERG_USERNAME`, `GOTENBERG_PASSWORD`, `GOTENBERG_TIMEOUT` (30) | env | |
| `THROTTLE_STOREFRONT_PER_IP` (300), `THROTTLE_STOREFRONT_PER_HOST` (3000) | env | §2.10 |
| Per-store encrypted settings | `payment_gateway_accounts.credentials`, `courier_accounts.credentials`, `courier_accounts.webhook_secret_*` | never in env |

Fixtures: `tests/Fixtures/payments/{bkash,sslcommerz}/*.json` and `tests/Fixtures/couriers/{steadfast,pathao,redx}/*.json`,
built from the public docs now (marked `"_source": "docs"`) and replaced by sandbox recordings (`"_source":
"sandbox-YYYY-MM-DD"`) during certification. CI never calls a real provider.

---

## 16. Credentials and accounts the PO must provide

| For | What | Where to get it | Blocks |
|---|---|---|---|
| bKash sandbox | `app_key`, `app_secret`, `username`, `password` (Tokenized Checkout), and the **live base URL** | bKash PGW integration team via the bKash merchant/developer support (developer.bka.sh does not self-issue credentials) | 5b-2 certification of bKash |
| bKash IPN (optional) | registration of `https://{PUBLIC_API_URL}/api/v1/webhooks/bkash/{route_key}` | bKash technical support | nothing (polling is the fallback) |
| SSLCommerz sandbox | `store_id`, `store_passwd` | self-serve at https://developer.sslcommerz.com/registration/ | 5b-2 certification of SSLCommerz |
| SSLCommerz live refunds | the platform's public egress IP registered | SSLCommerz merchant support (per merchant account; documented in the merchant setup guide) | live gateway refunds |
| Steadfast | a merchant account with API access: `Api-Key`, `Secret-Key`; permission to create and cancel test parcels | Steadfast merchant panel (portal.packzy.com → API settings); no sandbox is documented | 5b-3 Steadfast certification |
| Pathao | sandbox `client_id`, `client_secret`, `username`, `password` (shown in the panel); a test store id | merchant.pathao.com → Developer API (needs a Pathao merchant login) | Pathao driver |
| RedX | sandbox and live API access token; the developer docs | RedX merchant panel / redx.com.bd/developer-api (request access) | RedX driver |
| Public HTTPS URL | a tunnel (e.g. `cloudflared tunnel`) for sandbox callbacks/webhooks, or a staging API host | platform | sandbox runs only |
| PO answers | Q45–Q63 (defaults in effect) | — | none (defaults) |

---

## 17. Infrastructure prerequisites

1. **Postgres for every API agent** (Docker Desktop running): `docker compose up -d postgres redis`; role init script
   `infrastructure/docker/postgres/initdb/01-roles.sql` (QA owns compose). Not the Homebrew Postgres.
2. **Gotenberg** service in compose: `gotenberg/gotenberg:<exact 9.x tag ≥ 14 days old>`, internal network only, no
   published port in production, basic auth env, healthcheck `GET /health`, memory limit 1 GB; queue worker
   `queue-documents` (`--queue=documents --tries=2 --timeout=150`). Production: one Gotenberg per API node pool.
3. **Queue workers:** add `webhooks` (`--tries=5 --backoff=10,60,300`) and `documents`; `bulk` handles shipment
   batches; scheduler runs the §3 commands.
4. **Public callback URL** for sandbox work (tunnel) → `PUBLIC_API_URL`.
5. **Production DB:** create the three roles (runbook), switch the app user, keep PgBouncer off or in session mode.
6. **Egress IP** stable for SSLCommerz live refunds.
7. **CI:** new jobs `api-rls` and `api-documents` (Gotenberg service); `e2e.yml` gains the fake-driver env.

---

## 18. File ownership for Phase 5b

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: RLS (migration, `RlsTables`, definer functions, `PlatformDb`, GUC middleware/listeners, boot check, `withoutTenancy` reroute, fixture helpers, `database/sql/rls-emergency-off.sql`); storefront limiter; migrations §3; models; `Integrations/{Payments,Couriers}`; `Domain/Payments`, `Domain/Couriers`, `Domain/Webhooks`, `Domain/Documents`, `Domain/Returns`; `Domain/Orders` changes (state machine, edit items, restock, refunds, cancel); `Domain/Stores` settings additions; `Permission::ManageIntegrations`; SMS templates `payment_link`, `order_updated`; Blade document views, fonts (`resources/fonts`, with OFL licence files), lang `bn/documents.php`; schedules; DemoSeeder (fake gateway + fake courier accounts, 2 online orders, 2 shipments, 1 return; idempotent) |
| **WEB** | `apps/merchant-dashboard/**` (§10), `packages/api-client/**` (gateways, couriers, shipments, documents, returns, payment links, edit items), `packages/ui/**` (Stepper, ProviderLogo, StatusBadge variants for shipments/returns/payments, CopyField, SecretField, KPI tiles reuse) |
| **SF** | `apps/storefront/**` (§11) |
| **QA** | `tests/e2e/**`, `.github/**` (`api-rls`, `api-documents`), `docker-compose.yml` (gotenberg, workers, initdb mount), `infrastructure/docker/postgres/initdb/01-roles.sql`, `docs/development/TESTING.md`, `docs/reviews/phase-5b-*-qa.md` |
| **Orchestrator** | `packages/types/src/index.ts` (§9) |
| **ARCH** | Done with this contract: this file, `docs/api/openapi.yaml` (1.6.0), ADR 0012/0013/0014, ADR 0007/0011 amendments, OPEN-QUESTIONS Q45–Q63. Follow-ups after acceptance: API-CONVENTIONS (§4.0 codes, limiter values, webhook paths), SECURITY.md (T28, T29, T1/T5 updates), MULTI-TENANCY §9 (as built), DATABASE-DESIGN (5b tables), FIGMA-INDEX (5b frames), DEVELOPMENT-ROADMAP (5b increments), deployment runbook (roles, Gotenberg) |

---

## 19. Order of work

1. **Orchestrator** applies §9 types (additive). WEB/SF can mock against openapi 1.6.0 + MSW from day one.
2. **5b-1 (API + QA):** roles script and compose (QA) → GUC lifecycle + boot check + `withoutTenancy` reroute +
   definer functions + fixture helper (API) → policy migration → `api-rls` CI job green (tenancy, security, rls, races)
   → storefront limiter (API) + SF client-IP forwarding. **QA gate 5b-1. No 5b-2/5b-3 code merges before it.**
3. In parallel after 5b-1 (no external accounts needed): **5b-4 documents** (API renderer + `html` driver, then
   Gotenberg; WEB print page/settings) and **5b-5 order changes** (API edit items, returns, restock; WEB edit
   order, returns). QA gates 5b-4 and 5b-5.
4. **5b-2 payments:** API with fake gateway first (accounts, checkout, return/IPN, links, refunds, expiry) → WEB
   integrations/payments settings/onboarding 07/advance dialog → SF checkout/payment-result/pay page → sandbox
   certification per provider (credentials from §16) → QA gate 5b-2.
5. **5b-3 couriers:** Steadfast with fake + fixtures → shipments pages/onboarding 06 → certification → QA gate;
   then Pathao; then RedX (each its own short gate).
6. ARCH follow-ups (§18) after each gate.

---

## 20. Acceptance criteria

1. **RLS:** with `TENANCY_RLS=true` and the app connected as `storeplix_app`, the tenancy, security, rls and race
   suites pass on Postgres in CI; raw SQL as the app role can't read, insert, update or delete another tenant's rows;
   every table with `tenant_id` has a forced policy; the policy migration rolls back cleanly; checkout p95 < 300 ms
   with RLS on.
2. **Rate limit:** one shopper IP is limited at 300/min while other shoppers on the same store still get 200.
3. **Online checkout:** a shopper pays with bKash (sandbox certified, fake in CI) and with SSLCommerz; the order goes
   `pending_payment → confirmed` only after server-side verification; a forged success redirect, a wrong amount and a
   replayed IPN change nothing; an unpaid order is cancelled after 30 min and its stock released; switching to COD works.
4. **Advance:** a shop requiring the delivery charge in advance collects it at checkout; a merchant sends a payment
   link from the order, the shopper pays on `/pay/{token}`, and the order shows `partially_paid` and confirms itself;
   an unpaid link with "cancel if not paid" cancels the order at expiry.
5. **Refunds:** a full and a partial gateway refund from the order detail update `refunded_amount` only after the
   gateway confirms; manual refunds still work; staff can't refund.
6. **Couriers:** a merchant connects Steadfast (then Pathao, RedX), books one and a bulk of parcels, sees them on
   Shipments with KPIs, and courier events move orders to shipped/delivered/returned with the 5a stock rules; a forged
   or replayed webhook has no effect; the 15-minute poll recovers a missed webhook.
7. **Documents:** A4, 80 mm, A5 two-up, packing slip and 4×6 label PDFs render with correctly shaped Bangla; the
   download URL expires after 5 minutes; "Printed today" updates.
8. **Order changes:** items on a confirmed, unbooked order can be edited with correct stock and totals; a delivered
   order gets a return (restocked on receipt) and an exchange (new order with credit and a payment link).
9. Onboarding 06/07 connect cards and Integrations pages work for O A and are read-only for staff.
10. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls` + `api-documents`), the race jobs and the
    Playwright `phase5b.*` specs are green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes for 1.6.0.

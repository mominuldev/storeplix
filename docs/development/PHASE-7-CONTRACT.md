# Phase 7 contract: Monetization (binding for API, WEB, SF, QA)

Status: **Binding for Phase 7** from 2026-11-23. Branch `phase-7-monetization` (from `main` @ 1b9843f: Phase 6 merged as
PR #2, UI parity fixes as PR #3). Roadmap tasks 7.1–7.4.

Everything in AGENT-CONTRACTS.md, PHASE-2/3/4/5/5B/6-CONTRACT.md and docs/api/API-CONVENTIONS.md still applies
(envelope, snake_case, ULIDs, roles, cookie sessions, idempotency, foreign-id rules, paisa, RLS rules, fake-driver
pattern). Where this file changes an earlier rule it says **"amends …"**.
Machine-readable spec: `docs/api/openapi.yaml` **v1.8.0**. ADRs: **0008** (amended by this contract, same date), 0007
(drivers reused with platform credentials), 0012 (RLS), 0014 (PDFs). Product defaults: OPEN-QUESTIONS **Q77–Q90**
(Q77–Q89 accepted by the PO 2026-11-23; Q90 open: platform gateway accounts).

### Scope

One build cycle on fake drivers (`BILLING_FAKE`), one QA gate (`docs/reviews/phase-7-qa.md`), then a **certification
run against the platform's own bKash and SSLCommerz sandbox accounts** (§13) before the phase closes, exactly like
5b §16 and Phase 6 §13.

| Task | Owner | Ships |
|---|---|---|
| **7.1** Plan enforcement | API | One enforcement matrix (§2) covering every limit and feature that has a module; `upgrade_plan` hint on every 402; downgrade rules (nothing deleted, creates blocked, custom domains detached after a grace, resolving Q71); `PlanEnforcementTest` dataset over every gate |
| **7.2** Invoices + renewal payments | API (+ WEB pay flow) | Subscription state machine (§3), plan changes with proration, `billing_invoices` + `billing_payments`, hourly `billing:run` (trial end, renewal invoices, past_due, expiry to Free, domain enforcement), payment through **platform** bKash / SSLCommerz credentials with server-side verification, IPN, reconcile, invoice PDFs, emails, audit, ops commands |
| **7.3** Billing UI | WEB | Settings → Plan & billing (`60:16361`, **amends the roadmap's "Account 148:33261"**, see §8): plan compare with Monthly/Yearly, upgrade / downgrade / cancel with a quote, pay with bKash or card, return handling, invoice history with PDF, app-wide billing banners (`148:35383`) |
| **7.4** Reports | API / WEB | Reports → Sales overview (`60:11864`), Profit & loss (`60:12262`, Growth + owner/admin), Delivery & returns (`60:12660`); store timezone; numbers reconcile with order data |

**Storefront (SF): no Phase 7 work.** Non-payment drops a shop to the Free plan instead of locking it (P7-4, Q77), so
no shop ever becomes "temporarily unavailable" through billing; `StorefrontConfig` is unchanged. Custom-domain
detachment reuses the Phase 6 `expired` path, which the storefront already handles (unknown host → "Store not found").

**Out of scope** (hide, never fake): bKash tokenized agreements / auto-debit and a saved payment method (Figma
`65:17602`, Q83), Nagad, card-on-file; SMS credit packs and domain purchases on invoices (Figma rows "SMS credits ·
3,000", "Domain … · 1 year", Q84); credit balances, refunds of platform payments through the API (ops refunds
manually, Q89); coupons/discounts on plans; per-seat add-ons (`subscription_items` is not built); Reports → Money &
COD (`60:13058`, payout import, Q49/Q85) and Product performance (`60:13456`, Q85); ad spend and expenses (Phase 8.7);
gateway fee tracking (Q86); report CSV export; super-admin billing screens (Phase 8.1; Phase 7 gives ops artisan
commands only); multi-currency plans (BDT only); tenant hard delete after expiry (Q15, Phase 9).

### Conventions in this file
- `T` = `X-Tenant-Id`. O / A / S = owner / admin / staff. Billing reads (`subscription`, invoices, payments) need the
  existing `Permission::ViewBilling` (O A); billing writes (change plan, cancel a scheduled change, pay) need the
  existing `Permission::ManageBilling` (**O only**, Q88). Reports: Sales and Delivery `Operate` (O A S); Profit
  `ViewCosts` (O A) **and** feature `profit_reports` (Q87).
- **Foreign ids:** an `{invoice}` / `{payment}` of another tenant → 404 `not_found`. Never 403.
- **Money** is integer paisa (`*_amount`) with `currency: "BDT"`. Plan prices are whole taka; proration rounds **up to
  whole taka** (100 paisa). Never floats; rates/shares are JSON numbers 0–1 with 4 decimals, computed from integers.
- **Time:** billing instants (`current_period_end`, `due_at`, …) are UTC `timestamptz`. Report days, weeks and months
  are **store-local** in `stores.timezone` (the single store of the tenant; the field Settings edits, also used by
  `FeatureGate::monthStart`). Roadmap "tenant timezone" = this.
- "**VERIFY against sandbox**" marks a provider detail the public docs don't settle (kept in one method, resolved by
  §13). "**default accepted by PO 2026-11-23**" marks a product decision in §1.1 and OPEN-QUESTIONS Q77–Q89, all accepted 2026-11-23.

### Standing rules for every agent
- Browser checks: Playwright only (never the Claude in Chrome extension or the user's Chrome).
- Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>` or commit. Touch only owned files (§14).
- New dependencies: at least 14 days old, pinned exactly. No chart library is required (§8.3).
- Postgres (Docker, role init script) for API work; RLS on (`TENANCY_RLS=true`, app role) for billing, report and
  definer-function tests. Not the Homebrew Postgres.
- CI never calls bKash or SSLCommerz. Real calls only in the manual certification run (§13).

---

## 0. Summary and goals

1. Every plan limit and feature that has a module is enforced in exactly one place, answers 402 with the cheapest plan
   that would allow it, and is covered by one data-driven test.
2. A merchant on Free or in the Starter trial picks Starter or Growth (monthly or yearly), sees the exact amount, pays
   with bKash or card through **Storeplix's own** gateway accounts, and the plan changes only after a server-side
   verification. Upgrades mid-period charge the prorated difference; downgrades and cancellations take effect at
   period end.
3. Paid plans renew manually: an invoice 7 days before period end, reminders, `past_due` with a 7-day grace (features
   kept, banner), then the shop drops to **Free** (`expired` subscription row + new Free row). Nothing is deleted;
   things above the Free limits keep working but can't grow; custom domains beyond the plan are detached.
4. Reports show what the shop sold, kept and delivered, in the shop's timezone, and every figure reconciles with the
   orders and shipments it is built from.
5. Every external dependency is behind an interface with a fake; certification against real sandboxes is a listed
   blocker (§13).

---

## 1. Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| P7-1 | **Effective plan unchanged:** plan of the current (`trialing`, `active`, `past_due`) subscription, else `free` (`FeatureGate::plan`, 60 s cache, busted on any subscription save). `past_due` keeps the paid plan's limits and features until expiry | Grace must not break a shop that is about to pay |
| P7-2 | **One current subscription row per tenant** (existing partial unique index). It is **mutated in place** for trial end, renewals, upgrades and scheduled changes. A row is closed only at non-payment expiry (`expired`, `ended_reason: unpaid`) or when the owner cancels during `past_due` (`expired`, `ended_reason: cancelled`); in the same transaction a new `active` Free row starts. `cancelled` stays reserved for tenant closure (not used in Phase 7) | Keeps the as-built model (EndTrials mutates) while giving the roadmap's "past_due → expired" a durable record |
| P7-3 | **Plans and intervals.** `plans` gains `price_yearly_amount` (Starter ৳4,990 = `499000`, Growth ৳14,990 = `1499000`, Free null): **yearly = 10 × monthly** ("Yearly · 2 months free", Figma `65:17493`). `subscriptions.billing_interval` `month` \| `year`. Free has no yearly option (`plan_unavailable`). Default accepted by PO 2026-11-23 (Q79) | Figma shows the Monthly/Yearly chips |
| P7-4 | **Non-payment drops to Free, never locks the shop** (**amends ADR 0008** "store read-only / storefront temporarily unavailable"; default accepted by PO 2026-11-23, Q77). `past_due` lasts `BILLING_GRACE_DAYS` (7) from `current_period_end`; then the row expires and a Free row starts. The merchant dashboard and storefront keep working on Free limits. `402 subscription_inactive` stays reserved and unused | ADR 0008 predates the Free plan (Q10 amendment). Locking a shop that could legally be on Free only loses merchants |
| P7-5 | **Change kinds** (from current plan `C`/interval `Ci` to target `P`/`Pi`; plan rank = `plans.sort`): **new** = from Free or `trialing` to a paid plan; **upgrade** = paid → higher rank, or same plan `month → year`; **downgrade** = paid → lower paid rank, or `year → month`; **cancel** = paid → Free; **unchanged** → 409 `plan_unchanged`. A change of plan *and* interval is classified by rank first (Growth monthly → Starter yearly is a downgrade) | Deterministic, testable table (§3.3) |
| P7-6 | **Pricing of a change** (default accepted by PO 2026-11-23, Q78/Q80). **new:** full price of `P`/`Pi`; on payment `current_period_start = now`, `current_period_end = max(now, trial_ends_at) + Pi` (unused trial days are kept). **upgrade, same interval:** `ceil100((price(P) − price(C)) × remaining / period)` where `remaining = current_period_end − now` and `period = current_period_end − current_period_start` in seconds, `ceil100` = round up to whole taka, minimum ৳1; period dates unchanged. **upgrade with `month → year`:** `price(P, year) − floor(price(C, month) × remaining / period)` (credit floored to paisa then the total rounded up to whole taka); a new yearly period starts at payment. **downgrade / cancel:** no charge, no refund; stored as `scheduled_plan_id` / `scheduled_interval` and applied at `current_period_end`. Prices come from the `plans` row at issue time and are frozen on the invoice | ADR 0008 "upgrades charge the remaining-period difference immediately; downgrades at period end" |
| P7-7 | **One open invoice per tenant** (partial unique index). Issuing a new one voids the old open one (`void_reason: superseded`) in the same transaction, except in `past_due` where the overdue renewal invoice can only be paid or the subscription cancelled (409 `invoice_overdue`). `new`/`upgrade` invoices are voided after `BILLING_CHANGE_INVOICE_TTL_HOURS` (24, `void_reason: expired`) because their proration is time-based; renewal invoices stay open until expiry (`void_reason: unpaid`) | One thing to pay, no stale prorations, simple UI |
| P7-8 | **Renewal** (`billing:run`, §4). At `current_period_end − BILLING_RENEWAL_LEAD_DAYS` (7) a paid active subscription gets a `renewal` invoice for the **next** plan (the scheduled plan/interval if a paid downgrade is scheduled; none if the next plan is Free) with `period_start = current_period_end`, `period_end = + interval`, `due_at = current_period_end`. Paid early → the period is extended from `current_period_end` (no lost days). Unpaid at `current_period_end` → `past_due` (`past_due_at`, `grace_ends_at = current_period_end + 7 d`), the paid plan stays effective; paid during grace → `active`, the new period still starts at the old `current_period_end` | ADR 0008 manual-renewal model |
| P7-9 | **Paid means verified** (CLAUDE.md rule 8, ADR 0007). An invoice is `paid` only when a provider server-side answer (bKash Execute/Query Payment; SSLCommerz Validation API) says completed **and** amount = invoice `total_amount` (exact paisa) **and** currency `BDT` **and** reference (`merchantInvoiceNumber` / `tran_id`) = our `billing_payments.id`. Browser returns and IPNs only trigger that check. Every transition is a conditional update (`WHERE status = 'pending'`, `WHERE status = 'open'`) under `Cache::lock("billing:tenant:{tenant}", 30)`; duplicates are no-ops | Same guarantees as 5b payments |
| P7-10 | **Platform credentials, same provider protocol code.** Billing charges use **Storeplix's** merchant accounts from env/secret manager (`BILLING_BKASH_*`, `BILLING_SSLCOMMERZ_*`, §12), never a merchant's `payment_gateway_accounts`, and vice versa. API refactors the 5b drivers, **behaviour-preserving**, into provider protocol classes (`BkashClient`, `SslCommerzClient`: credentials value object + charge request DTO + token store) used by the existing merchant adapters (`BkashGateway`, `SslCommerzGateway`, interface unchanged, all 5b tests and fixtures green without edits) and by new billing adapters (`Billing\Gateways\BillingGateway`: `initiate`, `complete`, `query`). The bKash grant token for the platform account is cached in the **global** cache (`billing:bkash:token:{fingerprint}`, lock-protected), not `TenantCache`, so the 2-calls/hour grant limit is shared correctly across tenants | One implementation of each provider protocol; platform token not multiplied per tenant |
| P7-11 | **Charge request fields.** bKash: `payerReference` = owner's phone (else `01000000000`), `merchantInvoiceNumber` = billing payment id, `intent: sale`. SSLCommerz: `tran_id` = billing payment id, `product_name` = "Storeplix {Plan} plan ({interval})", `product_category: "saas"`, `product_profile: "non-physical-goods"`, `shipping_method: "NO"` (**VERIFY** accepted values), `cus_name`/`cus_email`/`cus_phone` from the owner, `cus_add1`/`cus_city` from the store's business address (fallback "Dhaka"), `value_a` = invoice number. No other PII | Minimal data to the provider |
| P7-12 | **Returns and IPN.** Return URL: signed (26 h) `GET\|POST /api/v1/billing/payments/return/{provider}/{payment}` (prefix `PUBLIC_API_URL`, first-signature rule as `PaymentUrls`), tenant from `sp_billing_payment_owner()` (B22). After the check the browser is redirected **only** to `{MERCHANT_APP_URL}/settings/plan?payment={id}` (config, never from the request). SSLCommerz IPN: one platform URL `POST /api/v1/billing/webhooks/sslcommerz` registered in the platform SSLCommerz panel; `verify_sign` with the platform `store_passwd`, `tran_id` → `sp_billing_payment_owner()` (B23), then the Validation API decides; unknown or malformed → 200 `{data:{received:true}}` (identical body, nothing stored). bKash has no usable IPN (5b): `billing:reconcile-payments` every 5 min queries `pending` payments older than 2 min | Same pattern as 5b-2, single platform account |
| P7-13 | **Payment lifecycle** `pending → succeeded \| failed \| cancelled`; `pending` expires after `BILLING_PAYMENT_HOLD_MINUTES` (30): the reconciler queries once more, then `cancelled` (`failure_code: expired`). A late provider success always wins (money was taken): it moves `failed`/`cancelled → succeeded` once. Several pending payments for one invoice are allowed (shopper switched provider); the first verified success pays the invoice | No lost money, no double plan change |
| P7-14 | **Late and duplicate payments** (default accepted by PO 2026-11-23, Q89). A verified success for an invoice that is already `paid` → payment `succeeded` with `is_duplicate = true`, audit `billing.payment_duplicate`, ops alert mail to `BILLING_OPS_EMAIL`; ops refunds it in the provider panel (no API refund, no credit balance). A verified success for an invoice voided `unpaid`/`expired`/`superseded` → the invoice goes `void → paid` (`paid_late = true`) and is applied as a **new** term starting now (P7-6 "new" rule with the invoice's plan and interval; the price on the invoice stands) — unless another invoice was paid since, then it is a duplicate | Money taken must turn into service or an explicit refund |
| P7-15 | **Invoices** (`billing_invoices`, §5.1). Global gapless number `SP-{YYYY}-{NNNNNN}` (year of issue, per-year counter row in `platform_counters`, locked `FOR UPDATE` in the issuing transaction). Prices are **VAT-inclusive** at `BILLING_VAT_RATE_BPS` (1500): `tax_amount = floor(total × rate / (10 000 + rate))`, `subtotal = total − tax` (same formula as Q52), Storeplix BIN from `BILLING_VAT_BIN` printed on the PDF (default accepted by PO 2026-11-23, Q82). `bill_to` is snapshotted at issue from the store (name, business address, contact email/phone); "Edit billing details" links to Settings → Store details. Invoices are immutable after issue except status fields. PDF through the 5b-4 renderer (ADR 0014), A4, English, generated on demand and cached on the private disk under the tenant prefix once `paid` or `void` | Accountable numbering; reuses the Gotenberg pipeline |
| P7-16 | **Downgrade effects** (resolves Q71; default accepted by PO 2026-11-23, Q81). When the effective plan drops (trial end, scheduled downgrade/cancel applied, non-payment expiry): **nothing is deleted, hidden or disabled**; every create that would exceed the new limit is refused with 402 (§2); staff above `staff_seats` keep access (no new invites); courier connections above the limit keep working; products above the limit keep selling. **Custom domains:** if `custom_domains` usage > allowed (allowed = 0 without feature `custom_domain`), `subscriptions.domain_grace_ends_at` = now + `BILLING_DOMAIN_GRACE_DAYS` (7), or **now** when the drop is a non-payment expiry (the 7-day `past_due` grace already warned, Figma banner "Fix it by 25 Nov to keep custom domain"). At `domain_grace_ends_at`, `billing:run` moves the excess custom rows to `expired` with the new failure code `plan_limit` (§2.3); upgrading before then clears the grace | Turning a live domain off without warning is drastic; keeping it forever kills the upgrade lever |
| P7-17 | **`upgrade_plan` hint on every 402.** `PlanLimitReached` and `FeatureNotInPlan` add `details.upgrade_plan: ["<code>"]` = the cheapest active plan (by `sort`) whose limit is null or ≥ usage + adding, or that includes the feature; omitted when no plan qualifies (additive; existing `details.<limit>` / `details.feature` stay) | ADR 0008 "402 with upgrade hint"; the WEB dialog says "Upgrade to Growth" instead of always Starter |
| P7-18 | **Reports are live aggregates** over orders, order items, shipments and return requests of the store, in the store timezone, cached per tenant 120 s (`TenantCache` key `reports:{type}:{sha1(from,to)}`); `meta.generated_at` says when. Range `from`/`to` local dates inclusive, max 366 days, default = 1st of the current local month → today; `previous` = the equal-length period immediately before. Definitions §6.4 (default accepted by PO 2026-11-23, Q86) | Small shops, simple SQL; caching only smooths repeated tab switches |
| P7-19 | **Report access** (default accepted by PO 2026-11-23, Q87). Sales overview and Delivery & returns: every role (`Operate`) on every plan (Figma Free card "Basic reports"). Profit & loss: `ViewCosts` (O A) → staff 403, **and** feature `profit_reports` (Growth) → 402 `feature_not_in_plan` | Cost data is owner/admin (Q21); "Profit & ad-spend reports" is a Growth line in Figma `65:17593` |
| P7-20 | **Fake drivers for everything** (mirrors P5B-29, P6-13). `BILLING_FAKE=true` binds `FakeBillingGateway` for both providers (hosted fake page `/api/v1/dev/fake-billing-gateway/{payment}`, signed, buttons **Pay**, **Pay wrong amount** (reports +1 paisa), **Fail**, **Cancel**, **Pay, then time out** (complete throws `provider_unavailable`, a later query reports success)); testing-only `/dev/billing/*` endpoints move the clock of the current tenant's subscription (§4.6). The API **refuses to boot** with `BILLING_FAKE=true` and `APP_ENV=production`. Empty platform credentials don't block boot; that provider is simply not offered (`meta.providers`) and `pay` answers 422 `billing_gateway_unavailable` | CI and e2e run the whole lifecycle with no gateway account |
| P7-21 | **Emails** (owner only, Q88; queued, existing mail layout, `billing` mail tag): trial ends in 3 days; invoice issued (renewal, T−7) with pay link to the dashboard; reminders T−3 and T−1; payment received (receipt + PDF link); subscription `past_due` (day 0); grace ends in 2 days; dropped to Free; custom domain will be detached on {date}; custom domain detached. Sent once each (`billing_invoices.reminders` / `subscriptions.notices` jsonb keys) | Manual renewals need reminders (ADR 0008) |
| P7-22 | **Audit** (`audit_logs`, existing writer; system actor for jobs): `subscription.trial_ended` (exists), `subscription.plan_changed` (`{from, to, interval, kind}`), `subscription.change_scheduled`, `subscription.change_cancelled`, `subscription.renewed`, `subscription.past_due`, `subscription.expired` (`{reason}`), `billing.invoice_issued`, `billing.invoice_paid` (`{late}`), `billing.invoice_voided` (`{reason}`), `billing.payment_initiated`, `billing.payment_succeeded`, `billing.payment_failed`, `billing.payment_duplicate`, `billing.manual_payment` (ops), `billing.period_extended` (ops), `domain.status_changed` with `failure_code: plan_limit` | Billing and plan changes are security- and money-relevant |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q77–Q90; defaults in effect until answered)

| # | Question | Default |
|---|---|---|
| Q77 | Unpaid renewal after the grace | Drop to Free (subscription `expired` + new Free row); dashboard and storefront keep working; amends ADR 0008's read-only / "temporarily unavailable" |
| Q78 | Paying during the 14-day trial | Unused trial days are added to the first paid period |
| Q79 | Yearly billing | Yearly = 10 × monthly; `month → year` is an immediate upgrade with a credit for the unused month; `year → month` at renewal |
| Q80 | Proration | Upgrades charge the remaining-period difference rounded up to whole taka; downgrades and cancellations at period end; no refunds or credits |
| Q81 | Effects of a downgrade (resolves Q71) | Nothing deleted or hidden; creates above the limit get 402; extra staff keep access; custom domains above the plan are detached 7 days after the drop (immediately after a non-payment expiry) |
| Q82 | VAT and invoice numbering on Storeplix invoices | Prices include 15 % VAT; VAT shown on the invoice with Storeplix's BIN; numbers `SP-YYYY-NNNNNN`, gapless per year; bill-to from Store details. Needs the company's accountant |
| Q83 | Auto-debit (bKash tokenized agreement) and a saved payment method (Figma `65:17602`) | Not in Phase 7; every invoice is paid by hand with bKash or card (SSLCommerz); the card shows the accepted methods only |
| Q84 | SMS credit packs (Q33 said Phase 7) and domain purchases as invoice lines | Deferred (Phase 8); the invoice `kind` enum is designed to add `sms_credits` later |
| Q85 | Reports scope | Sales overview, Profit & loss, Delivery & returns in Phase 7; Money & COD (needs courier payout import, Q49) and Product performance in Phase 8 |
| Q86 | Report definitions | Sales = shipped + delivered orders placed in the range, net of refunds; Profit on delivered orders by delivery date; gateway fees "not tracked" and ad spend empty until Expenses (8.7); ISO weeks; weekend = Friday + Saturday; "Inside Dhaka" = Dhaka district |
| Q87 | Who sees which report | Sales and Delivery: all roles, all plans; Profit: owner/admin on Growth |
| Q88 | Billing roles and emails | Only the owner changes the plan or pays; admins see plan and invoices; billing emails go to the owner only |
| Q89 | Late and duplicate platform payments | A late payment reactivates the plan from the payment date; a duplicate is refunded by ops in the provider panel within 7 days; no credit balance |
| Q90 | Platform gateway accounts (refines Q5) | Storeplix's own bKash PGW and SSLCommerz merchant accounts (company KYC) with sandbox credentials for certification; built on fakes until provided |

---

## 2. Plan enforcement (7.1, owner API)

### 2.1 Enforcement matrix (as built + Phase 7 additions; one row = one test case in `PlanEnforcementTest`)

| Key | Kind | Free / Starter / Growth | Enforced at | Answer | Since |
|---|---|---|---|---|---|
| `products` | limit | 100 / 1000 / ∞ | product create, duplicate (`ProductService`, under the store lock); import run (remaining room) and each import create | 402 `plan_limit_reached` `details.products` | P4-21 |
| `staff_seats` | limit | 5 / 5 / 15 | invitation create; invitation accept (`adding: 0`, re-check) | 402 `details.staff_seats` | Phase 2 |
| `orders_per_month` | limit | 50 / 500 / ∞ | manual orders and exchange orders (`OrderPlacementService`, in the transaction); storefront orders **never** refused (Q34) | 402 `details.orders_per_month` | P5-27 |
| `courier_connections` | limit | 1 / ∞ / ∞ | courier connect and reconnect of a disconnected account | 402 `details.courier_connections` | P5B-31 |
| `sms_per_month` | limit | 200 / 2000 / ∞ | order SMS send job | SMS skipped + timeline note (no HTTP error) | P5-26 |
| `custom_domains` | limit | 0 / 2 / 5 | domain add; **re-check of a `verification_failed`/`expired` row (Phase 7)** | 402 `details.custom_domains` | P6-7, P7 |
| `campaign_sms_per_month` | limit | 0 / 1000 / 5000 (SMS **parts**) | campaign schedule, send now, test send (estimate); campaign start (exact count after the snapshot) | 402 `details.campaign_sms_per_month {limit, used, needed}`; at start → campaign `failed/limit`, nothing sent | P85-13/14 (amends this table, Phase 8.5) |
| `campaign_emails_per_month` | limit | 0 / 5000 / 20000 | same as above for email campaigns | 402 `details.campaign_emails_per_month {limit, used, needed}`; at start → `failed/limit` | P85-13/14 (Phase 8.5) |
| `custom_domain` | feature | – / ✓ / ✓ | domain add, make a custom domain primary, **re-check of a `verification_failed`/`expired` row (Phase 7)** | 402 `feature_not_in_plan` `details.feature` | P6-7, P7 |
| `bulk_courier_booking` | feature | – / ✓ / ✓ | `POST /stores/{store}/shipments/bulk` | 402 `feature_not_in_plan` | P5B-31 |
| `profit_reports` | feature | – / – / ✓ | `GET /stores/{store}/reports/profit` (§6) | 402 `feature_not_in_plan` | **P7** |
| `all_couriers` | feature | – / ✓ / ✓ | **no separate check**: expressed by `courier_connections` (Free = 1 courier). Kept as a display key | — | — |
| `sms_automation` | feature | – / ✓ / ✓ | automation create, enable, PATCH of an `on` automation, trigger time (no run), step time (waiting runs → `stopped/plan`), automation test message | 402 `feature_not_in_plan` `details.feature`; downgrade pauses automations without deleting them | P86-17 (amends this table, Phase 8.6) |
| `fake_order_guard`, `custom_roles`, `multi_warehouse`, `pos`, `api_webhooks` | feature | as seeded | **not enforced: no module yet** (Phase 8). When a module lands, its contract adds the gate and a matrix row | — | — |

Phase 7 enforcement changes in code: (a) `profit_reports` gate; (b) domain re-check from `verification_failed`/
`expired` needs the feature and room in `custom_domains` (counting the row itself: `assertWithin(adding: 0)`), so a
detached domain can't be revived on Free; re-checks of `pending_verification`/`active` rows stay ungated (Q71); (c) the
`upgrade_plan` hint (P7-17); (d) `FeatureGate::usage()` documents every key; unknown keys keep returning 0.

### 2.2 Rules
- Every check goes through `FeatureGate::assertWithin` / `assertAllows`; no module reads `plans.limits` directly
  (arch test: `plans.limits` / `Plan::limits` used only in `App\Domain\Billing`).
- Checks that create rows run **inside the creating transaction under the existing per-store lock** (products, orders)
  or a `Cache::lock` (invites, couriers, domains), so concurrent creates at `limit − 1` give one success and one 402.
- `limit = null` = unlimited. A plan row missing a key → unlimited (fail open for display, but seeders always write
  every key; a test asserts every seeded plan has every `Limit` case).
- The 402 body: `{"error":{"code":"plan_limit_reached","message":"Your plan allows 100 products.","details":{"products":["Your plan allows 100 products."],"upgrade_plan":["starter"]}}}`.
- Downgrade (P7-16) never runs a "fix-up" over existing rows except custom domains.

### 2.3 Domain detachment (amends PHASE-6 §2.1 and §2.4)
- New `DomainFailureCode` **`plan_limit`**. New transition: any custom state except `suspended` → `expired`, trigger
  "plan enforcement" (`billing:run`, P7-16), side effects as the existing `active → expired` row (provider hostname
  deleted by job, primary fallback to the platform subdomain, `domain.status_changed` audit with the failure code,
  email "custom domain detached").
- Which rows: keep the primary custom row first, then `active` rows by `activated_at`, then the rest by `created_at`;
  rows after the first `allowed` are detached (`allowed` = `custom_domains` limit, 0 without the feature).
- Re-check of a `plan_limit` row → 402 until the plan allows it (§2.1 b); after an upgrade it re-enters
  `pending_verification` like any expired row.

---

## 3. Subscription and invoice lifecycle (7.2, owner API)

### 3.1 Subscription statuses (`subscriptions.status`)

| From | To | Trigger | Side effects |
|---|---|---|---|
| (tenant created) | `trialing` (Starter) | `TenantCreated` (exists) | `trial_ends_at = +14 d` |
| `trialing` | `active` (Free) | `billing:run` at `trial_ends_at` (was `subscriptions:end-trials`, kept as alias) | period now → +1 month; domain grace (P7-16); audit `subscription.trial_ended`; email |
| `trialing` / `active` Free | `active` paid | `new` invoice paid | plan, interval, period per P7-6; `scheduled_*` cleared; audit `subscription.plan_changed` |
| `active` paid | `active` paid (higher) | `upgrade` invoice paid | P7-6; open renewal invoice was voided at issue |
| `active` paid | `active` (same) | `renewal` invoice paid | `current_period_start = old end`, `current_period_end += interval`; audit `subscription.renewed` |
| `active` paid | `active` (scheduled plan) | `billing:run` at `current_period_end` with `scheduled_plan_id` | apply plan + interval; Free → period +1 month, cleared `scheduled_*`; paid downgrade continues with the renewal rules (row below); domain grace when needed |
| `active` paid | `past_due` | `billing:run` at `current_period_end`, renewal invoice unpaid | `past_due_at`, `grace_ends_at = current_period_end + 7 d`; audit; email; banner |
| `past_due` | `active` | renewal invoice paid | period from the old `current_period_end` (P7-8); `past_due_at`, `grace_ends_at` cleared |
| `past_due` | `expired` + new `active` Free row | `billing:run` at `grace_ends_at` | invoice `void` (`unpaid`); `ended_at`, `ended_reason: unpaid`; Free row period now → +1 month; domain grace = now; audit `subscription.expired`; email |
| `past_due` | `expired` + new `active` Free row | owner chooses Free (cancel) in `past_due` | as above, `ended_reason: cancelled`, invoice `void` (`cancelled`) |
| `active` Free | `active` Free | `billing:run` at `current_period_end` | period +1 month (for "Usage resets on") |

Rules: every transition runs in one DB transaction under `Cache::lock("billing:tenant:{id}")`, with the subscription
row `lockForUpdate()` and a conditional status update; affected rows = 0 → reload and stop. `cancel_at_period_end`
(existing column) is kept equal to "scheduled plan is Free". Any other transition → `InvalidSubscriptionTransition`
(unit-tested matrix).

### 3.2 Invoice statuses (`billing_invoices.status`)
`open → paid` (verified payment) · `open → void` (`superseded` \| `expired` \| `unpaid` \| `cancelled` \| `manual`) ·
`void → paid` (late payment, P7-14, `paid_late = true`). `paid` is final. Kinds: `new`, `upgrade`, `renewal`.

### 3.3 Change classification (`BillingQuoteService::classify`, data-driven test over every pair)
| Current | Target | Kind | Charge | Effective |
|---|---|---|---|---|
| Free or trialing | Starter/Growth, month/year | `new` | full price | on payment |
| Starter month | Growth month | `upgrade` | prorated difference | on payment, period unchanged |
| Starter month | Starter year / Growth year | `upgrade` | year price − unused credit | on payment, new yearly period |
| Starter year | Growth year | `upgrade` | prorated difference | on payment |
| Growth any | Starter any | `downgrade` | none | `current_period_end` |
| Growth year / Starter year | same plan month | `downgrade` | none | `current_period_end` |
| Starter year | Growth month | `downgrade` (interval shorter, rank higher) → **422 `plan_unavailable`** with "Switch to Growth yearly or change at renewal" | — | — |
| paid | Free | `cancel` | none | `current_period_end` (or now in `past_due`) |
| same plan + interval | — | `unchanged` → 409 `plan_unchanged` | — | — |

`trialing → Starter` (the trial plan) is a valid `new`. In `past_due` only `cancel` (immediate) is accepted; anything
else → 409 `invoice_overdue`.

### 3.4 Payment verification (owner API)
`BillingPaymentService::confirm(payment, Verification)`: provider success **and** amount = `invoice.total_amount`
**and** currency `BDT` **and** reference = payment id → payment `succeeded` (conditional) → invoice `open → paid` (or
P7-14) → subscription applied (§3.1) → audit + receipt email, all in one transaction; the PDF is rendered afterwards
by a job. Any mismatch → payment `failed` with `failure_code: amount_mismatch | currency_mismatch |
reference_mismatch`, audit `billing.payment_failed`, ops alert (a mismatch on a verified provider success is money
taken without service: ops refunds, Q89). Provider "failed"/"cancelled" → `failed`/`cancelled`.

---

## 4. Jobs, scheduler and ops commands (owner API)

### 4.1 `billing:run` (hourly, `withoutOverlapping`)
Discovery on `pgsql_admin` (`// cross-tenant: billing schedule`): tenants with a current subscription matching any due
condition below, max 1 000 per run, ordered by the earliest due instant. One `ProcessSubscriptionJob(tenant_id)` per
tenant (`TenantAware`, `ShouldBeUnique` 10 min, queue `billing`, 3 tries, timeout 120 s). The job reloads in the
tenant context and runs, in order, whatever is due:
1. `trialing` and `trial_ends_at ≤ now` → Free (§3.1); trial-ending email at `trial_ends_at − 3 d`.
2. `open` `new`/`upgrade` invoice older than 24 h → void `expired`.
3. `active` paid, next plan paid, `current_period_end − 7 d ≤ now`, no renewal invoice for that `period_start` → issue
   `renewal` invoice (voids a stale open one) + email; reminder emails at T−3 d and T−1 d.
4. `current_period_end ≤ now`: apply a scheduled change; then Free → roll period; paid with the renewal invoice paid →
   nothing (already extended); paid unpaid → `past_due` + email.
5. `past_due` and `grace_ends_at − 2 d ≤ now` → "grace ends soon" email; `grace_ends_at ≤ now` → expire to Free.
6. `domain_grace_ends_at ≤ now` → detach excess custom domains (§2.3), clear the field, email.
Each step is idempotent (status conditions + `reminders`/`notices` keys).

### 4.2 `billing:reconcile-payments` (every 5 min)
`pending` billing payments older than 2 min (and `failed`/`cancelled` ones younger than 48 h whose provider may still
complete): `query()` and `confirm()`; past `expires_at` with no success → `cancelled`. Discovery on `pgsql_admin`,
work in `ReconcileBillingPaymentJob` per payment (TenantAware, queue `billing`).

### 4.3 Other jobs
`RenderBillingInvoicePdf(invoice_id)` (queue `documents`, after paid/void); mails on `notifications`.

### 4.4 Ops commands (B24; no super-admin UI until 8.1; every command writes audit with `actor_type: system` and
`--reason`, and requires `--force` in production)
- `billing:mark-paid {invoice} --reference= --reason=` — bank transfer or support case; creates a `billing_payments`
  row `provider: manual` (new allowed value for ops only), applies like a verified payment.
- `billing:void {invoice} --reason=` — void an open invoice (`manual`).
- `billing:extend {tenant} --days= --reason=` — move `current_period_end` (and `trial_ends_at` while trialing) forward.
- `billing:change-plan {tenant} {plan} --interval= --reason=` — comp plan with no invoice.
- `billing:show {tenant}` — subscription, open invoice, last payments (no secrets).

### 4.5 Configuration of the queue
New queue `billing` (worker `queue-billing`, `--queue=billing --tries=3 --timeout=150`); compose + RUNBOOK.

### 4.6 Testing-only dev endpoints (not in openapi; API-CONVENTIONS §10.3 rules)
Registered only outside production, 404 unless `BILLING_FAKE=true`, merchant session + `T` (owner):
- `POST /dev/billing/clock` `{ state: "trial_ends_soon" | "trial_ended" | "renewal_due" | "period_ended" | "grace_ends_soon" | "grace_ended" | "domain_grace_ended" }`
  — moves the current tenant's subscription dates so that state is due (e.g. `renewal_due` = `current_period_end` in
  6 days), then runs `ProcessSubscriptionJob` synchronously; answers 200 `Subscription`.
- `GET|POST /dev/fake-billing-gateway/{payment}` — the fake hosted page (P7-20), signed.
Throttle 60/min.

---

## 5. Data (migrations, owner API) — prefix `2026_08_01_`, forward-only

### 5.1 New and changed tables
**`000100_extend_plans_and_subscriptions`**
- `plans`: add `price_yearly_amount bigint null` CHECK `>= 0`; `PlanSeeder` writes Starter `499000`, Growth `1499000`,
  Free null; convert timestamps to `timestamptz` if needed.
- `subscriptions`: add `billing_interval varchar(8) not null default 'month'` CHECK IN (`month`,`year`);
  `scheduled_plan_id` FK plans null RESTRICT; `scheduled_interval varchar(8) null` (same CHECK); `past_due_at`,
  `grace_ends_at`, `domain_grace_ends_at`, `ended_at`, `cancelled_at`, `plan_changed_at timestamptz null`;
  `ended_reason varchar(16) null` CHECK IN (`unpaid`,`cancelled`); `notices jsonb not null default '{}'`. Convert
  `trial_ends_at`, `current_period_start`, `current_period_end`, `created_at`, `updated_at` to `timestamptz` (`USING col
  AT TIME ZONE 'UTC'`, pgsql only). CHECK `status IN (…)`; CHECK `status <> 'past_due' OR grace_ends_at IS NOT NULL`;
  CHECK `(status IN ('expired','cancelled')) = (ended_at IS NOT NULL)`. `IX(status, current_period_end)` and
  `IX(status, trial_ends_at)` (platform discovery, deliberately not tenant-led, read through `pgsql_admin`).
- Data fix: active Free rows without a period get now → +1 month; `billing_interval = 'month'` everywhere.

**`000200_create_platform_counters`** — `platform_counters` (platform table, **no `tenant_id`, no RLS**): `key
varchar(64) PK`, `value bigint not null`, `updated_at timestamptz`. Grants: `storeplix_app` SELECT, INSERT, UPDATE.
Keys `billing_invoice:{YYYY}`.

**`000300_create_billing_invoices`** (RLS forced, `RlsTables::TENANT`)
`id` · `tenant_id` · `subscription_id` FK(t) `(tenant_id, subscription_id) → subscriptions(tenant_id, id)` ·
`number varchar(20)` **U** · `kind varchar(16)` CHECK IN (`new`,`upgrade`,`renewal`) · `status varchar(8)` CHECK IN
(`open`,`paid`,`void`) · `plan_id` FK plans RESTRICT · `interval varchar(8)` · `currency char(3)` CHECK = `BDT` ·
`subtotal_amount`, `tax_amount`, `total_amount bigint` (CHECK `total_amount > 0 AND subtotal_amount + tax_amount =
total_amount`) · `tax_rate_bps int` · `credit_amount bigint not null default 0` · `lines jsonb` · `bill_to jsonb` ·
`period_start`, `period_end timestamptz null` (set at issue for `renewal`, at payment for `new`/`upgrade`) ·
`issued_at`, `due_at timestamptz` · `paid_at`, `voided_at timestamptz null` · `void_reason varchar(16) null` CHECK IN
(`superseded`,`expired`,`unpaid`,`cancelled`,`manual`) · `paid_late boolean default false` · `paid_payment_id char(26)
null` (soft ref) · `reminders jsonb not null default '[]'` · `pdf_path varchar(255) null` · `created_by` FK users null
SET NULL · `idempotency_key varchar(64) null` · timestamps. `U(tenant_id, id)`; **partial `U(tenant_id) WHERE status =
'open'`** (P7-7); `U(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`; partial `U(subscription_id,
period_start) WHERE kind = 'renewal' AND status <> 'void'`; `IX(tenant_id, issued_at DESC)`; `IX(status, due_at)`
(platform).

**`000400_create_billing_payments`** (RLS forced)
`id` · `tenant_id` · `invoice_id` FK(t) → `billing_invoices(tenant_id, id)` · `provider varchar(16)` CHECK IN
(`bkash`,`sslcommerz`,`manual`) · `status varchar(12)` CHECK IN (`pending`,`succeeded`,`failed`,`cancelled`) ·
`amount bigint` CHECK `> 0` · `currency char(3)` · `provider_payment_id varchar(64) null` · `provider_trx_id
varchar(64) null` · `failure_code varchar(48) null` · `is_duplicate boolean default false` · `raw jsonb null` (scrubbed
by `PayloadScrubber`, hidden; last 5 provider answers) · `expires_at timestamptz` · `verified_at timestamptz null` ·
`initiated_by` FK users null SET NULL · `idempotency_key varchar(64) null` · `reference varchar(120) null` (manual
only) · timestamps. `U(tenant_id, id)`; partial `U(provider, provider_trx_id) WHERE provider_trx_id IS NOT NULL`
(global: one provider transaction can't pay two invoices); `U(tenant_id, idempotency_key) WHERE idempotency_key IS NOT
NULL`; `IX(tenant_id, invoice_id)`; `IX(status, created_at)` (platform reconcile).

**`000500_billing_definer_functions`** (pgsql only, MULTI-TENANCY §9.4 pattern):
| Function | Returns | Caller |
|---|---|---|
| `sp_billing_payment_owner(p_payment text)` | `tenant_id text` or no row | `PreTenantLookup::billingPaymentOwner` — billing return URL (**B22**) and SSLCommerz billing IPN (**B23**) |

**`000600_add_plan_limit_failure_code`** — widen the `store_domains.failure_code` CHECK (if any) for `plan_limit`.

**`000700_report_indexes`** (only those missing; `CREATE INDEX CONCURRENTLY` outside a transaction on pgsql):
`orders IX(tenant_id, store_id, placed_at)`, `orders IX(tenant_id, store_id, delivered_at) WHERE delivered_at IS NOT
NULL`, `shipments IX(tenant_id, store_id, booked_at) WHERE booked_at IS NOT NULL`, `return_requests IX(tenant_id,
store_id, created_at)`.

`subscription_items` (DATABASE-DESIGN §5) is **not built** (no add-ons in Phase 7).

### 5.2 Bypass paths (MULTI-TENANCY §9 gets them after acceptance)
| # | Path | Mechanism |
|---|---|---|
| B22 | `GET\|POST /billing/payments/return/{provider}/{payment}` | signed URL → `sp_billing_payment_owner()` → `TenantContext::run()` |
| B23 | `POST /billing/webhooks/sslcommerz` | `verify_sign` → `sp_billing_payment_owner(tran_id)` → `TenantContext::run()` |
| B24 | `billing:run`, `billing:reconcile-payments`, `billing:*` ops commands | discovery on `pgsql_admin`; per-tenant work in `TenantContext::run()` or a TenantAware job |
| B25 | `/dev/billing/*`, `/dev/fake-billing-gateway/*` (testing only) | session tenant / signed payment id; null in production or without `BILLING_FAKE` |
| B26 | `platform_counters` | platform table without RLS; only `InvoiceNumberAllocator` writes it (arch test) |

Suggested layout: `app/Domain/Billing/` — `Models\{Plan, Subscription, BillingInvoice, BillingPayment}`,
`SubscriptionStateMachine`, `BillingQuoteService`, `PlanChangeService`, `InvoiceService` (+ `InvoiceNumberAllocator`,
`VatCalculator`), `BillingPaymentService`, `DowngradeEnforcer`, `Gateways\{BillingGateway, BillingGatewayManager,
BkashBillingGateway, SslCommerzBillingGateway, FakeBillingGateway, PlatformCredentials}`, `Jobs\…`, `Console\…`,
`Http\…`, `Mail\…`, `Policies\BillingPolicy`; `app/Domain/Payments/Providers\{BkashClient, SslCommerzClient,
ChargeRequest, GatewayCredentials, TokenStore}` (refactor, P7-10); `app/Domain/Reports/` — `ReportRange`,
`SalesReport`, `ProfitReport`, `DeliveryReport`, `Http\ReportController`, `Http\Requests\ReportRangeRequest`.

---

## 6. API endpoints (owner API)

### 6.0 New error codes (add to API-CONVENTIONS §3)
| HTTP | code | When |
|---|---|---|
| 409 | `plan_unchanged` | change-plan to the current plan and interval |
| 409 | `invoice_overdue` | a plan change other than Free while `past_due` (pay the overdue invoice first) |
| 409 | `invoice_not_open` | pay an invoice that is `paid` or `void` |
| 422 | `plan_unavailable` | unknown/inactive plan code, interval the plan doesn't offer (Free yearly), or a change §3.3 refuses (`details.plan_code`) |
| 422 | `billing_gateway_unavailable` | `pay` with a provider the platform hasn't configured |
Reused: `provider_unavailable` (502, gateway timeout on initiate; nothing changed), `feature_not_in_plan` (reports),
`plan_limit_reached`, `idempotency_key_*`, `forbidden`, `not_found`, `rate_limited`, `validation_failed`.
`subscription_inactive` stays reserved (P7-4).

### 6.1 Billing (tenant-level: `auth` + `tenant`; no `{store}`)
| Method & path | Who | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /plans` (exists) | public | — | 200 `Plan[]` (+ `price_yearly_amount`) | — |
| `GET /subscription` (exists) | O A | — | 200 `Subscription` (extended, §9) | 403 |
| `GET /features` (exists) | O A S | — | 200 `FeatureAccess` (+ `grace_ends_at`, `domain_grace_ends_at`) | — |
| `POST /billing/quote` | O A | `BillingQuoteInput {plan_code, interval}` | 200 `BillingQuote` (no side effects; `warnings` list what the target plan won't cover) | 403; 409 `plan_unchanged` \| `invoice_overdue`; 422 `plan_unavailable` |
| `POST /billing/change-plan` | **O** | `BillingQuoteInput`; `Idempotency-Key` required | `new`/`upgrade`: **201** `ChangePlanResult` `{subscription, invoice}` (invoice `open`); `downgrade`/`cancel`: **200** `{subscription (scheduled_change set), invoice: null}`; `cancel` in `past_due`: 200, new Free subscription | 400; 403; 409 `plan_unchanged` \| `invoice_overdue` \| idempotency; 422 `plan_unavailable` |
| `DELETE /billing/scheduled-change` | **O** | — | 200 `Subscription` (`scheduled_change: null`); audit `subscription.change_cancelled` | 403; 404 (nothing scheduled) |
| `GET /billing/invoices` | O A | `page`, `per_page` (≤ 50), `filter[status]` | 200 `BillingInvoiceSummary[]` newest first, `meta: PaginationMeta & {providers: GatewayProvider[]}` | 403 |
| `GET /billing/invoices/{invoice}` | O A | — | 200 `BillingInvoice` (with `payments`) | 403; 404 |
| `GET /billing/invoices/{invoice}/pdf` | O A | — | 200 `application/pdf`, `Content-Disposition: attachment; filename="SP-2026-000123.pdf"`, `Cache-Control: private, no-store`; void PDFs carry a "VOID" watermark | 403; 404; 502 `provider_unavailable` (renderer down) |
| `POST /billing/invoices/{invoice}/pay` | **O** | `PayInvoiceInput {provider: 'bkash' \| 'sslcommerz'}`; `Idempotency-Key` required | 201 `BillingPayment` (`status: pending`, `redirect_url` to the provider); same key → same payment | 400; 403; 404; 409 `invoice_not_open`; 422 `billing_gateway_unavailable`; 502 `provider_unavailable`; 429 |
| `GET /billing/payments/{payment}` | O A | — | 200 `BillingPayment`; when `pending` and the last provider query is older than 10 s, the API runs `query()` once synchronously (≤ 10 s) before answering | 403; 404 |

Limiter `billing` (POST/DELETE above): 20/min per tenant + user; `pay` additionally 10/min per tenant.

### 6.2 Public billing callbacks (no session, no tenant header, no CSRF)
| Method & path | Answers |
|---|---|
| `GET\|POST /billing/payments/return/{provider}/{payment}?expires&signature` | Signature valid → `complete()` + `confirm()` (B22) → **303** to `{MERCHANT_APP_URL}/settings/plan?payment={payment}`. Invalid/expired signature or unknown id → 303 to `{MERCHANT_APP_URL}/settings/plan?payment_error=1` (no detail). Provider errors never surface (the page polls). Limiter `payment-returns` (exists) |
| `POST /billing/webhooks/sslcommerz` | Always 200 `WebhookAck` unless rate limited; processing per P7-12 in a job (`ProcessBillingIpn`, queue `billing`); bad `verify_sign` → ignored + log `billing.ipn_invalid` (no row change). Limiter `webhooks` (exists, per IP) |

### 6.3 Reports (store-scoped: `auth` + `tenant` + `store`)
| Method & path | Who | Query | Success | Errors |
|---|---|---|---|---|
| `GET /stores/{store}/reports/sales` | O A S | `from`, `to` (`YYYY-MM-DD`, store-local) | 200 `SalesReport`, `meta: ReportMeta` | 404; 422 |
| `GET /stores/{store}/reports/profit` | O A (`ViewCosts`) + `profit_reports` | same | 200 `ProfitReport`, `meta: ReportMeta` | 402 `feature_not_in_plan`; 403; 404; 422 |
| `GET /stores/{store}/reports/delivery` | O A S | same | 200 `DeliveryReport`, `meta: ReportMeta` | 404; 422 |

Validation (`ReportRangeRequest`): both optional; `from ≤ to`; `to` > today → clipped to today; `from ≥ 2020-01-01`;
span ≤ 366 days → else 422 `validation_failed` on `from`/`to`. Responses `Cache-Control: private, no-store`
(server-side cache only, P7-18). Limiter `merchant` (exists).

### 6.4 Report definitions (default accepted by PO 2026-11-23, Q86; every one has a test that recomputes it from fixtures in PHP)
Common: only orders of the store; **abandoned orders** (cancelled straight from `pending_payment`, i.e. the online hold
expired or the shopper switched away; identified by the `order_events` status change `pending_payment → cancelled`)
and orders still `pending_payment` are excluded everywhere. A *local day* is `[00:00, 24:00)` in `stores.timezone`.
"Net" amount of an order = `total_amount − refunded_amount`. Weeks are ISO weeks (Monday start) labelled `YYYY-Www`;
weekend = Friday + Saturday (Bangladesh). "Inside Dhaka" = `district_code` of the Dhaka district in the BD geo dataset.

**Sales overview** (`SalesReport`), orders by `placed_at` in range:
- `orders_count` = orders placed (any status after the exclusions); `orders_per_day` = `orders_count / elapsed days`
  (days from `from` to `min(to, today)`), 1 decimal.
- **Sold orders** = placed in range with status `shipped` or `delivered`. `sales_amount` = Σ net of sold orders;
  `sold_orders_count`; `average_order_value_amount` = `floor(sales_amount / sold_orders_count)` (null if 0);
  `items_per_order` = Σ `order_items.quantity` of sold orders / `sold_orders_count`, 1 decimal.
- `cancelled_count` (status `cancelled`), `cancelled_rate` = `/ orders_count`; `fake_cancelled_count` = cancelled
  with `cancel_reason = 'fake_order'`.
- `daily[]` every local day in range (zeros included): `{date, orders_count, sold_orders_count, sales_amount}`;
  `best_day` = max `sales_amount` (earliest on ties; null if all 0); `weekend_share` = Σ Fri+Sat `sales_amount` /
  `sales_amount`.
- `channels[]` by `orders.channel` over sold orders: `{channel, orders_count, sales_amount, share}` (share of
  `sales_amount`), sorted by `sales_amount` desc, channels with 0 omitted.
- `top_products[]` (≤ 6) over sold orders' items: Σ `quantity`, Σ line net (`line_total_amount` after line discount;
  order-level discounts not allocated), `share` of Σ lines; grouped by `product_id` (deleted products keep the item's
  `product_name`; `product_id` null lines grouped by name).
- `areas`: `inside_dhaka_share` (sold orders' `sales_amount`), `districts[]` top 8 by `orders_count` over sold orders:
  `{district_code, district_name, orders_count, sales_amount, share}`.
- `previous` = the same `summary` for the previous period.

**Profit & loss** (`ProfitReport`), **delivered** orders by `delivered_at` in range (status `delivered`; an order
returned later in the same range is no longer `delivered` and is excluded):
- `revenue_amount` = Σ net (includes the delivery charge the shopper paid). `delivered_orders_count`.
- `product_cost_amount` = Σ `order_items.unit_cost_amount × (quantity − returned_quantity)`; items with null cost add
  0 and are counted in `data_quality.items_without_cost`.
- `delivery_cost_amount` = Σ `shipments.delivery_fee_amount` of the order's delivered shipment(s); `cod_fee_amount` =
  Σ `shipments.cod_charge_amount`. Manual shipments or null fees add 0 and count in `data_quality.shipments_without_fee`.
- `gateway_fee_amount` = **null** ("not tracked", Q86); `ad_spend_amount` = **null** (Expenses, Phase 8.7).
  **Amended by PHASE-8-7 §7 (2026-11-24):** `ad_spend_amount` = Σ expenses of category `ads` by `spent_on` (integer);
  new `other_expenses_amount` and `profit_before_expenses_amount`; total cost, net profit, margin and per-order profit
  are after expenses (changed fields listed in PHASE-8-7 §7.3). Appendix A types are superseded by `packages/types`.
- `total_cost_amount` = Σ the non-null costs; `net_profit_amount` = revenue − total cost; `margin` = profit / revenue
  (null if revenue 0); `profit_per_order_amount` = `floor(profit / delivered_orders_count)`.
- `per_order` = each summary amount ÷ `delivered_orders_count` (floored; null if 0).
- `weekly[]` = the 12 ISO weeks ending with the week of `to` (independent of `from`): `{week, week_start,
  revenue_amount, net_profit_amount, margin}`.
- `daily[]` every local day in range, newest first, same columns as the summary plus `orders_count`.

**Delivery & returns** (`DeliveryReport`), courier shipments (`provider` ≠ `manual`) **booked** in range
(`booked_at`), excluding `cancelled` and `booking_failed`:
- `parcels_count`; `delivered_count` (`delivered`, `partially_delivered`); `returned_count` (`returned`);
  `returning_count` (`returning`); `in_progress_count` (the rest). `success_rate` = delivered / parcels; `return_rate`
  = returned / parcels; `returning_charges_amount` = Σ `delivery_fee_amount` of returned + returning parcels.
- `avg_delivery_days` = mean(`delivered_at − coalesce(picked_up_at, booked_at)`) in days, 1 decimal, over delivered
  parcels; `_inside_dhaka` / `_outside_dhaka` split by the order's district.
- `couriers[]` per provider with parcels: `{provider, parcels_count, delivered_share, returned_share,
  in_progress_share, avg_delivery_days, cod_held_amount}`; `cod_held_amount` = the Q49 figure (collected COD of
  delivered shipments in the last 60 days with `settled_at` null), independent of the range.
- `return_reasons[]` over `return_requests` created in range: `{reason, count, share}`; `returns_count`.
- `weekly[]` = 8 ISO weeks ending with the week of `to`: `{week, week_start, parcels_count, success_rate}`.
- `returning[]` (≤ 5, any booking date, oldest `last_event_at` first): `{shipment_id, order_id, order_number,
  customer_name, district_name, provider, problem, last_location, last_event_at}`.
- `districts[]` top 16 by parcels: `{district_code, district_name, parcels_count, success_rate}`.
- `previous` = the same `summary` for the previous period.

Implementation: query builder aggregates with bindings (no interpolated SQL, T20), always filtered by `tenant_id`
**and** `store_id`, running on `pgsql` under RLS. Budget: p95 < 800 ms for a 366-day range over 50 000 orders on CI
Postgres (`reports` perf test, group `perf`, Postgres only).

---

## 7. External providers (owner API)

### 7.1 Platform gateways
Same provider APIs as 5b §5 (bKash Tokenized Checkout v2, SSLCommerz v4 session + IPN + Validation API), base URLs
from `config/payments.php` by `BILLING_GATEWAY_MODE` (`sandbox` \| `live`). bKash live stays unavailable until
`BKASH_LIVE_BASE_URL` is set (as 5b). No refunds through the API in Phase 7. Every 5b **VERIFY** point applies; new
ones: SSLCommerz `product_profile: non-physical-goods` + `shipping_method: NO` without `ship_*` fields; bKash
`payerReference` with the owner's phone.

### 7.2 Fake driver (`FakeBillingGateway`)
State in the global cache under `billing:fake:{payment}` (26 h). `initiate()` → signed page URL; the page's buttons
record the outcome and redirect to the return URL with provider-shaped params (bKash `paymentID`, `status`;
SSLCommerz `tran_id`, `val_id`, `status`). Only the button decides (S53). Fixtures for the real billing adapters:
`tests/Fixtures/billing/{bkash,sslcommerz}/*.json` (`"_source": "docs"`, copied from the 5b fixtures with billing
fields), replaced by sandbox recordings at certification.

---

## 8. Dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`

### 8.1 Frames
- **Billing = Settings → Plan & billing `60:16361`** (Content `60:16857`): Current plan `65:17435` (with Limit warning
  `65:17445`), Usage this month `65:17455`, Plans `65:17495` (Monthly / Yearly chips `65:17491` / `65:17493`, plan
  cards `65:17502` / `65:17534` / `65:17570`), Payment method `65:17602`, Invoices `65:17616` (table `65:17622`,
  billing details line `65:17716`). **Amends roadmap 7.3**: `148:33261` is *Account · Profile & security* (ARCH
  checked the section on 2026-11-23: profile, sign-in, sessions, shops, alerts, transfer ownership; no billing).
- **Billing banner** `148:35383` in States `148:35364` ("Payment failed for your Starter plan. Fix it by 25 Nov to
  keep custom domain.").
- **Reports** section `60:11810`: Sales overview `60:11864` (Main `60:11866`), Profit & loss `60:12262` (Main
  `60:12264`), Delivery & returns `60:12660` (Main `60:12662`), local components `60:11811`. **Not built:** Money &
  COD `60:13058`, Product performance `60:13456` (Q85). No mobile frames exist for billing or reports: compose at
  390 px from the desktop cards (stack, tables → cards).
- States: Loading `148:35302`, Error `148:35336`, No results `148:35352`.
WEB pulls `get_design_context` per frame id (never the page) and reports any child ids it relies on for FIGMA-INDEX.

### 8.2 Plan & billing page (`/settings/plan`, extends the existing `PlanPage`)
| Card | Build |
|---|---|
| Current plan | Tag (Free trial / Current plan / Past due / Ends {date}), "{Plan} plan", price per interval and limit summary; trial line (exists); **scheduled change** line "Switches to Free on 1 Dec · Keep Growth" (→ `DELETE /billing/scheduled-change`); **past_due** block with due amount, `grace_ends_at` and "Pay now"; Limit warning `65:17445` when any limit ≥ 80 %: for `orders_per_month` "38 of 50 orders used — at this pace you'll reach the limit around 24 Nov" (linear projection from local month days elapsed; omit when < 3 days elapsed) with copy per **Q34** ("Shoppers can still order; you can't add orders by hand until you upgrade or the month resets"; the Figma line about confirming orders does not apply) and button "Upgrade to {upgrade plan} · ৳ {price}/mo" |
| Usage this month | Exists. Row for `sms_per_month` reads "Order SMS this month · N of M" (no credit packs, Q84). Over-limit rows (used > limit after a downgrade) show the danger colour and "Over your plan: existing items keep working; you can't add more" |
| Plans | Monthly / Yearly chips (yearly shows `price_yearly_amount` / year and "2 months free"); per card: **Current plan** (disabled), **Upgrade to X** / **Subscribe to X** (new), **Switch to X** (downgrade), **Scheduled** (disabled, when it is the scheduled plan). Click → **Change plan dialog**: `POST /billing/quote` → amount, what happens when ("Charged ৳ 400 now for the rest of this month, then ৳ 1,499 on 1 Dec" / "Switches on 1 Dec, no charge"), downgrade `warnings` list (e.g. "You have 140 products; Starter allows 1,000 ✓", "Custom domain shop.acme.com stops working on 8 Dec"), confirm → `POST /billing/change-plan` (fresh `Idempotency-Key` per dialog open). For `new`/`upgrade` the dialog continues to **Pay** |
| Pay dialog | Provider choice from `meta.providers` ("bKash", "Card, mobile banking (SSLCommerz)"), amount, invoice number → `POST /billing/invoices/{id}/pay` → `window.location.assign(redirect_url)` (only an `https:` URL, or `http://localhost` in dev for the fake). 502 → retry message; 422 `billing_gateway_unavailable` → hide that provider |
| Return | `/settings/plan?payment={id}`: poll `GET /billing/payments/{id}` every 2 s (max 60 s) → `succeeded`: success banner "You're on Growth. Receipt SP-…" and invalidate `subscription`, `features`, `invoices`, plus every query that shows plan state; `failed`/`cancelled`: "Payment didn't go through. You haven't been charged." + Pay again; still pending after 60 s: "We're confirming with bKash. This page updates by itself." (keep polling every 15 s). `payment_error=1`: generic error. Remove the query params after reading |
| Payment method | Q83: no saved method. Card text "Pay each invoice with bKash or card. Payments are confirmed by the gateway before your plan changes." with the two provider logos; no "Change" button, no "auto-pay" tag |
| Invoices | Table INVOICE / DATE / DESCRIPTION (`lines[0].description`) / AMOUNT / STATUS (Paid success, Open info, Overdue danger when `due_at` passed, Void neutral) / download icon (`/pdf`, blob download); open invoice row has **Pay**; pagination; empty "No invoices yet"; below: "Invoices are issued to {bill_to.name}, {bill_to.address}." + "Edit billing details" → `/settings/store` |
| Roles | Owner: everything. Admin: read-only (no Upgrade/Pay/Switch; "Only the shop owner can change the plan"). Staff: existing "Plan & billing is for owners and managers" empty state |

### 8.3 App-wide
- **Banners** (in `plan/Banners.tsx`, below the top bar, O A only; staff see none): `past_due` → `148:35383` copy
  "Payment failed for your {Plan} plan. Pay by {grace_ends_at} to keep {first lost feature, e.g. custom domain}." +
  "Pay now"; open renewal invoice due within 7 days → info "Your {Plan} plan renews on {date} · ৳ X" + "Pay now";
  `domain_grace_ends_at` set → warning "Your custom domain stops working on {date}. Upgrade to keep it."; trial banner
  (exists). One banner at a time, priority past_due > domain > renewal > trial.
- **402 dialog** (exists): label from `details.upgrade_plan[0]` ("Upgrade to Growth"), fallback Starter; staff/admin
  see "Ask your shop owner to upgrade".
- **Reports** nav item (sidebar, icon per `60:11865` Sidebar instance) → `/reports` with tabs Sales (`/reports/sales`,
  default), Profit (`/reports/profit`), Delivery (`/reports/delivery`). Range picker: This month (default), Last month,
  Last 30 days, Last 90 days, Custom (two dates, ≤ 366 days); state in the URL (`?from=&to=`). Query keys
  `[tenantId, storeId, 'reports', type, from, to]`, `staleTime` 60 s.
- **Charts** without a new dependency: small SVG components in `packages/ui` (`BarChart`, `LineChart`,
  `StackedMeter`, `DonutMeter`/share bar) using tokens only; each has an accessible table fallback (`<table
  className="sr-only">`). If WEB still wants a library, it is a separate proposal (≥ 14 days old, pinned).
- **Sales tab** (`60:11866`): KPI tiles (Sales with vs previous, Orders with per-day, Average order with items per
  order, Cancelled with rate and "fake orders: N"); daily bar chart with best day + weekend share; channels list;
  top products table ("See all" hidden, Q85); inside/outside Dhaka bar + top districts. Empty range → empty state.
- **Profit tab** (`60:12264`): tiles (Delivered sales, Costs, Net profit + per order, Margin); waterfall (Revenue →
  Product cost → Delivery → COD fee → Gateway fees "Not tracked" → Ad spend "Coming with Expenses" → Net profit);
  per-order breakdown; 12-week margin line with best/lowest/average; daily table (first 7 rows + "Show all N days")
  with a total row; `data_quality` notice "12 items have no cost price — add it in Products for a true profit". No
  "Target 25 %" (no target setting) and no ad-spend tip. Non-Growth: the tab shows an upgrade card (from `features`,
  no request); staff: tab hidden.
- **Delivery tab** (`60:12662`): tiles (Delivered rate, On the way back + charges, Average delivery days in/out of
  Dhaka, Return rate); per-courier cards with stacked bars; return reasons list (labels for `ReturnReason`); weekly
  success line; returning parcels list (links to the order); districts grid. No "Turn on Fake order guard" tip (Phase 8).
- **States**: loading skeletons, error with retry, empty ("No orders in this period") for every tab and card.
- **390 px**: tiles 2-up, charts full width with horizontal labels thinned, tables become cards, no horizontal scroll.

---

## 9. Appendix A — `packages/types` additions (`packages/types/src/index.ts`; orchestrator applies verbatim; additive)

Replace the existing `Plan`, `Subscription` and `FeatureAccess` interfaces with the versions below, add `'plan_limit'`
to `DomainFailureCode`, add the two `ROLE_CAN` keys, and append the rest after the Phase 6 block.

```ts
// ==================== Phase 7: monetization (PHASE-7-CONTRACT §9) ====================
export type BillingInterval = 'month' | 'year';
export interface Plan {
  id: string; code: 'free' | 'starter' | 'growth' | (string & {}); name: string;
  price_amount: number; currency: string; interval: 'month' | 'year';
  limits: Record<LimitKey, number | null>; features: FeatureKey[];
  /** Phase 7 (P7-3): yearly price (10 × monthly); null = no yearly option (Free) */
  price_yearly_amount: number | null;
}
export interface SubscriptionScheduledChange { plan: Plan; interval: BillingInterval; effective_at: string }
export interface Subscription {
  id: string; status: SubscriptionStatus; plan: Plan;
  trial_ends_at: string | null; current_period_start: string | null; current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Phase 7 */
  billing_interval: BillingInterval;
  scheduled_change: SubscriptionScheduledChange | null;
  past_due_at: string | null; grace_ends_at: string | null; domain_grace_ends_at: string | null;
  open_invoice: BillingInvoiceSummary | null;
}
export interface FeatureAccess {
  plan_code: string; subscription_status: SubscriptionStatus; trial_ends_at: string | null;
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, { limit: number | null; used: number }>;
  /** Phase 7: end of the past_due grace (null unless past_due) and the custom-domain detach date (P7-16) */
  grace_ends_at: string | null; domain_grace_ends_at: string | null;
}

export type BillingInvoiceKind = 'new' | 'upgrade' | 'renewal';
export type BillingInvoiceStatus = 'open' | 'paid' | 'void';
export type BillingVoidReason = 'superseded' | 'expired' | 'unpaid' | 'cancelled' | 'manual';
export interface BillingInvoiceLine {
  description: string; plan_code: string | null; interval: BillingInterval | null;
  period_start: string | null; period_end: string | null;
  quantity: number; unit_amount: number; amount: number;
}
export interface BillingInvoiceSummary {
  id: string; number: string; kind: BillingInvoiceKind; status: BillingInvoiceStatus;
  description: string; total_amount: number; currency: 'BDT';
  issued_at: string; due_at: string; paid_at: string | null; is_overdue: boolean; can_pay: boolean;
}
export interface BillingBillTo { name: string; address: string | null; email: string | null; phone: string | null }
export type BillingPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';
export interface BillingPayment {
  id: string; invoice_id: string; provider: GatewayProvider | 'manual'; status: BillingPaymentStatus;
  amount: number; currency: 'BDT';
  /** Only while pending and not expired; an https provider page (http://localhost fake page in dev). */
  redirect_url: string | null;
  failure_code: string | null; is_duplicate: boolean;
  created_at: string; expires_at: string; verified_at: string | null;
}
export interface BillingInvoice extends BillingInvoiceSummary {
  plan_code: string; interval: BillingInterval;
  subtotal_amount: number; tax_amount: number; tax_rate_bps: number; credit_amount: number;
  lines: BillingInvoiceLine[]; bill_to: BillingBillTo;
  period_start: string | null; period_end: string | null;
  voided_at: string | null; void_reason: BillingVoidReason | null; paid_late: boolean;
  payments: BillingPayment[];
}
export interface BillingInvoiceListMeta extends PaginationMeta { providers: GatewayProvider[] }
export interface BillingQuoteInput { plan_code: string; interval: BillingInterval }
export type BillingChangeKind = 'new' | 'upgrade' | 'downgrade' | 'cancel';
export interface BillingDowngradeWarning {
  key: LimitKey | FeatureKey; used: number | null; limit: number | null; message: string;
}
export interface BillingQuote {
  kind: BillingChangeKind; plan: Plan; interval: BillingInterval;
  amount: number; credit_amount: number; currency: 'BDT';
  requires_payment: boolean; effective_at: string;
  period_start: string | null; period_end: string | null;
  lines: BillingInvoiceLine[]; warnings: BillingDowngradeWarning[];
}
export interface ChangePlanResult { subscription: Subscription; invoice: BillingInvoice | null }
export interface PayInvoiceInput { provider: GatewayProvider }

// ---------- Reports (PHASE-7-CONTRACT §6.3–6.4) ----------
export interface ReportRangeQuery { from?: string; to?: string }  // YYYY-MM-DD, store-local
export interface ReportMeta {
  from: string; to: string; previous_from: string; previous_to: string;
  timezone: string; currency: string; generated_at: string;
}
export interface SalesSummary {
  sales_amount: number; sold_orders_count: number; orders_count: number; orders_per_day: number;
  average_order_value_amount: number | null; items_per_order: number | null;
  cancelled_count: number; cancelled_rate: number | null; fake_cancelled_count: number;
}
export interface SalesReport {
  summary: SalesSummary; previous: SalesSummary;
  best_day: { date: string; sales_amount: number; orders_count: number } | null;
  weekend_share: number | null;
  daily: { date: string; orders_count: number; sold_orders_count: number; sales_amount: number }[];
  channels: { channel: OrderChannel; orders_count: number; sales_amount: number; share: number }[];
  top_products: { product_id: string | null; name: string; image: MediaRef | null; units: number; sales_amount: number; share: number }[];
  areas: {
    inside_dhaka_share: number | null;
    districts: { district_code: string; district_name: string; orders_count: number; sales_amount: number; share: number }[];
  };
}
export interface ProfitSummary {
  revenue_amount: number; delivered_orders_count: number;
  product_cost_amount: number; delivery_cost_amount: number; cod_fee_amount: number;
  gateway_fee_amount: number | null; ad_spend_amount: number | null;
  total_cost_amount: number; net_profit_amount: number; margin: number | null;
  profit_per_order_amount: number | null;
}
export interface ProfitReport {
  summary: ProfitSummary; previous: ProfitSummary;
  per_order: {
    order_value_amount: number; product_cost_amount: number; delivery_cost_amount: number;
    cod_fee_amount: number; gateway_fee_amount: number | null; profit_amount: number;
  } | null;
  weekly: { week: string; week_start: string; revenue_amount: number; net_profit_amount: number; margin: number | null }[];
  daily: ({ date: string; orders_count: number } & Omit<ProfitSummary, 'delivered_orders_count' | 'profit_per_order_amount'>)[];
  data_quality: { items_without_cost: number; shipments_without_fee: number };
}
export interface DeliverySummary {
  parcels_count: number; delivered_count: number; returned_count: number; returning_count: number;
  in_progress_count: number; success_rate: number | null; return_rate: number | null;
  returning_charges_amount: number;
  avg_delivery_days: number | null; avg_delivery_days_inside_dhaka: number | null; avg_delivery_days_outside_dhaka: number | null;
}
export interface DeliveryReport {
  summary: DeliverySummary; previous: DeliverySummary;
  couriers: {
    provider: CourierProvider; parcels_count: number; delivered_share: number; returned_share: number;
    in_progress_share: number; avg_delivery_days: number | null; cod_held_amount: number;
  }[];
  returns_count: number;
  return_reasons: { reason: ReturnReason; count: number; share: number }[];
  weekly: { week: string; week_start: string; parcels_count: number; success_rate: number | null }[];
  returning: {
    shipment_id: string; order_id: string; order_number: string; customer_name: string; district_name: string | null;
    provider: CourierProvider; problem: string | null; last_location: string | null; last_event_at: string | null;
  }[];
  districts: { district_code: string; district_name: string; parcels_count: number; success_rate: number | null }[];
}
```

Edits to existing declarations (exact):
```ts
// DomainFailureCode: add the member
  | 'plan_limit'
// ROLE_CAN: add the keys
  view_billing: ['owner', 'admin'],     // plan, invoices, payments (Phase 7)
  manage_billing: ['owner'],            // change plan, pay (Phase 7, Q88)
```
Field rules: `is_overdue` = `status === 'open' && due_at < now`; `can_pay` = open and the caller is the owner;
`open_invoice` only for O A (null for staff, who can't call `/subscription` anyway); `redirect_url` is never stored
in the browser beyond the redirect; `BillingPayment.raw` never leaves the API. All `share`/`rate`/`margin` values are
0–1 with 4 decimals; amounts integer paisa.

---

## 10. Security checklist (Phase 7; numbering continues S40–S52; each has a test in §11)

| # | Threat | Control | Test |
|---|---|---|---|
| S53 | **Forged return / client-decided success** (T5) | Only provider server-side answers decide (P7-9); return params ignored except as a trigger; fake page outcome decides in tests | Return with `status=success` while the provider says Initiated → invoice stays open |
| S54 | **Amount / currency / reference mismatch** | Exact paisa vs `invoice.total_amount`, BDT, reference = payment id | "Pay wrong amount" → payment `failed amount_mismatch`, invoice open, plan unchanged, ops alert |
| S55 | **IPN forgery and replay** | `verify_sign` with platform `store_passwd` + Validation API; conditional transitions; identical 200 bodies | Bad sign → no change; same IPN twice → one transition; unknown `tran_id` → 200, nothing written |
| S56 | **Cross-tenant billing access** (T1) | `BelongsToTenant`, RLS on both tables, definer returns tenant only | `assertTenantIsolation` on invoice show/pdf/pay and payment show → 404; RLS raw-SQL test on both tables |
| S57 | **Privilege** (T10) | ManageBilling = owner; ViewBilling = O A; reports Profit O A | Admin change-plan/pay → 403; staff invoices → 403; staff profit → 403 |
| S58 | **Merchant/platform credential confusion and leakage** (T15) | Platform credentials from env only, never in DB, responses, logs, `raw`; billing code never loads `payment_gateway_accounts` and merchant code never loads `billing.*` config (arch test) | Log scan after a fake + `Http::fake` run has no secret; arch test |
| S59 | **Open redirect after return** | Redirect target is `MERCHANT_APP_URL` + fixed path; `redirect_url` to the provider must be `https:` from the provider host list in config | Return with `?next=https://evil` → 303 to the merchant app only |
| S60 | **Plan-gate bypass** | Gates in the creating transaction/lock (§2.2); FeatureGate cache busted on every subscription save | Parallel creates at `limit − 1` → one 201, one 402 (Postgres `race`) for products, invites, couriers, domains; downgrade visible to FeatureGate immediately |
| S61 | **Double charge / replayed pay request** | `Idempotency-Key` on change-plan and pay; one open invoice; duplicate success flagged (P7-14) | Same key twice → same payment; two verified successes → second `is_duplicate`, one plan change |
| S62 | **Mass assignment / tampering** | Inputs map `plan_code`, `interval`, `provider` only; price, period, status computed server-side | Posting `amount`, `status`, `current_period_end`, `plan_id` has no effect |
| S63 | **Report data exposure** | Store + tenant filter on every aggregate, RLS, cost data O A only, no customer phone/address in reports (names + district only) | `assertStoreIsolation` on the three report routes; staff profit 403; key-set test of `returning[]` |
| S64 | **Invoice PDF injection** (T29) | Template escapes every value (store name, address); no merchant HTML; renderer rules of 5b-4 | Store name `<img src=x onerror=…>` renders as text |
| S65 | **Fake driver in production** | Boot refusal (P7-20); dev routes not registered in production | Boot test; route list in production env has no `/dev/billing` |
| S66 | **Downgrade abuse of grace** | Domain grace stored server-side; re-check of detached domains needs the plan | Re-check a `plan_limit` row on Free → 402 |

SECURITY.md gets **T31 "Platform billing manipulation"** (this change) and T5 points to it.

---

## 11. Test requirements

### API (Pest; groups `billing`, `plans`, `reports`; security items also in `security`; definer functions and RLS in `rls`)
- **Unit:** `BillingQuoteService::classify` over every (current, target) pair of §3.3; proration (frozen clock; same
  interval, month→year credit, trial carry-over, rounding up to taka, ৳1 minimum); `VatCalculator`;
  `InvoiceNumberAllocator` (gapless under concurrency on Postgres `race`, new year resets); `SubscriptionStateMachine`
  full matrix incl. illegal transitions and the conditional-update race; `FeatureGate` upgrade hint; report
  definitions (§6.4) each recomputed in PHP from fixtures (timezone boundary: an order at 23:30 Asia/Dhaka on the
  last day of the month lands in that month; DST-free but a test with a non-Dhaka timezone still passes).
- **Feature (endpoints):** happy path for every route in §6; every §6.0 code; roles (S57); `assertTenantIsolation`
  on billing routes and `assertStoreIsolation` on report routes; idempotency (S61); quote ↔ change-plan amounts equal;
  402 `profit_reports`; `PlanEnforcementTest` (one dataset row per §2.1 row: at limit → 402 with
  `details.<key>` and `upgrade_plan`; below → success; unlimited → success).
- **Lifecycle on fakes (frozen clock):** trial → Free (+ domain grace) → detach after 7 days; Free → Starter (new) →
  renewal invoice at T−7 → paid early (period extends) ; renewal unpaid → `past_due` (features kept) → paid in grace
  (period from old end) ; unpaid → expired + Free row + invoice void + immediate domain detach; upgrade Starter→Growth
  mid-period (prorated, renewal voided and re-issued); downgrade scheduled → applied at period end → renewal at the
  lower price; cancel → Free at period end; cancel in `past_due`; late payment after expiry reactivates; duplicate
  payment flagged; change invoice voided after 24 h; ops commands.
- **Gateways:** billing adapters against `Http::fake` fixtures (bKash create/execute/query, SSLCommerz session/
  validation/IPN incl. bad sign); 5b gateway tests **unchanged and green** after the refactor (P7-10); platform token
  cached once across two tenants (one grant call).
- **Jobs:** `billing:run` discovery (due tenants only, one job per tenant, RLS on), idempotent reruns (no double
  invoice or email); `billing:reconcile-payments` (pending → succeeded via query; expiry → cancelled; late success).
- **Reports:** each endpoint against a seeded store whose expected numbers are computed independently in the test;
  abandoned orders excluded; profit with missing costs/fees counted in `data_quality`; range validation; cache key
  per range; perf budget (group `perf`, Postgres).
- **Security group:** S53–S66.
- **Boot checks:** `BILLING_FAKE=true` in production refuses.

### Dashboard (Vitest + Testing Library)
Plan cards per state (trial, free, paid, scheduled, past_due) and role; Monthly/Yearly switch; quote dialog copy
for each `kind` and warnings; pay dialog provider list and 422/502 handling; return polling (success, failure,
still pending, `payment_error`); invoices table statuses, overdue, PDF download, Pay; banners priority; 402 dialog
uses `upgrade_plan`; reports range picker ↔ URL; each tab's empty/loading/error; profit tab gating (non-Growth
card, staff hidden); chart components render their sr-only tables; 390 px layouts.

### QA (Playwright, `tests/e2e/specs/phase7.*.spec.ts`, fake drivers, fresh merchant per spec)
- **billing-upgrade:** Free (after `dev clock trial_ended`) → Upgrade to Starter monthly → quote → pay with fake bKash
  "Pay" → back on Plan & billing with success, plan Starter, invoice Paid, PDF downloads (`%PDF`).
- **billing-failures:** "Fail" and "Pay wrong amount" leave the plan unchanged with the right message; "Pay, then time
  out" ends paid after reconcile (or the status poll).
- **billing-renewal:** Starter → `renewal_due` → banner + open invoice → pay with fake SSLCommerz → period extended;
  `period_ended` → Past due banner (`148:35383` copy) → `grace_ended` → Free, invoice Void; a connected (fake) custom
  domain is detached and the platform subdomain is primary again.
- **billing-downgrade:** Growth → Switch to Starter → scheduled line → Keep Growth cancels it; Switch again →
  `period_ended` → Starter.
- **limits:** Free shop at 100 products → product create shows the 402 dialog "Upgrade to Starter"; Starter third
  domain → "Upgrade to Growth".
- **reports:** a fresh store with orders created through the API (manual orders, status transitions, fake courier
  shipments) → Sales / Delivery numbers equal the expected sums; Profit hidden for staff and shows the upgrade card on
  Starter; Growth owner sees profit with the missing-cost notice; range picker changes the URL and data.
- **mobile:** Plan & billing and each report tab at 390 px, no horizontal scroll.
- **certification (manual dispatch only, never in CI):** `phase7.billing.sandbox.spec.ts` with `BILLING_FAKE=false`
  and sandbox credentials (§13).

---

## 12. Configuration

| Key | Where | Notes |
|---|---|---|
| `BILLING_FAKE` | env | `true` in local/testing/e2e; boot refuses in production |
| `BILLING_GATEWAY_MODE` | env | `sandbox` \| `live` (production `live`) |
| `BILLING_BKASH_APP_KEY`, `_APP_SECRET`, `_USERNAME`, `_PASSWORD` | env (secret manager) | platform bKash PGW; empty → bKash not offered |
| `BILLING_SSLCOMMERZ_STORE_ID`, `_STORE_PASSWD` | env (secret manager) | platform SSLCommerz; IPN URL `{PUBLIC_API_URL}/api/v1/billing/webhooks/sslcommerz` set in its panel |
| `BILLING_GRACE_DAYS` (7), `BILLING_RENEWAL_LEAD_DAYS` (7), `BILLING_DOMAIN_GRACE_DAYS` (7), `BILLING_PAYMENT_HOLD_MINUTES` (30), `BILLING_CHANGE_INVOICE_TTL_HOURS` (24) | config `billing.php` | |
| `BILLING_VAT_RATE_BPS` (1500), `BILLING_VAT_BIN`, `BILLING_SELLER` (legal name + address on PDFs) | env → config | Q82 |
| `BILLING_OPS_EMAIL` | env | duplicate / mismatch alerts |
| `MERCHANT_APP_URL` (exists), `PUBLIC_API_URL` (exists) | env | return redirect target; signed URL base |
| Queue `billing` | worker `queue-billing` | compose + RUNBOOK |
| Scheduler | `billing:run` hourly; `billing:reconcile-payments` every 5 min; `subscriptions:end-trials` removed from the schedule (alias kept for ops) | `routes/console.php` |

Storefront: no change. Dashboard: no new env.

---

## 13. Certification and accounts the PO must provide (post-build blocker)

| For | What | Blocks |
|---|---|---|
| Platform bKash PGW (Q90, Q5) | Sandbox `app_key`, `app_secret`, `username`, `password` for **Storeplix's** merchant account; the live base URL from bKash | roadmap 7.2 AC on a real gateway |
| Platform SSLCommerz (Q90) | Sandbox `store_id` / `store_passwd` (self-serve) and the IPN URL registered in the panel | same |
| Company details (Q82) | Legal name, address and VAT BIN for invoices; accountant sign-off on VAT-inclusive pricing and numbering | invoice PDFs going live |
| PO answers | Q77–Q90 (defaults in effect) | none |

Run `phase7.billing.sandbox.spec.ts` (manual dispatch, public HTTPS tunnel as `PUBLIC_API_URL`): upgrade with each
provider to `paid`, an SSLCommerz IPN arriving before the browser return, a cancelled payment, a renewal paid in
grace; record fixtures with `"_source": "sandbox-YYYY-MM-DD"`; resolve every **VERIFY** in §7 and in this file.

---

## 14. File ownership for Phase 7

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: migrations §5, `app/Domain/Billing/**`, `app/Domain/Reports/**`, the provider refactor in `app/Domain/Payments/**` (P7-10, behaviour-preserving), `FeatureGate`/exceptions (P7-17), `PreTenantLookup` (B22/B23), domain changes (§2.3: `plan_limit`, re-check gate), `PlanSeeder`, routes, limiters, schedule, boot checks, mail, PDF template, fixtures, `DemoSeeder` (demo tenant stays on its trial; no invoices) |
| **WEB** | `apps/merchant-dashboard/**` (§8), `packages/api-client/**` (billing + reports methods), `packages/ui/**` (charts, plan card, status pills) |
| **SF** | nothing in Phase 7 |
| **QA** | `tests/e2e/**`, `.github/**`, `docker-compose.yml`, `infrastructure/**`, `docs/development/TESTING.md`, `docs/reviews/phase-7-qa.md`, `docs/deployment/RUNBOOK.md` §10 (billing: platform credentials, IPN URL, queue, ops commands) |
| **Orchestrator** | `packages/types` (§9, verbatim) |
| **ARCH** | Done with this contract: this file, `openapi.yaml` 1.8.0, ADR 0008 amendment, DATABASE-DESIGN, API-CONVENTIONS, SECURITY (T31), OPEN-QUESTIONS Q77–Q90, DOMAIN-INFRASTRUCTURE (Q71 resolution), roadmap. After acceptance: MULTI-TENANCY §9.4 (B22–B26 as built), FIGMA-INDEX (child frame ids from WEB's report) |

---

## 15. Order of work
1. Types (orchestrator, Appendix A §9) and openapi 1.8.0 land first; WEB mocks against them.
2. **API:** migrations + definer function → `FeatureGate` hint + enforcement gaps (7.1, small, can merge first) →
   provider refactor with 5b tests green → quote/change-plan/invoices/state machine on the fake → `billing:run` and
   reconcile → return/IPN → PDFs + emails + ops commands → reports (independent; can run in parallel from day one).
3. **WEB:** reports tabs (against mocks) in parallel with Plan & billing; then both against the API on fakes.
4. **QA:** compose/CI env (`BILLING_FAKE=true`, worker `queue-billing`), `phase7.*` specs, RUNBOOK §10 → QA gate
   `docs/reviews/phase-7-qa.md`.
5. **Certification** (§13) when the platform sandbox accounts exist; Phase 7 closes after it.

---

## 16. Acceptance criteria
1. Every §2.1 enforced row answers 402 with `details.<key>` and `upgrade_plan` at the limit and succeeds below it;
   rows without a module are documented as not enforced.
2. On fakes: Free → paid, upgrade with proration, renewal paid early and in grace, `past_due → expired` to Free,
   downgrade at period end, late and duplicate payments behave as §3; a paid invoice extends the period; nothing is
   paid without a verified provider answer whose amount, currency and reference match.
3. Downgrade deletes nothing; creates above the new limit get 402; custom domains above the plan are detached at
   `domain_grace_ends_at` and the platform subdomain becomes primary.
4. Plan & billing matches Figma `60:16361` (+ banner `148:35383`), works at 390 px, has empty/loading/error states;
   only the owner can change the plan or pay.
5. Reports match `60:11864`, `60:12262`, `60:12660`; every number equals an independent recomputation from the
   seeded orders/shipments in the store timezone; Profit is Growth + O A only.
6. Another tenant's invoices/payments and another store's reports → 404; S53–S66 pass, incl. `rls` and `race` on
   Postgres; 5b payment tests pass unchanged after the refactor.
7. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`), Playwright `phase7.*` are green;
   `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes for 1.8.0.
8. **Post-build:** the certification run (§13) pays a real sandbox invoice with each provider and resolves every VERIFY.

# ADR 0022 — Fake-order guard: own-shop signals, hold flag and checkout OTP

Status: Accepted (Phase 8.8a; scope set by the PO and defaults Q184–Q199 accepted, 2026-11-24) · Date: 2026-11-24 ·
Binding detail: PHASE-8-8-CONTRACT §1 (P88-1 – P88-17), §3–§9, §12
Builds on: ADR 0001 (shared-database tenancy), 0007 (payment gateways and payment links, P5B-22), 0011 (orders and
stock commitment), 0012 (Postgres RLS), 0013 (courier integration), 0017 (granular permissions); replaces the
PHASE-8-5 P85-25 risk class.

## Context
Cash-on-delivery fake orders cost a Bangladeshi merchant a delivery charge and a return each time. Figma Orders · Fake
order guard (`39:11233`) checks every new order against the buyer's "delivery record", holds risky ones for a call,
asks for the delivery charge in advance, blocks repeat returners and verifies new numbers. Constraints:
- A buyer's history at **other** Storeplix shops is cross-tenant personal data; Q23 (shared signals) is undecided and
  the PDP Act 2026 needs a lawful basis we do not have.
- No Bangladeshi courier offers an official per-phone "success rate" API. Steadfast and RedX records are only
  reachable by panel-login scraping (refused, Q185); Pathao's is not a supported endpoint.
- The order state machine, its DB CHECK, reports, webhooks and the external API all enumerate order statuses; a new
  "On hold" status ripples into all of them.
- Phase 8.5 already shipped a risk class (`CustomerRisk`, P85-25) for campaigns and 8.6 used it in automations; two
  meanings of "risky" in one product would confuse merchants.
- Checkout must never call an external service synchronously, and an SMS outage must never lose a sale.

## Decision
1. **Own-shop signals only.** A phone's record = this store's own orders, shipments and returns for that normalised
   phone (delivered vs returned; cancelled-before-shipping ignored). No courier lookup, no other tenant, no other store.
   The check stores the numbers it used, so every decision is reproducible and explainable.
2. **One risk tier everywhere** (`RiskTier`: `good`, `careful`, `risky`, `new`): total 0 → `new`; fewer than
   `min_parcels` → `careful` if any return else `good`; otherwise rate below `hold_below` → `risky`, below
   `advance_below` → `careful`, else `good`. The same rule (PHP and an equivalent SQL form) drives order checks,
   customer pages, campaign audiences and automation conditions. `CustomerRisk` becomes a deprecated alias for one
   release.
3. **Hold = a flag, not a status.** `orders.guard_hold` ∈ `call_first`, `advance`, `checking` on a `pending` order.
   Placement sets `checking` inside the placement transaction for storefront COD orders of a guarded store; the
   `CheckOrderRisk` job (after commit, idempotent, one check per order) replaces it with the decision. Confirm, bulk
   confirm, ready, courier booking (single and bulk) and the external API's `→ confirmed` answer 409 `order_held` until
   a merchant releases the hold or the advance link is paid. A 5-minute sweep resolves stale `checking` rows.
4. **Advance through the existing payment link** (P5B-22): kind `delivery_charge` (or 25 % when shipping is free), the
   store's expiry and cancel-if-unpaid. Paid → released and confirmed by the existing link flow; expired → back to
   `call_first`. No gateway connected → `call_first` with reason `no_gateway` (never a silent pass).
5. **Checkout rules before stock reservation, COD only**: blocked numbers (manual or automatic after N own-shop
   returns; a merchant unblock is remembered) → 422 `cod_unavailable` with a neutral message; the (limit+1)-th COD
   order of a phone in a store day → 422 `order_limit_reached`; online payment is always allowed.
6. **Checkout OTP for numbers new to the shop.** A 6-digit code, HMAC-hashed, 5-minute TTL, 5 attempts, per-phone and
   per-IP limiters. `POST /storefront/checkout/otp` answers the same shape for blocked, known and unknown numbers (no
   oracle). SMS allowance exhausted or SMS failure → **fail open**: no code, the order is placed and held
   `call_first` (`otp_unavailable`).
7. **Permission and plan.** New sensitive permission `fraud.manage` (owner + admin) for settings, blocklist, number
   check and decision log; releasing holds stays `orders.process`. The seeded `fake_order_guard` plan feature
   (Starter, Growth) is now enforced for actions and writes; tiers and own-shop records show on every plan.

## Consequences
- Positive: no personal data leaves the tenant; no new provider, dependency or queue; the order state machine,
  reports and webhooks are untouched; every hold carries reasons and the numbers behind them.
- Negative: a buyer new to a shop always starts as `new` (no network effect), so first orders rely on OTP, the daily
  limit and duplicates; risk classifications from 8.5 change for every store (PHASE-8-8 §6.6); held orders need a
  merchant action or a paid advance.
- Follow-ups (Q199): cross-shop network and super-admin Risk network (Q23), courier records if an official API
  appears, VPN/proxy rule (needs a provider), CAPTCHA/Turnstile, call-outcome log, `order.held` webhooks, advance rules
  by order total, ML scoring.

## Alternatives considered
- **Shared cross-shop record** ("Delivery record across Storeplix"): rejected by the PO for now — cross-tenant personal
  data without a decided lawful basis (Q23).
- **Courier records** (Pathao/Steadfast/RedX): rejected — no official per-phone API; scraping merchant panels violates
  their terms and leaks credentials (Q185).
- **New "On hold" order status**: rejected — touches the state machine, CHECK, reports, webhooks and the external API
  for a state that is really "pending, but not yet".
- **Synchronous check inside checkout**: rejected — slows checkout and couples it to the guard; `checking` plus an
  after-commit job gives the same guarantee (no confirm before the check).
- **Fail closed on OTP SMS failure**: rejected — an SMS outage would stop all first-time COD sales; a held order is
  recoverable, a lost sale is not.

# ADR 0008 — SaaS subscriptions and billing

Status: Accepted (provider pending PO, OPEN-QUESTIONS Q5) · Date: 2026-11-21

## Context
Plans with trials, limits and feature gates; merchants pay in BDT; card recurring billing is uncommon in BD.

## Decision
- Own billing engine (no Stripe Billing — Stripe is unavailable to BD entities): `plans`, `subscriptions`,
  `subscription_items`, `invoices`. 14-day trial on signup (no payment method).
  **Amendment (Phase 2, pending PO Q10):** plans follow Figma (`free`, `starter` ৳499, `growth` ৳1,499). The trial runs on
  `starter`; when it ends the tenant drops to the `free` plan (active, nothing locked) instead of expiring.
  `FeatureGate` API: PHASE-2-CONTRACT §1.6.
- **Manual-renewal model:** invoice generated 7 days before period end; merchant pays via bKash/SSLCommerz
  using the same `PaymentGateway` drivers with **platform** credentials; paid invoice extends the period.
  Unpaid → `past_due` (7-day grace, banner) → `expired` (store read-only for merchant, storefront shows
  "temporarily unavailable" after a further 7 days; data retained 90 days).
- **Limits/feature gates:** `plans.limits` jsonb; `FeatureGate::check($tenant, 'custom_domain')` and
  `Limit::assert($tenant, 'products', $count)` used in Policies/Actions; 402 `plan_limit_reached` with upgrade hint.
- Proration: upgrades charge the remaining-period difference immediately; downgrades at period end.

## Consequences
+ Works with BD payment rails; no foreign-card dependency.
− Manual renewals cause churn → reminders by SMS/email; bKash tokenized agreement for auto-debit evaluated in Phase 7.

## Alternatives
- Stripe/Paddle: not viable for BD entity/payers today.
- Annual-only prepaid: simpler but worse conversion.

## Amendment 2026-11-23 — Phase 7 binding detail (PHASE-7-CONTRACT P7-1–P7-22)
- **Non-payment drops to Free** (PO accepted Q77, 2026-11-23): `past_due` keeps the paid plan for a 7-day grace, then the
  subscription row becomes `expired` and a new `active` Free row starts. The shop is never read-only and the storefront
  never shows "temporarily unavailable" because of billing; `402 subscription_inactive` stays reserved. Data retention
  after expiry is therefore moot for billing (tenant closure keeps Q15).
- **Yearly interval** = 10 × monthly (Q79). **Proration** as decided above, rounded up to whole taka; `month → year`
  is an immediate upgrade with a credit (Q80). Unused trial days carry into the first paid period (Q78).
- **Invoices** `billing_invoices` (one open per tenant, gapless `SP-YYYY-NNNNNN`, VAT-inclusive, Q82) and
  `billing_payments`; `subscription_items` is not built.
- **Platform credentials** for bKash/SSLCommerz come from env; the 5b provider protocol code is shared through a
  behaviour-preserving refactor (credentials value object, charge request, token store) and the platform bKash token is
  cached globally. Paid only after a server-side provider answer with exact amount, BDT and our reference.
- **Downgrades** delete nothing; creates above the limit get 402; custom domains above the plan are detached after a
  7-day grace (immediately after a non-payment expiry) (Q81, resolves Q71).
- **bKash tokenized agreements / auto-debit** evaluated and deferred (Q83).

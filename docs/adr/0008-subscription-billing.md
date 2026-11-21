# ADR 0008 — SaaS subscriptions and billing

Status: Accepted (provider pending PO, OPEN-QUESTIONS Q5) · Date: 2026-11-21

## Context
Plans with trials, limits and feature gates; merchants pay in BDT; card recurring billing is uncommon in BD.

## Decision
- Own billing engine (no Stripe Billing — Stripe is unavailable to BD entities): `plans`, `subscriptions`,
  `subscription_items`, `invoices`. 14-day trial on signup (no payment method).
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

# ADR 0007 — Payment gateway abstraction

Status: Accepted · Date: 2026-11-21

## Context
Merchants collect via COD, bKash, SSLCommerz (later Nagad, others). Each gateway differs; redirects are forgeable.

## Decision
`PaymentGateway` interface in `app/Integrations/Payments`:
`initiate(Order, Payment): InitiationResult` (redirect URL / client payload) · `verify(Payment): VerificationResult`
(server-to-server status query) · `handleWebhook(Request): WebhookResult` (signature verified) ·
`refund(Payment, int $amount): RefundResult` · `status(Payment): PaymentStatus`.
Drivers: `CodGateway`, `BkashGateway` (tokenized checkout), `SslCommerzGateway` (IPN + validation API). Resolved by
`PaymentManager::driver($provider)` with per-tenant credentials from `payment_gateway_accounts` (encrypted).
Rules: order marked paid **only** after `verify()` or a verified webhook confirms provider status success **and**
amount + currency + our reference match; callbacks/redirects just trigger `verify()`. All transitions in
`PaymentStateMachine`; webhooks deduplicated via `webhook_events (provider, event_id)`; initiation/refund require
idempotency keys. Raw payloads stored with secrets stripped.

## Consequences
+ New gateway = new driver + tests against recorded fixtures; checkout code unchanged.
+ Redirect forgery and replay are neutralized.
− Requires sandbox accounts and recorded fixtures per provider in CI.

## Alternatives
- Aggregator only (SSLCommerz for everything): fewer drivers but higher fees and no native bKash UX.
- Platform as merchant-of-record collecting all money: regulatory burden (BD payment licensing). Rejected; merchants use their own gateway accounts.

## Amendment 2026-11-22 — Phase 5 split (PHASE-5-CONTRACT P5-1, P5-18, §16.2)
- Phase 5a ships COD only. `payments` rows exist from 5a (`provider: cod` charge; `provider: manual` refunds recorded by
  the merchant); no money moves through Storeplix.
- Online gateways (bKash Tokenized Checkout, SSLCommerz) are Phase 5b, after Postgres RLS lands. Merchant-owned
  credentials are confirmed by the Figma copy ("Money goes straight to your bKash merchant account", Integrations
  14:980); OPEN-QUESTIONS Q32 records the PO confirmation still needed. Advance payment links (144:46081) use the same
  drivers through a hosted pay page.

## Amendment 2026-11-22 — Phase 5b binding detail (PHASE-5B-CONTRACT §3–§5, P5B-10–P5B-29)
- **Merchant-owned credentials** (Q32) live in `payment_gateway_accounts`, one row per store and provider, encrypted
  with a dedicated integration-credentials key (not `APP_KEY`), sandbox/live mode, masked hint only in responses.
  Base URLs come from config by mode, never from the merchant.
- **Interface, as built:** `initiate(Payment, InitiationContext): Initiation` (redirect URL), `complete(Payment,
  array $callback): Verification` (bKash Execute; SSLCommerz Validation API), `verify(Payment): Verification`
  (bKash Query Payment; SSLCommerz query by `tran_id`), `parseWebhook(account, Request): ?WebhookEvent`,
  `refund(Payment $charge, int $amount, string $reason): RefundResult`, `refundStatus(Payment $refund)`,
  `verifyCredentials(account)`. `PaymentManager::driver()` adds `FakeGateway` for local dev and CI.
- **Paid means verified.** A payment succeeds only when the provider's server-side answer (Execute/Query for bKash,
  Validation API for SSLCommerz) says completed **and** amount (exact paisa), currency `BDT` and our reference
  (`merchantInvoiceNumber` / `tran_id` = our payment id) match. Browser returns and IPNs only *trigger* that check.
  Returns land on the API (signed URLs), never on a storefront route handler.
- **bKash Tokenized Checkout v2** (`/v2/tokenized-checkout/...`) is the target API; the callback `signature`
  algorithm and the IPN for tokenized payments are not publicly documented, so a 5-minute reconcile job using Query
  Payment is the safety net. **SSLCommerz v4** session + IPN + Validation API.
- `PaymentStateMachine`: charge `pending → succeeded | failed | cancelled`; refund `pending → succeeded | failed`.
  Every transition is a conditional update (`WHERE status = 'pending'`), so duplicates have no effect.
- Order effects: a verified payment on `pending_payment` → `confirmed` (Figma 60:14865); an advance on a COD order →
  `partially_paid`, and the order confirms itself. A payment verified after the hold expired is refunded
  automatically (default, pending PO Q61).
- Gateway refunds go through the original gateway (partial allowed where the provider allows it); manual refund
  records from 5a stay.

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

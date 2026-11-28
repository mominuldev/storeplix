# ADR 0027 — Platform SMS providers in the database, automatic failover, platform messages and broadcasts

Status: Accepted (Phase 8.9b; defaults Q274–Q286 accepted by the PO (product owner), 2026-11-28) · Date: 2026-11-28 ·
Binding detail: PHASE-8-9B-CONTRACT §1 (P89B-1 – P89B-30), §3–§9, §10.2 (S220–S233)
Builds on: ADR 0001 (shared-database tenancy), 0012 (Postgres RLS), 0019 (campaign opt-out link), 0026 (SMS credits,
`sms_messages` as the SMS log); PHASE-5b T28 (integration credentials encrypter, `SafeHttpClient`); PHASE-8-1
amendment A1 (`manage_settings`, `platform_settings`).

## Context
Every SMS — shop order updates, checkout codes, receipts, campaigns, and the platform's own sign-in codes — goes through
one REVE SMS account whose credentials live in `.env` (`config/sms.php`). Changing a key means a deploy; when REVE is
down, nothing is sent and nobody is told; there is no second provider. The platform sends merchants only account codes
by SMS; invoices and plan notices are email only. Figma `2098:*`–`2114:*` design a super-admin **SMS provider** page:
a primary and a failover provider, write-only credentials with rotation, a balance with alerts, platform message types
with bn/en texts, promotional broadcasts and a platform SMS log. 8.9a just made `sms_messages` the shop SMS log and put
shop charging in front of the gateway.

## Decision
1. **Providers are database rows** (`sms_providers`, platform table, app role SELECT only) edited only by staff with
   `manage_settings`. Credentials are encrypted with the integration-credentials key and are write-only (hints only).
   The env REVE account stays the bootstrap while no primary row exists, so the switch-over needs no deploy and no
   downtime.
2. **Drivers behind one interface** (`SmsProviderDriver::send/balance`): REVE and a generic HTTP driver (mapping
   configured per provider, called through `SafeHttpClient`). Other Bangladeshi providers are catalogue entries marked
   "Coming soon" until their APIs are verified.
3. **A router is the `SmsGateway`**. Each send names a route (`shop`, `registration`, `billing`, `security`,
   `promotional`); the router tries the primary, then the failover, per the groups each carries, with a circuit breaker
   (n consecutive provider-level failures or one timeout; half-open after 5 minutes). A message is tried on a second
   provider only when the first certainly did not accept it, so nothing is sent twice. Shop SMS keep 8.9a charging; they
   only gain failover.
4. **Safe changes**: activating the primary needs a passed test after the last connection change and the typed provider
   name; rotation tests the new credentials before swapping them in; the primary can't be removed.
5. **Platform messages are a fixed catalogue** wired only at events that exist (account codes, first phone
   verification, renewal invoice, payment received, reminder / past due, trial / grace ending). Account-code texts stay
   locked and unchanged; the others have bn/en templates with the 8.9a editor rules. Platform SMS rows are written with
   `tenant_id = NULL` (plus `merchant_tenant_id`) so they never appear in a shop's log and stay writable by platform
   jobs under RLS.
6. **Promotional broadcasts** are platform rows with per-recipient rows: audience by plan/status/trial, 09:00–21:00
   Dhaka, a weekly cap of 2 per merchant, an opt-out link footer per recipient (per-user opt-out), an estimate with cost
   and balance, and a typed recipient count to confirm.

## Consequences
- Positive: keys rotate without a deploy and without risking an outage; a provider outage fails over automatically and
  is visible; merchants get invoice and plan SMS; staff can reach merchants by SMS within clear rules; one log shows
  every platform SMS.
- Negative: the gateway gains routing state (breaker in the platform cache) and every SMS writer stores `provider_id`;
  `SmsGateway::send` gains a route parameter (all callers touched once); merchant masked sender IDs don't work on the
  failover (falls back to its default sender); provider credentials are readable by the app role (encrypted) because
  every queue worker must send; cost figures are estimates from list prices.
- Follow-ups (Q286): native drivers for SSL Wireless / Alpha SMS / BulkSMSBD, delivery reports, HTTP-driver balance,
  SMS two-step and sign-in alerts, offer/win-back automations, Announcements SMS channel, inbound STOP.

## Alternatives considered
- **Keep credentials in env, add a second env provider**: rejected — rotation and failover would still need deploys,
  and the Figma flows (test before activate, rotate) could not exist.
- **Store credentials in `platform_settings` JSON**: rejected — no per-provider lifecycle, roles, uniqueness or history.
- **Retry a failed message on the failover after any error**: rejected — a timeout may have been accepted; resending
  would duplicate codes and broadcasts.
- **A separate `platform_sms_messages` table**: rejected — the gateway, retries, previews pruning and masking already
  live on `sms_messages`; `tenant_id IS NULL` cleanly separates platform rows.
- **Opt-out per tenant or per phone**: rejected — the recipient is a person (owner); per-user survives phone changes
  and a user owning two shops opts out once.
- **"Reply STOP" to a short code**: rejected — REVE has no inbound SMS (Q141); the link works today.

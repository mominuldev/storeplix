# ADR 0019 — Marketing campaigns, consent and suppression

Status: Accepted (Phase 8.5; defaults Q138–Q151 accepted 2026-11-24) · Date: 2026-11-24 · Binding detail:
PHASE-8-5-CONTRACT §1 (P85-1 – P85-28), §3–§7, §10
Builds on: ADR 0001 (shared-database tenancy), 0002 (central storefront), 0012 (Postgres RLS), 0017 (granular
permissions); reuses the Phase 5 `SmsGateway` and the Phase 7 plan limits.

## Context
Figma Marketing (`61:12479`: overview `66:19179`, composer `70:19774`) lets a merchant send one-off SMS (and, in its
WhatsApp slot, email) campaigns to a segment of customers. Roadmap task 8.5 has one acceptance criterion: **opt-out
respected**. Constraints:
- Customers are store-scoped rows that merchants can delete, re-create, merge and re-import; a consent flag on the row
  is lost or overwritten by those operations.
- Storefront checkout has never captured explicit marketing consent; pure opt-in would leave almost every merchant
  with an empty audience.
- The SMS provider (Revesms) has no inbound channel, so "reply STOP" can't be implemented.
- The platform's SMS sender ID and email domain are shared by all merchants: one merchant's abuse hurts every
  merchant's deliverability, and order SMS (OTP-like, transactional) must never be starved by marketing traffic.
- No merchant-provided code or HTML may execute or render (CLAUDE.md rule 7); shoppers must never see the API host.
- Every queued job that touches tenant data is `TenantAware`; a duplicated or retried job must not double-message a
  shopper.

## Decision
1. **Suppression by address is the source of truth for opt-out.** `marketing_suppressions(store_id, channel, address)`
   is unique per store, channel and normalized address (`8801XXXXXXXXX` / lower-cased email). It is independent of the
   customer row, so deletes, re-creates and imports can't revive a shopper's consent. `customers.accepts_marketing` is
   kept as a merchant-editable hint; an unsubscribe never changes it (opt-out is per channel only — amended 2026-11-24,
   QA finding P85-QA-4), and it never clears a suppression.
2. **Ownership of a suppression follows who created it.** `source = link` (the shopper) can only be removed by the
   shopper on the same unsubscribe page; `source = merchant` only by the merchant (409 `suppression_customer_owned`
   otherwise).
3. **Eligibility = soft opt-in.** A customer may be messaged on a channel iff they have an address for it, no
   suppression matches, and (`accepts_marketing` or at least one order). Hand-added contacts without consent or orders
   are never messaged. Opted-out and ineligible customers are always excluded — not a merchant checkbox.
4. **Every message carries a per-recipient opt-out link on the merchant's own domain**, `https://{primary host}/u/{code}`,
   `code` = 10 random base62 chars stored only as sha256. The SMS footer (bn/en) is appended by the server and counts
   toward parts; email adds a footer link plus RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post`. The **storefront**
   renders the page (same trusted host, store branding, tenant resolved from the host); GET never changes state, a
   button or the one-click POST does. The API endpoint is `/storefront/unsubscribe/{code}` behind the storefront key.
5. **Consent is re-checked at send time, per recipient.** The audience is materialized when the campaign starts
   sending (not when scheduled); each recipient is then checked again inside the send job (suppression, customer still
   present, same address, still eligible, campaign still `sending`, plan, store live). An opt-out that lands between
   scheduling and sending wins.
6. **At most once per recipient.** Recipient state `queued → sending → sent | failed` moves by conditional UPDATE; the
   provider call is never retried (`tries = 1`); a recipient stuck in `sending` over 15 min becomes `unknown` and is
   never retried. Campaign start and `dispatch-due` also move state by conditional UPDATE.
7. **Separate allowances and a separate queue.** New plan limits `campaign_sms_per_month` (parts) and
   `campaign_emails_per_month`, checked on the estimate at schedule/send and on the exact count after the snapshot
   (not enough → campaign `failed/limit`, nothing sent). Order SMS keep `sms_per_month`. Campaign jobs run on their own
   `campaigns` queue with Redis limiters (10 SMS/s per store, 50/s platform, 20 emails/s per store) and quiet hours
   21:00–09:00 store time.
8. **Content is data, not markup.** SMS is plain text with four merge fields; email is plain text rendered into one
   fixed platform template (everything escaped, only `http(s)` URLs auto-linked, header CR/LF rejected). Sender is the
   platform (SMS prefix `"{shop}: "`, email `"{Store}" <CAMPAIGN_MAIL_FROM>` with the store as `Reply-To`).
9. **Attribution without tracking.** An order placed by a recipient customer within 7 days after their message was sent
   is attributed to the latest such campaign (`campaign_conversions`, unique per order). No click tracking, link
   shortening or storefront changes.
10. **Permission.** The existing `marketing.manage` covers campaigns and becomes sensitive ("Coupons & campaigns");
    recipient lists also need `customers.view` and always mask addresses.

## Consequences
- The opt-out guarantee holds across customer edits, deletes and imports and across the schedule→send gap; tests S113,
  S114, S118 pin it.
- Campaigns can't partially send because of the allowance, and can't starve order SMS.
- A recipient may be `unknown` (provider outcome lost); the merchant sees it, the shopper is never messaged twice.
- Storefront owns a new public route `/u/{code}` that must bypass the Coming-soon rewrite; a suspended store's link
  answers 404 (sending is impossible then).
- Without delivery receipts and bounce/complaint processing, `sent` means "accepted by the provider". Bounces,
  complaints, masked sender IDs, WhatsApp, saved segments, A/B tests and recurring campaigns are not supported yet;
  each fits this model as an added source, channel or audience type.
- The SMS part-count algorithm exists twice (API authoritative, dashboard for the live counter); both run the same
  vector file `docs/api/sms-parts-vectors.json`.

## Alternatives considered
- **Consent flag on `customers` only**: simplest, but lost on delete/re-create/import and ambiguous per channel.
- **Pure opt-in**: legally cleanest, but checkout doesn't capture consent today, so audiences would be empty; soft
  opt-in for existing buyers plus a mandatory link on every message is the accepted default (Q138).
- **Unsubscribe page on the API host**: one app less, but a long, unbranded, unfamiliar URL in every SMS and the API
  host exposed to shoppers.
- **Snapshot at schedule time**: predictable counts, but misses opt-outs and new customers between schedule and send.
- **Retrying failed provider calls**: better delivery, but risks double-messaging when the provider accepted the
  first call and the response was lost.
- **Money balance / credit packs for SMS** (Figma "Top up"): needs a ledger and payments (Q84, deferred); monthly
  allowances are predictable and reuse FeatureGate.

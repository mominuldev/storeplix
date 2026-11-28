# ADR 0026 — SMS credits after the allowance; per-store templates and masked sender IDs

Status: Accepted (Phase 8.9a; defaults Q257–Q272 accepted by the PO (product owner), 2026-11-28) · Date: 2026-11-28 ·
Binding detail: PHASE-8-9A-CONTRACT §1 (P89A-1 – P89A-26), §3–§10, §11.2 (S208–S219)
Builds on: ADR 0001 (shared-database tenancy), 0007 (payments; rule 8), 0008 (platform billing), 0012 (Postgres RLS),
0017 (granular permissions), 0019 (campaign allowances), 0020 (automations share the allowance), 0022 (checkout OTP),
0025 (POS SMS receipt).

## Context
Every shop sends SMS through the platform REVE SMS account: order updates and payment links (Phase 5/5b), checkout codes
(8.8a), POS receipts (8.8d), campaigns (8.5) and automation messages (8.6). They are paid by two monthly plan
allowances — `sms_per_month` (messages) and `campaign_sms_per_month` (parts) — and silently stop when those run out.
Texts are fixed files (`resources/sms/{bn,en}.php`) prefixed with "{Shop}: " because every SMS shows the platform
sender (Q145). Q84 deferred SMS credit packs; Q140 refused a money balance for campaigns. Figma `31:5120` and the
`2075:*` frames now design an SMS integration page with credits, editable templates, a sender ID request and a log.

What must keep working: the at-most-once order SMS (order row lock + timeline dedupe), S13 sanitising, the 3-segment
shortening, the checkout-OTP fail-open, the campaign/automation allowance checks, account OTPs sent without a tenant
(the `sms_messages` RLS policy that allows `tenant_id IS NULL`), and the platform billing flow (one open subscription
invoice, rule 8 verification, dunning).

## Decision
1. **Allowance first, then credits.** A new `SmsCharger` decides for every shop-paid SMS, inside the tenant context
   and under a `FOR UPDATE` lock on the tenant's `sms_credit_accounts` row: the allowance of the message's kind if it
   covers it, else the purchased **SMS credits** (1 credit = 1 SMS part, either kind, never expire), else the message is
   **skipped** with a log row. Credits never unlock a 0 allowance and are never touched by an unlimited one. The lock
   also makes the old count-then-insert allowance check race-free.
2. **Append-only credit ledger.** `sms_credit_ledger` (`purchase`, `consume`, `refund`, `admin_adjust`, signed credits,
   `balance_after`) with unique indexes that make consume/refund idempotent per `sms_message_id` and a purchase grant
   unique per invoice; the balance is cached on the account row and always equals the ledger sum.
3. **Credits are bought as platform billing invoices** of a new kind `sms_credits` (no plan, no interval, `sms_credits`
   column) paid with the Phase 7 platform bKash / SSLCommerz flow; the grant happens in the transaction that marks the
   invoice paid after server-side verification. One open subscription invoice and one open SMS invoice may coexist
   (two partial unique indexes); every subscription reader filters `subscriptionKinds()`.
4. **`sms_messages` becomes the shop's SMS log** (store, kind, parts, charged source, sender used, link-free 160-char
   preview, error code, reference) while remaining a platform table with nullable `tenant_id`; the tenant listing
   filters tenant, store and `purpose NOT LIKE 'otp_%'` explicitly with RLS as the backstop. OTP and checkout-code texts
   are never stored; previews are pruned after 90 days.
5. **Per-store templates** (`sms_templates`, only custom bodies stored) for the 6 order events and the POS receipt in
   bn and en, with a per-key merge-field allow-list, no typed links and a 3-part limit on a sample render; the defaults
   are the existing files byte for byte; on/off stays in `store_settings.customer_sms`.
6. **Masked sender IDs** (`sms_sender_ids`, one pending and one approved per store, globally unique among pending and
   approved) are requested with a private trade-licence upload and reviewed by platform staff with `manage_domains`.
   An approved ID is passed to the gateway as caller ID and a leading `{shop}: ` is dropped from the body.

## Consequences
- Positive: shops can keep sending after the allowance without a plan change; one ledger explains every credit; no
  second payment integration; the existing billing verification, PDFs and admin invoice tools cover SMS purchases;
  merchants control their texts and sender name; SMS problems are visible in a log.
- Negative: every SMS sender changes (orders, checkout OTP, POS, campaigns, automations), so the charger is guarded by a
  static test and a byte-for-byte default-text test; all charging in one tenant is serialised on one row (acceptable at
  SMS volumes; campaign batches charge per recipient); billing code gains a kind branch and every subscription reader
  must use the kind scope; the log adds columns and a back-fill to a platform table; a unique index on sender IDs spans
  tenants (it reveals only that a public sender name is taken).
- Follow-ups (Q272): delivery reports, merchant-own gateways, promotional sender IDs, per-kind pricing, credit expiry or
  refunds, auto top-up, editable OTP text and quiet hours.

## Alternatives considered
- **Charge credits before the allowance, or split one message between both**: rejected — the allowance expires
  monthly, and split charging complicates refunds for no merchant benefit.
- **A money (৳) balance with per-SMS prices** (Figma, Q140): rejected — Bangla and English cost different parts; credits
  per part are exact and need no price table per kind.
- **A separate SMS payment flow outside billing invoices**: rejected — would duplicate gateway verification, VAT, PDFs,
  reconciliation and the admin tools that rule 8 already covers.
- **A new tenant-owned `sms_log` table**: rejected — every sender already writes `sms_messages`; a second table would
  have to be kept in sync and account OTP rows would still live in the old one.
- **Storing full message bodies**: rejected — bodies contain checkout codes, payment-link tokens and unsubscribe codes.
- **Merchant-uploaded documents through the public `/media` library**: rejected — identity documents must stay private
  and staff-only, as expense receipts (8.7).

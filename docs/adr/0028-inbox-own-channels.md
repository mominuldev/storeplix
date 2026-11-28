# ADR 0028 — Inbox on platform-owned channels: website chat, order messages, email replies

Status: Accepted (Phase 8.8e; PO (product owner) scope decision and defaults Q287–Q302 accepted, 2026-11-28; Q299
provider open) · Date: 2026-11-28 · Binding detail: PHASE-8-8E-CONTRACT §1 (P88E-1 – P88E-23), §3–§13, §14.2
(S234–S247)
Builds on: ADR 0001 (shared-database tenancy), 0009 (file storage), 0012 (Postgres RLS), 0017 (granular permissions),
0022 (checkout code pattern), 0026 (SMS credits; `SmsCharger`), 0027 (platform SMS routing).

## Context
Figma section `141:48129` designs an Inbox that merges Messenger, WhatsApp, Instagram and website chat and drafts
orders with AI. External channels need Meta app review, business verification and per-shop OAuth; AI drafting needs a
model provider decision. Shoppers already want to reach shops about orders, and the platform owns three paths without
any third party: the storefront, the order tracking page and the order emails it sends. There are no storefront
customer accounts (Q14/Q58), no websocket stack in the repo, and no in-app notification centre. Shop SMS are charged
through the 8.9a `SmsCharger`; private documents follow the expense-receipt pattern.

## Decision
1. **8.8e ships own channels only** (`web_chat`, `order`, `email`); external channels and AI drafting are roadmap 8.8f.
   The data model keeps `channel` open for them (new CHECK values later) and the UI shows "Connect a channel"
   placeholders.
2. **Conversations are keyed by thread**: `UNIQUE(store_id, channel, thread_key)` with keys derived from the proven
   identity (verified phone, order, sender email, or an unverified widget session). A thread that writes again reuses its
   conversation and reopens it for the same assignee. Messages are immutable rows of kind customer / reply / note /
   system; notes are filtered out of every shopper path by explicit `kind` predicates.
3. **Shopper identity without accounts**: web chat proves a mobile with a 6-digit SMS code and then holds an opaque
   httpOnly session cookie (stored as sha256); order messages reuse order access (confirmation token or tracking
   number + phone) via a stateless store-bound HMAC token; email uses the sender address, trusted for customer linking
   only with SPF/DKIM pass. When the code SMS cannot be sent the message is still delivered as an *unverified*
   thread that is never linked or texted.
4. **Reply notification by SMS**, charged through `SmsCharger` (purposes `inbox_verify`, `inbox_reply`), delayed two
   minutes, skipped when seen, at most one per conversation per 30 minutes, with a magic link that restores the
   session on the shopper's phone.
5. **Email via a platform inbound domain**: a rotatable per-store address plus HMAC-signed per-conversation and
   per-order reply addresses; the provider's inbound webhook is signature-verified with a replay window, routed
   cross-tenant only inside `InboundRouter`, deduplicated by `Message-ID`, loop-protected, and raw MIME is never stored.
   A driver interface ships `fake` and `mailgun`; the production provider is an open decision (Q299).
6. **Polling, not websockets**: ETag/304 answered from tenant-prefixed cache version counters before any query, and
   `after` cursors on threads.
7. **One permission** `inbox.manage` (Owner, Admin, Staff) for the whole Inbox; channel switches are `settings.manage`;
   side-panel order and customer data still need their own keys. No plan gate.
8. **Channels are off until turned on**, so nothing changes for a shop that ignores the Inbox.
9. **Retention**: 24 months after the last message; sessions, links and orphan uploads expire within days.

## Consequences
+ Ships a useful inbox with no external approvals and no new infrastructure or dependencies.
+ Identity is never stronger than what the shopper proved; SMS cost is bounded and metered by 8.9a.
+ The thread model and attachment pipeline carry over to 8.8f channels.
− Polling costs requests (mitigated by 304s and pausing hidden tabs); "live" latency is up to 5 s.
− Shoppers must enter an SMS code once per device for web chat; a lost cookie means re-verifying.
− Email depends on a provider choice and an MX record for `INBOX_MAIL_DOMAIN` (RUNBOOK); until then the email
  channel can't be turned on in production (`INBOUND_MAIL_DRIVER` unset → channel switch disabled with a reason).
− No notification centre: assignment and nothing else is emailed; missed-message reminders are later (Q305).

## Alternatives considered
- **Websockets (Reverb/Soketi)**: lower latency, but new stateful infrastructure, auth per channel and a scaling story
  (ADR 0010) for a feature that tolerates seconds of delay. Revisit with 8.8f.
- **Unverified chat by default**: less friction, but lets anyone make a shop text any number and lets impostors pull a
  customer's order details; rejected except as the SMS-outage fallback.
- **Merchant-forwarded mailbox / IMAP polling**: needs mailbox credentials per shop and parsing everybody's mail;
  rejected for a platform inbound domain.
- **Storing messages in `customer_notes` or order timeline**: no threading, unread state or attachments; rejected.

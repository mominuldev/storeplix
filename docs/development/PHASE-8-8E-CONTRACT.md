# Phase 8.8e contract: Inbox — website chat, order messages, email replies (binding for ARCH, API, WEB, SF, QA)

Status: **Accepted, 2026-11-28 — PO (product owner) set the scope (own channels only; Messenger / WhatsApp / Instagram
and AI "Order from chat" move to 8.8f) and accepted the proposed defaults for Q287–Q302**. Q303 and Q304 are defaults
in effect (open), Q299 (inbound mail provider) and Q305 (later features) stay open. Branch `feat/phase-8-8e-inbox`
(stacked on `feat/phase-8-9a-sms` + 8.9b; rebased on `main` once both merge).
Roadmap task **8.8e** "Inbox" (Figma section `141:48129`; new frames `2118:*`–`2126:*`, FIGMA-INDEX "Phase 8.8e").
AC: **"A shop turns on website chat, order messages and email replies; shoppers reach it from the chat widget, from
their order page and by replying to an email; staff with the Inbox permission see one list, read, reply, add internal
notes, attach photos and PDFs, assign, mark pending and close; shoppers get an SMS when the shop replies; nothing
changes for a shop that does not turn a channel on"** (§17).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-9B contracts and
docs/api/API-CONVENTIONS.md still applies. PHASE-5 P5-23 (shopper order access without accounts, Q42/Q58), PHASE-5 P5-26
(order emails), PHASE-8-3 (permission catalogue, ADR 0017), PHASE-8-7 P87-7/8 (private documents, signed 5-minute view
links), PHASE-8-8 P88-13 (checkout code pattern), PHASE-8-9A §4 (`SmsCharger`, every shop SMS charged) and PHASE-8-9B
(SMS routing, route `shop`) apply in full. **Amends** PHASE-5 P5-23 (`StorefrontOrderTracking` gains `messages`; new
`GET /storefront/orders/access`), PHASE-5 P5-26 (Reply-To of the shopper order email when the email channel is on),
PHASE-8-3 §2.1 (new key `inbox.manage`), PHASE-8-9A §3.4 (purposes `inbox_verify`, `inbox_reply`; `reference_type`
`conversation`) and DATABASE-DESIGN §6 (the Inbox sketch is replaced by §5.14).
Machine-readable spec: `docs/api/openapi.yaml` **v1.25.0** (tags `inbox`, `storefront`, `webhooks`). ADR **0028** (new:
Inbox on own channels). Product defaults: OPEN-QUESTIONS **Q287–Q305**.

### Scope

**One API PR, one WEB PR, one SF PR, one QA gate** (WEB and SF build against the types/client written here).

| Area | Owner | Ships |
|---|---|---|
| **Conversations** | API/WEB | List, thread, reply, internal note, attachments, assign, open/pending/closed, reopen, read state, block, delete (§5–§7) |
| **Saved replies** | API/WEB | Team-shared, `/shortcut`, merge tags, optional attachment, chips, order (§8) |
| **Channels** | API/WEB | Per-store on/off for website chat, order messages, email replies; inbound address; "Connect a channel" placeholders (§4) |
| **Website chat** | API/SF | Widget, SMS-verified mobile, session cookie, reply SMS with a magic link (§9) |
| **Order messages** | API/SF | Messages card on the tracking result and thank-you page (§10) |
| **Email replies** | API | Per-store inbound address, per-conversation signed reply address, signed inbound webhook, outbound reply mail (§11) |
| **Realtime** | API/WEB/SF | Polling with ETag + `after` cursors; sidebar badge (§12) |
| **Docs + types** | ARCH | openapi 1.25.0, `packages/types`, `packages/api-client` (**written**, §15), ADR 0028, DATABASE-DESIGN §5.14, SECURITY T45, MULTI-TENANCY count, OPEN-QUESTIONS, roadmap |
| **QA** | QA | `phase8-8e.*`, Pest group `inbox` (§16) |

**Out of scope** (hide, never fake): Messenger, WhatsApp, Instagram and every other external channel, AI order drafting
("Order from chat", `141:48130`, `166:35920`, `167:36176`, `172:37079`, `168:36454`) — roadmap **8.8f**; merchant UI shows
only "Connect a channel" placeholders. Also out (Q305): storefront customer accounts and the account order page
(`1:12706`), @mention notifications, missed-message emails, CSAT, typing indicators, message edit/delete, websockets,
"Suggest when a customer asks about delivery", editable reply-SMS text, captcha, manual customer linking, Bangla UI.

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Member" = a signed-in merchant user.
- **Shopper** = the person on the storefront or writing the email. **Contact** = the shopper as stored on a conversation
  (name, phone and/or email).
- **Channel** = `web_chat` (storefront widget), `order` (order-page Messages), `email` (inbound email).
- `[S]` = store-scoped table (`BelongsToStore`, composite FK to `stores(tenant_id, id)`, RLS `tenant_isolation`).
- Phones are stored normalised `8801XXXXXXXXX` (`Phone::bdMsisdn`), shown masked to shoppers (`017••••5678`), in full to
  members with `inbox.manage`. Times: store timezone in UI, UTC `timestamptz` in the DB.
- Local runs: api **:8010**, merchant **:5183**, storefront **:3010**; `SMS_DRIVER=fake`, `INBOUND_MAIL_DRIVER=fake`,
  `MAIL_MAILER=log|smtp` (Mailpit).

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit for another agent. Touch only owned files (§16). Before every Edit of a shared-read file, re-read it.
- New dependencies: **none** (MIME parsing uses what the inbound provider already parsed; no websocket stack).
- Never `migrate:fresh` the local dev DB.
- Every SMS goes through `SmsCharger` (8.9a §4) — the static sender allow-list gains the two inbox senders only.
- **A shop that never turns a channel on behaves exactly as before**: no widget, no Messages card, order emails keep the
  store contact Reply-To, the Inbox page shows the first-run card. Every existing Pest test and Playwright spec stays
  green without edits except the permission catalogue counts and added enum values.

---

## 0. Summary and goals
Shoppers already message shops — by phone, on Facebook, by replying to order emails that go to a personal mailbox. 8.8e
gives every shop one **Inbox** (`/inbox`, Figma `2118:51165`) fed by three channels the platform owns end to end: a
**website chat widget** (`2125:9509`–`2126:10484`), **Messages on the order page** (`2126:10642`), and **email
replies** to a per-shop address. Members with the new `inbox.manage` permission read and answer in one thread view with
the customer, linked order and past orders beside it, write staff-only internal notes, attach photos and PDFs, insert
team-shared saved replies with `/`, assign a conversation to one teammate (who is emailed), and move it between Open,
Pending and Closed. A shopper who is not looking at the shop when it answers gets an SMS with a link back to the
conversation, charged like any shop SMS.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P88E-1 | **Scope** (PO 2026-11-28, Q287): own channels only — `web_chat`, `order`, `email`. Social channels and AI drafting → **8.8f**; merchant UI shows them only as "Connect a channel" placeholders ("Coming later") | No third-party app review or Meta business verification needed; ships value now |
| P88E-2 | **One conversation per contact per channel thread** (Q288): `UNIQUE(store_id, channel, thread_key)`; `thread_key` = `phone:{msisdn}` (verified web chat), `session:{widget_session_id}` (unverified web chat, P88E-14), `order:{order_id}` (order messages), `email:{lowercased address}` (email). A closed conversation is **reused** when the same thread writes again (P88E-5) | No duplicate threads for one shopper; history stays together |
| P88E-3 | **Permission** (Q289): one new key **`inbox.manage`** "Reply to customer messages" — group `customers` after `customers.delete`, not sensitive, `requires() = []`, grantable; SystemRole Owner ✓ Admin ✓ **Staff ✓**. Covers every `/inbox/*` read and write incl. saved replies. Channel settings writes: `settings.manage`. Side-panel extras need their own keys (§6.3). Custom roles get it only when granted | One key keeps support roles simple; channel switches are a shop setting |
| P88E-4 | **Assignment** (Q289): at most one assignee, who must currently hold `inbox.manage` (422 `inbox_assignee_invalid`); "Unassigned" = shared queue. Every assign/unassign writes a system row; the **new assignee is emailed** (`InboxAssignedMail`, never on self-assign). A member who loses the key or leaves is unassigned from every conversation (job `UnassignInboxMember`, system row) | Figma `2121:51432`; clear ownership without an in-app notification centre (none exists) |
| P88E-5 | **Status** (Q290): `open` → `pending` (waiting on the shopper) → `closed`, any direction by a member. A **new shopper message** on a pending or closed conversation sets it `open` and keeps (returns it to) its assignee; a member **reply** on a closed conversation reopens it too. System rows for `pending`, `closed`, `reopened`. Closing never deletes | Figma `2121:51977` copy: "If {customer} writes again it reopens and goes back to {assignee}" |
| P88E-6 | **Internal notes** (Q291): `kind = 'note'`, visible only in merchant responses; every storefront, email and SMS path selects `kind IN ('customer','reply')` explicitly (static test). Notes never reopen, never notify, never count as a reply. `@name` is plain text in 8.8e (Q305) | Staff-only by construction |
| P88E-7 | **Attachments** (Q292): JPG, PNG, PDF only, ≤ **5 MB** each, ≤ **3** per message, MIME **sniffed**, new media purpose **`inbox_attachment`** (private disk, tenant prefix, images re-encoded / EXIF stripped, no variants, never a library purpose). Viewed via **signed 5-minute URLs** (members) or streamed through the storefront proxy (shoppers, own conversation only); `nosniff`, CSP `sandbox; default-src 'none'`, `no-store`, PDF as attachment. Unattached uploads pruned after 24 h | Same proven rules as expense receipts / sender-ID documents (P87-7/8, P89A-16) |
| P88E-8 | **Saved replies** (Q293): team-shared per store, ≤ 200; title (1–60), `shortcut` (`[a-z0-9_-]{2,24}`, unique per store), body (1–1000) with merge tags (§8.2), optional one attachment, "Show as a chip" flag, manual order. Inserted with `/` (search title + shortcut) or a chip; the server **renders** the merge tags for the conversation, the member edits the text and sends a normal reply. `use_count` +1 when a reply referencing it is sent | Figma `2123:52877`, `169:36693` ("Quick replies" = Saved replies) |
| P88E-9 | **Unread per member** (Q294): `inbox_reads(conversation_id, user_id, last_read_message_id)`. A conversation is unread for a member when its `last_customer_message_id` > their `last_read_message_id` (ULIDs sort by time). Sidebar badge = conversations not closed, not blocked, assigned to me **or unassigned**, unread for me | Figma sidebar "Inbox 5", list unread badges |
| P88E-10 | **Shopper identity** (Q295): storefront customer accounts do not exist (Q14/Q58). Web chat: name + mobile, proven by a **6-digit SMS code**; the browser then holds an opaque **chat session cookie** (`sp_chat`, 90 days) — this is the Figma "signed in" case (name/number skipped). Order messages: holding order access (confirmation token or tracking number + phone, P5-23) — replies notify the **order's phone**. Email: the sender address, marked authenticated only when the provider reports SPF or DKIM pass | Same trust the shop already gives each path |
| P88E-11 | **Verification code** (Q295): purpose **`inbox_verify`** (transactional, charged via `SmsCharger`, body never stored), HMAC-hashed, 10-minute TTL, 5 attempts, resend after 60 s, 5 sends per phone per hour per store. The first message waits on the session (`pending_message`) and reaches the Inbox only after verification | A number nobody proved never gets texted or linked to a customer |
| P88E-12 | **Reply SMS** (Q296): purpose **`inbox_reply`** (transactional; fixed bn/en text, §9.5) to the verified phone (web chat) or order phone (order messages), never for email or unverified threads. Sent by a job **2 minutes** after a reply, skipped when the shopper has seen it meanwhile, **at most one per conversation per 30 minutes**; carries a **magic link** (`/m/{code}`, 7 days) that reopens the conversation on the shopper's phone. Allowance/credits exhausted → skipped (`sms_status = 'no_credits'`), nothing else breaks | PO: "A guest gets an SMS when the shop replies, charged through SmsCharger"; bounded cost |
| P88E-13 | **Public widget protection** (Q297): limiter `inbox-widget-start` 5/h per store+IP and 3/h per store+phone; `inbox-widget-code` 5 sends/h per store+phone, 20/h per store+IP; `inbox-widget-message` 20/min and 200/day per session; `inbox-link` 20/min per IP; honeypot field `website` (filled → 202 fake success, nothing stored); body 1–2000 chars, control characters stripped; members can **Block** a conversation (further shopper messages are dropped silently). Draft / not-live stores: no widget | Spam, SMS-pumping and enumeration resistance without a captcha |
| P88E-14 | **Fail-open when SMS cannot be sent** (Q295): if the code SMS cannot be afforded or the provider fails, the message is delivered as an **unverified** conversation (`thread_key = session:{id}`, identity `unverified`): shown with "Number not verified", never linked to a customer, never texted; the shopper reads replies in the widget while the cookie lasts | Never lose a customer message to an SMS outage (P88-13 precedent) |
| P88E-15 | **Email inbound** (Q298): each store gets an inbound address `shop-{key}@{INBOX_MAIL_DOMAIN}` (key 12 random base32, rotatable); outbound replies set Reply-To `c-{conversation}-{sig}@…` and the shopper order email (P5-26) sets Reply-To `o-{order}-{sig}@…` when the email channel is on (sig = 12 hex of HMAC-SHA256 with `INBOX_REPLY_SECRET`). The mail provider's **inbound webhook** `POST /webhooks/inbound-email/{driver}` is signature-verified (driver-specific, timestamp ±15 min, token replay cache 1 h), deduplicated by `Message-ID`, loop-protected (auto-replies, bounces, `Auto-Submitted`, `Precedence: bulk` dropped). Driver interface + `fake` + **`mailgun`** (default driver; **provider choice open, Q299**) | Platform-owned addresses need no merchant DNS; signatures stop forged posts |
| P88E-16 | **Outbound email replies**: default (transactional) mailer, From `"{Shop name}" <inbox@{platform_domain}>`, Reply-To the conversation address, subject `Re: {subject}`, `In-Reply-To`/`References` from the last inbound `Message-ID`, plain text + escaped HTML, attachments attached. `delivery_status` `queued → sent | failed` (3 tries) | Threads correctly in Gmail/Outlook; no merchant mail setup |
| P88E-17 | **Realtime** (Q300): no websocket stack exists in the repo (no Reverb/Pusher/Soketi) → **polling**. `GET` summary/list/messages answer `ETag` (store inbox version + member read version + query hash, cache counters via the tenant cache helper) and `304` on `If-None-Match` without touching the DB; threads poll with `after={message_id}`. Intervals §12 | Cheap, cache-friendly, no new infrastructure |
| P88E-18 | **Retention** (Q301): a conversation whose last message is older than **24 months** is deleted nightly with its messages, attachments and reads (`inbox:prune`); widget sessions: pending 24 h, verified 90 days after last use; magic links 7 days; unattached uploads 24 h; inbound raw MIME is **never stored** (only parsed text, quoted history trimmed, accepted attachments). Members with `inbox.manage` + `customers.delete` may delete a conversation now (audited). Customer deletion unlinks (`customer_id` null) | Useful service history, bounded personal data |
| P88E-19 | **Plan** (Q302): no feature key, no limit — Inbox on every plan (Free included). SMS are paid through 8.9a allowance/credits | Answering customers is basic; cost is already metered by SMS |
| P88E-20 | **Channels default off** (Q303, default in effect): `inbox_settings` row absent = every channel off. The first-run card (`2123:52602`) shows each channel with **Turn on** (`settings.manage`); Figma draws the On state | "Nothing changes for a shop that does nothing" (8.9a principle); no surprise launcher or Reply-To change |
| P88E-21 | **Order page** (Q304, default in effect): Figma `2126:10642` is the account order page (`1:12706`), which needs customer accounts. 8.8e puts the **Messages card on the `/track` result** and on **`/checkout/thank-you`** with the same content | Built pages, same order access rules |
| P88E-22 | **Linking**: auto-link the customer when identity is proven — verified phone → `customers` row with that phone in the store; order channel → the order's customer; authenticated email → the single customer with that email (none or many → no link). Linked order: order channel fixed; others may set/clear it (`inbox.manage` + `orders.view`, system row); a web chat from a product page stores a product context card | Side panel `2118:51165` without trusting unproven identities |
| P88E-23 | **Text only, safely rendered**: bodies are plain text. Dashboard never autolinks shopper text; storefront and email autolink `http(s)` URLs in **shop replies** only (`rel="nofollow noopener noreferrer"`). No HTML from email is shown (text part, else HTML → text) | XSS and phishing resistance (CLAUDE.md: no `dangerouslySetInnerHTML`) |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q287–Q305)
Q287–Q298, Q300–Q302 **answered 2026-11-28: proposed defaults accepted**; Q299 open (provider); Q303, Q304 defaults
in effect (open); Q305 record only.

| Q | Question | Proposed default |
|---|---|---|
| Q287 | 8.8e scope | Own channels (website chat, order messages, email replies); social + AI order drafting → 8.8f |
| Q288 | Conversation grouping | One per contact per channel thread; reused when the thread writes again |
| Q289 | Who works the inbox, assignment | New `inbox.manage` (O/A/S); one assignee; new assignee emailed |
| Q290 | Statuses | Open / Pending / Closed; a shopper message reopens and returns it to the assignee |
| Q291 | Internal notes | Staff-only, never sent anywhere |
| Q292 | Attachments | JPG/PNG/PDF ≤ 5 MB, ≤ 3 per message, sniffed, private |
| Q293 | Saved replies | Team-shared, merge tags, `/` and chips, optional attachment |
| Q294 | Unread counts | Per member; sidebar badge = mine + unassigned |
| Q295 | Guest identity | SMS-verified mobile + chat session cookie (no shopper accounts exist), order access, email sender; unverified fallback when SMS is unavailable |
| Q296 | Reply SMS | `inbox_reply` via `SmsCharger`, 2-min delay, skip if seen, ≤ 1 per 30 min, magic link |
| Q297 | Widget spam | Limiters, honeypot, block action, no captcha |
| Q298 | Email inbound mechanism | Platform inbound domain, per-store + per-conversation signed addresses, signed provider webhook |
| Q299 | Inbound mail provider | **Open**: build driver interface + `mailgun`; deployment picks |
| Q300 | Realtime | Polling with ETag / after cursors |
| Q301 | Retention | 24 months after the last message; raw MIME never stored |
| Q302 | Plan | Every plan |
| Q303 | Channel defaults | Off until turned on (Figma shows On) — default in effect |
| Q304 | Order page Messages | On `/track` result + thank-you (no account page) — default in effect |
| Q305 | Later (record) | See Out of scope |

## 2. Permission and plan
`Permission::InboxManage = 'inbox.manage'` (P88E-3), label "Reply to customer messages", description "Inbox: chats, order
messages and email replies". Route map rows for every §13 route (O/A/S parity fixture). **Staff** gets it (Staff system
role list), so a fresh shop's staff see the Inbox. Channel settings writes: `settings.manage`; reading them:
`inbox.manage | settings.manage`. Delete conversation: `inbox.manage` **and** `customers.delete`. Impersonation: every
write → 403 `impersonation_read_only`; attachment links → 403 `impersonation_attachment_hidden`. No external-API scope.
Plan: P88E-19. Catalogue counts: 28 grantable keys + owner-only `billing.manage`.

## 3. Data (owner API; forward-only; RLS in each create migration; `database/sql/rls-emergency-off.sql`)
Migrations prefix `2026_12_13_`; `RlsTables::TENANT` docblock "103 after Phase 8.8e" (8 new tables). All `[S]`.

- **inbox_settings** (`000100`): id · tenant_id · store_id **U** · web_chat_enabled bool default false ·
  order_messages_enabled bool default false · email_enabled bool default false · email_key varchar(12) **U (global)**
  (lowercase base32, generated on first enable / rotate) · email_key_rotated_at null · widget_reply_time varchar(12)
  CHECK `IN ('minutes','hour','day')` default `minutes` · widget_hours varchar(40) null · widget_greeting varchar(200)
  null · revision int default 1 · updated_by null FK users SET NULL · timestamps. Created lazily.
- **inbox_conversations** (`000200`): id · tenant_id · store_id · channel varchar(8) CHECK `IN ('web_chat','order',
  'email')` · thread_key varchar(300) · status varchar(8) CHECK `IN ('open','pending','closed')` default open · identity
  varchar(16) CHECK `IN ('verified_phone','order_access','email','email_unverified','unverified')` · assignee_id null FK
  users SET NULL · customer_id null FK (tenant_id, customer_id) → customers SET NULL · order_id null FK (tenant_id,
  order_id) → orders SET NULL (CHECK `channel <> 'order' OR order_id IS NOT NULL` enforced in code — the FK may null it) ·
  contact_name varchar(120) · contact_phone varchar(15) null · contact_email varchar(254) null · subject varchar(200)
  null (email) · context jsonb null (`{product_id, name, price_amount, currency, path}` on the first web-chat message) ·
  source_path varchar(300) null (path only, no query) · preview varchar(160) (last customer/reply text, notes excluded)
  · last_message_at · last_customer_message_id char(26) null · last_customer_message_at null · first_response_at null ·
  last_inbound_message_id varchar(255) null (email threading) · reply_sms_sent_at null · customer_seen_at null ·
  closed_at null · closed_by null FK users SET NULL · blocked_at null · blocked_by null · messages_count int default 0
  · revision int default 1 · timestamps. **U(store_id, channel, thread_key)** · IX(tenant_id, store_id, status,
  last_message_at DESC, id DESC) · IX(tenant_id, store_id, assignee_id, status) · IX(tenant_id, customer_id) ·
  IX(tenant_id, order_id) · trigram IX(contact_name) on pgsql.
- **inbox_messages** (`000300`): id · tenant_id · store_id · conversation_id FK (tenant_id, conversation_id) CASCADE ·
  kind varchar(8) CHECK `IN ('customer','reply','note','system')` · author_user_id null FK users SET NULL · body text
  null CHECK `char_length(body) <= 4000` (null only for system) · system_event varchar(16) null CHECK `IN ('assigned',
  'unassigned','pending','closed','reopened','order_linked','order_unlinked','blocked','unblocked')` · system_meta jsonb
  null (`{assignee: UserRef|null, order_number}`) · client_id varchar(36) null · delivery_status varchar(8) null CHECK
  `IN ('queued','sent','failed')` (email replies) · sms_status varchar(16) null CHECK `IN ('pending','sent','seen',
  'throttled','no_credits','failed','not_applicable')` (replies) · sms_message_id char(26) null (soft ref) ·
  email_message_id varchar(255) null · saved_reply_id null (soft ref) · created_at · updated_at. **U(conversation_id,
  client_id) WHERE client_id IS NOT NULL** (idempotent sends) · **U(store_id, email_message_id) WHERE email_message_id IS
  NOT NULL** (inbound dedupe) · IX(tenant_id, conversation_id, id). Messages are immutable (no edit/delete endpoint).
- **inbox_attachments** (`000300`): id · tenant_id · store_id · media_id **U** FK (tenant_id, media_id) → media RESTRICT ·
  message_id null FK (tenant_id, message_id) → inbox_messages CASCADE · saved_reply_id null FK → inbox_saved_replies
  CASCADE · uploaded_by_type varchar(8) CHECK `IN ('user','shopper','email')` · uploaded_by_user_id null ·
  widget_session_id null · filename varchar(160) · mime varchar(32) CHECK `IN ('image/jpeg','image/png',
  'application/pdf')` · size_bytes int CHECK `<= 5242880` · created_at. CHECK `NOT (message_id IS NOT NULL AND
  saved_reply_id IS NOT NULL)`. IX(tenant_id, message_id).
- **inbox_reads** (`000400`): id · tenant_id · store_id · conversation_id FK CASCADE · user_id FK users CASCADE ·
  last_read_message_id char(26) · read_at · **U(conversation_id, user_id)** · IX(tenant_id, user_id).
- **inbox_saved_replies** (`000500`): id · tenant_id · store_id · title varchar(60) · shortcut varchar(24) · body text
  CHECK `char_length BETWEEN 1 AND 1000` · show_as_chip bool default false · position int · use_count int default 0 ·
  last_used_at null · created_by / updated_by null FK users SET NULL · revision int default 1 · timestamps.
  **U(store_id, lower(shortcut))** · IX(tenant_id, store_id, position).
- **inbox_widget_sessions** (`000600`): id · tenant_id · store_id · token_hash char(64) **U** (sha256 of the 43-char
  token) · name varchar(80) · phone varchar(15) · status varchar(10) CHECK `IN ('pending','verified','unverified')` ·
  code_hash char(64) null (HMAC-SHA256, `INBOX_CODE_SECRET` ∥ session id) · code_sent_at null · code_attempts smallint
  default 0 · code_sends smallint default 0 · pending_message jsonb null (`{body, attachment_ids, context, source_path,
  client_id}`) · verified_at null · conversation_id null FK SET NULL · ip_hash char(64) · last_seen_at · expires_at ·
  timestamps. IX(tenant_id, store_id, phone, created_at) · IX(expires_at).
- **inbox_magic_links** (`000600`): id · tenant_id · store_id · conversation_id FK CASCADE · code_hash char(64) **U** ·
  uses smallint default 0 (≤ 20) · expires_at · created_at.

**Changed**
- **media**: purpose `inbox_attachment` (`MediaPurpose::InboxAttachment`; mimes jpeg/png/pdf, 5 MB, sides [32, 10000],
  no variants, private; widen the purpose CHECK if one exists in `000300`).
- **sms_messages** (`000700`): `reference_type` CHECK + `conversation`; `SmsPurposes::LISTED` + `inbox_verify`,
  `inbox_reply` (transactional; `SmsTemplates::COUNTED` gains both; `body_preview` always null for `inbox_verify`;
  the reply SMS preview shows the link as `[link]`).
- **Permission catalogue**: `inbox.manage` (code; no migration — system roles are code-defined; custom roles unchanged).

### 3.1 Locking
Send / status / assign / read take the **conversation row `FOR UPDATE`** first (then nothing else of the inbox); the
SMS charger's account lock (8.9a §3.3) is taken only inside the reply-SMS **job**, never in a request holding a
conversation lock. Widget verify takes the session row `FOR UPDATE`, then (first verify) inserts/locks the conversation by
`ON CONFLICT (store_id, channel, thread_key) DO UPDATE … RETURNING` — no duplicate threads under races.

## 4. Channels (owner API/WEB; `GET|PATCH /stores/{store}/inbox/settings`)
`InboxSettings`: `channels.web_chat` `{enabled, live_on: primary host | null}`, `channels.order_messages` `{enabled}`,
`channels.email` `{enabled, address: string | null, available: boolean}` (`available` false while
`INBOUND_MAIL_DRIVER` or `INBOX_MAIL_DOMAIN` is unset; turning it on then → 422 `inbox_email_unavailable`), `widget` `{reply_time, hours, greeting}`, `external_channels`
(fixed placeholders `messenger`, `whatsapp`, `instagram` with `status: 'coming_later'`), `revision`, `can`
(`{edit: settings.manage}`). PATCH (`settings.manage`, `revision` required, 409 `revision_conflict`): channel booleans,
`widget_reply_time`, `widget_hours` (≤ 40), `widget_greeting` (≤ 200, plain text). First `email_enabled = true`
generates `email_key`. `POST …/inbox/settings/email-address/rotate` (`settings.manage`) → new key; the old address stops
at once (Q305 grace later). Audited `inbox.settings_updated`, `inbox.email_address_rotated`. Turning `web_chat` on/off
revalidates the storefront tag `store:{host}` (config carries `inbox`, §9.1). Turning a channel **off** stops new
inbound on it (widget hidden; order card hidden; inbound mail dropped with 202) — existing conversations stay and
members can still reply (web chat replies then reach the shopper only through an existing magic link / session).

## 5. Conversation list and summary (owner API/WEB)
- `GET /stores/{store}/inbox/summary` → `InboxSummary` `{unread, open, pending, mine_open, unassigned_open,
  channels_enabled: {web_chat, order_messages, email}}` (unread per P88E-9). ETag/304.
- `GET /stores/{store}/inbox/conversations` — `filter[status]` (`open` default | `pending` | `closed`),
  `filter[scope]` (`mine_unassigned` default | `mine` | `unassigned` | `all`), `filter[channel]` (comma list), `q`
  (≥ 2: contact name, phone digits, email, order number; `%`/`_` literal), `cursor`; 30 per page ordered
  `(last_message_at DESC, id DESC)`; `meta` = `InboxListMeta` (`counts {open, pending, closed}` for the same scope /
  channel / q; cursor fields). Rows `InboxConversationSummary`: id, channel, status, identity, contact (name, phone,
  email), order ref `{id, number}` | null, preview, last_message_at, assignee `UserRef` | null, `unread_count` (customer
  messages after my last read, capped 99), blocked. ETag/304.

## 6. Thread (owner API/WEB)

### 6.1 `GET /inbox/conversations/{conversation}` → `InboxConversation`
Summary fields + `subject`, `context` (product card), `source_path`, `started_at`, `first_response_seconds`,
`customer_seen_at`, `revision`, `customer` (§6.3), `can` (`reply`, `assign`, `link_order` = + `orders.view`,
`delete` = + `customers.delete`, `view_customer` = `customers.view`, `view_order` = `orders.view`).

### 6.2 Messages
`GET …/messages` — `after={id}` (polling, oldest first, ≤ 100) or `before={id}` (history, newest 50 then reversed);
default = the latest 50. `InboxMessage`: id, kind, body, author `UserRef` | null (null for customer/system), attachments
`InboxAttachment[]`, system `{event, assignee, order_number}` | null, delivery_status, sms_status, seen (reply rows:
`created_at ≤ customer_seen_at`), created_at. ETag/304.
`POST …/messages` `{kind: 'reply'|'note', body (1–4000, trimmed; may be empty only with attachments), attachment_ids
(≤ 3, own unattached uploads of this store), client_id (uuid, required), saved_reply_id?}` → 201 `InboxMessage`; a
replay with the same `client_id` → 200 with the stored row. Reply effects (one transaction under the conversation
lock): closed → open + `reopened` system row; `first_response_at` set once; preview/last_message_at; channel dispatch
after commit — `email` → `SendInboxEmailReply`; `web_chat` (verified) / `order` → `sms_status = pending` +
`SendInboxReplySms` delayed 120 s; unverified / blocked → `not_applicable`. Notes: no status change, no dispatch.

### 6.3 Side panel `InboxConversation.customer`
`contact` always; with `customers.view`: `customer` `{id, name, since, orders_count, phone, email, address (district,
thana, street)}` or null + `risk` (`CustomerRisk`, P88-4); with `orders.view`: `linked_order` (`InboxOrderCard`: id,
number, placed_at, status, payment_status, payment_method, first line `{name, variant, qty, image_url}`, extra_lines,
paid_amount, due_amount, total_amount, currency) and `past_orders` (≤ 5, newest, excluding the linked one: id, number,
placed_at, total_amount, status). Keys missing → field `null` and the card hidden.

### 6.4 Actions (all `inbox.manage`, conversation lock, system row, `revision` optional → 409 on mismatch)
- `POST …/assign` `{assignee_id: string|null}` → `InboxConversation` (P88E-4); audited `inbox_conversation.assigned`.
- `POST …/status` `{status}` → same status = no-op 200. Closing sets closed_at/by.
- `PUT …/order` `{order_id: string|null}` (+ `orders.view`; channel `order` → 422 `inbox_order_locked`; order of
  another store → 404).
- `POST …/block` / `…/unblock` (audited). Blocked: shopper messages dropped (202-equivalent to the shopper), excluded
  from badge counts, row shows "Blocked".
- `POST …/read` `{last_read_message_id}` → 204; never moves backwards.
- `DELETE …/conversations/{c}` (+ `customers.delete`) → 204, cascades, objects deleted after commit, audited with a
  snapshot (contact masked, counts).
- `GET /inbox/assignees` → `InboxAssignee[]` `{user: UserRef, role_name, open_count, is_you}` — members holding
  `inbox.manage`, ordered you first then name.

## 7. Attachments (owner API)
`POST /stores/{store}/inbox/attachments` multipart `file` (`inbox.manage`; limiter `inbox-upload` 30/min per member) →
201 `InboxAttachment` `{id, filename, mime, size_bytes, status (processing|ready), kind ('image'|'pdf')}`; 422
`validation_failed` (`file`: type/size). `GET /inbox/attachments/{attachment}/link` → `{url, expires_at}` signed
5-minute URL to `GET /api/v1/inbox-attachments/{attachment}/download` (tenant from the signature; image inline, PDF
attachment, headers P88E-7); processing → 409 `inbox_attachment_processing`; impersonation → 403
`impersonation_attachment_hidden`. Only attachments of this store's messages / saved replies / own pending uploads.

## 8. Saved replies (owner API/WEB, `inbox.manage`)

### 8.1 Routes
`GET /inbox/saved-replies` (`q`, `filter[chip]=1`, `filter[attachment]=1`; meta counts `{all, chips, with_attachment}`;
ordered by position) · `POST` (201) · `PATCH /{id}` (`revision`) · `DELETE /{id}` (204) · `POST
/inbox/saved-replies/reorder` `{ids: [...] (all ids)}` · `POST /inbox/conversations/{c}/saved-replies/{r}/render` →
`{body, attachment: InboxAttachment|null, unresolved: string[]}`. Errors: 409 `saved_reply_shortcut_taken`, 422
`saved_reply_limit_reached` (200), 422 `saved_reply_unknown_merge_tag` (details `{tags}`). Audited
`inbox_saved_reply.created|updated|deleted`. The attachment of a saved reply is **copied** (new media row) into each
reply that uses it.

### 8.2 Merge tags
`{customer_name}` (contact first name), `{shop_name}`, `{order_number}`, `{order_total}`, `{order_due}` (COD to pay),
`{delivery_inside}` / `{delivery_outside}` (current Inside/Outside Dhaka shipping rates), `{payment_link}` (the linked
order's newest **active** payment link URL), `{track_url}` (`https://{primary_host}/track`). A tag without a value
(no linked order, no active link) is left in the text and listed in `unresolved`; the composer highlights it and blocks
Send until edited. Money formatted `৳1,920`.

## 9. Website chat (owner API/SF)

### 9.1 Config
`StorefrontConfig.inbox` = `{web_chat: {enabled, reply_time, hours, greeting} | null, order_messages: boolean}`
(null/absent → no widget). Never on draft/preview responses (`store.status = 'draft'` → null).

### 9.2 Storefront API (server-to-server; `storefront` middleware; `X-Storefront-Host` + key; `X-Storefront-Client-Ip`)
| Method | Path | Notes |
|---|---|---|
| GET | `/storefront/inbox/session` | `X-Inbox-Session` → `InboxWidgetSession` `{status, name, phone_masked, unread_count, resend_after}`; unknown/expired → 404 `inbox_session_invalid` |
| POST | `/storefront/inbox/sessions` | multipart `name` (1–80), `phone` (BD mobile), `message` (1–2000), `file?`, `product_slug?`, `page_path?`, `client_id`, `website` (honeypot) → 201 `InboxWidgetStart` `{session_token, status: 'code_sent'|'unverified', phone_masked, resend_after}`. `code_sent` = SMS sent, message held; `unverified` = P88E-14 (message delivered). Limiters `inbox-widget-start` + `inbox-widget-code` |
| POST | `/storefront/inbox/sessions/verify` | `{code}` → `{status: 'verified', unread_count}`; message delivered. 422 `inbox_code_invalid` (details `{attempts_left}`), `inbox_code_expired`; 5th wrong → session reset to require a new code |
| POST | `/storefront/inbox/sessions/resend` | 60 s cooldown → 429 `rate_limited` with `retry_after` |
| GET | `/storefront/inbox/messages` | `after?` → `InboxShopperMessage[]` (customer + reply only; author shown as the shop name; attachments as proxied ids; `seen`: reply rows = shopper saw it, customer rows = a member has read up to it, and a read that moves the shop's furthest point bumps the store version), ETag/304 |
| POST | `/storefront/inbox/messages` | multipart `body`, `file?`, `client_id` → 201 (verified or unverified session only; pending → 409 `inbox_session_unverified`) |
| POST | `/storefront/inbox/messages/seen` | → 204; sets `customer_seen_at`, reply rows' `sms_status pending → seen` |
| GET | `/storefront/inbox/attachments/{id}` | stream (own conversation only; same headers as §7) |
| POST | `/storefront/inbox/links/{code}` | magic link → `{kind: 'chat', session_token}` or `{kind: 'order', access_token, number}`; 404 `inbox_link_invalid`; limiter `inbox-link` |
All 404 `inbox_unavailable` when the channel is off; 409 `store_not_live` for draft stores.

### 9.3 Widget behaviour (owner SF; `components/inbox/**`, route handlers `app/api/chat/**`, `app/m/[code]/route.ts`)
- Client component mounted in the store layout when `config.inbox.web_chat` is set; never on preview or draft. Launcher
  pill "Chat with us" bottom-right 32 px (`2125:9509`), unread badge, dismissible teaser (dismissal in `sessionStorage`,
  try/catch). Open: 380 px panel (`2125:9736`), mobile bottom sheet with scrim (`2126:10484`); focus trapped, Esc closes,
  `aria-live` on new messages.
- No session: guest form (Your name, Mobile number "We text you when we reply", Message, "Add a photo or PDF · up to 5
  MB", **Send message**, privacy line). On PDP the product card "Asking about {product} · {price}" is sent as
  `product_slug`. After send: code step (composed; Figma has none: "Enter the 6-digit code we sent to 017••••5678",
  Resend in 60 s, "Change number") → sent state (`2125:10004`): context card, greeting, customer bubble "Sent · {time}
  ✓", confirmation "Thanks, {name}! We usually reply in a few minutes, and we'll text 017••••5678 when we do.", composer.
  Unverified fallback: "We couldn't text you a code right now. Your message is with the shop — keep this page open or come
  back on this device to see the reply." No typing row (Q305).
- Session cookie `sp_chat`: httpOnly, Secure (except localhost), SameSite=Lax, path `/`, 90 days, set by the route
  handler from `session_token`; the browser never sees the token in JS. Route handlers forward to the API with the
  storefront key and `X-Storefront-Client-Ip`; responses `no-store`.
- Polling §12. Shop replies autolinked (P88E-23); shopper text plain.
- `/m/{code}` route: POST the code to the API, set `sp_chat` (chat) or `sp_order_access` (order) and redirect to `/?chat=open`
  or `/track?view=messages`; invalid → `/` with no cookie.

### 9.4 Delivery into the Inbox
Verify (or unverified start) creates/reuses the conversation (P88E-2) under §3.1, links the customer (P88E-22), stores
the message with its attachments and context, sets status `open` (reopen rules P88E-5), updates preview and
`last_customer_message_*`, bumps the inbox version. A blocked conversation swallows the message (shopper sees success).

### 9.5 Reply SMS (`Inbox\Jobs\SendInboxReplySms`, `TenantAware`, queue `sms`)
Runs 120 s after a reply: lock the conversation; skip (`seen`) if `customer_seen_at ≥ reply.created_at`; skip
(`throttled`) if `reply_sms_sent_at` within 30 min; else create a magic link (7 days), render, `SmsCharger::charge`
(purpose `inbox_reply`, reference `conversation`), send on route `shop` with the store's sender ID (P89A-17 prefix
rule). Result → `sent` / `no_credits` / `failed` (refund per 8.9a). Texts (`resources/sms/{bn,en}.php` key
`inbox_reply`, not editable in 8.8e): bn `{shop}: আপনার মেসেজের উত্তর দেওয়া হয়েছে। দেখুন: {url}` · en `{shop}: We
replied to your message. Read it here: {url}`. Code text key `inbox_verify`: bn `{shop}: আপনার কোড {code}। ১০ মিনিট
কার্যকর।` · en `{shop}: Your code is {code}. It expires in 10 minutes.`

## 10. Order messages (owner API/SF)
- `StorefrontOrderTracking.messages` (from `POST /storefront/orders/track`, `GET /storefront/orders/confirmation` and the
  new `GET /storefront/orders/access`) = `{enabled, access_token, unread_count, reply_time}` or null when the channel is
  off. `access_token` = stateless `base64url(order_id.exp)` + HMAC-SHA256 (`INBOX_ORDER_SECRET`, bound to tenant +
  store), 12 h from track, 24 h from confirmation, 7 days from a magic link.
- `GET /storefront/orders/access` (`X-Order-Access`) → `StorefrontOrderTracking` (same limited view as track).
- `GET|POST /storefront/orders/messages` (+ `/seen`, attachments as §9.2) with `X-Order-Access`; 404
  `order_access_invalid` on a bad/expired token. The first POST creates the `order` conversation (contact from the
  order snapshot, customer + order linked). Limiter `inbox-widget-message` keyed by order.
- SF: **Messages** card in the right column of the `/track` result and of `/checkout/thank-you` (`2126:10642`):
  "Replies in about an hour" (reply_time), thread (shop bubble bg/sunken, customer bubble bg/brand + "Seen"),
  attachments, textarea "Write a message about this order…", "Attach photo or PDF", **Send**, note "We also text you
  when the shop replies. Messages stay with this order."; replaces nothing on `/track` (the "Problem with this order?"
  link exists only on the unbuilt account page). Token kept in httpOnly cookie `sp_order_access` (path `/`, 12–24 h).
  Mobile: card stacks under the timeline.

## 11. Email replies (owner API)

### 11.1 Addresses and outbound
`config/inbox.php`: `mail_domain` (`INBOX_MAIL_DOMAIN`, e.g. `in.storeplix.com`), `reply_secret`, `inbound_driver`
(`INBOUND_MAIL_DRIVER=fake|mailgun`), `mailgun.signing_key`. Store address `shop-{key}@domain`; conversation
`c-{ulid lower}-{sig}@domain`; order `o-{ulid lower}-{sig}@domain` (P88E-15). `OrderPlacedMail` Reply-To = the order
address when the email channel is on (else unchanged). `SendInboxEmailReply` (`TenantAware`, 3 tries, backoff 1/5/15
min) per P88E-16; failure → `delivery_status = failed`, thread shows "Not delivered".

### 11.2 Inbound `POST /api/v1/webhooks/inbound-email/{driver}` (public, `throttle:webhooks`, ≤ 25 MB)
1. Driver verifies the signature (`mailgun`: HMAC-SHA256 of timestamp+token with the signing key, |now − timestamp| ≤
   15 min, token unseen in the platform cache for 1 h) → else 401 `inbound_email_signature_invalid`, nothing stored.
2. Parse recipients (To/Cc/envelope); the first address on `mail_domain` decides the target; none or unknown key /
   bad sig → 202 `{accepted: false}` (no bounce, no oracle).
3. Resolve tenant + store on `pgsql_admin` (`// cross-tenant: inbound email routing`, `Inbox\Support\InboundRouter`),
   then `TenantContext::run`; queue `ProcessInboundEmail` (`webhooks` queue) with the parsed payload (text, sender,
   subject, Message-ID, In-Reply-To, auth verdict, ≤ 3 accepted attachments) — raw MIME discarded.
4. Job: channel off → drop; loop/auto mail (`Auto-Submitted` ≠ no, `Precedence: bulk|junk|list`, mailer-daemon/postmaster
   senders, provider spam flag) → drop; dedupe `U(store_id, email_message_id)`; per-sender limit 20/h per store; text =
   text part (else HTML → text), quoted history trimmed (`On … wrote:` / `>` blocks / signature `-- `), ≤ 4000 chars
   (rest dropped with "…"); attachments filtered by sniffed type/size (rejected ones noted "1 attachment was not
   accepted"). Target `c-`: the conversation if the sender equals its `contact_email`, else treated as the store address.
   Target `o-`: thread `email:{sender}` with the order linked (system row). Store address: thread `email:{sender}`.
   Identity `email` when SPF/DKIM pass else `email_unverified` (never auto-linked). Reopen rules P88E-5.
Webhook answers 200/202 within 10 s; `202 {accepted}` = `WebhookAck`.

## 12. Realtime and the sidebar badge (owner API/WEB/SF)
ETag rules P88E-17 (`W/"ix{store_version}.{read_version}.{hash}"`; versions bumped after commit). WEB intervals (tab
visible; hidden → paused, refetch on focus): summary **30 s** (sidebar badge, all pages, only with `inbox.manage`), list
**15 s** while `/inbox` is open, thread **5 s** with `after`. SF: widget open **5 s**, closed with a session **60 s**
(badge), order card **10 s**; stop after 30 min without interaction. All through TanStack Query `refetchInterval`;
304 keeps cached data (client helper §15).

## 13. API surface and errors (openapi 1.25.0 binding)

### 13.1 Merchant (`routes/inbox.php` + include line; merchant group; `{store}` scoped; limiter `inbox-write` 120/min per member on writes)
| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/stores/{store}/inbox/summary` | `inbox.manage` | §5, ETag |
| GET | `/stores/{store}/inbox/conversations` | `inbox.manage` | §5, ETag |
| GET · DELETE | `/stores/{store}/inbox/conversations/{conversation}` | GET `inbox.manage` · DELETE + `customers.delete` | §6.1, §6.4 |
| GET · POST | `/stores/{store}/inbox/conversations/{conversation}/messages` | `inbox.manage` | §6.2, ETag on GET, POST 201 |
| POST | `…/conversations/{conversation}/assign` · `/status` · `/block` · `/unblock` · `/read` | `inbox.manage` | §6.4 |
| PUT | `…/conversations/{conversation}/order` | `inbox.manage` + `orders.view` | §6.4 |
| POST | `…/conversations/{conversation}/saved-replies/{saved_reply}/render` | `inbox.manage` | §8.2 |
| GET | `/stores/{store}/inbox/assignees` | `inbox.manage` | §6.4 |
| POST | `/stores/{store}/inbox/attachments` | `inbox.manage` | §7 · `inbox-upload` 30/min, 201 |
| GET | `/stores/{store}/inbox/attachments/{attachment}/link` | `inbox.manage` | §7 |
| GET · POST | `/stores/{store}/inbox/saved-replies` | `inbox.manage` | §8.1 |
| PATCH · DELETE | `/stores/{store}/inbox/saved-replies/{saved_reply}` | `inbox.manage` | §8.1 |
| POST | `/stores/{store}/inbox/saved-replies/reorder` | `inbox.manage` | §8.1 |
| GET · PATCH | `/stores/{store}/inbox/settings` | GET `inbox.manage\|settings.manage` · PATCH `settings.manage` | §4 |
| POST | `/stores/{store}/inbox/settings/email-address/rotate` | `settings.manage` | §4 |
| GET | `/inbox-attachments/{attachment}/download` | signed URL | §7 (public route in `api.php`) |

### 13.2 Storefront and webhook — §9.2, §10, §11.2. Limiters: `inbox-widget-start`, `inbox-widget-code`,
`inbox-widget-message`, `inbox-link`, plus `storefront`; webhook `webhooks`.

### 13.3 Error codes (new)
`inbox_assignee_invalid` (422), `inbox_order_locked` (422), `inbox_attachment_processing` (409),
`impersonation_attachment_hidden` (403), `saved_reply_shortcut_taken` (409), `saved_reply_limit_reached` (422),
`saved_reply_unknown_merge_tag` (422, details `{tags}`), `inbox_unavailable` (404), `inbox_session_invalid` (404),
`inbox_session_unverified` (409), `inbox_code_invalid` (422, details `{attempts_left}`), `inbox_code_expired` (422),
`inbox_link_invalid` (404), `order_access_invalid` (404), `inbound_email_signature_invalid` (401),
`inbox_email_unavailable` (422). Existing:
`validation_failed`, `revision_conflict`, `impersonation_read_only`, `rate_limited`, `store_not_live`, `not_found`.

## 14. Audit and security

### 14.1 Audit actions (`INBOX_AUDIT_ACTIONS`)
`inbox.settings_updated`, `inbox.email_address_rotated`, `inbox_conversation.assigned`, `inbox_conversation.blocked`,
`inbox_conversation.unblocked`, `inbox_conversation.deleted`, `inbox_saved_reply.created`, `inbox_saved_reply.updated`,
`inbox_saved_reply.deleted`. Meta never holds message bodies, codes, tokens or unmasked phones. Status changes and
replies live in the thread (system rows), not the audit log.

### 14.2 Security checklist (S234–S247; each has a test)
- **S234** isolation: every conversation, message, attachment, saved reply, read, session and link of another tenant or
  store → 404; RLS on the 8 tables; `assertTenantIsolation` + `assertStoreIsolation` for conversations, saved replies,
  attachments; ids in bodies (`attachment_ids`, `assignee_id`, `order_id`, `saved_reply_id`) resolved within the store.
- **S235** permissions: route map O/A/S/C for `inbox.manage`, `settings.manage`, `orders.view`, `customers.view`,
  `customers.delete` combinations; impersonation 403 on writes and attachment links; no API-key route.
- **S236** notes never leave: storefront, email, SMS, magic link and shopper attachment paths never return `note` /
  `system` rows or their attachments (query + static test).
- **S237** shopper access: widget endpoints only with a valid `sp_chat` session of this store; order endpoints only with a
  valid, unexpired, store-bound order token; a shopper sees only their own conversation's customer/reply rows and
  attachments; tokens are random (session 256 bit, link 128 bit) and stored as sha256.
- **S238** verification: HMAC codes, 10-min TTL, 5 attempts, 60 s resend, per-phone/IP limiters; no oracle (same
  response for any number; blocked numbers still go through the normal path); codes never in DB, logs, `sms_messages`
  preview or audit.
- **S239** SMS cost: reply SMS only to verified/order phones, through `SmsCharger`, ≤ 1 per conversation per 30 min,
  skipped when seen; never for unverified/email/blocked; static sender allow-list.
- **S240** widget abuse: limiters, honeypot, body caps, control-character stripping, blocked conversations swallow
  messages, draft stores closed.
- **S241** attachments: sniffed JPG/PNG/PDF, ≤ 5 MB, ≤ 3, private disk under the tenant prefix, images re-encoded,
  never a library purpose, signed 5-min member links, shopper stream only through the proxy for own messages,
  `nosniff` + sandbox CSP + PDF as attachment.
- **S242** XSS: all bodies rendered as text; email HTML converted to text server-side; autolink only shop replies on
  storefront/email with `rel` set; no `dangerouslySetInnerHTML`.
- **S243** inbound email: signature + timestamp + replay cache; unknown addresses accepted silently; HMAC-signed reply
  addresses (a guessed `c-…` without the sig is ignored); sender must match to append; loop/bulk/auto mail dropped;
  dedupe by Message-ID; per-sender limit; raw MIME never stored.
- **S244** identity linking: customer auto-link only for verified phone, order access or authenticated email; unverified
  threads never linked or texted.
- **S245** assignment: only current `inbox.manage` members; departed members unassigned; assignment email has no
  attachments and a ≤ 160-char preview.
- **S246** idempotency/races: `client_id` unique per conversation; two verifies of one phone create one conversation
  (Postgres race); inbound duplicates create one message.
- **S247** retention: prune command deletes conversations > 24 months with objects, sessions/links/uploads per P88E-18;
  delete conversation removes storage objects after commit.

## 15. ARCH and types (owner ARCH — done in this change)
openapi **1.25.0** (tag `inbox`; storefront and webhook paths; `StorefrontConfig.inbox`; `StorefrontOrderTracking.messages`;
`PermissionKey` + `inbox.manage`; `SmsPurpose` + `inbox_verify`, `inbox_reply`; `SmsReferenceType` + `conversation`).
`packages/types`: Inbox block (channels, statuses, identity, conversation, message, attachment, saved reply + merge tags,
settings, summary, list filters/meta, assignee, widget/order shopper shapes, errors, audit actions, constants) and the
edits above. `packages/api-client`: `inbox.summary/conversations/conversation/messages/send/assign/setStatus/linkOrder/
block/unblock/markRead/remove/assignees/uploadAttachment/attachmentLink/savedReplies.*/settings.*`, conditional GETs
returning `{ status: 'not_modified' } | { status: 'ok', data, etag }`, `storefront.inbox.*` and
`storefront.orderMessages.*`, `inboxConversationQuery`; tests `phase8-8e.test.ts`. Docs: ADR 0028, DATABASE-DESIGN
§5.14, SECURITY T45, MULTI-TENANCY count 103, OPEN-QUESTIONS Q287–Q305 (+ Q1, Q232), roadmap 8.8e + 8.8f.

## 16. Test requirements
**API (Pest)**, group `inbox` (+ `rls`, `security`, `race`): every §13 route (happy, validation, authz matrix,
impersonation, isolation); status/reopen/assign vectors incl. departed member; unread counts per member + badge scope;
ETag 304 on summary/list/messages and invalidation after each write; send idempotency (`client_id`); reply dispatch per
channel/identity (email job, SMS job with seen/throttle/no_credits/failed + refund, not_applicable); notes never in any
shopper/email/SMS output (S236, static); attachments (sniffing, 5 MB, 3 max, private path, re-encode, signed link,
processing 409, impersonation 403, prune); saved replies (shortcut unique case-insensitive, limit 200, reorder, render
every tag + unresolved, copy attachment, use_count); widget start/verify/resend/unverified fallback/honeypot/limiters/
blocked/draft store; magic link chat + order; order token issue/expiry/store binding and `/orders/access`; inbound email
(signature, timestamp, replay, unknown address 202, sig mismatch, sender mismatch, loop/bulk drop, dedupe, trimming,
attachment filtering, SPF/DKIM identity, channel off, order address linking); outbound email headers (Reply-To,
In-Reply-To, References) and failure; `OrderPlacedMail` Reply-To on/off; customer auto-link rules; delete + retention
prune; `sms_messages` purposes and `body_preview` (null for codes); Postgres races (two verifies, two sends with one
`client_id`, inbound duplicate); permission catalogue + system roles.
**Web (Vitest)**: nav item + badge gating; list chips/scope/channel filters, search, cursor, unread badges; thread
(bottom-anchored, history load, polling append, system rows, notes styling, failed send retry with the same `client_id`);
composer (Reply/Internal note toggle, `/` search, chips, unresolved tags block, attachments with progress + limits);
assign popover, status actions, close toast + Undo, reopen; side panel permission variants; saved replies page CRUD +
reorder; channels drawer (toggles, copy/rotate address, placeholders); first-run, all-caught-up, loading, error states.
**SF (Vitest)**: widget states (closed/teaser, form validation, code step, sent, unverified, mobile sheet), cookie route
handlers (httpOnly, no token in JS), polling stop, autolink only shop replies; order Messages card on track/thank-you.
**QA (Playwright)** `phase8-8e.spec.ts` (fake SMS + inbound drivers): owner turns channels on; shopper chats from a PDP
(code from the fake SMS sink) → message in Inbox with product card; staff replies with a saved reply → after the job the
fake sink has the reply SMS with a link → opening `/m/{code}` shows the reply; internal note never visible on the
storefront; order Messages from `/track`; fake inbound email creates an email conversation, reply produces a mail in
Mailpit/log with the signed Reply-To; assign → assignee email; close → shopper writes → reopened and assigned; staff
without `inbox.manage` (custom role) has no Inbox; 390 px screenshots of list, thread and widget sheet.
**QA infra**: CI Pest group `inbox` on sqlite, Postgres and RLS; race tests in `api-perf` / `api-rls` lists.

## 16.1 File ownership

| Agent | Owns (create/edit) |
|---|---|
| **API (Laravel)** | `apps/api/**` only: `app/Domain/Inbox/**` (models, services, presenters, requests, policies, jobs, mail, `InboundRouter`, drivers, `InboxServiceProvider` limiters, console `inbox:prune`), `routes/inbox.php` + include line, storefront/webhook routes in `routes/inbox.php` (own groups) and the signed download in `api.php`, migrations `2026_12_13_*`, `config/inbox.php`, `resources/sms/{bn,en}.php` (two new keys), `resources/views/mail/inbox/*`, `Media/MediaPurpose.php` (`inbox_attachment`), `Sms/SmsPurposes.php` + `SmsTemplates::COUNTED` + static allow-list, `Orders/Mail/OrderPlacedMail.php` (Reply-To), `Orders/OrderPresenter.php` + storefront order controller (`messages`, `/orders/access`), storefront config presenter (`inbox`), `Tenancy/Authorization/Permission.php` + `SystemRole.php`, `Tenancy` (`RlsTables`), `rls-emergency-off.sql`, staff membership listener hook, `AuditLogger` subject types, tests |
| **WEB (React)** | `apps/merchant-dashboard/**`: `src/inbox/**` (new: page, list, thread, composer, side panel, assign popover, saved replies page, channels drawer, polling hooks), `src/layout/nav.ts` (Inbox `requires: can.manageInbox`, badge, mobile More "Sales"), `src/layout/Sidebar*` badge, `src/lib/permissions.ts` (`manageInbox`), `App.tsx` routes, fixtures/tests |
| **SF (Next.js)** | `apps/storefront/**`: `components/inbox/**` (widget, order Messages card), `app/api/chat/**`, `app/api/order-messages/**`, `app/m/[code]/route.ts`, store layout mount, `/track` + `/checkout/thank-you` card, `lib/inbox.ts`, tests |
| **ARCH** | `docs/**` except `docs/reviews/**`, TESTING.md, FIGMA-INDEX.md, AGENT-CONTRACTS.md; `packages/types/**`, `packages/api-client/**` (done) |
| **QA** | `tests/e2e/**` (`phase8-8e*.spec.ts`, fake inbound helper), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-8e-qa.md` |
ADMIN: **no change**. Shared-read rules: re-read `routes/api.php`, `OrderPresenter.php`, `OrderPlacedMail.php`,
`Permission.php`, `nav.ts`, the store layout before each Edit.

## 16.2 Order of work
1. ARCH: types + api-client + openapi (done), this file, ADR 0028, docs.
2. API: migrations + RLS → permission → settings → conversations/messages + attachments → actions + reads + ETag →
   saved replies → widget sessions + code SMS → reply SMS + magic links → order access + messages → email out → inbound
   webhook + router + job → prune, limiters, audit, static tests.
3. WEB: shell + list + summary badge → thread + composer → side panel → assign/status → saved replies → channels drawer
   → states + mobile.
4. SF: widget (form, code, thread) + route handlers → magic link route → order Messages card.
5. QA: specs + CI group while the others build; gate after all are green.

## 17. Acceptance criteria
1. A shop that turns nothing on sees no change anywhere (no widget, no card, same order email Reply-To); all
   pre-existing tests pass (catalogue counts and enum additions only).
2. With channels on, website chat (verified by SMS code), order messages and email replies land in one Inbox with one
   conversation per contact per channel thread; a shopper message reopens a closed conversation for its assignee.
3. Members with `inbox.manage` reply, write staff-only notes, attach JPG/PNG/PDF ≤ 5 MB, insert saved replies with merge
   tags, assign (assignee emailed), mark pending, close and reopen; unread counts per member drive the sidebar badge.
4. Shoppers get at most one reply SMS per 30 minutes per conversation, only to a proven number, charged through the 8.9a
   charger, with a link that reopens the conversation; email replies thread in the shopper's mail client.
5. Notes, other shoppers' messages and other stores' data never reach a shopper; inbound email is signature-verified
   (S234–S247).
6. Figma `2118:51165`, `2121:51432`, `2121:51977`, `2122:51964`, `2122:52543`, `2122:53073`, `2123:52602`,
   `2123:52877`, `2124:1335`, `2124:1509`, `2125:9509`, `2125:9736`, `2125:10004`, `2126:10484`, `2126:10642` match with
   the documented differences (§18); loading/empty/error; 390 px usable.
7. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `inbox`, `rls`, `security`, `race`),
   Playwright `phase8-8e*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

## 18. Figma notes for the PO (product owner)
- Channel cards on the first-run screen show **Off + Turn on** until enabled (Figma draws On, Q303).
- The widget gets a **code step** between "Send message" and "Sent" (not drawn) and an "unverified" note; there is no
  typing row (no typing indicators).
- The order Messages card sits on the `/track` result and thank-you page, not on an account order page (Q304).
- "Signed in · verified phone" in the side panel reads "Verified phone" / "Order access" / "Email (verified)" /
  "Number not verified".
- "Suggest when a customer asks about delivery" toggle on saved replies is hidden (8.8f AI, Q305); `@Sumon` in notes is
  plain text.
- "Connect a channel" opens the channels drawer: our three channels with switches; Messenger, WhatsApp and Instagram as
  "Coming later" cards (8.8f).
- Saved-reply merge tags: Figma's four plus `{shop_name}`, `{order_number}`, `{order_due}`, `{delivery_outside}`,
  `{track_url}`.

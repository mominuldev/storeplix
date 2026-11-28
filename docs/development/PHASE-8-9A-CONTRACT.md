# Phase 8.9a contract: SMS integration — credits, templates, sender IDs, SMS log (binding for ARCH, API, WEB, ADMIN, QA)

Status: **Accepted, 2026-11-28 — PO (product owner) set the scope (SMS integration first out of roadmap 8.9) and accepted
the proposed defaults for Q257–Q272**. Branch `feat/phase-8-9a-sms` (from `main` @ 7701c7c, after PR #21).
Roadmap task **8.9** is split: this file is **8.9a "SMS integration"**. Help center, tracking/marketing/AI integrations
stay under 8.9 ("scoped after PO confirms").
AC: **"A merchant sees how their shop's SMS are paid for and how they went, edits the order SMS texts in Bangla and
English, asks for their own sender ID, and buys SMS credits that keep messages going after the monthly allowance; Store
Plix staff review sender IDs and adjust credits; nothing changes for a shop that does none of this"** (§17).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-8D contracts and
docs/api/API-CONVENTIONS.md still applies. PHASE-5 §8 (order SMS: at most once per (order, event), S13 sanitising),
PHASE-5b P5B-28 (payment link SMS), PHASE-7 (platform billing invoices, platform bKash/SSLCommerz, rule 8, `BILLING_FAKE`),
PHASE-8-5 (campaign allowance P85-13/14, quiet hours P85-15, part counting P85-18, Q145 prefix), PHASE-8-6 (automation
steps share the campaign allowance, P86-8), PHASE-8-8 P88-13 (checkout OTP) and PHASE-8-8D P88D-12 (POS SMS receipt)
apply in full. **Amends** PHASE-5 §8 (templates become editable per store; skipped SMS get a log row), PHASE-7 §5
(`billing_invoices.kind` gains `sms_credits`; one open subscription invoice **and** one open SMS-credit invoice per
tenant), PHASE-8-5 §2.2 and PHASE-8-6 (allowance fit = allowance + SMS credits; Q140 money balance now exists as
credits), Q84 (SMS credit packs, now built) and Q145 (a masked sender ID drops the "{Shop}: " prefix).
Machine-readable spec: `docs/api/openapi.yaml` **v1.23.0** (tags `sms`, `billing`, `admin`). ADR **0026** (new: SMS
credits and sender IDs). Product defaults: OPEN-QUESTIONS **Q257–Q272**.

### Scope

**One PR, one QA gate.**

| Area | Owner | Ships |
|---|---|---|
| **Charging** | API | `SmsCharger`: allowance first, then credits, else skipped; every SMS sender goes through it (§4) |
| **Credits** | API | Account + append-only ledger, purchase via a platform billing invoice, admin adjust, low-credit alert (§5) |
| **Overview + test SMS** | API/WEB | §6 |
| **Templates** | API/WEB | Per-store bn/en bodies for 7 keys, preview, reset; checkout OTP read-only (§7) |
| **Sender ID** | API/WEB/ADMIN | Merchant request with trade licence; staff approve / reject / revoke (§8) |
| **SMS log** | API/WEB | 90-day per-store log, masked phones, no OTP text (§9) |
| **Super admin** | API/ADMIN | Sender ID queue + drawer, merchant SMS credits card + adjust dialog (§10.3, §13) |
| **Docs + types** | ARCH | openapi 1.23.0, `packages/types`, `packages/api-client` (**already written**, §14), ADR 0026, DATABASE-DESIGN §5.12, SECURITY T43, MULTI-TENANCY count, OPEN-QUESTIONS, roadmap |
| **QA** | QA | `phase8-9a.*`, Pest group `sms` (§15) |

**Out of scope** (hide, never fake): delivery reports / "Delivered" rate (Q267); a merchant's own SMS gateway and
"Disconnect" (Q257); promotional (marketing) masked sender IDs; per-message pricing for transactional vs marketing;
credit expiry, refunds of purchased packs, auto top-up (Q272); the Figma "Delivered" order event and `{review_link}`
(no such event); editable checkout OTP text; editable quiet hours (Q268); WhatsApp; SMS for account sign-in codes in the
log (`otp_*`, platform-paid).

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- **Part** = one SMS segment (P85-18: GSM-7 160 / 153 per part, UCS-2 70 / 67 per part; `SmsParts::count`).
  **Credit** = one part. **Allowance** = the plan's monthly `sms_per_month` (transactional, counts **messages**) or
  `campaign_sms_per_month` (marketing, counts **parts**) — units unchanged from P5-26 / P85-13.
- **Shared sender** = the platform caller ID (`REVESMS_CALLER_ID`, shown "Storeplix") with the "{shop}: " text prefix.
  **Masked sender** = the shop's approved sender ID.
- Money: integer paisa (BDT), VAT-inclusive like every platform invoice. Dates: store timezone (one store per tenant).
- `[S]` = store-scoped table (`BelongsToStore`); `[T]` = tenant-level table (`BelongsToTenant`, no `store_id`).
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**, storefront **:3010**; `SMS_DRIVER=fake` (tests)
  / `log` (dev), `BILLING_FAKE=true` for purchases.

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§16). Before every Edit of a shared-read file, re-read it.
- New dependencies: **none**. Never `migrate:fresh` the local dev DB.
- Every SMS that a shop pays for goes through `SmsCharger` (§4) — no sender may call `SmsGateway::send` for a
  tenant message without a charged `sms_messages` row (static test, §15).
- **A shop that never buys credits, never edits a template and never asks for a sender ID behaves exactly as before**:
  same texts byte for byte, same allowance behaviour, same timeline notes except the wording of the "used up" note
  (§4.4). Every existing Pest test and Playwright spec stays green without edits except added enum values and that note.

---

## 0. Summary and goals
Every shop already sends order SMS, checkout codes, POS receipts, campaigns and automation messages through the
platform's REVE SMS account, paid by a monthly plan allowance; when the allowance runs out, messages silently stop.
8.9a gives that a home at **Integrations → Messaging → SMS** (Figma `31:5120`): what is being sent and how it is paid,
editable Bangla/English texts, an optional own sender name, an SMS log, and **SMS credits** a shop can buy so messages
keep going after the allowance. Store Plix staff get a sender-ID review queue and can grant or deduct credits.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P89A-1 | **One gateway** (Q257): every shop sends through the platform REVE SMS account (`config/sms.php`). No merchant gateway, no credentials, no "Disconnect". The overview reports `gateway.status = 'connected'` always; `active_since` = the store's first `sent` SMS, `last_sent_at` = the latest | BTRC-registered platform account; nothing to connect |
| P89A-2 | **Send test SMS** (Q257): fixed text to the **acting member's verified phone** only (`users.phone` with `phone_verified_at`), language from the body or the store's `sms_language`; synchronous; purpose `sms_test`, kind transactional, charged like any transactional SMS; limiter `sms-test` 5/hour per member and store; audited `sms.test_sent`. Replaces Figma "Test connection" | Proves the shop can send without texting a stranger |
| P89A-3 | **Charging order** (Q258): an SMS is paid from the monthly allowance of its kind first; when that does not cover it, from the tenant's **SMS credits**; with neither it is **skipped** (`status = skipped`, `error_code = no_credits`). A message is paid wholly from one source (no split) | Allowance is free and expires monthly; credits never expire |
| P89A-4 | **Kinds and purposes** (§3.4): `transactional` = `order_placed`, `order_confirmed`, `order_shipped`, `order_cancelled`, `order_updated`, `payment_link`, `pos_receipt`, `checkout_otp`, `sms_test` → `sms_per_month` (1 per message). `marketing` = `campaign`, `automation` → `campaign_sms_per_month` (parts). Account codes `otp_*` (sign-up, sign-in, staff) are platform-paid: never charged, counted, or listed | Units and limits stay what P5-26 / P85-13 shipped |
| P89A-5 | **Credits** (Q258): per tenant, **1 credit = 1 part** for either kind, never expire. Balance on `sms_credit_accounts.balance` (row-locked), every change one row in the append-only `sms_credit_ledger` (`purchase`, `consume`, `refund`, `admin_adjust`) with `balance_after`; consume and refund are **idempotent per `sms_message_id`**; a final provider failure refunds | One number to show, a ledger to explain it |
| P89A-6 | **Credits never unlock a feature**: a 0 allowance (Free `campaign_sms_per_month`) stays 0 — campaigns/automations on Free still get 402 / skip; an unlimited allowance (`null`, Growth transactional) never touches credits. Campaign schedule/send and test checks fit when `needed ≤ allowance remaining + credits` (`CampaignEstimate.allowance.credits`, 1.23.0) | Credits are a top-up, not a plan bypass |
| P89A-7 | **Template keys** (Q261): editable `order_placed`, `order_confirmed`, `order_shipped`, `order_cancelled`, `order_updated`, `payment_link` (Figma "Payment link / advance"), `pos_receipt`; each in `bn` and `en`. `checkout_otp` listed **read-only** ("Managed by Fake order guard"). Figma "Delivered" + `{review_link}` is not built (no such event) | Exactly the texts the code sends today |
| P89A-8 | **Body rules** (Q261): 1–480 characters after trim; only the key's merge fields (§7.1) as `{field}`; required fields kept (`payment_link`: `url`); **no typed links** (`http://`, `https://`, `www.` → 422 `sms_template_link_not_allowed`); line breaks collapse to spaces (as `SmsTemplates::fill` today); the sample render (§7.3) must fit **3 parts** (422 `sms_template_too_long`, details `{parts, max_parts}`). Saving the default text deletes the custom row | Phishing-safe, cost-bounded |
| P89A-9 | **Packs and purchase** (Q259, Q260): `credits_1000` ৳350, `credits_5000` ৳1,600, `credits_10000` ৳3,000 (`config/sms.php` `packs`, paisa, VAT included). Bought by the **owner** (`billing.manage`) as a platform billing invoice **`kind = sms_credits`** (plan and interval null, `sms_credits` = pack credits) paid through the Phase 7 platform bKash / SSLCommerz flow. Credits are granted **only** when the payment is verified server-side (rule 8), once per invoice, in the same transaction that marks the invoice paid. An open SMS invoice lives 24 h; a new purchase voids the older open SMS invoice (`superseded`) and never touches subscription invoices | Reuses tested platform billing; no second money path |
| P89A-10 | **One source for on/off** (Q262): the per-event toggles shown on Overview and Templates are `store_settings.customer_sms[event]` — the same data as Settings → Notifications, written through the existing `PATCH /stores/{store}/settings` (`settings.manage`). `pos_receipt` is the cashier's tick, `checkout_otp` the Fake order guard rule: no toggle (`enabled: null`) | No drift between two screens |
| P89A-11 | **Defaults = today's texts** (Q261): `resources/sms/{bn,en}.php` stay the defaults, quoted in §7.2. `SmsTemplates::render` keeps S13 sanitising and the free-text shortening (footer, first_name, carrier, shop) and applies it to custom bodies too; shortening target becomes "≤ 3 parts" (`SmsParts`) instead of 201 characters | Behaviour unchanged until edited |
| P89A-12 | **Low-credit alert** (Q269): threshold `100 | 200 | 500 | null (off)` on `sms_credit_accounts.low_credit_threshold` (default **200** once the first credits arrive, null before). When a consume takes the balance below it, the owner gets **one** email; re-armed when the balance is back ≥ threshold or the threshold changes. `PATCH /billing/sms-credits` (`billing.manage | settings.manage`), audited `sms_credits.alert_updated` | "Notify you before messages stop" (Figma) without spam |
| P89A-13 | **Sender ID request** (Q263): `sender_id` 3–11 letters/digits with ≥ 1 letter (`SMS_SENDER_ID_PATTERN`), stored as typed, compared case-insensitively; `business_name` (2–120, as on the licence); `uses` ⊆ {order_updates, otp, pos_receipts} (≥ 1; "Promotions" chip shown disabled "Needs a separate approval later"); `rights_confirmed` tick; `note` ≤ 300; **trade licence** document. `integrations.manage`. Audited `sender_id.requested` | What BTRC registration through REVE needs |
| P89A-14 | **Review** (Q264): platform permission **`manage_domains`** (super_admin, support) on the queue, detail, document, approve, reject, revoke. Approve requires `provider_registered: true` (staff confirm REVE/BTRC registration) + reason; reject/revoke reason is shown to the merchant and emailed to the owner. Every action `// cross-tenant: sender-ID review` and audited (`sender_id.approved|rejected|revoked|document_viewed`, platform actor) | Support already reviews domains; same trust level |
| P89A-15 | **Uniqueness and limits**: one `pending` request per store (409 `sender_id_request_pending`, details `{request_id}`); one `approved` per store (approving supersedes the previous one); a sender ID is unique case-insensitively across **pending + approved** rows of **all** shops (409 `sender_id_taken`); reserved IDs (`config('sms.reserved_sender_ids')` + the platform caller ID) → 422 `sender_id_reserved`; the shop's active ID again → 422 `sender_id_unchanged`; limiter `sms-sender-id` 5/day per store; withdraw = pending → cancelled | A sender name identifies one business |
| P89A-16 | **Trade licence upload**: `media` row, new purpose **`sender_id_document`** with the `expense_receipt` rules (JPG/PNG/WebP/PDF ≤ 5 MB, sniffed, private disk, tenant prefix, images re-encoded, no variants, never a library purpose). Merchants never download it back (they see filename + size); staff stream it from `/admin/sender-ids/{id}/document` (`nosniff`, CSP sandbox, `no-store`, attachment) | Identity documents stay private |
| P89A-17 | **Masked sender drops the prefix** (Q265, amends Q145): with an approved sender ID the gateway call carries it as caller ID, and a body that starts with the literal `{shop}: ` has that prefix removed before rendering (other `{shop}` uses stay). With the shared sender nothing changes. Revocation falls back to the shared sender from the next message. `sms_messages.sender_id` records the caller ID used (null = shared) | The name is already on the phone |
| P89A-18 | **Admin credit adjust** (Q270): `POST /admin/tenants/{tenant}/sms-credits/adjust` (`manage_billing`), `credits` ±1…1,000,000 (never 0), reason 5–500 (shown to the merchant on the ledger), `Idempotency-Key` required; a deduction below 0 → 422 `sms_credits_insufficient`; one `admin_adjust` ledger row; audited `sms_credits.adjusted` (platform actor, `// cross-tenant: SMS credit adjustment`) | Goodwill credits and corrections, traceable |
| P89A-19 | **SMS log scope** (Q266): this store's `sms_messages` of the last **90 days** (store timezone), newest first, 50 per page, **cursor** pagination; filters purpose (list), status (list), from/to dates (≥ today − 90 d, else 422), exact phone (normalised `8801…`, invalid → 422) | Figma `2075:51037`; bounded query |
| P89A-20 | **`sms_messages` gains store columns** (§3.2): `store_id`, `kind`, `parts`, `charged_from`, `credits_charged`, `sender_id`, `body_preview`, `error_code`, `sent_at`; existing tenant rows are back-filled with the tenant's single store. The table stays a platform model (nullable `tenant_id`, RLS policy from Phase 2); the log query filters `tenant_id = context` **and** `store_id = {store}` **and** `purpose NOT LIKE 'otp\_%'` explicitly (RLS is the backstop) | Account OTP rows must keep working without a tenant |
| P89A-21 | **Privacy** (Q266): never store a checkout code or account code text (`body_preview` null for `checkout_otp`, `otp_*`); other rows keep a ≤ 160-character preview with every URL replaced by `[link]` (unsubscribe codes, payment tokens never stored); previews are nulled after 90 days (`sms:prune-previews`, daily); phones are masked in every API output (`01711-•••211`); provider raw text is never returned (`error_code` `provider_error` / `no_credits` only; `error` column stays internal) | OTPs and tokens are secrets; numbers are personal data |
| P89A-22 | **No delivery reports** (Q267): REVE DLR is not polled. Figma "Delivered" is shown as **"Sent successfully"** = sent / (sent + failed) this month; "Delivered" event row hidden | Honest number |
| P89A-23 | **Quiet hours** (Q268): the 8.5 rule (P85-15, `config('campaigns.quiet_from'/'quiet_to')` = 21:00–09:00 store time, marketing only) is shown read-only on the overview; no new setting. Figma "10 PM – 8 AM" select → read-only text | One rule, already built and tested |
| P89A-24 | **Where it lives** (Q271): Integrations list gets a **Messaging** group with one **SMS** card ("Active", "Storeplix SMS · BTRC-approved", Manage → `/integrations/sms`); the filter chips gain "Messaging". Route `/integrations/sms?tab=overview|templates|sender-id|log|credits` | Figma breadcrumb "Integrations › Messaging › SMS" |
| P89A-25 | **Permissions** (no new key): reads `settings.manage | integrations.manage | billing.view` (overview, templates list, credit account); template writes `settings.manage`; test SMS, sender-ID list, log `settings.manage | integrations.manage`; sender-ID request/cancel `integrations.manage`; credit ledger `billing.view`; low-credit alert `billing.manage | settings.manage`; purchase `billing.manage` (owner only). `SmsOverview.can` carries the flags (§10.1) | Existing keys map cleanly; owner-only money |
| P89A-26 | **Plan**: no new feature key; SMS integration, templates, sender ID and credits on every plan (Free included). Allowances unchanged | Credits are how a Free shop sends more |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q257–Q272; **answered 2026-11-28: proposed defaults accepted**)

| Q | Question | Proposed default |
|---|---|---|
| Q257 | Gateway, "Disconnect", "Test connection" | Platform REVE SMS only, always connected, no Disconnect; "Send test SMS" to the member's verified phone (5/hour, charged) |
| Q258 | How SMS are paid after the allowance | Allowance first (per kind), then purchased credits (1 credit = 1 part, both kinds, never expire), else skipped; failures refunded |
| Q259 | Pack sizes and prices | 1,000 ৳350 · 5,000 ৳1,600 · 10,000 ৳3,000 (VAT included, config) |
| Q260 | How credits are bought | Owner only; platform billing invoice `sms_credits` via bKash / SSLCommerz; credits after server-verified payment |
| Q261 | Editable templates | 6 order events + POS receipt, bn + en, merge tags, no typed links, ≤ 3 parts, reset to default; defaults = today's texts; checkout OTP read-only |
| Q262 | Event on/off toggles | Same data as Settings → Notifications (one source) |
| Q263 | Sender ID request | 3–11 letters/digits, business name, uses (order updates / OTP / POS receipts; promotions later), rights tick, trade licence (private), one pending per shop, unique across shops |
| Q264 | Who reviews sender IDs | Store Plix support / super admin (`manage_domains`); approve after REVE/BTRC registration; reject or revoke with a reason shown to the merchant |
| Q265 | Prefix with a masked sender ID (Q145) | Dropped: the leading "{Shop}: " is removed when the shop's own sender ID is used |
| Q266 | SMS log content | 90 days, store's messages only (no account codes), masked phones, ≤ 160-char preview with links hidden, never checkout codes |
| Q267 | Delivery reports | None yet; "Sent successfully %" instead of "Delivered" |
| Q268 | Quiet hours | The 8.5 fixed rule (9 PM – 9 AM, marketing only), shown read-only |
| Q269 | Low-credit alert | Off / below 100 / 200 / 500; one email to the owner per crossing; default 200 after the first purchase |
| Q270 | Staff credit adjustments | Grant/deduct with a reason (`manage_billing`), never below 0, audited, reason visible to the merchant |
| Q271 | Integrations list | SMS card in a new Messaging group (was hidden) |
| Q272 | Later SMS features (record only) | Delivery reports, merchant-own gateway, promotional sender IDs, per-kind pricing, credit expiry/refund of packs, auto top-up, editable OTP text, editable quiet hours, WhatsApp, "Delivered"/review event |

## 2. Permission and plan
No new permission key and no catalogue change (P89A-25). Route map rows for every §10 route (O/A/S parity fixture):
Owner ✓ everything; **Admin (Manager)** has `settings.manage`, `integrations.manage`, `billing.view` → everything except
purchase; **Staff** has none of them → no SMS page (sidebar unchanged; `/integrations/sms` → 403 page). Custom roles
follow their keys. Impersonation: every write → 403 `impersonation_read_only`. No external-API (API key) scope reaches
any SMS route. Plan: P89A-26.

## 3. Data (owner API; forward-only; RLS in each create migration; `database/sql/rls-emergency-off.sql`)

### 3.1 New tables (migrations prefix `2026_12_11_`; `RlsTables::TENANT` docblock "95 after Phase 8.9a")
- **sms_credit_accounts** (`000100`, `[T]`): id · tenant_id **U** FK tenants CASCADE · balance bigint default 0 CHECK
  `>= 0` · purchased_total bigint default 0 · low_credit_threshold smallint null CHECK `IN (100, 200, 500)` ·
  low_alert_sent_at timestamptz null (null = armed) · last_purchase_at timestamptz null · timestamps. Created lazily by
  `SmsCreditService::account()` with `INSERT … ON CONFLICT (tenant_id) DO NOTHING` then `SELECT … FOR UPDATE`.
- **sms_credit_ledger** (`000100`, `[T]`, **append-only**: RLS SELECT + INSERT policies only, no UPDATE/DELETE grant,
  as `audit_logs`): id · tenant_id FK tenants · type varchar(16) CHECK `IN ('purchase','consume','refund',
  'admin_adjust')` · credits int (signed) CHECK `(type IN ('purchase','refund') AND credits > 0) OR (type = 'consume'
  AND credits < 0) OR (type = 'admin_adjust' AND credits <> 0)` · balance_after bigint CHECK `>= 0` · sms_message_id
  char(26) null (soft ref — `sms_messages` is a platform table) · billing_invoice_id char(26) null FK (tenant_id,
  billing_invoice_id) → billing_invoices(tenant_id, id) RESTRICT · reason varchar(500) null (admin_adjust only) ·
  actor_type varchar(16) CHECK `IN ('system','user','platform')` · actor_user_id null FK users SET NULL ·
  idempotency_key varchar(100) null · request_hash char(64) null · created_at. Partial **U(sms_message_id, type) WHERE
  sms_message_id IS NOT NULL** (idempotent consume / refund); partial **U(billing_invoice_id) WHERE type = 'purchase'**
  (one grant per invoice); partial **U(tenant_id, idempotency_key) WHERE type = 'admin_adjust'**. IX(tenant_id,
  created_at DESC, id DESC); IX(tenant_id, type, created_at).
- **sms_templates** (`000200`, `[S]`): id · tenant_id · store_id · key varchar(24) CHECK `IN ('order_placed',
  'order_confirmed','order_shipped','order_cancelled','order_updated','payment_link','pos_receipt')` · language char(2)
  CHECK `IN ('bn','en')` · body text CHECK `char_length(body) BETWEEN 1 AND 480` · revision int default 1 ·
  updated_by null FK users SET NULL · timestamps. **U(store_id, key, language)**. Only custom bodies are stored.
- **sms_sender_ids** (`000300`, `[S]`): id · tenant_id · store_id · sender_id varchar(11) · business_name varchar(120)
  · uses jsonb (list of `order_updates|otp|pos_receipts`, 1–3) · note varchar(300) null · status varchar(12) CHECK
  `IN ('pending','approved','rejected','cancelled','superseded','revoked')` · document_media_id char(26) **U** FK
  (tenant_id, document_media_id) → media(tenant_id, id) RESTRICT · rights_confirmed_at timestamptz · requested_by null
  FK users SET NULL · requested_at · reviewed_by null FK users SET NULL (platform staff) · reviewed_at null ·
  decision_reason varchar(500) null · approved_at null · ended_at null (cancelled/superseded/revoked) · timestamps.
  Partial **U(store_id) WHERE status = 'pending'**; partial **U(store_id) WHERE status = 'approved'**; partial
  **U(lower(sender_id)) WHERE status IN ('pending','approved')** (global, deliberately not tenant-led: a unique index
  is enforced regardless of RLS; the violation is mapped to 409 `sender_id_taken`); IX(tenant_id, store_id,
  requested_at DESC); IX(status, requested_at) (admin queue, `pgsql_admin`).

### 3.2 Changed tables
- **sms_messages** (`000400`): add `store_id char(26) null` (FK (tenant_id, store_id) → stores(tenant_id, id)
  CASCADE on Postgres; null for account codes) · `kind varchar(16) null CHECK IN ('transactional','marketing')` ·
  `parts smallint null` · `charged_from varchar(10) null CHECK IN ('allowance','credits')` · `credits_charged int
  default 0 CHECK >= 0` · `sender_id varchar(11) null` · `body_preview varchar(160) null` · `error_code varchar(32)
  null` · `sent_at timestamptz null` · `reference_type varchar(16) null CHECK IN ('order','pos_sale','campaign',
  'automation')` · `reference_id char(26) null` (soft ref). Status values gain **`skipped`** (no CHECK existed; add CHECK `IN ('queued',
  'sent','failed','skipped')`). Data step: `UPDATE sms_messages SET store_id = (SELECT id FROM stores WHERE
  stores.tenant_id = sms_messages.tenant_id) WHERE tenant_id IS NOT NULL` (run on `pgsql_admin`; one store per
  tenant), `kind` from purpose (P89A-4), `sent_at = updated_at` for `sent` rows. Indexes: IX(tenant_id, store_id,
  created_at DESC, id DESC); IX(tenant_id, store_id, to, created_at DESC). RLS policies unchanged.
- **billing_invoices** (`000500`): kind CHECK + `sms_credits`; `plan_id` and `interval` nullable; add `sms_credits
  int null`; CHECK `(kind = 'sms_credits') = (plan_id IS NULL AND interval IS NULL AND sms_credits > 0)`
  (subscription_id stays set to the tenant's current subscription). Replace the partial U(tenant_id) WHERE status =
  'open' with **U(tenant_id) WHERE status = 'open' AND kind <> 'sms_credits'** and **U(tenant_id) WHERE status =
  'open' AND kind = 'sms_credits'**. `BillingInvoice::KINDS` + `SMS_CREDITS`; new scope `subscriptionKinds()`.
- **campaign_recipients**, **automation_run_steps** (`000600`): add `charged_from varchar(10) null` (null = before
  8.9a = allowance).
- **media**: purpose `sender_id_document` (`MediaPurpose::SenderIdDocument`, private; widen the purpose CHECK if one
  exists in the same migration `000300`).
- `SmsTemplates::COUNTED` gains `sms_test`.

### 3.3 Locking
`SmsCharger` (§4.2) and every credit write take **`sms_credit_accounts` row `FOR UPDATE`** first; this serialises all
charging of a tenant, so the allowance count-then-insert is also race-free (it was not before). Purchase grant: billing
lock (`BillingLock::run`) → invoice row → account row. Order SMS: order row lock (existing) → account row. Never take
an order or stock lock while holding the account row.

### 3.4 Purposes, kinds, statuses
`SmsPurpose` (merchant-visible) = `order_placed | order_confirmed | order_shipped | order_cancelled | order_updated |
payment_link | pos_receipt | checkout_otp | campaign | automation | sms_test`; account `otp_*` exist in the table but
are never listed or counted (P89A-4). `SmsKind` per P89A-4. `SmsMessageStatus` = `queued | sent | failed | skipped`.
`SmsChargedFrom` = `allowance | credits` (null for skipped, failed-before-charge and pre-8.9a rows). Log `reference`
from the new `reference_type` / `reference_id` columns (§3.2): order events → `order` (label = order number);
`pos_receipt` → `pos_sale` (id = the `pos_sales` row, label = order number); `campaign` / `automation` → their id and
name; `checkout_otp`, `sms_test` and pre-8.9a rows → null (pre-8.9a campaign/automation rows are back-filled from
`template` = `campaign:{id}` / `automation:{id}`; order rows stay null). A reference to a deleted subject → null.

## 4. Sending pipeline (owner API; `App\Domain\Sms\*`)

### 4.1 Gateway
`SmsGateway::send(string $msisdn, string $text, ?string $senderId = null): SmsResult` — `RevesmsGateway` uses
`$senderId ?? config caller_id` as `callerID`; `LogSmsGateway` / `FakeSmsGateway` record it. No other driver change.
`SmsSender::for(Store $store): ?string` = the store's approved `sms_sender_ids.sender_id` (cached per request; tenant
cache key via helper, flushed on approve/revoke).

### 4.2 `SmsCharger::charge(SmsMessage $message, string $text): Charge` (inside the tenant context, in a transaction)
1. Lock the account row (§3.3). `parts = SmsParts::count($text)['parts']`; `kind` from purpose.
2. `limit = FeatureGate::limit(kind's Limit)`. `null` → charged_from `allowance`. Else `used = FeatureGate::usage(...)`
   (which now **excludes** `charged_from = 'credits'` rows and `skipped` rows, §4.5); units = 1 (transactional) or
   `parts` (marketing); `used + units ≤ limit` → `allowance`.
3. Else if `limit === 0` → **skip** (P89A-6). Else if `balance ≥ parts` → `balance −= parts`; ledger `consume`
   (−parts, `sms_message_id`, `balance_after`); `charged_from = credits`, `credits_charged = parts`.
4. Else **skip**: `status = skipped`, `error_code = no_credits`, nothing charged.
5. Write `parts`, `kind`, `charged_from`, `credits_charged`, `sender_id`, `body_preview` (P89A-21) on the row in the
   same transaction. After commit: low-credit check (§5.6).
`SmsCharger::refund(SmsMessage)`: when a row ends `failed` and `credits_charged > 0` → ledger `refund` (+credits,
unique per message), balance +; idempotent. `SmsCharger::canAfford(kind, parts): bool` (read-only, for checks that
must answer before creating a row).

### 4.3 Senders (each verified in code; all keep their existing locks and dedupe)
| Sender | Today | 8.9a |
|---|---|---|
| `Orders\Notifications\SendOrderSms` (order events, `payment_link`, `pos_receipt`) | In the order-locked transaction: `FeatureGate` `sms_per_month` check → timeline "SMS not sent: monthly SMS allowance used"; creates `sms_messages` (queued, template name only); renders `SmsTemplates::render` | Same transaction: create the row (with `store_id`), render with the store's template + sender (§7), `SmsCharger::charge`; skipped → row stays `skipped` + timeline **"SMS not sent: monthly SMS allowance and SMS credits used up"**; send with `senderId`; provider failure → row `failed` + `refund` (each retry creates a new row, as today) |
| `FraudGuard\CheckoutOtpService` + `Jobs\SendCheckoutOtp` | Row created in the service; `allowanceUsed()` → fail-open `sms_allowance` | Charge when creating the row; `unavailableReason` = `sms_allowance` when `! canAfford(transactional, parts of the rendered text)`; job sends with `senderId`, refunds on failure; `body_preview` always null |
| `Pos` SMS receipt (`POST /pos/sales/{sale}/sms-receipt` → `SendOrderSms`) | 402 `plan_limit_reached` when the allowance is used | 402 only when `! canAfford(transactional, parts)` (openapi 1.23.0 note) |
| `Marketing\CampaignPipeline` (+ `CampaignMessenger`) | Start: `limit < used + needed` → campaign fails `limit`; per recipient: send, then create `sms_messages` after the provider call | Start: fail `limit` only when `needed > remaining + balance` (no reservation). Per recipient: create the row **before** the call (queued) + charge in one transaction; skipped → recipient `skipped` with existing reason **`plan`**, row `skipped`; else send with `senderId`; update row + recipient (`charged_from`); failure → refund. Prefix rule P89A-17 applies to the campaign's "{shop}: " prefix |
| `Marketing\CampaignService` (estimate, test send, schedule) | `CampaignAllowance::assertFits` | `assertFits` passes when `needed ≤ remaining + balance` (limit > 0); estimate adds `allowance.credits`; test sends charge (audit meta `charged_from`) |
| `Automations\Engine\AutomationEngine::sendMessage` + `AutomationService` test | Allowance check → reason `allowance`; row created after send | Same as campaigns: row before the call, charge, skip reason stays **`allowance`**, `charged_from` on the step |
| `Identity\Otp\OtpService` + `Sms\Jobs\SendSms` (account codes `otp_*`) | Platform | **Unchanged**: never charged, never counted, always the shared caller ID |
| New `Sms\SmsTestService` (`POST /sms/test`) | — | §6.2 |

### 4.4 Rendering
`SmsTemplates::render(string $key, string $language, array $vars, Store $store): string`: body = custom row
(`sms_templates`) else the default file; if `SmsSender::for($store)` is not null and the body starts with `{shop}: `,
drop that prefix (P89A-17); fill + S13 sanitising + shortening until `SmsParts` ≤ 3 parts (free-text vars only, same
order as today); a still-longer text is sent as is and charged by its real parts. Var sets come from
`SmsTemplates::varsFor` (+ `PosReceipts::smsVars`, + payment-link `amount`/`url`) unchanged.

### 4.5 Allowance usage (amends P5-26, P85-13, P86-8)
`FeatureGate::usage(SmsPerMonth)` counts `purpose IN COUNTED`, `status IN ('queued','sent')`, `charged_from IS
DISTINCT FROM 'credits'`. `CampaignAllowance::used` sums recipients/steps with `charged_from IS DISTINCT FROM
'credits'` and test-send audit rows whose `meta.charged_from` is not `credits`. Overview `allowance` (§6.1) uses these.

## 5. Credits (owner API; `App\Domain\Sms\Credits\*`; tenant-level routes under `/billing`)

### 5.1 Account read `GET /billing/sms-credits` → `SmsCreditAccount`
`balance`, `status` (`none` = never bought and 0 · `empty` = 0 after a purchase or grant · `low` = below the
threshold, or < 100 with the alert off · `healthy`), `estimated_days_left` = floor(balance / (credits consumed − refunded
in the last 30 days ÷ 30)), null when nothing was used, `low_credit_threshold`, `packs` (config order), `providers`
(configured platform gateways, as `BillingInvoiceListMeta.providers`), `open_invoice` (the open `sms_credits` invoice
summary or null), `last_purchase_at`.

### 5.2 Consume / refund — §4.2.

### 5.3 Purchase `POST /billing/sms-credits/purchase` (`billing.manage`; `Idempotency-Key` required; limiter `billing`)
1. Validate `pack` ∈ config, `provider` ∈ configured providers (422 `billing_gateway_unavailable`).
2. `BillingLock::run`: same key + body → replay the first response; different body → 409 `idempotency_key_mismatch`.
   Void an older open `sms_credits` invoice (`superseded`); `InvoiceService::issueSmsCredits(pack)`: number from the
   platform sequence, `kind sms_credits`, plan/interval null, `sms_credits` = pack credits, one line
   "SMS credits · 5,000", VAT split, `due_at = now + 24 h`, bill_to snapshot. Audit `billing.invoice_issued`.
3. `BillingPaymentService::pay(invoice, provider, key, user)` (existing); return URL for this kind:
   `/integrations/sms?tab=credits&payment={payment id}` (`BillingUrls::returnUrl` by invoice kind). 502
   `provider_unavailable` leaves the invoice open (payable later from Plan & billing).
4. **Grant** (`BillingPaymentService::payInvoice` by kind): for `sms_credits` no "paid since" rule — an `open` invoice
   → `paid`, a `void` one → `paid` with `paid_late = true` (money was taken); then, in the same transaction,
   `SmsCreditService::grantForInvoice`: account lock → balance += credits, `purchased_total` +=, `last_purchase_at`,
   ledger `purchase` (unique per invoice), threshold defaults to 200 when null on the first grant, re-arm the alert;
   audit `sms_credits.purchased` (system or actor). Owner email `BillingMail::SMS_CREDITS_ADDED` instead of
   `PAYMENT_RECEIVED`. A duplicate payment follows the existing duplicate path (ops alert, no second grant).
   `plans->applyPaidInvoice` is **never** called for `sms_credits`; ops `MarkInvoicePaid` uses the same dispatch.
5. Sweep: `billing:run` voids open `sms_credits` invoices past `due_at` with `expired` (no reminders, no dunning, no
   effect on the subscription).
Every subscription-flow reader of open/paid invoices uses `subscriptionKinds()`: `InvoiceService::issue`,
`PlanChangeService` (L80, 117, 145, 219, 257), `SubscriptionProcessor` (83, 103, 182, 219), `Ops\SchedulePlanChange`,
`Ops\CompPlanChange`, `PlanPresenter` (open invoice banner), `Console\BillingRun` reminders, `AdminTenantController`
open invoice, `AdminOverviewController` past-due amount. `BillingInvoicePdf` and `BillingPaymentService::party` describe
an `sms_credits` invoice as "SMS credits · {n}". `GET /billing/invoices` gains `filter[kind]` (comma list).

### 5.4 Admin adjust — P89A-18; account lock → ledger `admin_adjust` → balance; replay by `(tenant_id,
idempotency_key)` + `request_hash`; re-arm the alert when the balance rises ≥ threshold.

### 5.5 Ledger `GET /billing/sms-credits/ledger` (`billing.view`) — newest first, 50, cursor, `filter[type]` list; rows
are raw (consume rows not grouped); `invoice {id, number}` on purchases; `reason` on admin_adjust only.

### 5.6 Low-credit alert (`Sms\Jobs\SendLowSmsCreditAlert`, `TenantAware`)
After a consume commits: `threshold !== null && balance < threshold && low_alert_sent_at IS NULL` → dispatch. The job
runs `UPDATE … SET low_alert_sent_at = now() WHERE tenant_id = ? AND low_alert_sent_at IS NULL` and emails the owner
only when 1 row changed ("{n} SMS credits left — buy more before messages stop", link `/integrations/sms?tab=credits`).
Re-arm (`low_alert_sent_at = null`) on purchase, refund, grant or threshold change when `balance ≥ threshold`, and
always on threshold change.

## 6. Overview and test SMS (owner API; `routes/sms.php`)

### 6.1 `GET /stores/{store}/sms` → `SmsOverview`
`gateway` (P89A-1), `sender` (`type shared|masked`, `sender_id`, `pending_request`), `language` (=
`store_settings.sms_language`), `allowance.transactional` (`sms_per_month`, unit messages) and `.marketing`
(`campaign_sms_per_month`, unit parts) with `limit/used/remaining`, `credits` (`SmsCreditsSummary`, §5.1),
`this_month` (store month: `messages_sent`, `messages_failed`, `messages_skipped` over listed purposes,
`sent_success_rate`, `credits_used` = consumed − refunded this month, `otp_sent` = sent `checkout_otp`),
`quiet_hours {from: '21:00', to: '09:00', timezone}`, `can` flags (`SmsCapabilities`, P89A-25).

### 6.2 `POST /stores/{store}/sms/test` → `SmsTestResult`
Actor's phone must be verified (422 `phone_not_verified`). Fixed text: bn "{shop}: এটি Store Plix থেকে একটি পরীক্ষামূলক
SMS। আপনার দোকানের SMS চালু আছে।", en "{shop}: This is a test SMS from Store Plix. Your shop's SMS is working." (prefix
rule applies). Row purpose `sms_test`, charge (§4.2); skipped → 402 `sms_credits_exhausted` with
`SmsCreditsExhaustedDetails` and the row stays `skipped`; synchronous `send`; provider failure → row failed, refund,
502 `provider_error`. 200 `{sms_message_id, to_masked, status: 'sent', charged_from, parts}`. Audit `sms.test_sent`
(`to_masked`, parts, charged_from).

## 7. Templates (owner API)

### 7.1 Keys and merge fields
| Key | Label | Merge fields (required in **bold**) |
|---|---|---|
| `order_placed` | Order received | first_name, shop, number, total, due, track_url |
| `order_confirmed` | Order confirmed | first_name, shop, number, total, due, track_url |
| `order_shipped` | Shipped | first_name, shop, number, total, due, carrier, track_url |
| `order_cancelled` | Order cancelled | first_name, shop, number, total |
| `order_updated` | Order updated | first_name, shop, number, total, due, track_url |
| `payment_link` | Payment link | first_name, shop, number, amount, **url** |
| `pos_receipt` | POS receipt | first_name, shop, number, total, method, footer |
| `checkout_otp` (read-only) | Checkout code | shop, code |
Unknown `{x}` → 422 `sms_template_unknown_merge_field` (`details.fields`); a missing required one → 422
`sms_template_missing_merge_field`. Figma tags map: `{name}` → `{first_name}`, `{order_no}` → `{number}`, `{otp}` →
`{code}`, `{pay_link}` → `{url}`, `{track_link}` → `{track_url}`.

### 7.2 Defaults (today's `resources/sms/{bn,en}.php`, byte for byte) and save / reset
| Key | bn | en |
|---|---|---|
| order_placed | `প্রিয় {first_name}, {shop} এ আপনার অর্ডার {number} পেয়েছি। মোট {total} টাকা, ডেলিভারির সময় পরিশোধ করবেন। ট্র্যাক: {track_url}` | `{shop}: Order {number} received. Total Tk {total}, pay on delivery. Track: {track_url}` |
| order_confirmed | `{shop}: আপনার অর্ডার {number} কনফার্ম হয়েছে।` | `{shop}: Order {number} is confirmed.` |
| order_shipped | `{shop}: অর্ডার {number} {carrier} এর মাধ্যমে পাঠানো হয়েছে। {due} টাকা প্রস্তুত রাখুন। ট্র্যাক: {track_url}` | `{shop}: Order {number} is on its way with {carrier}. Keep Tk {due} ready. Track: {track_url}` |
| order_cancelled | `{shop}: অর্ডার {number} বাতিল করা হয়েছে।` | `{shop}: Order {number} has been cancelled.` |
| payment_link | `{shop}: অর্ডার {number} নিশ্চিত করতে {amount} টাকা পরিশোধ করুন: {url}` | `{shop}: Pay Tk {amount} to confirm order {number}: {url}` |
| order_updated | `{shop}: আপনার অর্ডার {number} আপডেট হয়েছে। নতুন মোট {total} টাকা, ডেলিভারির সময় দিতে হবে {due} টাকা।` | `{shop}: Order {number} was updated. New total Tk {total}, pay Tk {due} on delivery.` |
| pos_receipt | `{shop}: ধন্যবাদ! রসিদ {number}, মোট {total} টাকা, পরিশোধ: {method}। {footer}` | `{shop}: Thank you! Receipt {number}, total Tk {total}, paid {method}. {footer}` |
| checkout_otp | `{shop}: আপনার চেকআউট কোড {code}। কোডটি ৫ মিনিট বৈধ। কাউকে জানাবেন না।` | `{shop}: Your checkout code is {code}. It is valid for 5 minutes. Do not share it.` |
`PUT /stores/{store}/sms/templates/{key}/{language}` (`settings.manage`): body rules P89A-8; `revision` must equal the
row's (0 when not custom) else 409 `revision_conflict`; a body equal to the default (after trim) deletes the row; audit
`sms_template.updated` (key, language, old/new length — never the full texts). `DELETE` (`settings.manage`): idempotent
reset, audit `sms_template.reset` when a row existed. `checkout_otp` → 422 `sms_template_read_only`.
`GET …/sms/templates`: 16 rows in `SMS_TEMPLATE_EVENTS` order then `checkout_otp`, bn before en, each with
`default_body`, `is_custom`, `editable`, `enabled` (P89A-10), `merge_fields`, `required_fields`, `preview`,
`updated_at/by`, `revision`.

### 7.3 Preview `POST …/sms/templates/preview` (`settings.manage`; limiter `sms-template-preview` 60/min per member)
Same validation as PUT, nothing saved. Sample values: `first_name` "Nasrin" / "নাসরিন", `shop` = the store name,
`number` = `{order prefix}-1042`, `total` "1,770", `due` "1,770", `carrier` "Steadfast", `track_url`
`https://{primary host}/track`, `amount` "500", `url` `https://{primary host}/pay/Ab12Cd34Ef56`, `method` "Cash" /
"নগদ", `footer` = the store's receipt footer or "Thank you", `code` "482913"; current sender (prefix rule). Returns
`{text, parts, encoding, characters}`; the 3-part rule (P89A-8) is checked on this render.

## 8. Sender ID (owner API + admin)

### 8.1 States
`pending → approved | rejected | cancelled`; `approved → superseded` (another ID approved) `| revoked`. Only one
`pending` and one `approved` per store (§3.1). The active sender = the `approved` row.

### 8.2 Merchant `GET /stores/{store}/sms/sender-ids` (`settings.manage | integrations.manage`) →
`{active, pending, history (≤ 20, newest first)}`; `POST` multipart (`integrations.manage`; P89A-13/15/16; 201) —
order of checks: validation (pattern, business_name, uses, rights_confirmed, note, document sniffed) → reserved (422)
→ unchanged (422) → pending exists (409) → taken (409, also on the unique-index race) → store the media → insert;
owner and platform ops email ("New sender ID request"); audit `sender_id.requested` (sender_id, uses, document
media id). `POST /{sender_id}/cancel` (`integrations.manage`): pending → cancelled (`ended_at`), else 409
`invalid_state_transition`; audit `sender_id.cancelled`. The document media row is kept (RESTRICT) and pruned by
`sms:prune-sender-documents` 180 days after a request ends in `rejected | cancelled | superseded | revoked`.

### 8.3 Admin review (§10.3) — approve: `provider_registered` must be `true`, reason 5–500; under a lock on the
store's rows: pending → approved (`approved_at`, `reviewed_by/at`), previous approved → superseded; flush the sender
cache; owner email "Your sender ID {ID} is live"; audit `sender_id.approved`. Reject: pending → rejected with
`decision_reason`; owner email with the reason; audit `sender_id.rejected`. Revoke: approved → revoked with reason;
the shop falls back to the shared sender; owner email; audit `sender_id.revoked`. Wrong state → 409
`invalid_state_transition`; approving an ID that became taken → 409 `sender_id_taken`.

## 9. SMS log `GET /stores/{store}/sms/messages` (`settings.manage | integrations.manage`)
P89A-19/20/21. Query: `tenant_id = context`, `store_id = {store}`, `purpose NOT LIKE 'otp\_%'`, `created_at ≥ start of
(today − 90 days)` (store tz), filters, order `(created_at DESC, id DESC)`, cursor. `SmsLogEntry`: `to_masked`
(`01711-•••211`: first 5 local digits, `-•••`, last 3), purpose, kind, status, parts, charged_from, sender_id,
body_preview (null for `checkout_otp` and rows older than 90 days), error_code, reference (§3.4). 422 on a bad
date/phone/list value (`validation_failed`).

## 10. API surface and errors (openapi 1.23.0 binding)

### 10.1 Merchant (`routes/sms.php` + include line; merchant group; `{store}` scoped; billing routes in the billing file)
| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/stores/{store}/sms` | `settings.manage\|integrations.manage\|billing.view` | §6.1 |
| POST | `/stores/{store}/sms/test` | `settings.manage\|integrations.manage` | §6.2 · `sms-test` 5/h |
| GET | `/stores/{store}/sms/templates` | `settings.manage\|integrations.manage\|billing.view` | §7 |
| POST | `/stores/{store}/sms/templates/preview` | `settings.manage` | §7.3 · 60/min |
| PUT · DELETE | `/stores/{store}/sms/templates/{key}/{language}` | `settings.manage` | §7.2 |
| GET · POST | `/stores/{store}/sms/sender-ids` | GET `settings.manage\|integrations.manage` · POST `integrations.manage` | §8.2 · POST `sms-sender-id` 5/day, 201 |
| POST | `/stores/{store}/sms/sender-ids/{sender_id}/cancel` | `integrations.manage` | §8.2 |
| GET | `/stores/{store}/sms/messages` | `settings.manage\|integrations.manage` | §9 |
| GET · PATCH | `/billing/sms-credits` | GET `billing.view\|settings.manage\|integrations.manage` · PATCH `billing.manage\|settings.manage` | §5.1, P89A-12 |
| GET | `/billing/sms-credits/ledger` | `billing.view` | §5.5 |
| POST | `/billing/sms-credits/purchase` | `billing.manage` | §5.3 · Idempotency-Key, limiter `billing`, 201 |
| GET | `/billing/invoices?filter[kind]=sms_credits` | `billing.view` (existing) | purchase history |
`SmsOverview.can`: `edit_templates` = settings.manage; `send_test`, `view_log`, `view_sender_ids` = settings.manage |
integrations.manage; `request_sender_id` = integrations.manage; `view_credit_history` = billing.view; `buy_credits` =
billing.manage; `edit_low_credit_alert` = billing.manage | settings.manage. Every write: impersonation → 403
`impersonation_read_only`. Reads use the default merchant limiter.

### 10.2 Error codes (new): `sms_credits_exhausted` (402, details `SmsCreditsExhaustedDetails`), `phone_not_verified`
(422), `provider_error` (502), `sms_template_read_only`, `sms_template_unknown_merge_field`,
`sms_template_missing_merge_field` (422, details `{fields}`), `sms_template_link_not_allowed`, `sms_template_too_long`
(422, details `{parts, max_parts}`), `sender_id_request_pending` (409, details `{request_id}`), `sender_id_taken` (409),
`sender_id_reserved`, `sender_id_unchanged` (422), `sms_credits_insufficient` (422, admin), `document_processing` (409,
admin document while an image is re-encoded). Existing: `validation_failed`, `revision_conflict`,
`invalid_state_transition`, `idempotency_key_mismatch`, `idempotency_key_in_use`, `billing_gateway_unavailable`,
`provider_unavailable`, `plan_limit_reached`, `impersonation_read_only`, `rate_limited`.

### 10.3 Super admin (`routes/admin-sms.php`, admin group; never reads `X-Tenant-Id`; reasons 5–500 per PHASE-8-1)
| Method | Path | Platform permission | Notes |
|---|---|---|---|
| GET | `/admin/sender-ids` | `manage_domains` | `filter[status]` (default `pending`; pending oldest first, else newest first), `filter[q]` (sender ID or shop name ≥ 2), page/per_page; `meta.counts.pending` |
| GET | `/admin/sender-ids/{id}` | `manage_domains` | `AdminSenderIdRequest` (tenant ref, requested_by_email, reviewed_by, current_sender_id) |
| GET | `/admin/sender-ids/{id}/document` | `manage_domains` | stream, audited `sender_id.document_viewed` |
| POST | `/admin/sender-ids/{id}/approve` · `/reject` · `/revoke` | `manage_domains` | §8.3 |
| GET | `/admin/tenants/{tenant}/sms-credits` · `/ledger` | `view_merchants` | `AdminSmsCredits`; ledger as §5.5 |
| POST | `/admin/tenants/{tenant}/sms-credits/adjust` | `manage_billing` | P89A-18, Idempotency-Key |
Cross-tenant reads/writes run on `pgsql_admin` or inside `TenantContext::run($tenant)` with `// cross-tenant: <reason>`
(sender-ID review, SMS credit adjustment). Admin writes audited with `platform: true`.

## 11. Audit and security

### 11.1 Audit actions (`SMS_AUDIT_ACTIONS`)
`sms.test_sent`, `sms_template.updated`, `sms_template.reset`, `sender_id.requested`, `sender_id.cancelled`,
`sender_id.approved`, `sender_id.rejected`, `sender_id.revoked`, `sender_id.document_viewed`, `sms_credits.purchased`,
`sms_credits.adjusted`, `sms_credits.alert_updated`. Meta never contains a full message body, OTP, unsubscribe code or
unmasked phone.

### 11.2 Security checklist (S208–S219; each has a test)
- **S208** isolation: templates, sender IDs, SMS log, credit account and ledger of another tenant/store → 404 (or empty);
  every `{key}`, `{sender_id}`, filter and media id resolved within tenant + store; RLS on the four new tables;
  `assertTenantIsolation` + `assertStoreIsolation` (templates, sender IDs, log) and `assertTenantIsolation` (credits).
- **S209** log isolation on the platform table: a tenant never sees another tenant's rows nor `tenant_id IS NULL` /
  `otp_*` rows even when RLS is off (explicit filters), and with RLS on (Postgres suite).
- **S210** permissions: P89A-25 matrix O/A/S/C, impersonation 403 on writes, no API-key route.
- **S211** charging integrity: allowance-then-credits vectors per kind; 0 allowance never uses credits; unlimited never
  uses credits; balance never < 0 (CHECK + lock); consume and refund at most once per message (unique index; replayed
  job); a failed send refunds; Postgres race: 20 parallel charges with balance for 10 → exactly 10 charged, ledger Σ =
  balance change.
- **S212** money (rule 8): credits only from a verified payment, once per invoice (replayed IPN / return / reconcile /
  duplicate payment → one grant); amount/currency/reference mismatch → no grant; the client never sends credits or
  amounts; an SMS invoice never activates, extends or changes a subscription, and subscription flows ignore it.
- **S213** admin adjust: `manage_billing` only, idempotent, never below 0, reason stored and shown, audited with the
  platform actor, cross-tenant marker.
- **S214** templates: only allowed merge fields; no typed links; control characters and URLs in **vars** still stripped
  (S13); ≤ 3 parts on the sample; checkout OTP not editable; a custom template of store A never renders for store B.
- **S215** sender ID: pattern, reserved list, global uniqueness incl. race (two shops, same ID), one pending/approved
  per store, the caller ID used is only an `approved` row of the sending store, revoke takes effect on the next message.
- **S216** document: sniffed MIME, ≤ 5 MB, private disk under the tenant prefix, re-encoded images, never in `/media`
  library routes, never downloadable by merchants, admin stream with `nosniff` + sandbox CSP + attachment, audited.
- **S217** privacy: no OTP/checkout-code text in `sms_messages`, logs, audit or API; previews without URLs, nulled
  after 90 days; masked phones everywhere; provider raw text never in responses.
- **S218** test SMS: only to the actor's verified phone (no `to` field accepted), limiter, charged, audited.
- **S219** abuse limits: `sms-test`, `sms-template-preview`, `sms-sender-id`, `billing` limiters; low-credit email at
  most once per crossing (conditional update).

## 12. Merchant dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`
Route `/integrations/sms` (lazy, `src/sms/**`), tabs via `?tab=overview|templates|sender-id|log|credits` (default
overview; unknown → overview). Page visible with any of `settings.manage | integrations.manage | billing.view`, else
the 403 page. Header (all tabs, `31:5120`): SMS tile, "SMS", pill **Active** (success), Tag "Messaging", description
"Send order updates, OTP codes and receipts in Bangla or English. Messages go through the Storeplix SMS gateway
(BTRC-approved) — nothing to connect.", meta "Active since {date}" (hidden when null) · "Last SMS {relative}" ·
"Sender: {sender_id or Storeplix}{ · {pending} in review}"; buttons **Buy credits** (→ credits tab; shown when
`can.view_credit_history || can.buy_credits`) and **Send test SMS** (`can.send_test`). Breadcrumb Integrations ›
Messaging › SMS. Tabs hidden per `can` (Sender ID: `view_sender_ids`; SMS log: `view_log`; Buy credits: shown to
everyone who can open the page, purchase controls disabled without `buy_credits` with "Only the shop owner can buy
credits").

### 12.1 Overview — desktop `31:5120`, mobile `2081:1197`
**Automatic messages** card: language segmented বাংলা / English = `store_settings.sms_language` (PATCH settings,
`settings.manage`, else read-only); caption "Sent when the order changes. Bangla uses about 2× the credits of
English."; one row per `SMS_TEMPLATE_EVENTS` key (label, "{parts} SMS" Tag from the template preview, preview text,
**Edit** → Templates tab with that key open, Switch = `enabled` (PATCH `notifications.customer_sms`), no switch for POS
receipt); **Checkout OTP** row with "Read-only" Tag and "Managed by Fake order guard" link (`/orders/fraud-guard`).
Figma "Delivered" row: **hidden** (Q272). **Sending rules** card: Quiet hours "9 PM – 9 AM · campaigns and automations
wait; order updates and codes always send" (read-only text, not a select); Sender name (read-only: "Storeplix
(default)" / the masked ID, caption per state, link "Sender ID" tab); **Low-credit alert** select Off / Below 100 /
200 / 500 (`can.edit_low_credit_alert`, PATCH `/billing/sms-credits`). Right column: **SMS credits** card (pill per
`status`: Healthy success / Low warning / Empty danger / none hidden; big number = credits balance + "credits left ·
~{days} days" when known; **Plan allowance** "{remaining} of {limit} left this month" + bar (transactional; "Unlimited"
on Growth) and caption "{plan} plan · resets {1st of next month} · used first"; marketing allowance line "Campaign SMS
{remaining} of {limit}"; Purchased credits + "Used after the allowance · never expire"; pack picker (3 cards) and
**Buy {n} credits with {provider}** → the same flow as §12.5, owner only); **This month** card: Messages sent, Sent
successfully (% one decimal, "—" when null), Credits used, OTP sent. Send test SMS dialog (composed): "We'll text
{masked phone}", language chips, Send; `phone_not_verified` → "Verify your phone in your profile first" with link;
402 → "No SMS left — buy credits" link; success toast "Test SMS sent to {masked}".

### 12.2 Templates — `2075:50213`
Card "Order SMS templates" + "Every message has a বাংলা and an English version. Customers get the language of their
order."; rows per key: label, "When: …" line (order_placed "a customer places an order", order_confirmed "you confirm
the order", order_shipped "parcel is booked with a courier", order_cancelled "order is cancelled", order_updated "you
edit the order", payment_link "you request an advance or send a payment link", pos_receipt "till sale with the buyer's
phone number"), Tag Edited/Default (`is_custom`), bn and en previews with "{n} SMS", **Edit**, Switch (P89A-10).
Checkout OTP row "Read-only · Managed by Fake order guard", "Locked". **Edit template** side panel (sheet on mobile):
title + "{label} · sent when …", Language chips, Message textarea (Bangla font for bn), Tag Edited / Unsaved, **Insert**
chips for the key's merge fields (insert at cursor), "{characters} characters · {parts} SMS parts" with a 3-segment bar,
caption "বাংলা uses Unicode: 70 characters per part (English: 160). Up to 3 parts. Merge tags count at their usual
length.", **Preview** bubble from `POST /preview` (debounced 400 ms, abortable) with "Sample order: …" caption and the
prefix note ("“{Shop}: ” is added because you use the Storeplix sender" / dropped with a masked ID); errors inline
(too long: "Too long for one message. Keep it within 3 parts — remove {n} characters to save."; unknown/missing
field; links); **Reset to default** (confirm when custom), Cancel, **Save** (disabled while invalid or unchanged;
409 → "Someone else changed this template" + reload). Read-only without `edit_templates`. A client-side count mirrors
`smsParts()` (8.5 helper) but the server preview is authoritative.

### 12.3 Sender ID — `2075:50625`
**Current sender** card: "Storeplix" + Tag "Platform default" with the prefix explanation and a phone bubble preview
(order_confirmed sample), or the masked ID + Tag Approved ("Live since {date}. All SMS now come from {ID} and the
shop-name prefix is removed."). **Pending request** card: ID + Tag "Pending review", "Requested {date} by {name} · for
{uses}", **Cancel request** (`request_sender_id`, confirm), timeline Submitted (date · "trade licence uploaded") →
Pending review ("Storeplix checks your licence, then registers {ID} with BTRC through REVE SMS. This usually takes 7–10
working days.") → Approved or rejected; info banner "Until then your SMS keep going out from Storeplix with your
shop-name prefix — nothing stops." **Request a masked sender ID** form (shown when no pending request; prefilled from a
rejected one by "Request again"): Sender ID (uppercase display, counter "n / 11", pattern hint), Business name on the
trade licence, "What will you send with it?" chips Order updates / OTP codes / POS receipts (+ Promotions disabled
"Needs a separate approval later"), Trade licence dropzone (PDF, JPG, PNG, WebP up to 5 MB; client pre-check of type and
size), Note (composed, optional), tick "This name belongs to my business and I have the right to use it.", **Submit
request** ("Review takes about 7–10 working days after you submit."). Upload progress via `UploadOptions`. Side cards
"When the review is done" (approved / rejected examples become the real last decision with its reason) and "Good to
know" (three static lines). History list (composed, collapsed): older requests with status pills. Without
`request_sender_id` the form and Cancel are hidden.

### 12.4 SMS log — desktop `2075:51037`, mobile `2081:1561`
"SMS log" + "Every SMS your shop sent in the last 90 days. Times are {timezone name} time."; search "Search by phone
number" (exact, Enter/blur, 422 → inline "Enter a full phone number"); Status select (All / Sent / Failed / Skipped /
Queued); date range (default last 30 days, min today − 90); Purpose chips **All · Order** (the 6 order keys) **· OTP**
(`checkout_otp`) **· Campaign · Automation · POS receipt** (+ "Test" when any). Table TIME · PHONE · PURPOSE · MESSAGE
· PARTS · CHARGED FROM · STATUS: purpose Tag colours as Figma; message = `body_preview` (checkout codes show "Checkout
code (hidden)" muted; null → "—"); charged "Allowance" / "Credits" / "—"; status pills Sent success / Failed danger +
"Provider error" / Skipped neutral + "No SMS left" / Queued neutral; reference links to the order / campaign /
automation. **Cursor pagination** (Previous / Next, "Showing 50 per page") instead of Figma's numbered pages and total.
Empty states: "No SMS sent yet" + Send test SMS; "No messages match these filters" + Clear filters; loading skeleton.
Mobile: cards (time, masked phone, purpose tag, status, two-line preview).

### 12.5 Buy credits — `2075:51449`
**Choose a pack** (3 radio cards: credits, price, "৳ x per SMS" = price / credits, "Most popular" on 5,000, "Best value"
on 10,000) + estimate line "{n} credits last about {weeks/months} at your current pace" (from overview usage, hidden
when unknown); **Pay with** bKash / SSLCommerz (from `providers`; none → "Online payment isn't available right now");
**Order summary** (SMS credits, Price, VAT Included, Total, "Purchased credits {balance} → {balance + n}"), **Pay ৳ x
with {provider}** (owner only; `Idempotency-Key` per click reused on retry) → `window.location = payment.redirect_url`;
caption "You'll go to {provider} to pay. Credits are added only after we confirm the payment — usually within a minute.
The invoice appears in Purchase history." Open invoice → banner "You have an unpaid SMS credit invoice {number}" + Pay
/ it is superseded by a new purchase. **Return** (`?payment={id}`): poll `billing.payment(id)` every 2 s up to 60 s →
success card "{n} credits added" (Payment confirmed by {provider} · TrxID when present; Purchased credits / Allowance
left / Total SMS left; Download invoice, Done) or "Confirming your payment…" card (Back to SMS) or failed banner.
**Purchase history**: `billing.invoices({kind: ['sms_credits']})` table DATE · PACK (invoice description) · AMOUNT ·
STATUS (Paid / Pending (open) / Expired or Cancelled (void)) · INVOICE (number → PDF download); Figma "PAID WITH" column
omitted (not on the invoice summary). **Credit history** (composed, `view_credit_history`): ledger list with type labels
(Purchase / Used / Refund / Adjusted by Store Plix + reason), Load more.

### 12.6 Integrations list and Settings → Notifications
`IntegrationsPage`: new **Messaging** section with the SMS card (logo tile "SMS", "Storeplix SMS", pill Active,
"Order updates, checkout codes and receipts · {balance} credits", **Manage** → `/integrations/sms`; visible to members
who can open the page) and a "Messaging" filter chip; header comment updated (Messaging no longer hidden). Settings →
Notifications: the preview uses the server template preview of the chosen event/language (`sms.templates.list`) and
gains "Edit text" → `/integrations/sms?tab=templates`; the client `smsPreview` stays only as the fallback for members
without template read access.

### 12.7 States, permissions, mobile
Loading / empty / error per `148:34032` on every tab; 390 px: tabs scroll horizontally, header buttons stack, the
template editor and dialogs are full-screen sheets, tables become cards. All copy in English (Bangla only in SMS
texts and the language chip).

## 13. Super admin (owner ADMIN)

### 13.1 Sender ID requests — `2087:7872` (drawer `2087:8426`, being drawn)
Nav item "Sender ID requests" under Operations with the pending count badge (`meta.counts.pending`), visible with
`manage_domains`. Route `/sender-ids`. Title + "Masked sender IDs merchants asked for. Approve once REVE SMS confirms the
BTRC registration is live."; tabs Pending review (count) · Approved · Rejected · All (counts on the other tabs are not
in the API — shown without a count); search "Search shop or sender ID" (≥ 2). Table MERCHANT (avatar, name, host) ·
REQUESTED ID · PURPOSE (uses labels) · SUBMITTED (date + relative) · DOCUMENTS ("Trade licence" → `document` blob
download) · STATUS pill. Row → drawer: shop link, requested ID, current sender ID, business name, uses, note, requested
by + email, licence preview/download, timeline; actions for pending **Approve** (tick "Registered on REVE SMS / BTRC"
required + reason) and **Reject** (reason, "shown to the merchant"); for approved **Revoke** (reason). Errors 409
inline. Without `manage_domains` the item is hidden and the route shows the 403 page.

### 13.2 Merchant detail `33:4851` → Billing tab, "SMS credits" card
Balance + status pill, Used this month, Purchased total, Last purchase, low-credit threshold; ledger table (type, credits
signed, balance after, invoice/reason, date; Load more) — `view_merchants`. **Adjust credits** (`manage_billing`) opens
**"Dialog · Adjust SMS credits"** (being drawn): Grant / Deduct segmented, Credits (1–1,000,000), Reason (5–500,
"Shown to the merchant"), preview "Balance {b} → {b ± n}", Confirm; one `Idempotency-Key` per dialog open; 422
`sms_credits_insufficient` inline. Admin invoice list/detail tolerate `plan_code`/`billing_interval` null (show "SMS
credits").

## 14. ARCH and types (owner ARCH — done in this change)
openapi **1.23.0** (tag `sms`; billing + admin paths; `BillingInvoiceKind` + `sms_credits`; nullable plan/interval;
`filter[kind]`; `CampaignEstimate.allowance.credits`; schemas listed in the changelog). `packages/types`: SMS block
(purposes, kinds, statuses, overview, templates + `SMS_TEMPLATE_EVENTS`, merge-field labels, sender ID + uses +
document constants, log, credits, ledger, errors, audit actions, admin shapes). `packages/api-client`:
`sms.overview/sendTest/templates.*/senderIds.*/messages`, `billing.smsCredits.*`, `billing.invoices({kind})`,
`admin.senderIds.*`, `admin.smsCredits.*`, `smsLogQuery`, `smsCreditLedgerQuery`, `adminSenderIdQuery`; tests in
`phase8-9a.test.ts`. Docs: ADR 0026, DATABASE-DESIGN §5.12, SECURITY T43 (S208–S219), MULTI-TENANCY count 95,
OPEN-QUESTIONS Q257–Q272 (+ Q84, Q145 notes), roadmap 8.9a. Proposed edits for other owners: FIGMA-INDEX rows for
`31:5120`, `2075:*`, `2081:*`, `2087:*` (QA/design owner), RUNBOOK (REVE balance and sender-ID registration steps).

## 15. Test requirements
**API (Pest)**, group `sms` (+ `rls`, `security`, `race`): every §10 route (happy, validation, authz matrix,
impersonation, isolation with `assertTenantIsolation` for credit account + ledger and `assertTenantIsolation` +
`assertStoreIsolation` for templates, sender IDs and the log); `SmsCharger` vectors (transactional allowance → credits →
skip; marketing parts; unlimited; 0 allowance; refund on failure; idempotent consume/refund on job replay); allowance
usage excludes credit-paid and skipped rows (FeatureGate + CampaignAllowance); every sender of §4.3 (order events with
custom template, masked sender + prefix drop, skipped timeline note; checkout OTP fail-open with credits; POS receipt
402 only without credits; campaign start/send/skip `plan` with credits; automation step skip `allowance`; account OTP
untouched); **byte-for-byte default texts** for every key × language vs. the 8.8d renderer; template rules (fields,
required, links, 3 parts, reset, revision 409, read-only OTP); purchase: invoice shape, superseding only SMS invoices,
fake gateway verified → one grant, replayed IPN/return/reconcile → no second grant, mismatch → none, void-then-paid →
paid late + grant, subscription flows ignore SMS invoices (renewal, plan change, dunning, PlanPresenter banner),
expiry sweep; low-credit alert once per crossing + re-arm; sender ID: pattern/reserved/unchanged/pending/taken (+
Postgres race of two shops), document sniffing and privacy, cancel, admin approve/reject/revoke + supersede + cache
flush + emails + audit, permission `manage_domains` matrix per platform role; admin adjust (idempotent, insufficient,
audit, cross-tenant); log filters, 90-day window, masking, `otp_*` and null-tenant rows never listed (RLS off and on),
preview pruning; Postgres race: parallel charges against a small balance (S211), purchase grant vs consume; static
test: no `SmsGateway::send(` outside `Sms\`, `OtpService`/`SendSms` and the charger-aware senders allow-list.
**Web (Vitest)**: tabs + permission gating; overview cards from fixtures (statuses, unlimited, null rate); language and
toggle writes; test SMS dialog states; template editor (insert chip at cursor, counter/bar, debounced preview abort,
error mapping, reset confirm, 409); sender ID form validation (pattern, file type/size, uses, tick), pending/cancel,
rejected → request again; log filters → query, chips mapping, masked/hidden OTP, cursor nav, empty states; buy credits
(pack/provider selection, idempotency key reuse on retry, redirect, return polling success/pending/failed, history
statuses); integrations Messaging card; Notifications preview from the server.
**Admin (Vitest)**: queue tabs/search/pagination, drawer actions (approve needs the tick + reason), document download;
merchant SMS credits card + adjust dialog (grant/deduct, preview, 422, key per open).
**QA (Playwright)** `phase8-9a.spec.ts` (fake SMS driver, `BILLING_FAKE`): owner opens Integrations → SMS card → overview;
send test SMS; edit the bn `order_confirmed` template, place + confirm an order → fake sink has the custom text; reset;
request sender ID with a PDF → admin approves in super-admin → next order SMS uses the ID without "{Shop}: "; buy 1,000
credits with fake bKash → balance +1,000 and ledger row; exhaust the allowance (seeded usage) → next order SMS charged
from credits, log shows "Credits"; staff without keys gets 403; 390 px screenshots of overview, templates editor and
log. Admin spec `phase8-9a-admin.spec.ts`: reject with a reason → merchant sees it; adjust credits +200.
**QA infra**: CI Pest group `sms` on sqlite, Postgres and RLS; race tests in `api-perf` / `api-rls` lists.

## 16. File ownership

| Agent | Owns (create/edit) |
|---|---|
| **API (Laravel)** | `apps/api/**` only: `app/Domain/Sms/**` (charger, credits, templates, sender IDs, log, test, jobs, presenters, requests, policies, limiters in `SmsServiceProvider`), `routes/sms.php`, `routes/admin-sms.php` + include lines, migrations `2026_12_11_*`, `config/sms.php` (packs, reserved IDs, test texts), `resources/sms/*.php` (unchanged texts; comments only), `Orders/Notifications/SendOrderSms.php` + `SmsTemplates.php`, `FraudGuard/CheckoutOtpService.php` + `Jobs/SendCheckoutOtp.php`, `Pos` SMS receipt check, `Marketing/CampaignPipeline.php`, `CampaignService.php`, `CampaignAllowance.php`, `Sending/CampaignMessenger.php`, `Automations/Engine/AutomationEngine.php`, `AutomationService.php`, `Billing/**` (kind, issue, pay dispatch, URLs, PDF, mail, sweep, `subscriptionKinds` readers), `Admin/**` (sender IDs, tenant SMS credits, invoice null plan), `Media/MediaPurpose.php` (`sender_id_document`), `Tenancy` (`RlsTables`, `RlsPolicies` ledger append-only), `rls-emergency-off.sql`, `AuditLogger` subject types, tests |
| **WEB (React)** | `apps/merchant-dashboard/**`: `src/sms/**` (new), `src/integrations/IntegrationsPage.tsx`, `src/settings/CommerceSettingsPages.tsx` + `commerceSettings.ts` (preview + link), `src/campaigns/PreviewColumn.tsx` (credits in the allowance box), `App.tsx` route, fixtures/tests |
| **ADMIN (React)** | `apps/super-admin/**`: sender-ID queue page + drawer, nav item, merchant detail SMS credits card + adjust dialog, invoice views tolerate null plan, fixtures/tests |
| **ARCH** | `docs/**` except `docs/reviews/**`, TESTING.md, FIGMA-INDEX.md, AGENT-CONTRACTS.md; `packages/types/**`, `packages/api-client/**` (done) |
| **QA** | `tests/e2e/**` (`phase8-9a*.spec.ts`, helpers), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-9a-qa.md` |
Storefront: **no change**. Shared-read rules: re-read `SendOrderSms.php`, `CampaignPipeline.php`, `BillingPaymentService.php`,
`InvoiceService.php`, `routes/api.php`, `IntegrationsPage.tsx` before each Edit.

## 16.1 Order of work
1. ARCH: types + api-client + openapi (done), this file, ADR 0026, docs.
2. API: migrations + RLS → `SmsCharger` + usage changes → senders (§4.3) + rendering → credits account/ledger → billing
   `sms_credits` (issue, pay dispatch, readers, sweep) → overview/test → templates → sender IDs + media purpose → log →
   admin routes → alert job, limiters, audit, static test.
3. WEB: tab shell + overview → templates editor → log → buy credits + return → sender ID → integrations card,
   Notifications link, campaign allowance credits.
4. ADMIN: sender-ID queue + drawer → merchant SMS credits card + adjust dialog.
5. QA: specs + CI group while the others build; gate after all are green.

## 17. Acceptance criteria
1. A shop that does nothing new sends exactly the same texts with the same allowance behaviour; all pre-existing tests
   pass (only the "used up" timeline wording and new enum values differ).
2. When the allowance of a kind is used up, messages are paid from SMS credits (1 per part) and are skipped only when
   both are gone; credits never let a plan send what its allowance forbids (0) (S211).
3. Credits arrive only after a server-verified platform payment, exactly once per invoice; SMS invoices never touch the
   subscription (S212); staff adjustments are idempotent, audited and visible to the merchant (S213).
4. Custom bn/en templates render with sanitised variables, ≤ 3 parts on the sample, and reset to today's text (S214).
5. A masked sender ID can be requested with a private trade licence, reviewed by Store Plix staff, and once approved is
   used as the caller ID without the "{Shop}: " prefix; revoking falls back (S215, S216).
6. The SMS log shows only this store's messages of the last 90 days with masked phones and never an OTP (S209, S217).
7. Figma `31:5120`, `2075:50213`, `2075:50625`, `2075:51037`, `2075:51449`, `2081:1197`, `2081:1561`, `2087:7872`
   match with the documented omissions; loading/empty/error; 390 px usable.
8. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `sms`, `rls`, `security`, `race`),
   Playwright `phase8-9a*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

## 18. Figma notes for the PO (product owner)
- Merge tags in Figma (`{name}`, `{order_no}`, `{otp}`, `{pay_link}`, `{track_link}`) are renamed to the ones the code
  has always used (§7.1); Figma sample texts differ from the real defaults — the defaults are today's texts (§7.2).
- Overview/Templates "Delivered" event with `{review_link}` is not built (no such event, Q272).
- "Quiet hours 10 PM – 8 AM" select → read-only text for the existing 9 PM – 9 AM rule (Q268); "Sender name" select →
  read-only (changed through the Sender ID tab).
- "Delivered" rate → "Sent successfully" (no delivery reports, Q267).
- SMS log uses Previous/Next (cursor) instead of numbered pages with a total; the OTP row's text is never shown; the
  "Waiting for quiet hours" sub-status is not stored (campaign messages get a log row only when they are sent);
  "Invalid number" failure reason → "Provider error" (no provider text is stored for display).
- Buy credits "PAID WITH" column (card brand) is not on the invoice summary and is omitted; invoice numbers use the
  platform sequence (`SP-2026-…`), not `INV-SMS-…`.
- Sender ID "Promotions" chip is shown disabled (promotional sender IDs need a separate approval, Q272); a Note field
  and a request history list are composed.
- Admin queue shows a count only on "Pending review".
- Mobile frames exist only for Overview and SMS log; Templates, Sender ID and Buy credits follow the 390 px rules (§12.7).

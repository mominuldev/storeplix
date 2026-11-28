# Phase 8.9b contract: Platform SMS provider — gateways, failover, platform messages, broadcasts, platform SMS log (binding for ARCH, API, ADMIN, WEB, QA)

Status: **Accepted, 2026-11-28 — PO (product owner) accepted the proposed defaults for Q274–Q286** (Q273 answered by
this contract). Branch `feat/phase-8-9b-sms-provider` (from `feat/phase-8-9a-sms` @ 104a439: 8.9b builds on the 8.9a
contract and **its API must land after the 8.9a API**, §16.1).
Roadmap task **8.9b** "Platform SMS provider (super-admin)". AC: **"Store Plix staff run the platform's SMS gateway
from the super-admin — a primary and a failover provider with write-only, rotatable credentials, a watched balance and
automatic failover — decide which platform messages merchants get and in what words, send promotional broadcasts
merchants can opt out of, and see every platform SMS in one log; nothing a merchant or shopper receives changes until
staff change it"** (§17).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 (+ amendment A1: `manage_settings`,
`platform_settings`) … PHASE-8-8D, **PHASE-8-9A** and docs/api/API-CONVENTIONS.md still applies. Addendum A (phone
OTPs: TTL 5 min, rate limits, HMAC storage), PHASE-5b T28/S26/S27 (integration credentials encrypter, `SafeHttpClient`),
PHASE-7 (platform billing emails P7-21, `BillingNotifier`), PHASE-8-5 P85-6/P85-8 (SMS opt-out link footer, re-check at
send time, Q141 no inbound SMS) apply in full. **Amends** PHASE-8-9A §4.1 (`SmsGateway::send` gains a route; the
binding becomes a router; `RevesmsGateway` becomes a driver), §9 (merchant log maps the new error codes to
`provider_error`), Addendum A (`OtpService` rows always `tenant_id = null`, gain `parts` and `merchant_tenant_id`) and
FIGMA-INDEX "Platform SMS provider" (old Settings card `46:6794` / `46:7167` superseded).
Machine-readable spec: `docs/api/openapi.yaml` **v1.24.0** (tag `platform-sms`; `account`). ADR **0027** (new:
platform SMS providers, failover and broadcasts). Product defaults: OPEN-QUESTIONS **Q274–Q286**.

### Scope

**One PR, one QA gate.**

| Area | Owner | Ships |
|---|---|---|
| **Providers** | API | `sms_providers` registry, drivers (REVE + generic HTTP), encrypted write-only credentials, test, activate (typed), rotate (test-then-swap), remove, env bootstrap (§3, §4) |
| **Routing + failover** | API | `SmsRouter` behind `SmsGateway`: primary → failover per message group, circuit breaker, 30-min retry window for platform SMS (§4.4–§4.6) |
| **Balance** | API | 15-minute balance fetch, low-balance email + in-app alert (§4.7) |
| **Platform messages** | API | 9 platform types, bn/en templates (3 locked), toggles, sends wired at existing events (§5, §6) |
| **Broadcasts** | API | Audience, schedule window, estimate, typed confirm, weekly cap, STOP footer, per-recipient rows, queued sending (§7) |
| **Opt-out** | API/WEB | Account page switch + public `/s/{code}` page (§7.6) |
| **Platform SMS log** | API/ADMIN | Platform-sent SMS only, masked, codes hidden, CSV (§8) |
| **Super admin UI** | ADMIN | `/settings/sms?tab=provider\|messages\|broadcasts\|log`, drawers, dialogs, shell banner (§11) |
| **Docs + types** | ARCH | openapi 1.24.0, `packages/types`, `packages/api-client` (**already written**, §13), ADR 0027, DATABASE-DESIGN §5.13, SECURITY T44, OPEN-QUESTIONS, roadmap |
| **QA** | QA | `phase8-9b*.spec.ts`, Pest group `platform-sms` (§14) |

**Out of scope** (hide, never fake): delivery reports and the DLR callback URL (Q267); native SSL Wireless, Alpha SMS
and BulkSMSBD drivers ("Coming soon" cards, Q274); SMS two-step sign-in codes for merchants, "New sign-in alert",
"Trial ending offer" and "Win-back" rows (no such events, Q278); SMS for `dropped_to_free` / `domain_will_detach`
(email only, Q278); inbound "reply STOP" (Q141); Announcements SMS channel (`42:3989`, not built); per-operator delivery
rate in Integration health `41:11082`; buying gateway balance; merchant masked sender IDs on the failover (Q277);
a separate broadcast permission (Q285).

### Conventions in this file
- **Platform SMS** = an SMS Store Plix sends to a merchant user (registration, billing, codes, broadcasts). **Shop SMS**
  = every 8.9a merchant-to-customer SMS (paid by the shop's allowance/credits). Both go through the same gateway.
- **Group** (`SmsMessageGroup`) = `shop | registration | billing | security | promotional` — the unit of routing.
- **Staff** = platform staff on the admin surface; every `/admin/sms/*` route needs `manage_settings` (super_admin).
- **Part** = one SMS segment (`SmsParts::count`, P85-18). Money: integer **paisa** (BDT). Times: **Asia/Dhaka** for
  platform rules (sending hours, KPIs "this month", log dates).
- Masked phone = the 8.9a format `01711-•••211` everywhere (Figma `017••••5678` is restyled, §18).
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**; `SMS_DRIVER=fake` (tests) / `log` (dev);
  `SMS_PROVIDERS_HTTP_FAKE=true` (dev/e2e) makes driver calls answer a canned success (§4.2).

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§15). Before every Edit of a shared-read file, re-read it.
- New dependencies: **none**. Never `migrate:fresh` the local dev DB.
- **Nothing changes until staff act**: with no database provider the gateway behaves exactly as 8.9a (env REVE); the
  three account-code texts stay byte for byte; billing emails stay as they are (SMS are added next to them, on by default
  only where §6.2 says so); every existing Pest test and Playwright spec stays green without edits except added enum
  values.
- **Secrets never leave the server**: no API response, log line, audit meta, exception message, queue payload or
  Playwright trace contains a provider credential (static + log-scan tests, §14).

---

## 0. Summary and goals
Today every SMS — shop order updates, checkout codes, campaigns, and the platform's own sign-in codes — goes through one
REVE SMS account configured in `.env`; when REVE is down, nothing is sent and nobody is told; the platform sends
merchants only sign-in codes by SMS. 8.9b moves the gateway into the database and the super-admin (**Platform settings
→ SMS provider**, Figma `2098:8460`): staff configure REVE (or any HTTP provider) as the primary, add a failover that
takes over automatically, rotate keys safely, watch the balance; they decide which platform messages merchants get
(registration, invoices and billing, codes) and edit their bn/en texts; they send promotional broadcasts within quiet
hours, a weekly cap and an opt-out; and they see every platform SMS in one log.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P89B-1 | **Provider registry in the database** (Q274): `sms_providers` rows configured by staff; drivers `revesms` (built, recommended) and `http` (generic HTTP, built); `ssl_wireless`, `alpha_sms`, `bulksmsbd` are catalogue entries with `status: coming_soon` (shown disabled; 422 `sms_provider_driver_unavailable`) until their APIs are verified — any of them can be configured now through `http` | REVE is the BTRC account we have; the others' APIs are unverified, and the generic driver covers them meanwhile |
| P89B-2 | **Env bootstrap** (Q274): while no `primary` row exists, routing uses the 8.9a env config (`SMS_DRIVER`, `REVESMS_*`) exactly as today (`source = environment`). The first activated primary takes over; env is then ignored for sending. `SMS_DRIVER=log\|fake` always wins for **sending** (local/tests never reach a real provider through routing) | Zero-downtime migration; tests stay deterministic |
| P89B-3 | **Generic HTTP driver**: `SmsHttpMapping` (method, body format json/form/query, param names for to/text/sender and each credential, success JSON path + value, message-id path); calls go through `SafeHttpClient` (https only, no private/loopback/link-local/metadata hosts, no redirects, 10 s connect / timeout = `failover_timeout_seconds`) | Any BD provider with a simple send API, without SSRF |
| P89B-4 | **Credentials write-only** (Q274): encrypted with the integration-credentials encrypter (`INTEGRATION_CREDENTIALS_KEY`, AES-256-GCM, T15/T28) in `credentials_encrypted`; never returned — responses carry `credentials_hint` (`••••` + last 4 per field); hidden on the model; never in logs, audit meta, exceptions or job payloads (jobs load by provider id) | Same proven path as merchant gateway credentials |
| P89B-5 | **Rotate = test, then swap** (Q275): `POST …/rotate {credentials, settings?, phone}` sends a test SMS with the **new** credentials synchronously; only a passing test replaces the stored ones (same transaction updates `credentials_rotated_at/by`, `revision`, clears the breaker); a failure → 422 `sms_provider_test_failed`, nothing stored, the old credentials keep working. Audited `sms_provider.credentials_rotated` / `rotation_failed` (field keys + hints only) | "The old secret stays active until the new one passes a test send" |
| P89B-6 | **Roles** (Q276): `draft → primary \| failover`; at most one `primary` and one `failover` (partial unique indexes). The primary must carry `shop`, `registration`, `billing`, `security` (`promotional` optional); a failover carries any non-empty subset. Replacing the primary demotes the old one to `failover` (checkbox "Keep {old} as the failover", default on; the existing failover then becomes `inactive`) or `inactive` | One clear path for every message |
| P89B-7 | **Typed confirmation + permission** (Q276): activating or replacing the **primary** needs `confirm_name` equal to the provider name (trimmed, case-insensitive; 422 `confirmation_mismatch`) and a **passed test after the last connection change** (`test_required` false; else 409 `sms_provider_test_required`) — the failover needs the passed test only. **Removal** (`POST …/remove {confirm_name}`) is allowed for `failover`, `draft` and `inactive` (409 `sms_provider_is_primary`); it deletes the credentials (`removed`, row kept for log history). All under `manage_settings` | A typo or a stale key can't take SMS down |
| P89B-8 | **Failover rule** (Q277): a provider's breaker opens after `failover_after_failures` (1–10, default **3**) consecutive **provider-level** failures (`unavailable` or `auth`, §4.4) or **one** call slower than `failover_timeout_seconds` (3–30, default **10**); while open, its groups go to the failover. After **5 minutes** without a new failure the breaker half-opens: the next message tries the primary again (success closes it). Breaker state in the platform cache (`PlatformCache::key('sms:breaker:{id}')`); opening and closing are audited (`sms_provider.failover_started/ended`, system actor) and opening emails super admins | Figma "switch after 3 failed batches … switch back after 5 min without errors" |
| P89B-9 | **Shop SMS gain failover only**: 8.9a charging, texts, rows and retries are unchanged; the router just picks the provider. A shop's approved masked sender ID (8.9a) is passed only to the **primary**; on the failover the failover's default sender is used and the body stays as rendered (no "{Shop}: " prefix re-added) | Masks are registered per provider; rare, bounded degradation (Q277) |
| P89B-10 | **Retry window** (Q277): a platform SMS whose send failed at provider level on every candidate is retried by its job (backoff 30 s, 60 s, 2, 4, 8, 15 min) until **30 minutes** after the row's `created_at`, then `failed` with `provider_unavailable`. Account codes (`otp_*`) stop at **5 minutes** (the code's TTL). A timeout is never retried (the provider may have accepted it); a message-level rejection (`rejected`) is never retried. Shop SMS keep their 8.9a retry behaviour | "Queued SMS are retried for 30 min, then marked failed"; codes are useless after 5 min |
| P89B-11 | **Platform message catalogue** (Q278): nine types in four groups — Registration: `welcome`, `phone_verification` (locked); Invoice & billing: `invoice_issued`, `payment_received`, `payment_due` ("Payment due or failed"), `plan_expiring`; Login & security: `sign_in_code` (locked), `password_reset_code` (locked); Promotional: `broadcast`. Each maps to one `sms_messages.purpose` (`otp_*` kept; new `platform_*`) | Exactly the events the code has (§5); nothing invented |
| P89B-12 | **Locked types**: always on (`enabled: null`), text not editable, read-only in the editor; the text is today's `OtpService::TEXT` byte for byte, English for both languages (codes are sent in English as today) | Codes must always arrive and must not be phishable |
| P89B-13 | **Sender by group, not per type**: `registration`, `billing`, `security` use the carrying provider's `default_sender_id` ("Storeplix"); `promotional` uses its `promotional_sender_id` and pauses while that mask is `pending` or absent (`promotional_paused` alert; broadcasts can't be scheduled: 409 `promotional_sender_not_approved`) | BTRC: promotional content only from a promotional mask, transactional never from it |
| P89B-14 | **Templates** (Q279): editable types have custom bn/en bodies in `platform_sms_templates` (only custom rows stored; defaults in `resources/sms/platform/{bn,en}.php`, §6.2); rules as 8.9a P89A-8: 1–480 chars, only the type's merge fields, required ones kept, **no typed links** (`{link}` is server-made), sample render ≤ **3 parts**, `revision` (409), saving the default deletes the row. Merge fields `{merchant_name}` `{store_name}` `{invoice_no}` `{amount}` `{due_date}` `{plan}` `{link}` (`{otp}` only in locked texts) | Same editor and safety as merchant templates |
| P89B-15 | **Toggles**: `platform_sms_message_types.enabled` per editable type (default **on** for all billing types and `welcome`, §6.2). Off = no SMS (emails unaffected). `broadcast` off is refused while a broadcast is `scheduled` or `sending` (409 `broadcasts_pending`); while off, broadcasts can't be scheduled (409 `platform_sms_type_disabled`) | Simple kill switches |
| P89B-16 | **Recipients of platform SMS**: the merchant user concerned — for billing the tenant **owner** (as P7-21 emails), for welcome the registering user — and only to a **verified** phone (`users.phone_verified_at`); no verified phone → no row (log line `platform_sms.skipped_unverified`). Language = the tenant's store `sms_language` (welcome: `bn`) | Never text an unverified number |
| P89B-17 | **Broadcast audience** (Q280): `all` · `plan` (plan codes) · `status` (subscription statuses) · `trial_ending` (status `trialing`, `trial_ends_at` within 7 days); one recipient per tenant = its owner; skipped: `suspended` tenants, owner without verified phone (`no_verified_phone`), `opted_out`, `weekly_cap`, the same user already in this broadcast (`duplicate`) | Figma radio cards; owners decide about the plan |
| P89B-18 | **Sending hours** (Q280): promotional SMS only leave **09:00–21:00 Asia/Dhaka**; `scheduled_at` must lie in that window, ≥ now + 5 min, ≤ now + 30 days; "Send now" outside it → 422 `outside_sending_hours`. A broadcast still sending at 21:00 pauses and resumes at 09:00 | Figma "9 AM – 9 PM only" |
| P89B-19 | **Estimate + typed confirm** (Q280): estimate = recipients, skipped by reason, parts per language incl. the STOP footer, total parts, cost (parts × promotional provider's masking price), gateway balance and balance after (`below_alert`). Schedule needs `acknowledged: true` and `confirm_recipients` = the count of a **fresh** server estimate (409 `broadcast_estimate_changed`, details = new estimate); cost > known balance → 422 `gateway_balance_insufficient`; 0 recipients → 422 `broadcast_empty_audience` | The number typed is the number sent |
| P89B-20 | **Weekly cap** (Q280): at most **2** promotional SMS per tenant in any rolling 7 days (sent + pending recipient rows), checked in the estimate and again per recipient at send time | Figma "2 per merchant per week" |
| P89B-21 | **Opt-out** (Q281): per **user** (`users.platform_promo_sms_opted_out_at`, source `account \| link`). Every promotional SMS ends with the server-added footer bn `বন্ধ করতে: {url}` / en `STOP: {url}`, `url` = `{PLATFORM_SMS_OPT_OUT_BASE}/{code}` (default `{merchant app URL}/s/{code}`), `code` = 10 base62 chars per recipient stored as sha256 only (P85-6). The public page (merchant app `/s/{code}`, WEB) shows the state; GET never opts out, a button POSTs. The owner can also switch it on/off on **Account → Store Plix SMS**. Codes, billing and security SMS are never affected | REVE has no inbound SMS (Q141); link opt-out proven in 8.5 |
| P89B-22 | **Queued sending**: confirm → `scheduled` (or `sending` when `scheduled_at` is null); `sms:run-broadcasts` (every minute) starts due ones; `StartPlatformBroadcast` materialises `platform_sms_broadcast_recipients` (one row per tenant, skipped ones with reason); `SendPlatformBroadcastBatch` (100 recipients) re-checks opt-out, cap, phone, suspension per recipient (P85-8), renders, sends through the `promotional` route paced by the provider's `rate_limit_per_minute`, writes `sms_messages` + recipient status; counters updated; `sent` when no recipient is `pending`; `failed` when the route stayed unavailable for the whole retry window and nothing was sent. Cancel only while `scheduled` | Per-recipient truth, restartable |
| P89B-23 | **Gateway balance** (Q282): `sms:fetch-balances` every **15 minutes** for primary and failover whose driver supports it (`revesms`: balance endpoint, POST body credentials; `http`: unsupported in 8.9b → `unsupported`). Stored on the provider (`balance_amount`, `balance_fetched_at`, `balance_status`). Below `low_threshold_paisa` (default ৳1,000 = 100,000) → one email to every active super admin and an in-app banner (`low_balance` alert), once per crossing (`low_balance_alerted_at`, re-armed when back above); per-provider `alert_email` / `alert_in_app` switches. Balance can't be bought here | Figma Gateway balance card; no spam |
| P89B-24 | **Platform SMS log** (Q283): rows with `tenant_id IS NULL` (all platform SMS: `otp_*`, `platform_*`; the shop is in `merchant_tenant_id`); never shop SMS. 90 days (Asia/Dhaka), newest first, cursor 50; filters `q` (exact phone, else shop name ≥ 2), status, group, dates. Phones masked; code bodies never stored (`body_preview` null, `body_hidden: true`, "Code hidden"); other previews ≤ 160 chars with links → `[link]`, nulled after 90 days (8.9a `sms:prune-previews`). CSV export with the same filters, same masking, ≤ 50,000 rows, 5/hour, audited | Figma `2098:10472`; privacy as 8.9a |
| P89B-25 | **Permissions** (Q285): every `/admin/sms/*` route needs **`manage_settings`** (super_admin only; nearest existing to "manage platform settings"). No new platform permission. Merchant: `/account/sms-preferences` = any signed-in user (own row); `/platform-sms/opt-out/{code}` public, limiter | Gateway keys and broadcasts are the highest-trust platform actions |
| P89B-26 | **Admin test sends**: provider test, rotation test, template test, broadcast test go to a phone the staff member types (BD mobile, normalised; pre-filled from their own profile phone), synchronous, limiter `admin-sms-test` **10/hour per staff member**, row purpose `platform_test`, audited with the masked phone | Staff accounts usually have no verified phone (My profile is not built) |
| P89B-27 | **Recent errors and health**: overview lists the last 20 failed or failed-over SMS of 24 h (any group) with our error code and the provider's text **redacted** (credentials removed, ≤ 200 chars) — staff only; merchants keep seeing `provider_error` only | Figma "Recent errors" without leaking secrets to merchants |
| P89B-28 | **Rate limit** per provider (`rate_limit_per_minute`, 1–6,000, default 300): enforced only on the `promotional` route (broadcast batches wait); every other send counts toward it but is never delayed ("codes always first") | Broadcasts never slow down codes |
| P89B-29 | **Cost** is an estimate: Σ parts × the carrying provider's `price_masking_paisa` (every platform and shop SMS uses a masked sender); no money is charged anywhere; `sms_messages.provider_id` records who sent it | KPIs and balance forecasts without a billing system |
| P89B-30 | **Admin writes take no `reason`** (unlike tenant-level PHASE-8-1 actions): they don't act on one merchant; the typed name / typed count is the deliberate step; every write is audited with the platform actor | Figma has no reason fields |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q274–Q286; **answered 2026-11-28: proposed defaults accepted**)

| Q | Question | Proposed default |
|---|---|---|
| Q274 | Providers, drivers, credentials, env | DB registry; REVE + generic HTTP built, SSL Wireless / Alpha SMS / BulkSMSBD "Coming soon" (use HTTP meanwhile); one primary + optional failover; credentials encrypted, write-only (last 4); env REVE is the bootstrap while no primary exists |
| Q275 | Rotating a secret | New credentials must pass a test send before they replace the old ones; audited |
| Q276 | Activating, replacing, removing | Typed provider name + passed test for the primary; `manage_settings`; remove only a failover (or a draft/inactive one), never the primary |
| Q277 | Failover | Switch after 3 consecutive provider failures or one 10 s timeout; back after 5 min without errors; platform SMS retried 30 min (codes 5 min) then failed; shop masked sender IDs only on the primary |
| Q278 | Which platform messages exist | Wired: welcome (first phone verification), phone verification / sign-in / password reset codes (locked), invoice issued, payment received, payment due or failed, plan expiring (trial or grace ending), broadcasts. Not built: SMS 2-step, new sign-in alert, trial-ending offer, win-back, dropped-to-free and domain-detach SMS |
| Q279 | Platform templates | bn + en per editable type, merge tags, no typed links, ≤ 3 parts, reset; locked code texts unchanged (English); sender fixed by group |
| Q280 | Broadcasts | Audience all / plan / status / trial ending; 9 AM–9 PM Dhaka; estimate with cost and balance; typed recipient count; weekly cap 2 per merchant; queued per-recipient sending; cancel until it starts |
| Q281 | Merchant opt-out | Per user: Account page switch + link footer "STOP: {link}" to `/s/{code}`; never affects codes or billing |
| Q282 | Gateway balance | Every 15 min where the driver supports it; low-balance email to super admins + in-app banner once per crossing; default threshold ৳1,000 |
| Q283 | Platform SMS log | Platform SMS only (tenant_id null), 90 days, masked phones, codes never stored, CSV export masked |
| Q284 | Old Figma SMS gateway card (`46:6794` / `46:7167`) | Superseded by `/settings/sms`; Integration health shows "accepted by gateway" only |
| Q285 | Who manages platform SMS | `manage_settings` (super admin) for everything incl. broadcasts and the log; no new permission |
| Q286 | Later (record only) | Native SSL Wireless / Alpha SMS / BulkSMSBD drivers, DLR callbacks and delivery rate, HTTP-driver balance, SMS two-step and sign-in alerts, trial-ending offer and win-back automations, Announcements SMS channel, inbound STOP, per-provider merchant masks, a broadcast-only permission, buying balance |

## 2. Permission and plan
No new platform permission (P89B-25): every §9.1 route is `platform.can:manage_settings`; the settings nav item "SMS
provider" and the shell banner are visible with `manage_settings` only. Billing, support and read-only roles get 403
`forbidden` (`AdminForbidden`) on every route (matrix test). Merchant: `/account/sms-preferences` needs
`auth:sanctum` on the merchant surface, no `X-Tenant-Id`, own row only; impersonation sessions → 403
`impersonation_read_only` on PATCH. Plans: none (platform feature).

## 3. Data (owner API; forward-only; migrations prefix `2026_12_12_`)
Platform tables (no `tenant_id` column of their own, no RLS — like `platform_settings`): **app role SELECT only** on
`sms_providers`, `platform_sms_message_types`, `platform_sms_templates` (sending needs them); **no grant** on the two
broadcast tables (only `pgsql_admin`). Writes run on the platform connection (`PlatformDb::reroute`). `RlsTables::TENANT`
stays **95**.

### 3.1 New tables
- **sms_providers** (`000100`): id · driver varchar(16) CHECK `IN ('revesms','ssl_wireless','alpha_sms','bulksmsbd',
  'http')` · name varchar(60) · role varchar(10) CHECK `IN ('draft','primary','failover','inactive','removed')` ·
  credentials_encrypted text null (null only when `removed`; CHECK) · credentials_hint jsonb default '{}' · settings jsonb
  (`account_id`, `base_url`, `http`) · default_sender_id varchar(11) · promotional_sender_id varchar(11) null ·
  promotional_sender_status varchar(10) null CHECK `IN ('approved','pending')` · message_groups jsonb (list) ·
  rate_limit_per_minute int default 300 CHECK 1–6000 · failover_after_failures smallint default 3 CHECK 1–10 ·
  failover_timeout_seconds smallint default 10 CHECK 3–30 · price_masking_paisa int null · price_non_masking_paisa int
  null · balance_amount bigint null · balance_fetched_at timestamptz null · balance_status varchar(12) null CHECK `IN
  ('ok','unsupported','error')` · low_threshold_paisa bigint null default 100000 · alert_email bool default true ·
  alert_in_app bool default true · low_balance_alerted_at timestamptz null (null = armed) · connection_changed_at
  timestamptz (create, rotate, settings change) · last_test_at null · last_test_status varchar(8) null CHECK `IN
  ('passed','failed')` · last_test_error_code varchar(32) null · last_test_by null FK users SET NULL ·
  credentials_rotated_at null · credentials_rotated_by null FK users SET NULL · activated_at null · activated_by null FK
  users SET NULL · removed_at null · removed_by null FK users SET NULL · created_by null FK users SET NULL · revision int
  default 1 · timestamps. Partial **U(role) WHERE role = 'primary'**, partial **U(role) WHERE role = 'failover'**,
  partial **U(lower(name)) WHERE role <> 'removed'**. `test_required` = `last_test_status IS DISTINCT FROM 'passed' OR
  last_test_at < connection_changed_at`.
- **platform_sms_message_types** (`000200`): type varchar(24) PK CHECK `IN` the 9 types · enabled bool · updated_by null
  FK users SET NULL · updated_at. Seeded by the migration (all `true`; locked types forced `true` in code).
- **platform_sms_templates** (`000200`): id · type varchar(24) CHECK editable types (`welcome`, `invoice_issued`,
  `payment_received`, `payment_due`, `plan_expiring`) · language char(2) CHECK `IN ('bn','en')` · body text CHECK
  `char_length BETWEEN 1 AND 480` · revision int default 1 · updated_by null FK users SET NULL · timestamps. **U(type,
  language)**.
- **platform_sms_broadcasts** (`000300`): id · name varchar(80) · body_bn text · body_en text (CHECK 1–480 each) ·
  audience jsonb · status varchar(10) CHECK `IN ('draft','scheduled','sending','sent','cancelled','failed')` ·
  scheduled_at null · started_at null · finished_at null · estimate jsonb null (confirmed estimate) · recipients_count
  int default 0 · sent_count · failed_count · skipped_count int default 0 · provider_id char(26) null (soft ref) ·
  sender_id varchar(11) null · failure_reason varchar(40) null · created_by / confirmed_by / cancelled_by null FK users
  SET NULL · confirmed_at · cancelled_at null · revision int default 1 · timestamps. IX(status, scheduled_at);
  IX(created_at DESC).
- **platform_sms_broadcast_recipients** (`000300`): id · broadcast_id FK CASCADE · tenant_id FK tenants CASCADE
  (subject, not an RLS owner) · user_id null FK users SET NULL · to varchar(15) null · language char(2) · status
  varchar(8) CHECK `IN ('pending','sent','failed','skipped')` · skip_reason varchar(20) null CHECK `IN ('opted_out',
  'no_verified_phone','weekly_cap','suspended','duplicate')` · parts smallint null · opt_out_code_hash char(64) null **U**
  · sms_message_id char(26) null · sent_at null · timestamps. **U(broadcast_id, tenant_id)**; IX(tenant_id, status,
  created_at) (weekly cap); IX(broadcast_id, status). Pruned after 13 months (`sms:prune-broadcast-recipients`, as
  P85-28); `to` is nulled with the 90-day preview prune.

### 3.2 Changed tables
- **sms_messages** (`000400`, platform model; RLS policies unchanged): add `provider_id char(26) null` (soft ref; null =
  environment or not sent) · `merchant_tenant_id char(26) null` (FK tenants SET NULL; platform rows only — the merchant
  the SMS was about) · `platform_type varchar(24) null` (the `PlatformSmsType`, null for shop rows). New purposes
  `platform_welcome`, `platform_invoice_issued`, `platform_payment_received`, `platform_payment_due`,
  `platform_plan_expiring`, `platform_broadcast`, `platform_test`; `error_code` gains `provider_unavailable`,
  `provider_timeout`, `provider_auth`, `no_route`. Data step (on `pgsql_admin`): `UPDATE sms_messages SET
  merchant_tenant_id = tenant_id, tenant_id = NULL WHERE purpose LIKE 'otp\_%' AND tenant_id IS NOT NULL`; set
  `platform_type` for existing `otp_*` rows. Indexes: partial IX(created_at DESC, id DESC) WHERE tenant_id IS NULL;
  partial IX(to, created_at DESC) WHERE tenant_id IS NULL; IX(provider_id, created_at) WHERE provider_id IS NOT NULL.
- **users** (`000500`): add `platform_promo_sms_opted_out_at timestamptz null` · `platform_promo_sms_opt_out_source
  varchar(8) null CHECK IN ('account','link')` · `welcome_sms_at timestamptz null` (once-only welcome).

### 3.3 Invariants and locks
Activation, removal, rotation and role changes run in one transaction on `pgsql_admin` that locks **all non-removed
`sms_providers` rows `FOR UPDATE` ordered by id**, then flushes the routing cache (`PlatformCache::key('sms:routing')`).
Broadcast schedule/cancel lock the broadcast row. The welcome SMS claims `UPDATE users SET welcome_sms_at = now() WHERE
id = ? AND welcome_sms_at IS NULL` (send only when 1 row changed).

## 4. Gateway, drivers, routing (owner API; `App\Domain\Sms\Providers\*`, `App\Domain\Sms\Routing\*`)

### 4.1 Driver interface (amends 8.9a §4.1)
```php
interface SmsProviderDriver {
    /** @throws SmsSendFailed with ->reason: rejected | unavailable | timeout | auth */
    public function send(SmsConnection $c, string $msisdn, string $text, string $senderId): SmsResult;
    /** null = not supported by this driver */
    public function balance(SmsConnection $c): ?SmsBalance;
}
```
`SmsConnection` = decrypted credentials (`#[\SensitiveParameter]`, never serialised, `__debugInfo` redacts) + settings +
timeout. `RevesmsGateway` becomes `Drivers\RevesmsDriver` (same request/response handling, `callerID` = `$senderId`);
reasons: connection error / HTTP 5xx → `unavailable`; REVE auth/credential status → `auth`; read timeout → `timeout`;
other non-zero `Status` → `rejected`. `Drivers\HttpDriver` per P89B-3. `FakeSmsGateway` / `LogSmsGateway` stay and also
implement the driver interface. `SmsSendFailed` gains `reason`, `providerId`, `detail` (redacted).

### 4.2 Catalogue (`config/sms.php` `drivers`)
Per code: `name`, `status`, `recommended`, `btrc_approved`, `price_masking_paisa`, `price_non_masking_paisa`, `features`
(`masking`, `unicode`, `balance`; `dlr` false), `credential_fields`, `settings_fields`, `default_base_url`. REVE: fields
`api_key` (secret), `secret_key` (secret); settings `account_id` (optional), `base_url` (default
`https://smpp.revesms.com:7790`). HTTP: credential fields are free keys (1–5, names `[a-z_]{2,32}`, all secret).
`SMS_PROVIDERS_HTTP_FAKE=true` → every driver call answers a canned success (`message_id` = ULID, balance ৳5,000) without
network; refused at boot in production (S231).

### 4.3 Router (`SmsGateway` binding)
`SmsGateway::send(string $msisdn, string $text, ?string $senderId = null, SmsRoute $route = SmsRoute::Shop):
SmsResult` (`SmsRoute` = the five groups). The binding is `RoutingSmsGateway`:
1. `SMS_DRIVER=log|fake` → that driver, done (P89B-2).
2. Candidates = [primary, failover] filtered by `message_groups ∋ route` and breaker state (open → skipped unless
   half-open probe); no database primary → [env REVE] (`source = environment`); none → throw `SmsSendFailed(reason
   unavailable, error_code no_route)`.
3. Sender: `promotional` → the candidate's approved `promotional_sender_id` (none/pending → skip candidate, `no_route`);
   `shop` → `$senderId` (masked) only on the primary, else the candidate's default; other routes → default.
4. Try the first candidate; on `unavailable` / `auth` → record failure, **try the next candidate in the same call** (the
   message was not accepted); on `timeout` → record failure + open the breaker, **no second try**; on `rejected` → throw
   (no breaker count). Success → record success (resets the count), return `SmsResult` with `provider_id`.
5. Every SMS writer stores `provider_id` from `SmsResult` / `SmsSendFailed` (`sms_messages.provider_id`).
Routing reads provider rows through a 60 s platform cache flushed on every provider write.

### 4.4 Breaker — P89B-8. Failure kinds counted: `unavailable`, `auth`, `timeout` (timeout trips at once).
### 4.5 Retry window — P89B-10. `SendSms` (account codes) and the new `SendPlatformSms` / broadcast batch jobs release
themselves with the backoff while `now < created_at + window`; the row stays `queued`; on expiry `failed`,
`error_code = provider_unavailable`. `tries` stays bounded by the window, never re-sends an accepted SMS.

### 4.6 Provider lifecycle (all `manage_settings`, audited, platform actor, `tenantId: false`)
- **Create** (`POST /admin/sms/providers`, 201): driver `available` (else 422 `sms_provider_driver_unavailable`), name
  unique (409 `sms_provider_name_taken`), credentials complete for the driver, `base_url` https (422), sender IDs 3–11
  letters/digits (8.9a pattern), groups non-empty. Role `draft`. Audit `sms_provider.created` (driver, name, hints).
- **Update** (`PATCH`, `revision` → 409 `revision_conflict`): name (drafts only), senders, groups (primary keeps the
  required four: 422), rate limit, failover rules, prices, alert settings; `settings.account_id/base_url` only while
  `draft` (active providers change them through rotate). Changing settings sets `connection_changed_at`. Audit
  `sms_provider.updated` (changed keys).
- **Test** (`POST …/test {phone}`): fixed text "Store Plix SMS test from {provider name}. No action needed." through
  this provider only (breaker ignored), synchronous, limiter `admin-sms-test`; records `last_test_*`, reads the balance
  when supported; 200 `SmsProviderTestResult` (a failed test is a 200 with `status: failed`). Row purpose
  `platform_test`. Audit `sms_provider.tested` (status, masked phone).
- **Activate** (`POST …/activate`) — P89B-6/7; result = the new overview. First primary: `source` becomes `database`.
  Queued platform SMS simply go out on their next attempt through the new routing. Audit `sms_provider.activated` (role,
  previous primary/failover ids).
- **Rotate** — P89B-5. **Remove** — P89B-7 (credentials and hints wiped, `removed_at/by`). Audit `sms_provider.removed`.
- **Refresh balance** (`POST …/refresh-balance`, 6/hour per provider) → `SmsProvider`.

### 4.7 Balance and alerts
`sms:fetch-balances` (every 15 min, `withoutOverlapping`) — P89B-23. `SmsBalanceAlerts`: crossing below threshold →
`PlatformSmsMail::LOW_BALANCE` to active super admins (when `alert_email`), audit `sms_provider.low_balance` (system).
`GET /admin/sms/alerts` (`manage_settings`) → list of `PlatformSmsAlert`: `no_provider` (danger: source `none` —
"No SMS provider — sign-in codes will fail"), `low_balance` (warning, when `alert_in_app`), `balance_unavailable` (info,
fetch failed twice), `failover_active` (warning), `promotional_paused` (info). The admin shell shows the highest one.

## 5. Where platform SMS are sent (owner API; verified in code 2026-11-28)
| Type | Event in code today | 8.9b |
|---|---|---|
| `phone_verification` | `OtpService::send(…, VerifyPhone)` via `OtpController` | Unchanged text and limits; row `tenant_id` null always, `platform_type`, `parts`; route `registration`; window 5 min |
| `sign_in_code` | `OtpService::send(…, Login)` | Same; route `security` |
| `password_reset_code` | `OtpService::send(…, ResetPassword)` | Same; route `security` |
| `welcome` | First successful `POST /auth/phone/verify` (`OtpController`) — no welcome email or SMS exists today | New send after the user's **first** phone verification (claim on `users.welcome_sms_at`); `{store_name}` = the user's first owned store or "your shop" |
| `invoice_issued` | `SubscriptionProcessor` renewal invoice → `BillingMail::INVOICE_ISSUED` | SMS next to the email |
| `payment_received` | `BillingPaymentService` → `PAYMENT_RECEIVED` (and 8.9a `SMS_CREDITS_ADDED`) | SMS next to either email |
| `payment_due` | `SubscriptionProcessor` → `REMINDER` (before due) and `PAST_DUE` (failed / overdue) | SMS next to both |
| `plan_expiring` | `SubscriptionProcessor` → `TRIAL_ENDING` and `GRACE_ENDING` | SMS next to both |
| `broadcast` | — | §7 |
Not sent by SMS (email only, recorded Q278): `DROPPED_TO_FREE`, `DOMAIN_WILL_DETACH`, `OPS_ALERT`, admin **Resend
invoice** (`Ops\ResendInvoice` never sends SMS). Mechanism: `PlatformSmsNotifier::send(PlatformSmsType, User $to,
array $vars, ?Tenant $about)` — checks `enabled`, verified phone, renders (§6), creates the `sms_messages` row
(`tenant_id` null, `merchant_tenant_id`, purpose, `platform_type`, `parts`, `body_preview`) and dispatches
`SendPlatformSms` **after commit**; it is **not** `TenantAware` (runs without a tenant, so the null-tenant row is
updatable under RLS). Billing calls it from `BillingNotifier::ownerSms($type, $vars)` right after the matching
`owner()` email (same vars: `invoice_no`, `amount` formatted "1,770", `due_date` "5 Dec 2026", `plan` name, `link` =
`BillingUrls` plan page). Failures never break the billing flow (caught, logged).

## 6. Message types and templates (owner API)

### 6.1 Catalogue (`GET /admin/sms/message-types` → `PlatformSmsMessageType[]` + `meta`)
| Type | Group | Trigger ("When: …") | Merge fields (required **bold**) | Locked |
|---|---|---|---|---|
| welcome | registration | "A new merchant verifies their phone" | merchant_name, store_name, link | |
| phone_verification | registration | "A merchant verifies a phone number" | otp | ✓ |
| invoice_issued | billing | "A renewal invoice is issued" | merchant_name, store_name, **invoice_no**, amount, due_date, plan, **link** | |
| payment_received | billing | "A payment is confirmed" | merchant_name, store_name, **invoice_no**, amount, plan | |
| payment_due | billing | "An invoice is due soon or a payment failed" | merchant_name, store_name, **invoice_no**, amount, due_date, plan, **link** | |
| plan_expiring | billing | "A trial or grace period is about to end" | merchant_name, store_name, plan, due_date, **link** | |
| sign_in_code | security | "A merchant signs in with a phone code" | otp | ✓ |
| password_reset_code | security | "A merchant resets their password by phone" | otp | ✓ |
| broadcast | promotional | "Staff send a broadcast" | merchant_name, store_name, plan, link (per broadcast) | |
`meta.kpis` (this Dhaka month, platform rows): `sent_this_month`, `codes_this_month` (`otp_*` sent),
`promotional_this_month`, `cost_this_month_paisa` (P89B-29). `meta.groups`: sender ID, carrying provider, rate limit.

### 6.2 Defaults (`resources/sms/platform/{bn,en}.php`; enabled by default)
| Type | bn | en |
|---|---|---|
| welcome | `Store Plix-এ স্বাগতম, {merchant_name}! {store_name} তৈরি। পণ্য যোগ করে বিক্রি শুরু করুন: {link}` | `Welcome to Store Plix, {merchant_name}! {store_name} is ready. Add products and start selling: {link}` |
| invoice_issued | `Store Plix: {plan} প্ল্যানের ইনভয়েস {invoice_no}, {amount} টাকা, শেষ তারিখ {due_date}। পরিশোধ: {link}` | `Store Plix: Invoice {invoice_no} for Tk {amount} ({plan}) is due {due_date}. Pay: {link}` |
| payment_received | `Store Plix: ইনভয়েস {invoice_no}-এর {amount} টাকা পেয়েছি। ধন্যবাদ!` | `Store Plix: Payment of Tk {amount} for invoice {invoice_no} received. Thank you!` |
| payment_due | `Store Plix: ইনভয়েস {invoice_no} ({amount} টাকা) পরিশোধ হয়নি, শেষ তারিখ {due_date}। পরিশোধ: {link}` | `Store Plix: Invoice {invoice_no} (Tk {amount}) is unpaid, due {due_date}. Pay now to keep {plan}: {link}` |
| plan_expiring | `Store Plix: {store_name}-এর {plan} প্ল্যান {due_date} শেষ হবে। চালু রাখতে: {link}` | `Store Plix: Your {plan} plan for {store_name} ends {due_date}. Keep it: {link}` |
| locked (3) | = en (codes are English) | `Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.` (= `OtpService::TEXT`) |

### 6.3 Edit, reset, preview, test
`PUT /admin/sms/message-types/{type}/templates/{language}` — P89B-14 (locked/broadcast → 422
`platform_sms_type_locked`; errors `platform_sms_template_unknown_merge_field` / `_missing_merge_field` (details
`{fields}`) / `_link_not_allowed` / `_too_long` (details `{parts, max_parts: 3}`)); audit `platform_sms_template.updated`
(type, language, old/new length). `DELETE` = idempotent reset (audit `platform_sms_template.reset` when a row existed).
`POST …/preview` (60/min per staff) → `PlatformSmsPreview`; samples: merchant_name "Nasrin" / "নাসরিন", store_name
"Mugdho Fashion", invoice_no "SP-2026-001042", amount "1,770", due_date "5 Dec 2026", plan "Growth", link
`{merchant app URL}/settings/plan`, otp "482913". `POST /admin/sms/message-types/{type}/test {language, phone, body?}`
(P89B-26; locked types send their fixed text with a sample code) → `PlatformSmsTestResult`; audit
`platform_sms.test_sent`. `PATCH /admin/sms/message-types/{type} {enabled}` — P89B-15; audit `platform_sms_type.updated`.
Rendering (`PlatformSmsTemplates::render`): S13 sanitising of every var (control chars stripped, URLs removed from
free-text vars), `{link}` inserted last; a text still over 3 parts is sent and its real parts recorded.

## 7. Promotional broadcasts (owner API; `App\Domain\Sms\Broadcasts\*`)

### 7.1 States
`draft → scheduled → sending → sent | failed`; `draft → (schedule with scheduled_at null) → sending`; `scheduled →
cancelled`; `draft` deletable. Wrong state → 409 `invalid_state_transition`.

### 7.2 Draft (`POST /admin/sms/broadcasts` 201, `PATCH /{id}` drafts only + `revision`, `DELETE /{id}` drafts only)
Body rules as §6.3 with the broadcast merge fields; both languages required; `scheduled_at` per P89B-18 (validated
again at schedule). Audit `platform_sms_broadcast.created/updated/deleted`.

### 7.3 Estimate (`POST /admin/sms/broadcasts/estimate`) and audience counts (`GET /admin/sms/broadcasts/audiences`)
P89B-17/19/20. Footer rendered with a sample 10-char code to count parts. Cost uses the provider that would carry
`promotional` now. Audience counts: tenants per plan, per subscription status, trial ending, all (not suspended).

### 7.4 Schedule (`POST /{id}/schedule`) and cancel (`POST /{id}/cancel`)
Order of checks: state draft → `revision` → `broadcast` type enabled (409 `platform_sms_type_disabled`) → sending hours
(422) → promotional sender approved on the carrying provider (409) → fresh estimate: 0 recipients (422), count =
`confirm_recipients` (409 with details), cost ≤ known balance (422). Stores the estimate, `confirmed_by/at`,
`provider_id`, `sender_id`; status `scheduled` (or `sending` + dispatch when `scheduled_at` is null). Audit
`platform_sms_broadcast.scheduled` (recipients, total parts, cost). Cancel: `scheduled` → `cancelled`; audit.

### 7.5 Sending — P89B-22. Text = rendered body + `\n` replaced by space + " " + footer (language of the recipient).
`sms_messages` row: `tenant_id` null, `merchant_tenant_id`, purpose `platform_broadcast`, `body_preview` with the link
replaced by `[link]`. When finished: `platform_sms_broadcast.finished` (system; counts). Test send (`POST
/admin/sms/broadcasts/test`) uses a test code (`/s/test`, page says "This was a test message").

### 7.6 Opt-out (owner API; page owner WEB)
- `GET /platform-sms/opt-out/{code}` (public, limiter `platform-sms-opt-out` 30/min per IP): sha256 lookup on
  `platform_sms_broadcast_recipients.opt_out_code_hash` (`pgsql_admin`, `// cross-tenant: platform SMS opt-out by code`)
  → `{status, phone_masked}`; unknown → 404. `test` → `{status: 'subscribed', phone_masked: '01•••-•••000'}`.
- `POST /platform-sms/opt-out/{code}`: sets the recipient's user `platform_promo_sms_opted_out_at = now()`, source `link`
  (idempotent); audit `platform_sms.opted_out` (user subject, no actor).
- `GET|PATCH /account/sms-preferences` (`auth:sanctum`, merchant surface, no tenant): `{promotional}`; PATCH true clears
  the opt-out, false sets it (source `account`); audit `platform_sms.opted_in` / `opted_out` (user actor).
- Opt-out is checked at estimate time and again per recipient at send time.

## 8. Platform SMS log (owner API)
`GET /admin/sms/messages` — P89B-24. Query on `pgsql_admin` (`// cross-tenant: platform SMS log`): `tenant_id IS
NULL`, `created_at ≥ start of (today − 90 d)` Dhaka, filters (`q`: normalised BD phone → exact `to`; else ILIKE on the
merchant's store name ≥ 2 chars; `group` → purposes of that group; `status` list; `from`/`to` dates, older than 90 days
→ 422), order `(created_at DESC, id DESC)`, cursor. `PlatformSmsLogEntry`: `type` from `platform_type` (`platform_test`
→ `test`), `merchant` from `merchant_tenant_id`, provider name (null id = environment), `error_code`.
`GET /admin/sms/messages/export` — same filters (no cursor), `text/csv; charset=utf-8` with BOM, columns `time
(Asia/Dhaka), phone (masked), merchant, type, group, message (preview or "Code hidden"), parts, status, provider,
error`; ≤ 50,000 rows (more → 422 `export_too_large`, details `{max}`), limiter `admin-sms-export` 5/hour per staff;
audit `platform_sms.log_exported` (filters, row count).

## 9. API surface and errors (openapi 1.24.0 binding)

### 9.1 Super admin (`routes/admin-sms.php` gains a `platform.can:manage_settings` group; admin stack; never reads `X-Tenant-Id`)
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/sms/drivers` | §4.2 |
| GET | `/admin/sms/alerts` | §4.7 |
| GET · POST | `/admin/sms/providers` | overview §4 · create 201 |
| GET · PATCH | `/admin/sms/providers/{provider}` | §4.6 |
| POST | `/admin/sms/providers/{provider}/test` · `/activate` · `/rotate` · `/remove` · `/refresh-balance` | §4.6; test/rotate limiter `admin-sms-test` |
| GET | `/admin/sms/message-types` | §6.1 |
| PATCH | `/admin/sms/message-types/{type}` | toggle |
| PUT · DELETE | `/admin/sms/message-types/{type}/templates/{language}` | §6.3 |
| POST | `/admin/sms/message-types/preview` · `/admin/sms/message-types/{type}/test` | §6.3 |
| GET · POST | `/admin/sms/broadcasts` | list (`filter[status]`, page; `meta.kpis`) · create 201 |
| GET | `/admin/sms/broadcasts/audiences` | §7.3 |
| POST | `/admin/sms/broadcasts/estimate` · `/admin/sms/broadcasts/test` | §7.3, §7.5 |
| GET · PATCH · DELETE | `/admin/sms/broadcasts/{broadcast}` | §7.2 |
| POST | `/admin/sms/broadcasts/{broadcast}/schedule` · `/cancel` | §7.4 |
| GET | `/admin/sms/broadcasts/{broadcast}/recipients` | cursor, `filter[status]` |
| GET | `/admin/sms/messages` · `/admin/sms/messages/export` | §8 |
Writes add `throttle:admin-write`. Every write audited with `platform: true`, `tenantId: false`.

### 9.2 Merchant and public
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET · PATCH | `/account/sms-preferences` | signed-in user (merchant surface), no tenant | §7.6 |
| GET · POST | `/platform-sms/opt-out/{code}` | public | §7.6, limiter 30/min per IP |

### 9.3 Error codes (new)
`sms_provider_driver_unavailable` (422), `sms_provider_name_taken` (409), `sms_provider_test_required` (409),
`sms_provider_test_failed` (422, details `SmsProviderTestFailedDetails`), `sms_provider_is_primary` (409),
`confirmation_mismatch` (422), `platform_sms_type_locked` (422), `platform_sms_type_disabled` (409),
`broadcasts_pending` (409), `platform_sms_template_unknown_merge_field` / `_missing_merge_field` (422, `{fields}`),
`platform_sms_template_link_not_allowed` (422), `platform_sms_template_too_long` (422, `{parts, max_parts}`),
`outside_sending_hours` (422), `broadcast_estimate_changed` (409, details = `PlatformSmsBroadcastEstimate`),
`promotional_sender_not_approved` (409), `gateway_balance_insufficient` (422, `{cost_paisa, balance_paisa}`),
`broadcast_empty_audience` (422), `export_too_large` (422). Existing: `validation_failed`, `revision_conflict`,
`invalid_state_transition`, `forbidden`, `rate_limited`, `impersonation_read_only`, `not_found`.
**Merchant outputs** (8.9a `SmsLogEntry.error_code`, test SMS 502) map every new provider error code to
`provider_error` (amends 8.9a §9).

## 10. Audit and security

### 10.1 Audit actions (`PLATFORM_SMS_AUDIT_ACTIONS`)
`sms_provider.created|updated|tested|activated|credentials_rotated|rotation_failed|removed|failover_started|failover_ended|low_balance`,
`platform_sms_type.updated`, `platform_sms_template.updated|reset`, `platform_sms.test_sent`,
`platform_sms_broadcast.created|updated|deleted|scheduled|cancelled|finished`, `platform_sms.log_exported`,
`platform_sms.opted_out|opted_in`. Meta never contains a credential (only field keys and hints), a code, a full body,
an opt-out code or an unmasked phone.

### 10.2 Security checklist (S220–S233; each has a test)
- **S220** credentials: encrypted column (not plaintext in DB), hidden on the model, absent from every response (key-set
  test), logs (log scan after create/test/rotate/send failure), audit meta, exception messages and serialised jobs.
- **S221** permission: every §9.1 route → 403 for billing, support, read_only and for merchant tokens (surface); the nav
  item and banner hidden without `manage_settings`.
- **S222** typed confirmation: primary activation and removal compare the name server-side; wrong → 422 and nothing
  changes; activation without a passed test after the last connection change → 409.
- **S223** rotation: a failing new credential never replaces the working one (DB unchanged, sends keep using the old);
  success swaps atomically and is audited.
- **S224** SSRF: `base_url` https only on save and at send; `SafeHttpClient` refuses private, loopback, link-local,
  CGNAT, metadata and IP-literal hosts and redirects (matrix incl. `https://169.254.169.254`, DNS rebinding pin).
- **S225** failover integrity: an accepted message is never sent twice (timeout not retried; next candidate only after
  `unavailable`/`auth`); breaker opens/closes per P89B-8 (clock tests); masked shop sender IDs never reach the failover.
- **S226** codes: `otp_*` texts never stored (no `body_preview`), never in the log, CSV, audit or job payload beyond
  `SendSms`'s `#[\SensitiveParameter]`; locked texts can't be edited or disabled (422).
- **S227** templates: merge-field allow-list, no typed links, S13 sanitising of vars, ≤ 3 parts on the sample.
- **S228** broadcasts: only within 09:00–21:00 Dhaka (schedule and at send time), weekly cap 2/7 days per tenant under
  concurrency (two broadcasts racing → cap holds: recipient insert checks inside a tenant-keyed advisory lock), opt-out
  re-checked per recipient, suspended tenants skipped, typed count must match a fresh estimate.
- **S229** opt-out: code 10 base62 random per recipient, stored as sha256, GET never changes state, POST idempotent,
  limiter, unknown code → 404 with no timing difference; account switch only for the signed-in user; impersonation → 403.
- **S230** privacy: platform log and CSV mask phones, hide codes, replace links by `[link]`, never show shop SMS;
  `merchant_tenant_id` rows never visible to a tenant (tenant queries filter `tenant_id = context`; RLS backstop).
- **S231** fakes: `SMS_PROVIDERS_HTTP_FAKE` refuses to boot in production; `SMS_DRIVER=log|fake` never routes to a
  database provider.
- **S232** abuse limits: `admin-sms-test` 10/h, `admin-sms-export` 5/h, preview 60/min, refresh-balance 6/h,
  `platform-sms-opt-out` 30/min per IP; low-balance email at most once per crossing.
- **S233** isolation of platform tables: the app role has SELECT only on providers/types/templates and nothing on the
  broadcast tables (grant test on Postgres); no merchant route reads them except routing.

## 11. Super admin (owner ADMIN) — Figma file `2W1wMKN79hhcr1czQS63oN`, section `49:7270`
Route `/settings/sms?tab=provider|messages|broadcasts|log` (default provider; unknown → provider). Settings nav (A1-6)
gains **SMS provider** under Security; page header "SMS provider"; tab bar as merchant detail `33:5075`. Without
`manage_settings` the nav item is hidden and the route shows the existing "You can't open platform settings" card.
**Shell banner**: `admin.platformSms.alerts()` on route change (stale 60 s) for `manage_settings` users; the highest
severity alert shows as a banner with "Open SMS provider".

### 11.1 Provider tab — `2098:8460`; not configured `2111:9331`
- `source = none`: red banner "No SMS provider — sign-in codes will fail", empty state "Set up an SMS provider" +
  **Configure provider**, 3 prerequisites (static), "What's waiting" table from `waiting` (group, queued, failed in
  24 h; caption "Platform SMS wait 30 minutes, sign-in codes 5 minutes, then fail"). Figma "> 24 h dropped" → 30 min.
- `source = environment`: info card "REVE SMS (server environment)" with caller ID and key hint, read-only, and
  **Configure provider** ("Move it into Store Plix to rotate keys and add a failover").
- **SMS gateway** card: Connected pill (from health), **Send test SMS** (dialog: phone pre-filled from the staff
  profile, → `providers.test(primary)`); primary tile (logo placeholder, Active, Primary, account ID, "accepted by
  gateway (24 h)" `accepted_rate_24h`%, last send, **Manage**); **failover slot** (dashed "Not set" + **Add failover**
  → configure drawer with role failover preselected, or the failover tile with its rule "used after {n} failed sends or
  a {s} s timeout"); **API credentials** (masked locked fields with hints + **Rotate** → Manage drawer in rotate state;
  "Last rotated {date} by {name}"); **Sender IDs** (default + promotional mask with Approved / Pending BTRC pill).
  Figma "Discard / Save changes" on this card → edits happen in the Manage drawer (no inline form).
- **Gateway balance** card: ৳ amount, ~parts, days left, 7-day spend, Low pill, warning banner below threshold,
  threshold field + alert channel switches (PATCH provider), "Open REVE portal" (static link from config), caption
  "Balance is bought from the provider." Unsupported → "This provider doesn't report a balance".
- **Recent errors** table (`recent_errors`): time, error code + detail, type, masked phone, result pill; "View SMS log"
  → log tab with status failed. Drafts/inactive providers listed below in a compact list (Manage / Remove).

### 11.2 Configure provider drawer — `2112:9494` → `2112:9905` → `2113:9852` → `2113:10237` (+ `2113:10584` testing, `2113:10589` failed)
520 px right drawer, 4-step stepper, overlay 0.48. **1 Choose**: radio cards from `drivers()` (REVE "Recommended",
coming-soon cards disabled with a "Coming soon" pill, Other (HTTP API) dashed); price per part and feature ticks from
the catalogue; DLR info banner "Delivery reports aren't available yet". **2 Credentials**: fields from
`credential_fields` / `settings_fields` (secret: show/hide only while typing; https check client-side mirrors the
server); HTTP adds method, body format and mapping fields (composed); DLR callback URL **hidden**. **3 Route &
senders**: role Primary / Failover, group checkboxes (`SMS_MESSAGE_GROUP_LABELS`; required four locked on for primary),
default sender, promotional mask + status, rate limit, failover rules (failover role). **4 Test & activate**: entering
step 4 creates the draft (`providers.create`; on back-and-change → `update` or a new draft when credentials changed —
drafts can be removed); test phone + **Send test** → result card (latency, parts, balance, message ID; "Delivery
report" line hidden) or failed state with **Check credentials** (→ step 2) / Try again; "When you activate" copy;
**Activate {provider}** opens the dialog (primary) or activates directly (failover). Footer "Logged as {admin} · saved
to the audit log".

### 11.3 Dialogs and Manage drawer
- **Activate primary provider** `2114:10581`: what changes (groups, default sender, old primary becomes failover),
  "Keep {old} as the failover" checkbox (hidden on first activation), type-the-name input (Activate disabled until it
  matches case-insensitively; server re-checks), 409/422 inline.
- **Remove provider** `2114:10634`: failover/draft/inactive only; type the name; danger button.
- **Manage provider** `2114:10202` (drawer `2114:10458`): header pills, connected since / last test; credentials with
  **Rotate** → rotate state (paste new values, test phone, "Test and save new key" → `providers.rotate`; failure keeps
  the old key with the error inline; "Cancel rotate"); account ID / endpoint read-only for active providers (changed in
  rotate); route & senders, rate limit, failover rules, alerts → `providers.update` with `revision` (409 → reload);
  last test + Send test SMS; failover adds **Remove provider**.

### 11.4 Message types tab — `2098:8963`; editor `2098:9466` (drawer `2101:9413`)
KPI strip from `meta.kpis` (cost as ৳ estimate); four group cards with a meta bar from `meta.groups` (sender, provider,
rate limit) and rows (label, trigger, "{parts} SMS" tag, বাংলা + EN preview, Edit, Switch; locked rows: lock icon,
"Always on", View only). Promotional card: rules box (opt-out honoured, 9 AM–9 PM, promotional mask only, automatic STOP
footer counted in parts, 2 per merchant per week) and the Broadcasts row (→ Broadcasts tab, Switch = `broadcast`
toggle). Figma rows "New sign-in alert", "Trial ending offer", "Win-back", "2-step code": **hidden** (Q278). Editor:
8.9a editor pattern — title + group pill, trigger, language chips, textarea with highlighted tags, insert chips for the
type's merge fields, counter + 3-segment bar, preview bubble (`preview`, debounced 400 ms, abortable), **Send test to
me** (phone dialog), Reset to default (confirm), Cancel, Save (409 → reload). Locked: read-only, no Save.

### 11.5 Broadcasts tab — `2098:9969`; confirm `2103:9134`
KPI strip from list `meta.kpis`; **New broadcast** card: Promotional route pill (sender mask + status), internal name,
bn and en textareas (both required) with merge chips, the locked STOP footer line shown under each ("বন্ধ করতে:
{link}" / "STOP: {link}" — Figma "STOP লিখে 16xxx-এ পাঠান" restyled, Q281), counters incl. footer; **Audience** radio
cards with sub-chips and counts from `audiences()`; skipped note from the estimate; **When**: Send now / Schedule (date
+ time, GMT+6, 09:00–21:00 only — client mirrors, server decides); **Estimate** panel (`estimate()`, debounced) with
warning colour when `below_alert`; Send test to me / Save draft / **Review and schedule** (saves the draft, then the
dialog). **Confirm dialog**: summary (sender, recipients, skipped, parts, cost, balance after), checks list,
acknowledge checkbox, **"Type {recipients} to confirm"** input (Q280), "Logged as {admin}", Back / **Schedule for
{date}** or **Send to {n} merchants**; 409 `broadcast_estimate_changed` → refresh the numbers in place. **Past
broadcasts** table (chips All / Scheduled / Sent / Drafts → status filter), row menu Cancel (scheduled) / Edit or Delete
(draft) / View recipients (drawer, composed, cursor list).

### 11.6 SMS log tab — `2098:10472`
Search "Phone number or shop", Status select, date range (default 30 days, min − 90), Type chips All / Registration /
Invoice & billing / Promotional / Login & security (→ `group`), **Export CSV** (`exportMessages`, current filters).
Table TIME · PHONE (masked) · MERCHANT · TYPE pill · MESSAGE (one line; codes: lock + "Code hidden") · PARTS · STATUS
(Sent / Queued / Failed / Skipped) (+ PROVIDER in a tooltip). Cursor Previous / Next. States: empty "No platform SMS yet"
+ Send test SMS; no match + Clear filters; skeleton.

### 11.7 States and mobile
Loading / empty / error per `148:34032` on every tab; 390 px: tabs scroll, cards stack, drawers full-screen, tables
become cards. Integration health `41:11082` (if shown anywhere) uses "accepted by gateway"; no delivery rate.

## 12. Merchant app (owner WEB) — composed (no Figma frame)
- **Account page** (`src/pages/AccountPage.tsx`): new card "Store Plix SMS" — Switch "Offers and news from Store Plix by
  SMS" (`account.smsPreferences`), caption "Sign-in codes, invoices and account messages are always sent.", shows the
  masked phone or "Add and verify a phone number to receive SMS"; read-only while impersonating.
- **Public page `/s/:code`** (outside the auth shell, no tenant, noindex): loads `platformSms.optOutLookup`; "Stop Store
  Plix offers to {phone_masked}?" + **Stop offers** (POST) → "You won't get Store Plix offers by SMS any more. You can
  turn them back on in your account." Already opted out → that message; 404 → "This link is not valid"; `test` code →
  "This was a test message". Plain layout from the auth screens' tokens; 390 px.

## 13. ARCH and types (owner ARCH — done in this change)
openapi **1.24.0** (tag `platform-sms`; paths §9; schemas listed in the changelog). `packages/types`: platform SMS block
(drivers, providers, overview, alerts, groups, types + purposes + labels + locked list, templates, broadcasts, audience,
estimate, recipients, log, preferences, opt-out, errors, audit actions, constants). `packages/api-client`:
`admin.platformSms.{drivers, alerts, providers.*, messageTypes.*, broadcasts.*, messages, exportMessages}`,
`account.smsPreferences.*`, `platformSms.optOutLookup/optOut`, `platformSmsLogQuery`, `platformSmsBroadcastQuery`;
tests `phase8-9b.test.ts`. Docs: ADR 0027, DATABASE-DESIGN §5.13, SECURITY T44 (S220–S233), OPEN-QUESTIONS Q273 +
Q274–Q286, roadmap 8.9b. Proposed for other owners: FIGMA-INDEX note "46:6794 SMS gateway card superseded; Provider
frames 2111:9331 … 2114:10458 belong to the Platform SMS provider section" (design owner); RUNBOOK: moving REVE from env
to the DB, rotating keys, reading the breaker, `SMS_PROVIDERS_HTTP_FAKE`.

## 14. Test requirements
**API (Pest)**, group `platform-sms` (+ `security`, `rls`, `race`): every §9 route (happy, validation, 403 matrix per
platform role + merchant token, 404s); env bootstrap byte-for-byte (no DB provider → same driver calls as 8.9a);
`SMS_DRIVER=fake` never routes to a DB provider; credential secrecy (S220: response key sets, DB not plaintext, log
scan, audit meta, `serialize(job)`); create/update/test/activate (typed name, test-required, first activation,
replacement keep/not keep, partial-unique race of two activations on Postgres)/rotate (fail keeps old; success swaps;
sends after use the new)/remove (primary 409, typed name); router vectors: primary ok; primary `unavailable` → failover
same call; `timeout` → no second try + breaker open; `rejected` → no count; n failures open; half-open after 5 min
(time travel) closes on success; groups filter; promotional mask pending → `no_route`; masked shop sender not on
failover; retry window 30 min / 5 min (`Bus::fake` + time travel); balance fetch + low alert once per crossing + re-arm;
alerts endpoint per state; every §5 sender (codes unchanged texts, row `tenant_id` null + `merchant_tenant_id`; welcome
once; each billing event → SMS + email, toggle off → email only, unverified phone → none, Resend invoice → no SMS;
billing still succeeds when SMS throws); templates (fields, links, 3 parts, reset, revision, locked 422); broadcasts
(audience vectors, estimate numbers, sending-hours boundaries 08:59/09:00/20:59/21:00 Dhaka, typed count 409, balance
422, cap 2 with a Postgres race of two broadcasts, opt-out between schedule and send, suspended skip, duplicate owner,
pause at 21:00 + resume, cancel, finish counters); opt-out code (GET no change, POST idempotent, 404, limiter), account
preferences + impersonation 403; log scope (never shop rows, 90 days, `q` phone/shop, group mapping, masked, codes
hidden) and CSV (masking, BOM, 50k cap, limiter, audit); 8.9a merchant outputs map new error codes to
`provider_error`; grants (S233) on Postgres.
**Admin (Vitest)**: tab routing + permission gating; provider tab per `source` (none / environment / database), failover
slot, recent errors; configure drawer steps (driver cards incl. coming soon disabled, field rendering from the catalogue,
https check, group rules, test success/failure, activate dialog typed name); Manage drawer rotate flow (fail keeps,
success); remove dialog; balance card states; message types (KPIs, locked rows, toggles, editor chips/counter/preview
abort/409/reset); broadcasts (audience chips, hours validation, estimate warning, confirm dialog typed count, 409
refresh, past list filters, cancel); log filters → query, CSV call, code hidden; shell banner per alert.
**Web (Vitest)**: Account SMS card states (verified / no phone / impersonation) and switch; `/s/:code` states (lookup,
stop, already, 404, test).
**QA (Playwright)** `phase8-9b.spec.ts` (super-admin, `SMS_PROVIDERS_HTTP_FAKE`, `SMS_DRIVER=fake`): configure REVE as
primary (test, typed name) → env source replaced; add an HTTP failover; rotate the secret (failing then passing);
edit the `invoice_issued` bn template and send a test; create a broadcast to a plan, confirm with the typed count →
fake sink has the text with the STOP link; open `/s/{code}` in the merchant app and stop → a second broadcast skips that
owner; log shows the SMS masked and an OTP row as "Code hidden"; CSV downloads; 390 px screenshots of the provider tab,
configure drawer and broadcasts. **QA infra**: CI Pest group `platform-sms` on sqlite + Postgres; race tests in the
`api-rls` list.

## 15. File ownership

| Agent | Owns (create/edit) |
|---|---|
| **API (Laravel)** | `apps/api/**` only: `app/Domain/Sms/{Providers,Routing,Platform,Broadcasts}/**`, `SmsGateway.php`, `SmsResult.php`, `SmsSendFailed.php`, `SmsServiceProvider.php`, `Drivers/**` (REVE → driver, HTTP driver, fake/log), `Jobs/SendSms.php` + new jobs, console commands (`sms:fetch-balances`, `sms:run-broadcasts`, `sms:prune-broadcast-recipients`), `routes/admin-sms.php` (platform group) + `routes/api.php` include for `/account/sms-preferences` and `/platform-sms/*`, migrations `2026_12_12_*`, `config/sms.php` (`drivers`, `platform`), `resources/sms/platform/*.php`, `Identity/Otp/OtpService.php`, `Identity/Http/Controllers/OtpController.php` (welcome hook), `Billing/BillingNotifier.php` + the §5 call sites (`SubscriptionProcessor`, `BillingPaymentService`), `Admin/Settings/**` only if shared helpers are needed, `Shared/Http/SafeHttpClient` reuse, `AuditLogger` subject types, every 8.9a sender's `provider_id` write, tests |
| **ADMIN (React)** | `apps/super-admin/**`: `src/settings/sms/**` (new), `SettingsPage.tsx` nav, `layout` shell banner, fixtures/tests |
| **WEB (React)** | `apps/merchant-dashboard/**`: `src/pages/AccountPage.tsx` (SMS card), new public route `/s/:code` (`src/platform-sms/**`), `App.tsx` route, tests |
| **ARCH** | `docs/**` except `docs/reviews/**`, TESTING.md, FIGMA-INDEX.md, AGENT-CONTRACTS.md; `packages/types/**`, `packages/api-client/**` (done) |
| **QA** | `tests/e2e/**` (`phase8-9b*.spec.ts`, helpers), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-9b-qa.md` |
Storefront: **no change**. Shared-read rules: re-read `SendOrderSms.php`, `CampaignPipeline.php`, `SmsServiceProvider.php`,
`BillingNotifier.php`, `SubscriptionProcessor.php`, `routes/api.php`, `SettingsPage.tsx`, `AccountPage.tsx` before each Edit.

## 16. Order of work
### 16.1 Dependency
The 8.9a API (gateway signature with `$senderId`, `sms_messages` columns, senders) must be merged first; 8.9b's API
branch rebases on it. ADMIN and WEB can start against fixtures from `packages/types` at once.
### 16.2 Steps
1. ARCH: types + api-client + openapi (done), this file, ADR 0027, docs.
2. API: migrations → driver interface + REVE driver + HTTP driver + fake → router + breaker + env bootstrap (all
   existing tests green here) → provider CRUD/test/activate/rotate/remove → balance + alerts → message types +
   templates + `PlatformSmsNotifier` + §5 wiring → broadcasts + opt-out → log + CSV → limiters, audit, static/log-scan
   tests.
3. ADMIN: settings nav + provider tab (sources) → configure drawer → manage/rotate/remove → message types + editor →
   broadcasts + confirm → log → shell banner.
4. WEB: Account SMS card → `/s/:code` page.
5. QA: specs + CI group while the others build; gate after all are green.

## 17. Acceptance criteria
1. With no database provider, every SMS is sent exactly as in 8.9a through the env REVE account; code texts are byte for
   byte unchanged; all pre-existing tests pass.
2. Staff configure REVE (and an HTTP provider) with write-only credentials, test, and activate it as primary only by
   typing its name; a failover takes over after 3 provider failures or a timeout and hands back after 5 quiet minutes;
   no SMS is sent twice (S222, S225).
3. A rotated key replaces the old one only after a passing test; secrets never appear in any response, log or audit row
   (S220, S223).
4. Merchants get the enabled platform SMS (welcome, invoice issued, payment received, payment due or failed, plan
   expiring) in their shop's language to a verified phone, with staff-edited texts; codes are always on and unchanged.
5. A promotional broadcast reaches only eligible owners within 9 AM–9 PM Dhaka, at most 2 per merchant per week, with a
   working opt-out link; the typed count matches what is sent (S228, S229).
6. The balance is shown and a low balance alerts super admins once by email and in-app.
7. The platform SMS log shows only platform SMS for 90 days, masked, codes hidden, and exports the same as CSV (S230).
8. Figma `2098:8460`, `2098:8963`, `2098:9466`, `2098:9969`, `2103:9134`, `2098:10472`, `2111:9331`, `2112:9494`,
   `2112:9905`, `2113:9852`, `2113:10237`, `2114:10581`, `2114:10634`, `2114:10202` match with the documented omissions;
   loading/empty/error; 390 px usable.
9. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres; groups `platform-sms`, `security`, `rls`, `race`),
   Playwright `phase8-9b*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

## 18. Figma notes for the PO (product owner)
- The old **SMS gateway** card in Settings `46:6794` / `46:7167` (SSL Wireless/Alpha) is superseded by `/settings/sms`.
- No delivery reports: "Delivery report" lines, the DLR callback URL and "Delivery rate by operator" are hidden; "accepted
  by gateway" is shown instead (Q267).
- SSL Wireless, Alpha SMS and BulkSMSBD cards say "Coming soon"; use "Other (HTTP API)" for them meanwhile (Q274).
- Provider not configured: queued platform SMS wait **30 minutes** (codes 5), not 24 h (Q277).
- Message types: "New sign-in alert", "Trial ending offer", "Win-back" and "2-step code" are not shown (no such events);
  "Password reset code" is added as a locked row; code texts stay English (Q278).
- Broadcast footer is a link ("STOP: {link}", bn "বন্ধ করতে: {link}") instead of "STOP লিখে 16xxx-এ পাঠান": REVE can't
  receive SMS (Q141, Q281).
- Confirm broadcast adds "Type {n} to confirm" next to the acknowledge checkbox (Q280).
- Provider card "Discard / Save changes" → changes are made in the Manage drawer.
- Phones use the 8.9a mask `01711-•••211` (Figma `017••••5678`).
- Admin "Send test SMS" asks for a phone number (pre-filled): staff profiles have no verified phone yet.

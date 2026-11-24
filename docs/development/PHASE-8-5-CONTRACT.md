# Phase 8.5 contract: Marketing campaigns, SMS + email (binding for ARCH, API, WEB, QA)

Status: **Accepted, 2026-11-24 (PO accepted the proposed defaults for Q138–Q151); QA re-gate PASS 2026-11-24 (`docs/reviews/phase-8-5-qa.md`)**. Branch
`feat/phase-8-5-campaigns` (from `main` @ 323529f, Phase 8.4 accepted).
Roadmap task **8.5** "Marketing campaigns SMS/email (Figma 61:12479)"; AC: **"Opt-out respected"**.
Tasks 8.6–8.9 are **not** in this contract (abandoned-cart recovery and Automations are 8.6).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-4 contracts and
docs/api/API-CONVENTIONS.md still applies (envelope, snake_case, ULIDs, cookie sessions, `BelongsToTenant` /
`BelongsToStore`, RLS, FeatureGate, `perm:` on every tenant route, audit log, money in minor units). Where this file
changes an earlier rule it says **"amends …"**. Machine-readable spec: `docs/api/openapi.yaml` **v1.13.0**. ADR **0019**
(new: marketing campaigns, consent and suppression). Product defaults: OPEN-QUESTIONS **Q138–Q151**.

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-5-qa.md`). No new external provider: SMS goes through the existing
`App\Domain\Sms\SmsGateway` (Revesms in production, `log`/`fake` elsewhere); email through Laravel Mail on a dedicated
`campaigns` mailer (`log` locally, `array` in tests). A dev message sink (`CAMPAIGNS_DEV_SINK`) lets e2e read what
was "sent"; it refuses to boot in production.

| Area | Owner | Ships |
|---|---|---|
| **Campaigns** | API | `campaigns`, `campaign_recipients`, `campaign_conversions`; create/edit draft, audience preview, test send, schedule, send now, cancel; send pipeline (queued, tenant-aware, throttled, at-most-once per recipient); attribution; overview metrics (§3–§6) |
| **Consent + opt-out** | API | `marketing_suppressions` (per store, per channel, per normalized address); eligibility rule; opt-out footer/link on every message; storefront unsubscribe API; merchant "stop marketing" toggle; checks at send time (§4) |
| **Plan limits** | API | new limits `campaign_sms_per_month`, `campaign_emails_per_month` (amends PHASE-7 §2.1); order-SMS pool untouched (§2.2) |
| **Marketing UI** | WEB | Marketing overview `66:19179`, Campaigns list (composed), New/Edit campaign `70:19774` (SMS + Email), campaign detail (composed), customer detail opt-out row; nav (§8) |
| **Unsubscribe page** | WEB (storefront) | `/u/{code}` page + `/u/{code}/one-click` POST route handler on the merchant's own domain; reachable in draft mode (§8.6) |
| **Docs + types** | ARCH | openapi 1.13.0, `packages/types`, `packages/api-client`, ADR 0019, DATABASE-DESIGN §5.5, SECURITY T35, API-CONVENTIONS, MULTI-TENANCY, OPEN-QUESTIONS, FIGMA-INDEX, roadmap (§9) |
| **QA** | QA | Playwright `phase8-5.*`, CI Pest group `campaigns`, TESTING.md, gate report (§11) |

**Out of scope** (hide, never fake): WhatsApp (channel card, "WhatsApp broadcast" quick-create, "SMS + WhatsApp" tags;
no WhatsApp provider exists), SMS credit balance / top-up / per-SMS price (Q84 stays deferred; Q140), "Return on
spend" and "Carts recovered" KPIs, "Cart recovery" chart series, "Abandoned cart recovery" quick-create, Automations
tab (8.6), "Best week yet" insight banner, "Expected ~N orders · ৳ sales" forecast, "Good pick — 38 % of orders …"
send-time hint (Q148), saved/custom segment builder (Q143), click tracking and link shortening, inbound SMS "STOP"
replies (no inbound channel; Q141), delivery receipts from the SMS provider, email bounce/complaint webhooks (Q146),
merchant HTML email or images, A/B tests, recurring campaigns, masked SMS sender IDs (Q145), super-admin views.

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- "Recipient" = one `campaign_recipients` row (one customer × one campaign). "Address" = normalized phone
  (`8801XXXXXXXXX`) for SMS or lower-cased email for email.
- "Part" = one SMS segment (GSM-7 160/153, UCS-2 70/67).
- `[S]` = store-scoped table (`BelongsToStore`, composite FK `(tenant_id, store_id) → stores`).

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§12). Before every Edit of a shared-read file, re-read it (another agent may have
  changed it).
- New dependencies: **none**.
- Never `migrate:fresh` the local dev DB; use Pest or a scratch DB. RLS items run on Postgres with `TENANCY_RLS=true`.

---

## 0. Summary and goals
Merchants send one-off **SMS or email campaigns** to a **segment** of their customers, now or at a scheduled time, see
what each campaign sent and earned, and never message someone who opted out. Opt-out is a property of the
**address on that channel in that store** (not of a customer row, which can be deleted and re-created), is captured
from a link in every message, and is checked **at the moment each message is sent**, not only when the audience is
built. Campaign SMS/email have their own monthly allowances so marketing can never starve order SMS.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P85-1 | Channels **`sms`** and **`email`**. One channel per campaign. WhatsApp hidden | Roadmap says SMS/email; Figma's WhatsApp has no provider. Email takes the WhatsApp slot in the channel card (composition, same `ChoiceCard`) |
| P85-2 | Campaigns are **store-scoped** `[S]`, routes `/api/v1/stores/{store}/campaigns/...` | Customers are store-scoped |
| P85-3 | **Eligibility** (Q138): a customer may receive marketing on a channel iff they have an address for it **and** no `marketing_suppressions` row matches (store, channel, address) **and** (`accepts_marketing = true` **or** `orders_count ≥ 1`) | "Existing customer" soft opt-in: storefront checkout doesn't capture consent today, so pure opt-in would leave almost every merchant with an empty audience; customers added by hand without consent or orders are never messaged |
| P85-4 | **Suppression is the source of truth for opt-out**: `marketing_suppressions(store, channel, address)` unique. Opt-out is **per channel only**: an unsubscribe (link or one-click) writes/removes that channel's suppression and **never touches `accepts_marketing`** (amended 2026-11-24, PO decision on QA finding P85-QA-4: clearing the flag also blocked the other channel for customers with no orders, and "Subscribe again" couldn't restore it) | Survives customer delete/re-create, CSV re-import and merges; per-channel |
| P85-5 | A suppression with `source = link` (customer-initiated) **can't be removed by the merchant** (API, import, `accepts_marketing = true` edit); only the customer can, from the same unsubscribe page ("Subscribe again"). A merchant-added suppression (`source = merchant`) can be removed by the merchant | Opt-out must stick; merchants can still correct their own mistakes |
| P85-6 | **Every message carries an opt-out link** to `https://{store primary host}/u/{code}`; `code` = 10 base62 chars (≈ 59 bits), random per recipient, stored as **sha256** only. SMS footer is appended by the server (language = campaign language): bn `বন্ধ করতে: {host}/u/{code}`, en `STOP: {host}/u/{code}`; it counts toward parts and is shown in preview/estimates (Q139). Email: footer link + `List-Unsubscribe: <https://{host}/u/{code}/one-click>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) | Revesms has no inbound SMS, so "reply STOP" can't work (Q141); the merchant's own domain is short and trusted |
| P85-7 | **The storefront renders the unsubscribe page** (`/u/{code}`), not the API | Same host as the link (short, branded, the shopper trusts it), store theme/logo, already resolves tenant from host; the API host is never shown to shoppers. GET never unsubscribes (link scanners, SMS previewers): the page has a button; one-click POST is a separate route handler |
| P85-8 | **Opt-out is re-checked per recipient at send time** inside the send job (suppression lookup by address, customer still exists and still eligible, campaign still `sending`); a hit marks the recipient `skipped` with `skip_reason` | AC "Opt-out respected" — an opt-out between scheduling and sending wins |
| P85-9 | **Audience snapshot at send start**, not at schedule time: when a campaign moves to `sending` the server materializes recipients (one per customer, deduped by address) from the stored audience definition | Scheduled campaigns see customers who arrived or opted out meanwhile |
| P85-10 | Audience = one **predefined segment** (§3.2) + exclusions ("Skip risky customers", "Skip anyone who ordered in the last N days"); opted-out and ineligible customers are **always** excluded (not a checkbox; Figma's "Skip customers who replied STOP" becomes a disabled, always-checked "Opted-out customers are never messaged (n)") | No free-form query language; testable; P85-3 can't be switched off |
| P85-11 | **At most once per recipient**: recipient `queued → sending → sent | failed`, transition by conditional UPDATE; the send job has `tries = 1` for the provider call (like `SendSms`); a recipient stuck in `sending` > 15 min becomes `unknown` and is **never retried** | Never double-message a shopper |
| P85-12 | Throughput: queue `campaigns` (new Horizon supervisor), jobs of ≤ 100 recipients, Redis limiter **10 messages/s per store** and **50/s platform-wide** for SMS (config `campaigns.sms_rate_per_second`, `campaigns.platform_sms_rate_per_second`), email 20/s per store | Protects the provider account and order SMS |
| P85-13 | Allowances (Q140): new limits **`campaign_sms_per_month`** (counted in **parts**) Free 0 / Starter 1,000 / Growth 5,000 and **`campaign_emails_per_month`** Free 0 / Starter 5,000 / Growth 20,000. Free plan → 402 `plan_limit_reached` (`upgrade_plan: starter`). Order SMS keep `sms_per_month` unchanged (amends PHASE-7 §2.1: two rows added; P5-26 counting unchanged because campaign SMS use purpose `campaign`) | Figma's money balance needs credit packs (Q84, deferred) |
| P85-14 | Limit checks: at **schedule / send now** the estimate (recipients × estimated parts) must fit the remaining allowance → else 402 `plan_limit_reached` with `details.campaign_sms_per_month {limit, used, needed}`. At **execution** the exact count is re-checked after the snapshot; not enough → campaign `failed` with `failure_reason = limit` and **nothing sent** (no partial campaigns). Test sends count too | Predictable; no half-sent campaign |
| P85-15 | Quiet hours (Q142): no campaign may start between **21:00 and 09:00 store time**; schedule into it → 422 `campaign_quiet_hours`; "Send now" in it → same 422. A campaign still `sending` at 21:00 pauses its remaining recipients until 09:00 | BD norms for promotional SMS; shopper goodwill |
| P85-16 | Scheduling: `scheduled_at` ≥ now + 5 min and ≤ now + 90 days. Scheduler `campaigns:dispatch-due` every minute moves `scheduled → sending` by conditional UPDATE (`WHERE status='scheduled' AND scheduled_at <= now()`) | No double start |
| P85-17 | States: `draft → scheduled → sending → sent`; `draft|scheduled → cancelled`; `sending → cancelled` (remaining `queued` recipients become `skipped/cancelled`, already-sent stay sent); `scheduled|sending → failed` (`failure_reason`: `limit`, `plan`, `store_unavailable`, `no_recipients`). Edit only in `draft`/`scheduled` (editing a scheduled campaign re-validates schedule + limit) | Simple, auditable |
| P85-18 | SMS text: ≤ 5 parts **including** the footer and shop prefix; the server auto-prefixes `"{shop name}: "` (shop name truncated to 20 chars) because the sender ID is the platform's (Q145). Encoding: GSM-7 if every char is in the GSM-7 basic set + extension table, else UCS-2. Server count is authoritative; WEB mirrors it for the live counter (shared algorithm documented in §5.3, both sides tested against the same vectors) | Matches Figma counter; cost honesty |
| P85-19 | Email: subject ≤ 150 chars; body **plain text** ≤ 5,000 chars with merge fields; the server renders it into a fixed platform template (store logo + name, paragraphs from blank lines, `https?://` URLs auto-linked, **everything else escaped**), footer = store contact line + unsubscribe link. From `"{Store name}" <{CAMPAIGN_MAIL_FROM}>` (platform domain), `Reply-To` = store `contact_email` when set | No merchant HTML (rule 7, T-XSS); deliverability from one platform domain (Q146) |
| P85-20 | Merge fields (Figma tags): `{name}` (customer first word of name, ≤ 20 chars; fallback bn "গ্রাহক" / en "there"), `{coupon}` (campaign's coupon code; required when used; the coupon must be active), `{shop_link}` (`{primary host}`, no scheme for SMS, `https://…` for email), `{product}` (selected product's name + ` {host}/products/{slug}`). Unknown `{…}` → 422 `campaign_unknown_merge_field` | Small, safe, no template engine |
| P85-21 | **Attribution** (Q144): an order is attributed to a campaign when it is placed by a recipient customer (`orders.customer_id`) within **7 days** after that recipient was `sent`; if several campaigns qualify the **latest** send wins; one row per order in `campaign_conversions`. Revenue = order `total_amount` of orders not `cancelled` (evaluated at read time); returned/refunded not netted in 8.5 | Deterministic without click tracking or storefront changes |
| P85-22 | "Revenue from marketing" (overview) = sum of `total_amount` over non-cancelled orders placed in range that have a coupon redemption **or** a campaign conversion (each order once) | Figma tile; coupons already built |
| P85-23 | Permission: existing **`marketing.manage`** covers campaigns; label changes "Create & edit coupons" → **"Coupons & campaigns"** and it becomes **sensitive** (amends PHASE-8-3 §2.1). Recipient lists additionally need **`customers.view`**; phones/emails in recipient lists are **masked** (`+880 17•• •••123`, `n•••@gmail.com`) | Mass messaging is a sensitive capability; no new key churn |
| P85-24 | Draft or suspended store: create/schedule/send → 409 `store_not_live` (exists); a scheduled campaign whose store is no longer live at execution → `failed/store_unavailable` | Shoppers must be able to reach the unsubscribe link |
| P85-25 | Customer-facing "risk" for the "Skip risky customers" exclusion and the audience breakdown (Q147): `risky` = `returned_orders_count ≥ 2` and returned ÷ (delivered + returned) ≥ 0.5; `careful` = returned ≥ 1 and ratio ≥ 0.25; else `good`. Code: `App\Domain\Customers\CustomerRisk` (single place; 8.8 fake-order guard may replace it) | Uses counters that exist since Phase 5 |
| P85-26 | Test send ("Send test to me"): SMS to the actor's verified phone, email to the actor's account email; uses the real render with sample merge values and a **test** unsubscribe code (page says "This was a test message"); counts toward the allowance; throttle 5/hour per user; audited | Figma action; abuse bound |
| P85-27 | Limits: ≤ 50 non-terminal campaigns (`draft`, `scheduled`, `sending`) per store → 422 `limit_reached` (exists); ≤ 3 campaigns `sending` at once per store (others wait in `scheduled` until a slot frees, still respecting quiet hours) | Abuse/queue bound |
| P85-28 | Retention: `campaign_recipients` kept 13 months then pruned daily (`campaigns:prune-recipients`), campaign rows and aggregate counters kept; suppressions kept forever | Reports a year back; opt-out permanent |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q138–Q151; defaults accepted by the PO 2026-11-24)

| Q | Question | Proposed default |
|---|---|---|
| Q138 | Who may be messaged? | P85-3: not suppressed and (`accepts_marketing` or ≥ 1 order) |
| Q139 | Opt-out footer in SMS | Mandatory, auto-appended, counts toward parts (bn/en per campaign language) |
| Q140 | Paying for campaign SMS/email | Monthly allowances (P85-13), no money balance/top-up/price; credit packs stay Q84 |
| Q141 | "Reply STOP" | Not possible (no inbound SMS); link only; merchants can mark "Stop marketing messages" per customer |
| Q142 | Quiet hours | 21:00–09:00 store time, no starts; sending pauses |
| Q143 | Segments | Fixed catalogue §3.2 with parameters; no saved/custom segments in 8.5 |
| Q144 | Attribution | Last send within 7 days by the same customer, gross order total, cancelled excluded |
| Q145 | Sender name | Platform sender ID; message auto-prefixed with "{Shop name}: " (masked IDs need BTRC registration, later) |
| Q146 | Email provider, bounces, complaints | One platform sending domain via `campaigns` mailer (provider chosen at deployment); no bounce/complaint processing in 8.5 |
| Q147 | "Risky customer" definition | P85-25 return-ratio rule until the 8.8 fake-order guard |
| Q148 | Send-time hint ("38 % of your orders come 7–9 PM") | Hidden in 8.5 |
| Q149 | Plans | Starter and Growth (Free has 0 allowance → upgrade prompt); numbers in P85-13 |
| Q150 | Templates ("Template: Win-back with coupon") | 4 built-in bn/en templates (§8.3), client-side, editable after insert |
| Q151 | Mobile layout (no mobile frames) | Cards stack below `lg`; phone preview moves under the form; tables scroll inside their card; 375 px usable |

## 2. Permission and plan

### 2.1 Permission (amends PHASE-8-3 §2.1)
`marketing.manage`: label **"Coupons & campaigns"**, `sensitive() = true`; `SystemRole` unchanged (O ✓, A ✓, S ✗).
Routes: every §6.1 route `perm:marketing.manage`; recipients list `perm:marketing.manage,customers.view` (both);
customer marketing toggle `perm:customers.edit`. `RoutePermissionsTest` gains the §6.1 rows.

### 2.2 Plan (amends PHASE-7 §2.1 — two rows added)
| Key | Kind | Free / Starter / Growth | Checked at | Over limit | Notes |
|---|---|---|---|---|---|
| `campaign_sms_per_month` | limit | 0 / 1,000 / 5,000 parts | schedule, send now, execution, test send | 402 `plan_limit_reached` (`details.campaign_sms_per_month {limit, used, needed}`); execution → `failed/limit` | usage = sum of `parts` of recipients `sent`/`sending`/`unknown` + test sends, calendar month, store tz |
| `campaign_emails_per_month` | limit | 0 / 5,000 / 20,000 | same | same | usage = count of email recipients `sent`/`sending`/`unknown` + test sends |

Migration (API) adds both keys to `plans.limits` for existing plans; `PlanSeeder` updated; `Limit` enum + `FeatureGate::usage`
cases; `LimitKey` in types. Plan & billing "Usage this month" lists the two new rows ("Campaign SMS this month · N of M").
Downgrade: nothing deleted; scheduled campaigns fail at execution if the allowance doesn't fit (P85-14).

## 3. Campaign model

### 3.1 Campaign fields
`name` (1–80), `channel` (`sms`|`email`), `language` (`bn`|`en`; footer/fallbacks), `audience` (§3.2), `body` (SMS ≤ 5
parts incl. prefix/footer; email ≤ 5,000 chars), `subject` (email only, 1–150), `coupon_id` (nullable, store's coupon),
`product_id` (nullable), `send_mode` (`now`|`schedule`), `scheduled_at`, `status`, `failure_reason`, counters
(`recipients_count`, `sent_count`, `failed_count`, `skipped_count`, `parts_sent`), `started_at`, `completed_at`,
`cancelled_at`, `created_by`, `revision`.

### 3.2 Audience (`audience` jsonb; validated by `AudienceDefinition`)
```json
{ "segment": "repeat_inactive", "params": { "min_orders": 2, "inactive_days": 60 },
  "exclude": { "risky": true, "ordered_within_days": 7 } }
```
| `segment` | Label (UI) | Params (defaults; bounds) | Rule (on top of P85-3 eligibility for the channel) |
|---|---|---|---|
| `all` | All customers you can message | — | everyone eligible |
| `repeat_inactive` | Bought {min_orders}+ times, inactive {inactive_days} days | min_orders 2 (2–20), inactive_days 60 (14–365) | `orders_count ≥ min` and `last_order_at < now − days` |
| `vip` | VIP · spent over ৳ {min_spent} | min_spent_amount 2,000,000 minor (≥ 1) | `total_spent_amount ≥ min` |
| `new_customers` | First order in the last {days} days | days 30 (1–365) | `orders_count ≥ 1` and `created_at ≥ now − days` |
| `one_time` | Ordered once | — | `orders_count = 1` |
| `district` | Customers in {districts} | districts[] (1–10, geo district names) | `district IN (...)` |
| `tag` | Tagged "{tag}" | tag (1–40) | `tags` contains tag |

`exclude.risky` (P85-25), `exclude.ordered_within_days` (null or 1–60, Figma default 7). Unknown keys → 422.

### 3.3 Audience preview (`POST …/campaigns/audience-preview`)
Input `{channel, audience}` → `{ matched (segment size before exclusions), excluded: {risky, recent_orders,
opted_out, no_address, not_eligible}, recipients, risk_breakdown: {good, careful, risky} (percent, one decimal) }`.
Figma rows: "Skip Risky customers (11)" = `excluded.risky`; "Skip anyone who ordered in the last 7 days (4)" =
`excluded.recent_orders`; "Opted-out customers are never messaged (2)" = `excluded.opted_out`; "197 customers will get
this message" = `recipients`. Counts are an estimate; the snapshot at send start is authoritative (P85-9).

## 4. Consent, opt-out and unsubscribe (owner API; page owner WEB)

### 4.1 `marketing_suppressions` rules
- Key: (store_id, channel, address). Address normalization: phone → `8801XXXXXXXXX` (same normalizer as customers);
  email → trimmed lower-case.
- Sources: `link` (customer via unsubscribe page/one-click), `merchant` (customer detail toggle), `import`
  (reserved, not written in 8.5).
- Created by: unsubscribe (P85-6), merchant toggle `POST …/customers/{customer}/marketing-opt-out {channel}`; removed by:
  customer "Subscribe again" (only `source=link` rows for that code's address+channel), merchant `DELETE` (only
  `source=merchant` rows) → 409 `suppression_customer_owned` otherwise.
- Customer `accepts_marketing = true` via PATCH/import does **not** delete a suppression (S118).
- `CustomerPresenter` gains `marketing: { sms: "subscribed"|"unsubscribed"|"not_eligible"|"no_address",
  email: …, unsubscribed_sms_at, unsubscribed_email_at, unsubscribed_source }` (computed; amends the Customer shape).

### 4.2 Storefront API (tenant from `X-Storefront-Host` + `X-Storefront-Key`, middleware `storefront`)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/storefront/unsubscribe/{code}` | `{ data: { channel, masked_address, status: "subscribed"|"unsubscribed", is_test, store_name } }`; unknown code → 404 `unsubscribe_link_invalid` (same body for malformed) |
| POST | `/api/v1/storefront/unsubscribe/{code}` | `{ action: "unsubscribe"|"resubscribe", one_click?: bool }` → 200 same shape; idempotent; test code → 200 with `is_test: true` and no change |

`code` format `^[A-Za-z0-9]{10}$`; lookup by sha256 within the host's tenant/store (RLS normal path, no definer
function). Limiter `storefront-unsubscribe` 20/min per shopper IP (forwarded `X-Shopper-Ip`, as checkout). Codes never
expire. Unsubscribe also sets the recipient `unsubscribed_at` (stats); it does **not** change
`accepts_marketing` (P85-4 as amended). "Subscribe again" removes that channel's `source = link` suppression. Not audited in `audit_logs` (shopper action); the suppression row is the record.

### 4.3 Send-time checks (every recipient, inside the send job, P85-8)
Skip with `skip_reason` when: suppression exists (`opted_out`); customer deleted (`customer_deleted`); address
changed since snapshot or now missing (`address_changed`); no longer eligible by P85-3 (`not_eligible`); campaign not
`sending` (`cancelled`); plan/limit no longer allows (`plan`); store not live (`store_unavailable`). Quiet hours → job
released until 09:00 (not a skip).

## 5. Send pipeline (owner API)

### 5.1 Flow
1. `sending` entered (send now or `campaigns:dispatch-due`): `StartCampaign` job (TenantAware, unique per campaign)
   materializes recipients (P85-9, insert in chunks of 1,000; dedupe by customer and address; each gets a fresh
   unsubscribe code, sha256 stored; SMS `parts` computed per recipient from the rendered text), sets
   `recipients_count`, checks the allowance (P85-14) → `failed/limit` or continues; zero recipients → `failed/no_recipients`.
2. Dispatches `SendCampaignBatch` jobs (≤ 100 recipient ids each) on queue `campaigns`.
3. Per recipient: §4.3 checks → conditional UPDATE `queued → sending` → render → provider call (rate limited, P85-12)
   → `sent` (+ `provider_message_id`, `sent_at`) or `failed` (`error_code`: `provider_error`, `invalid_address`).
   SMS also writes an `sms_messages` row (purpose `campaign`, template `campaign:{campaign id}`, no body).
4. When no recipient is `queued`/`sending`: campaign → `sent`, `completed_at`; counters recomputed from rows.
5. `campaigns:reap-stuck` every 5 min: recipients `sending` > 15 min → `unknown` (never retried, P85-11).

### 5.2 Rendering
`CampaignRenderer::render(Campaign, Recipient|Sample)` → SMS text (`"{shop}: " + body with merge fields + "\n" +
footer`) or email (subject, html, text). Pure function; unit tested. The rendered text is **not stored** per recipient
(only `parts`); the dev sink (§5.4) keeps rendered copies outside production.

### 5.3 SMS part counting (shared vectors in `docs/api/sms-parts-vectors.json`, written by ARCH)
GSM-7 basic set + extension (`^{}\[~]|€` count 2); all-GSM → single ≤ 160, multipart 153 per part; otherwise UCS-2 ≤ 70,
multipart 67 per part (UTF-16 code units). API `SmsParts::count(string)`; WEB `smsParts()` in `apps/merchant-dashboard`;
both run the vector file in their tests.

### 5.4 Drivers and dev sink
SMS: existing `SMS_DRIVER` (`log` local, `fake` tests, `revesms` production). Email: mailer `campaigns` from
`CAMPAIGN_MAILER` (default `log`; tests `array`). `CAMPAIGNS_DEV_SINK=true` (non-production only; boot guard) records
every campaign/test message (channel, to, rendered text/subject, unsubscribe URL) in a capped cache list (last 200 per
store), readable at `GET /api/v1/dev/stores/{store}/message-sink` (`perm:marketing.manage`). Production boot fails if
`CAMPAIGNS_DEV_SINK=true` or `CAMPAIGN_MAILER` is `log`/`array` with `SMS_DRIVER=revesms` (misconfig guard).

### 5.5 Attribution job
Listener on order placed (after commit, existing order-placed hook point): if the order has a `customer_id`, find the
latest `sent` recipient of that customer in the store with `sent_at ≥ placed_at − 7 days` → insert
`campaign_conversions` (unique `order_id`). Never blocks checkout (queued, `TenantAware`).

## 6. Merchant API (amends PHASE-8-3 §3 with these rows; openapi 1.13.0 binding)

### 6.1 Endpoints (all `auth:sanctum` + `surface:merchant,impersonation` + `tenant` + `store`; perm per §2.1)
| Method | Path (`/api/v1/stores/{store}`) | Notes |
|---|---|---|
| GET | `/marketing/overview?range=7d|30d|90d` | KPIs (§6.2), weekly series 8 weeks `{week_start, coupons_amount, campaigns_amount}`, active coupons (top 4 by revenue with `used_count`, `usage_limit`, `revenue_amount`), recent campaigns (5), tab counts `{coupons, campaigns}` |
| GET | `/campaigns` | filters `status` (csv), `channel`, `q` (name); sort `-created_at` default, `-started_at`; page 25 |
| POST | `/campaigns` | create `draft`; audit `campaign.created` |
| GET | `/campaigns/{campaign}` | detail + stats |
| PATCH | `/campaigns/{campaign}` | edit (`draft`/`scheduled` only, `revision` required) → 409 `invalid_state_transition` / `revision_conflict` |
| DELETE | `/campaigns/{campaign}` | `draft` only (hard delete) else 409; audit `campaign.deleted` |
| POST | `/campaigns/audience-preview` | §3.3 (throttle 30/min per user) |
| POST | `/campaigns/estimate` | `{channel, language, body, subject?, audience, coupon_id?, product_id?}` → `{recipients, parts_per_recipient (estimate with sample name of 20 chars), total_parts, encoding, characters, allowance: {limit, used, remaining, after}}` |
| POST | `/campaigns/{campaign}/test` | P85-26 → 202 `{to_masked}`; audit `campaign.test_sent` |
| POST | `/campaigns/{campaign}/schedule` | `{scheduled_at}` → `scheduled`; checks P85-14/15/16/24/27; `Idempotency-Key` required; audit `campaign.scheduled` |
| POST | `/campaigns/{campaign}/send` | send now → 202 `sending`; same checks; `Idempotency-Key` required; audit `campaign.sent` |
| POST | `/campaigns/{campaign}/unschedule` | `scheduled → draft`; audit `campaign.unscheduled` |
| POST | `/campaigns/{campaign}/cancel` | `draft|scheduled|sending → cancelled`; audit `campaign.cancelled` |
| POST | `/campaigns/{campaign}/duplicate` | new draft copy ("{name} (copy)"); audit `campaign.created` |
| GET | `/campaigns/{campaign}/recipients` | `perm:marketing.manage,customers.view`; filters `status`, `skip_reason`; cursor page 50; masked address; `customer {id, name}`; `attributed_order {id, number, total_amount}` |
| POST | `/customers/{customer}/marketing-opt-out` | `{channel}` → suppression `merchant`; `perm:customers.edit`; audit `customer.marketing_opted_out` |
| DELETE | `/customers/{customer}/marketing-opt-out/{channel}` | removes a `merchant` suppression only (else 409 `suppression_customer_owned`); audit `customer.marketing_opt_out_removed` |

Routes in `routes/campaigns.php` (API), included from `routes/api.php` like `developer-*.php`.
Storefront routes (§4.2) in the same file under the existing `storefront` group conventions.

### 6.2 Shapes (summary; openapi binding)
- `Campaign { id, name, channel, language, status, audience, audience_label, body, subject, coupon {id, code}|null,
  product {id, name, slug}|null, scheduled_at, started_at, completed_at, cancelled_at, failure_reason,
  stats { recipients, sent, failed, skipped, unsubscribed, parts_sent, orders, revenue_amount, currency },
  created_by {id,name}|null, created_at, updated_at, revision }`.
- `CampaignListItem` = Campaign without `body`/`subject`/`audience`.
- `CampaignRecipient { id, customer {id,name}|null, masked_address, status (queued|sending|sent|failed|skipped|unknown),
  skip_reason, error_code, parts, sent_at, unsubscribed_at, attributed_order {id, number, total_amount}|null }`.
- `AudiencePreview` (§3.3), `CampaignEstimate` (§6.1), `MarketingOverview { range, kpis: { revenue_amount,
  revenue_change_pct|null, campaign_orders, campaign_orders_share_pct, messages_sent, unsubscribes }, series[],
  active_coupons[], recent_campaigns[], counts {coupons, campaigns}, currency }`.
- `UnsubscribeStatus` (§4.2). `CustomerMarketing` (§4.1).

### 6.3 Error codes (API-CONVENTIONS §3 gains them)
`campaign_quiet_hours` (422, `details.allowed_from`), `campaign_unknown_merge_field` (422, `details.fields`),
`campaign_too_long` (422, `details.parts`, `details.max_parts`), `campaign_coupon_inactive` (422),
`campaign_no_recipients` (422 at schedule/send when the preview is 0), `suppression_customer_owned` (409),
`unsubscribe_link_invalid` (404); reuse `invalid_state_transition`, `revision_conflict`, `store_not_live`,
`limit_reached`, `plan_limit_reached`, `idempotency_key_*`.

## 7. Data (migrations, prefix `2026_12_02_`, forward-only; RLS in the create migration; tables added to `RlsTables::TENANT` and `database/sql/rls-emergency-off.sql`)

### 7.1 New tables (all `[S]`)
- **campaigns** (`000100`): id · tenant_id · store_id · name varchar(80) · channel varchar(8) CHECK · language char(2)
  CHECK · status varchar(12) CHECK (`draft`,`scheduled`,`sending`,`sent`,`cancelled`,`failed`) · audience jsonb · body
  text · subject varchar(150) null · coupon_id FK(t,s) null on delete set null · product_id FK(t,s) null set null ·
  scheduled_at, started_at, completed_at, cancelled_at timestamptz null · failure_reason varchar(24) null ·
  recipients_count, sent_count, failed_count, skipped_count, unsubscribed_count int default 0 · parts_sent int
  default 0 · created_by FK users null · revision int · timestamps. Indexes `(tenant_id, store_id, status,
  scheduled_at)`, `(tenant_id, store_id, created_at desc)`.
- **campaign_recipients** (`000100`): id · tenant_id · store_id · campaign_id FK(t,s) cascade · customer_id FK(t,s)
  null on delete set null · channel varchar(8) · address varchar(254) · status varchar(10) CHECK · skip_reason
  varchar(24) null · error_code varchar(24) null · parts smallint default 0 · unsubscribe_code_hash char(64)
  **U** · provider_message_id varchar(128) null · sent_at, unsubscribed_at timestamptz null · created_at, updated_at.
  Unique `(campaign_id, address)`, `(campaign_id, customer_id)`; indexes `(campaign_id, status)`,
  `(tenant_id, store_id, customer_id, sent_at desc)`.
- **campaign_conversions** (`000100`): id · tenant_id · store_id · campaign_id FK(t,s) cascade · recipient_id FK
  null set null · order_id FK(t,s) cascade **U** · placed_at timestamptz · created_at. Index `(tenant_id, store_id,
  campaign_id)`, `(tenant_id, store_id, placed_at)`.
- **marketing_suppressions** (`000200`): id · tenant_id · store_id · channel varchar(8) CHECK · address varchar(254) ·
  source varchar(12) CHECK (`link`,`merchant`,`import`) · campaign_id null (set null) · created_by FK users null ·
  created_at. Unique `(store_id, channel, address)`; index `(tenant_id, store_id, created_at)`.

### 7.2 Changed (`000300`)
`plans.limits` gains `campaign_sms_per_month` / `campaign_emails_per_month` (P85-13). `sms_messages.purpose` gains value
`campaign` (no CHECK exists today; doc only). Audit action catalogue (types) gains the §6.1 actions.

## 8. Merchant dashboard + storefront (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`, section `61:12479`

Nav: Marketing children become **Overview** `/marketing`, **Coupons** `/marketing/coupons`, **Campaigns**
`/marketing/campaigns` (amends Phase 5a nav). Pages need `marketing.manage` (else Forbidden state). Free plan: plan note
"Campaigns are part of the Starter plan." + See plans, create/send disabled.

### 8.1 Overview `/marketing` — frame `66:19179` (Main `66:19181`)
Header "Marketing" + subtitle; range dropdown (Last 7/30/90 days); "+ Create coupon" → `/marketing/coupons/new`; "+ New
campaign". Tabs: Overview · Coupons (count) · Campaigns (count); **Automations tab hidden** (8.6).
KPI tiles (`39:9401`): **Revenue from marketing** (± % vs previous range), **Orders from campaigns** ("n % of all
orders"), **Messages sent** (composed with the same tile: "SMS + email, this month: n of allowance"), **Unsubscribes**
(composed: "in the last N days"). Carts recovered and Return on spend tiles **hidden**.
Revenue chart: stacked weekly bars, 8 weeks, series **Coupons** and **Campaigns** (legend "SMS & WhatsApp" → "Campaigns";
Cart recovery series hidden); "Best week yet" banner hidden. Active coupons card as designed (from overview payload).
"Start something new": Discount coupon, SMS campaign ("Send a Bangla or English SMS to any segment." — price text
removed), **Email campaign** (composed card in the WhatsApp slot: "Send an email with your logo to any segment.");
Abandoned cart card hidden. Recent campaigns table as designed (CAMPAIGN, CHANNEL tag SMS info-tone / Email
brand-tone, AUDIENCE label, SENT, ORDERS, REVENUE, STATUS pill), "See all n →".

### 8.2 Campaigns list `/marketing/campaigns` — composed from the Recent campaigns table (`66:19809`) + Tab (`39:9419`)
Status tabs All / Scheduled / Sending / Sent / Drafts; search by name; columns as Recent campaigns + row menu
(Edit, Duplicate, Cancel/Unschedule, Delete draft). Empty state per `148:34032` with "+ New campaign".

### 8.3 New / edit campaign `/marketing/campaigns/new`, `/marketing/campaigns/:id/edit` — frame `70:19774` (Main `70:19776`)
Breadcrumb "Marketing / Campaigns / New"; actions **Save draft**, **Send test to me**, **Schedule campaign** (label
"Send campaign" when "Send now" is chosen; confirm dialog with recipient count + allowance).
1. **Channel**: ChoiceCards **SMS** ("Reaches every phone · Bangla & English", value "n left") and **Email** ("Your logo
   + text · needs an email address", value "n left") — WhatsApp card hidden.
2. **Audience**: segment select (§3.2 labels with live count), param inputs inline for the selected segment, checkboxes
   "Skip Risky customers (n)" + helper text, "Skip anyone who ordered in the last 7 days (n)", disabled checked
   "Opted-out customers are never messaged (n)"; summary row "N customers will get this message" + "Good x % · Be careful
   y % · Risky z %" (debounced `audience-preview`).
3. **Message**: language chips বাংলা / English; "Template: …" link opens a picker of 4 templates (Q150: Win-back with
   coupon, New arrivals, Flash sale, Eid greeting; bn + en text in `apps/merchant-dashboard/src/campaigns/templates.ts`);
   textarea (Hind Siliguri for bn) with merge tags "+ Customer name" `{name}`, "+ Coupon code" `{coupon}` (opens coupon
   picker), "+ Shop link" `{shop_link}`, "+ Product" `{product}` (product picker). SMS: counter "Unicode (Bangla) · n
   characters", pill "n SMS per person" (warning tone when > 1), segment bar, hint "Bangla SMS fits 70 characters each.
   Cut n characters to send 1 SMS." (money saving text removed); the auto prefix and footer are shown greyed in the box.
   Email: Subject field above the textarea; no segment counter.
4. **When to send**: Send now / Schedule, Date + Time fields (store timezone, label shows tz); quiet-hours error inline.
Right column: **Preview on phone** (SMS: bubble with rendered sample, header = store name initial + name, "Text
message · <time>", footer line "n parts" instead of "Delivered"); for email an email-card preview (subject, store
logo/name, body, footer) inside the same phone frame. **Cost estimate** card becomes **Allowance**: Recipients, SMS per
person (or Emails), Total SMS, divider, "Campaign SMS left this month n → m after" (no Top up, no ৳ rate/total, no
"Expected orders" row). Over allowance → danger row + "See plans".

### 8.4 Campaign detail `/marketing/campaigns/:id` (composed: page header + KPI tiles + table)
Header name + status pill + channel tag + actions per state (Edit, Unschedule, Cancel, Duplicate). Tiles: Recipients,
Sent, Orders, Revenue (and failed/skipped/unsubscribed as a caption line). Message card (rendered sample, read-only).
Recipients table (only with `customers.view`): customer, masked address, status pill, reason, sent at, order. `sending`
polls every 5 s.

### 8.5 Customers
Customer detail gains a "Marketing" row: SMS / Email each "Subscribed" · "Unsubscribed <date> (by customer|by you)" ·
"Not eligible" · "No address", with "Stop marketing messages" / "Allow again" (merchant-owned only) for `customers.edit`.

### 8.6 Storefront unsubscribe (WEB owns `apps/storefront/app/(store)/u/**`, `apps/storefront/app/u/**` route handler, proxy allowlist)
- `GET /u/{code}` (Server Component, theme layout, `noindex`, `Cache-Control: private, no-store`): calls §4.2 GET;
  shows store logo/name, "You get {SMS|emails} from {store} at {masked}", button **Unsubscribe** (server action → POST
  `unsubscribe`) → "You're unsubscribed. You won't get offers from {store} by {SMS|email}." + **Subscribe again**;
  invalid → "This link isn't valid"; test → "This was a test message. Nothing changed."
- `POST /u/{code}/one-click` (route handler): forwards `{action:"unsubscribe", one_click:true}`; returns 200 empty.
- Draft/Coming-soon mode: `/u/*` bypasses the coming-soon rewrite; suspended store → 404 (accepted gap, sending is
  impossible then).
- bn/en copy follows the store language setting.

States everywhere: loading/empty/error per `148:34032`. Tokens only; 375 px usable (Q151).

## 9. ARCH and types (owner ARCH)
openapi **1.13.0** (all §4.2 and §6.1 paths, schemas, error codes), `packages/types` (`Campaign`, `CampaignListItem`,
`CampaignChannel`, `CampaignStatus`, `CampaignAudience`, `CampaignSegment`, `AudiencePreview`, `CampaignEstimate`,
`CampaignRecipient`, `RecipientStatus`, `SkipReason`, `MarketingOverview`, `UnsubscribeStatus`, `CustomerMarketing`,
inputs; `LimitKey` + 2 keys; `Customer.marketing`; audit action union), `packages/api-client` methods for every §6.1 and
§4.2 endpoint, `docs/api/sms-parts-vectors.json` (≥ 20 vectors: GSM, extension chars, Bangla, emoji, boundaries 70/71,
160/161, 134/135), ADR 0019, DATABASE-DESIGN §5.5 (replace the §6 campaigns sketch), SECURITY T35 (S113–S126),
API-CONVENTIONS §3 codes + limiters, MULTI-TENANCY (storefront unsubscribe path), PHASE-7 §2.1 rows, PHASE-8-3 §2.1
label, OPEN-QUESTIONS Q138–Q151, FIGMA-INDEX Marketing rows → built/omissions, roadmap 8.5. **Types first.**

### 9.1 ARCH resolutions (binding via `packages/types` + openapi 1.13.0; where this file was silent or inconsistent)
- **`send_mode`** (§3.1) has no column in §7.1 and is **not an API field**: the mode is which endpoint is called
  (`/schedule` vs `/send`). Create/PATCH accept an optional nullable **`scheduled_at`**: stored on a draft without effect
  (the composer's remembered time), re-validated (P85-14/15/16) when the campaign is `scheduled`.
- **`audience.params`** is always present (`{}` for `all` / `one_time`); `exclude` is always present.
- **`Customer.marketing.unsubscribed_source`** is per channel: `{ sms: source|null, email: source|null }` (the UI shows
  "by customer / by you" and "Allow again" per channel).
- `POST …/marketing-opt-out` and `DELETE …/marketing-opt-out/{channel}` return **`CustomerMarketing`** (200). POST is
  idempotent and keeps an existing `link` row; POST for a customer without an address on that channel → 422; DELETE
  with no suppression → 200.
- Shopper IP for the `storefront-unsubscribe` limiter is the existing **`X-Storefront-Client-Ip`** header (§4.2's
  "`X-Shopper-Ip`" means the checkout header; there is no new header).
- **Send now while 3 campaigns are already `sending`** (P85-27) → 202 with the campaign in `scheduled` (it starts when a
  slot frees, still respecting quiet hours).
- **Estimate for email**: `parts_per_recipient` 1, `total_parts` = emails, `encoding` null, `characters` = body length.
  For SMS `characters` = units of the rendered sample (GSM septets with extension chars counted 2, or UTF-16 units).
- **SMS parts** (`docs/api/sms-parts-vectors.json`): plain `ceil(units / 153|67)` (no special handling of escape or
  surrogate pairs at part boundaries), form feed is **not** in the extension set, empty text = 0 parts.
- **`MarketingOverview`**: `series[].week_start` = ISO-week Monday (store tz) like reports; `messages_sent` counts the
  range; `active_coupons[]` = `{id, code, type, percent_bps, amount, ends_at, used_count, usage_limit, revenue_amount}`.
  The "n of allowance" caption uses `Subscription.limits` (the two new `LimitKey`s).
- Campaigns list `meta` = `PaginationMeta` (no tab counts; tabs filter by `filter[status]`). Recipients: cursor meta,
  `per_page` 50.
- **Test-send codes**: §7 adds no storage for them; the API chooses how `GET /storefront/unsubscribe/{code}` recognizes
  a test code (`is_test: true`) without a `campaign_recipients` row. Codes never expire (§4.2), so a TTL cache alone is
  not enough.
- Audit actions are listed as `CampaignAuditAction` in types (`AuditLog.action` stays `string`); there is no
  `campaign.updated` audit row (§6.1 lists none).
- `GET /dev/stores/{store}/message-sink` is not in openapi (dev route, API-CONVENTIONS §10.3); its shape is
  `DevSinkMessage[]` in types (`{channel, to, subject, text, unsubscribe_url, campaign_id, is_test, created_at}`,
  newest first).

## 10. Security checklist (S113–S126; each has a test)
- **S113** opt-out wins at send time: suppression created after snapshot, before the batch runs → recipient
  `skipped/opted_out`, provider never called (fake gateway asserts zero calls for that address).
- **S114** suppression is by address: delete + re-create the customer (or import the same phone) → still not messaged.
- **S115** every SMS/email rendered contains a working unsubscribe link for that recipient; email carries
  `List-Unsubscribe` + `List-Unsubscribe-Post`.
- **S116** unsubscribe GET never changes state; POST is idempotent; unknown/malformed code → identical 404; code stored
  only as sha256 (column scan); limiter 21st request/min → 429.
- **S117** unsubscribe code of store A presented on store B's host → 404 (tenant from host).
- **S118** merchant can't clear a customer-owned suppression: DELETE → 409, PATCH `accepts_marketing=true` and CSV
  import leave it in place.
- **S119** cross-tenant / cross-store: campaigns, recipients, conversions, suppressions → 404 (`assertTenantIsolation`,
  `assertStoreIsolation`), RLS on Postgres.
- **S120** permissions: staff → 403 on every §6.1 route; recipients need `customers.view` too; addresses masked in
  every merchant response; `RoutePermissionsTest` rows.
- **S121** at-most-once: two workers on the same batch / a duplicated job / `dispatch-due` twice → each address messaged
  once; `unknown` never retried.
- **S122** allowance: Free → 402; estimate over remaining → 402; execution over remaining → `failed/limit`, zero sends;
  test sends counted; order SMS (`sms_per_month`) usage unchanged by campaigns.
- **S123** content: merchant body/subject with `<script>`, HTML, `javascript:` URLs → escaped in email HTML; only
  `http(s)` auto-linked; header injection (CR/LF in subject/name) rejected 422.
- **S124** quiet hours and schedule bounds enforced server-side (frozen clock tests incl. store timezone).
- **S125** dev sink and log mailer: `CAMPAIGNS_DEV_SINK` refuses to boot in production; sink endpoint 404 in production.
- **S126** audit rows for create/schedule/send/cancel/test/opt-out toggles with actor; impersonation (read-only) can't
  send (existing read-only middleware → 403).

## 11. Test requirements
**API (Pest; group `campaigns`; RLS items also `rls`, security `security`)**: CRUD + validation + authz + isolation for
every §6.1 route; storefront unsubscribe routes; state machine transitions (allowed/denied); audience segments and
exclusions with fixtures (one test per segment); eligibility P85-3 matrix; risk classes; SMS parts against the shared
vectors; renderer (prefix, footer bn/en, merge fields, fallbacks, unknown field 422); pipeline with fake gateway +
`array` mailer (start → batches → sent, counters, `sms_messages` rows); quiet-hours pause/resume; cancel while sending;
reap-stuck; attribution (7-day window, latest wins, cancelled excluded, one per order); overview numbers; limits
(S122); S113–S126; prune.
**Web (Vitest)**: overview renders from fixture (hidden tiles absent), campaigns list tabs/menu by state, composer:
channel switch, segment params, preview counts, merge-tag insert, SMS counter against the shared vectors, allowance
row, quiet-hours error, schedule payload in store tz, test send; detail polling; customer marketing row; storefront
unsubscribe page states (valid/unsubscribed/invalid/test).
**QA (Playwright `tests/e2e/specs/phase8-5.*.spec.ts`, `SMS_DRIVER=log`, `CAMPAIGN_MAILER=log`, `CAMPAIGNS_DEV_SINK=true`)**:
Starter shop: create SMS campaign to "All" → send now → dev sink shows one message per eligible customer with prefix
and footer → open `/u/{code}` on the storefront host → Unsubscribe → second campaign skips that customer (detail shows
`opted_out`); email campaign one-click POST; scheduled campaign then cancel; Free plan shows plan note and 402; staff
can't open Marketing campaigns; quiet hours (frozen dev clock if available, else API-level check); 390 px screenshots
of overview, composer, unsubscribe page.

## 12. File ownership for Phase 8.5

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**` only: `app/Domain/Marketing/**` (campaigns, audience, renderer, SmsParts, suppressions, attribution, jobs, console, controllers, requests, resources, dev sink), `routes/campaigns.php` + its include line in `routes/api.php`, migrations `2026_12_02_000100`–`000300`, `Billing/Limit.php` + `FeatureGate::usage` cases + `PlanSeeder`, `Tenancy/Authorization/Permission` (label + sensitive), `RlsTables` + `database/sql/rls-emergency-off.sql`, `Customers/CustomerRisk.php`, `CustomerPresenter` (marketing block), customer controller opt-out routes, order-placed attribution hook (one line), `config/campaigns.php`, `config/mail.php` (`campaigns` mailer), Horizon supervisor + `routes/console.php` schedule lines, `tests/Feature/Marketing/**`, `tests/Unit/Marketing/**`, RoutePermissionsTest + parity fixture rows |
| **WEB** | `apps/merchant-dashboard/**`, `packages/ui/**`, `apps/storefront/app/(store)/u/**`, `apps/storefront/app/u/**`, the storefront proxy allowlist line for `/u/`, `apps/storefront/lib/storefront-api.ts` (two functions) |
| **ARCH** | `docs/**` except `docs/reviews/**` and TESTING.md; `packages/types/**`, `packages/api-client/**` |
| **QA** | `tests/e2e/**` (`phase8-5.*`), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-5-qa.md` |

Shared-read rule: API must not rename existing Customer/Coupon resources (WEB and types depend on them). WEB reads
`docs/api/sms-parts-vectors.json` (ARCH) in tests. Re-read `routes/api.php`, `CustomerPresenter` and the order-placed
hook before each Edit.

## 13. Order of work
1. ARCH: types + api-client + `sms-parts-vectors.json` first (§9), then openapi, ADR 0019, docs.
2. API: migrations 000100–000300 + `Limit` + RlsTables → suppressions + storefront unsubscribe API → audience +
   preview/estimate → campaign CRUD/state machine → pipeline + renderer + dev sink → attribution + overview → schedule.
3. WEB: composer and list against §6.2 shapes (types from ARCH, fixtures), then overview, detail, customer row,
   storefront `/u` page.
4. QA: specs + CI group `campaigns` while the others build; gate after all are green.

## 14. Acceptance criteria
1. **Opt-out respected:** an unsubscribed address (link, one-click or merchant toggle) receives no further campaign
   message on that channel from that store, including campaigns scheduled before the opt-out and customers re-created
   or re-imported afterwards (S113, S114, S118); every message carries a working opt-out link (S115).
2. SMS and email campaigns: create, preview audience, test, schedule/send now, cancel; at-most-once delivery;
   quiet hours; allowance limits per plan; attribution and overview numbers match order data.
3. Marketing overview, campaigns list, composer and detail match `66:19179` / `70:19774` with the documented
   omissions; storefront unsubscribe page on the merchant domain; loading/empty/error; 375 px usable.
4. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `campaigns`, `rls`, `security`),
   Playwright `phase8-5.*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

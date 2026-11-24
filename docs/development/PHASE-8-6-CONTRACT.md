# Phase 8.6 contract: Automations + checkout recovery (binding for ARCH, API, WEB, QA)

Status: **Accepted, 2026-11-24 (PO accepted the proposed defaults for Q152–Q166)**. Branch
`feat/phase-8-6-automations` (from `feat/phase-8-5-campaigns` @ fd69083, Phase 8.5 accepted; rebase onto `main` once
8.5 and `chore/dev-ports` merge).
Roadmap task **8.6** "Automations (Figma 140:30335)"; AC: **"Trigger → action runs logged"**.
Tasks 8.7–8.9 are **not** in this contract (fake-order guard, risky-order holds and courier success rate are 8.8).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-5 contracts and
docs/api/API-CONVENTIONS.md still applies (envelope, snake_case, ULIDs, cookie sessions, `BelongsToTenant` /
`BelongsToStore`, RLS, FeatureGate, `perm:` on every tenant route, audit log, money in minor units). **PHASE-8-5 applies
in full to every customer message an automation sends**: eligibility (P85-3), per-channel suppression checked at send
time (P85-4, P85-8, as amended), opt-out link on every message (P85-6), shop prefix and footer, SMS part counting
(§5.3 vectors), quiet hours (P85-15), at-most-once delivery (P85-11), dev sink (§5.4), job timeouts ≤ 240 s under
`REDIS_QUEUE_RETRY_AFTER` 360 (8.5 re-gate). Where this file changes an earlier rule it says **"amends …"**.
Machine-readable spec: `docs/api/openapi.yaml` **v1.14.0**. ADR **0020** (new: automations engine and checkout
recovery). Product defaults: OPEN-QUESTIONS **Q152–Q166**.

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-6-qa.md`). No new external provider: messages reuse the 8.5
send path (`SmsGateway`, `campaigns` mailer, dev sink); team notifications use the existing transactional mail.

| Area | Owner | Ships |
|---|---|---|
| **Engine** | API | `automations`, `automation_runs`, `automation_run_steps`; fixed recipe catalogue (§3); trigger fan-out from the 8.4 emit points + two new triggers; conditions; actions; waits; idempotent runs; the run log (§4–§6) |
| **Checkout recovery** | API | checkout contact on carts, abandoned-checkout detection, unfinished online orders, 2-step recovery flow, exit on order, cart-restore link, `automation_conversions` (§7) |
| **Messages** | API | automation SMS/email through the 8.5 renderer, suppressions, quiet hours and allowances; unsubscribe codes resolvable from automation steps; frequency cap; test message (§8) |
| **Plan + permission** | API | `sms_automation` enforced (amends PHASE-7 §2.1); `marketing.manage` covers automations (§2) |
| **Automations UI** | WEB | Automations `140:30336`, recipe editor `141:30622`, Abandoned cart recovery `71:20614`, Marketing overview items 8.5 hid for 8.6, nav (§10) |
| **Storefront** | WEB | checkout phone capture + notice (§10.6), `/r/{code}` cart-restore route handler, proxy allowlist |
| **Docs + types** | ARCH | openapi 1.14.0, `packages/types`, `packages/api-client`, ADR 0020, DATABASE-DESIGN, SECURITY T36, API-CONVENTIONS, MULTI-TENANCY, OPEN-QUESTIONS, FIGMA-INDEX, RUNBOOK, roadmap (§11) |
| **QA** | QA | Playwright `phase8-6.*`, CI Pest group `automations`, `queue-automations` worker in compose + e2e, TESTING.md, gate report (§13) |

**Out of scope** (hide, never fake): WhatsApp (actions, "WhatsApp owner", "Read on WhatsApp", "Recovered ·
WhatsApp"); recipes **Order received SMS** (already Settings → Notifications, P5-26), **Hold risky COD orders** (needs
the 8.8 fake-order guard, courier success rate and an "On hold" order state), **Auto-book courier** (Q62 stays
deferred), **Close COD orders automatically** (needs courier payout import, Q49), **Ask for a review** (no reviews
module), **Cancel unpaid advance** (already the payment link's "cancel if unpaid", P5B-22); conditions "Courier
success rate" and order-source chips "Messenger" / "POS"; free-form flow builder ("Add a step", drag handles,
"+ Add condition" outside the fixed list, per-step "more" menus); click tracking ("Clicked"); per-message cost
("Cost" tile, Q84); "Time saved" and "Risky orders held" tiles; push notifications; super-admin views; merchant-
written code or webhooks as actions (rule 7).

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- "Recipe" = a code-defined template (§3). "Automation" = a store's instance of a recipe (one row in `automations`).
- "Run" = one evaluation of one automation for one trigger occurrence (`automation_runs`). "Step" = one executed
  action of a run (`automation_run_steps`). "Checkout contact" = the phone (and optional name/email) a shopper typed
  on the checkout page.
- `[S]` = store-scoped table (`BelongsToStore`, composite FK `(tenant_id, store_id) → stores`).
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**, storefront **:3010** (`chore/dev-ports`).

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§14). Before every Edit of a shared-read file, re-read it (another agent may have
  changed it).
- New dependencies: **none**.
- Never `migrate:fresh` the local dev DB; use Pest or a scratch DB. RLS items run on Postgres with `TENANCY_RLS=true`.

---

## 0. Summary and goals
Merchants switch on ready-made **recipes** ("when X happens, do Y") instead of doing routine work by hand: win back
unfinished checkouts by SMS, thank buyers after delivery, tag repeat buyers as VIP, flag buyers who return parcels, and
get an email when stock runs low. Every trigger occurrence produces exactly one **run** with an outcome and one
**step** row per action (sent, skipped and why, failed) — the run log is the AC and the merchant's audit trail.
Customer messages are marketing messages under the 8.5 rules, so opt-out, quiet hours and allowances hold.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P86-1 | **Fixed recipe catalogue** (§3), one automation per recipe per store (`UNIQUE(store_id, recipe)`); merchants edit each recipe's parameters, messages and the conditions it allows; no free-form builder (Q152) | Testable, safe defaults for COD shops; Figma's editor is recipe-shaped |
| P86-2 | Ships **5 recipes** (Q153): `checkout_recovery` "Win back unfinished orders", `thank_you` "Thank-you message", `vip_tag` "Tag VIP buyers", `return_flag` "Handle returns", `low_stock` "Low stock alert". The other Figma recipes are hidden (see Out of scope) | Each hidden one needs a module that doesn't exist yet or duplicates a built behaviour |
| P86-3 | **Triggers come from the existing 8.4 emit points.** `WebhookEvents::emit` gains one line inside its after-commit closure, **before** the endpoint/plan filter: `AutomationTriggers::handle($type, $storeId, $subjectType, $subjectId, $at)`. It is independent of `api_webhooks` and of any webhook endpoint. Two new trigger sources (§4.1): `checkout.abandoned` (scheduler) and the order-placed exit/attribution hook | One place domain code already calls after commit; no second event bus |
| P86-4 | **Run idempotency**: a run is inserted with `UNIQUE(automation_id, dedupe_key)` (`ON CONFLICT DO NOTHING`); `dedupe_key` per recipe in §3 (e.g. `order:{id}`, `customer:{id}`, `checkout:{phone}:{window}`). A duplicate event, a retried job or two workers produce one run | "Once per order/event"; no double sends |
| P86-5 | **Steps are at-most-once**: a step row is inserted (`UNIQUE(run_id, step_index)`) with status `sending` **before** the provider call, then `done`/`failed`; a step stuck in `sending` > 15 min becomes `unknown` and is **never retried** (P85-11 pattern). Non-message actions (tag, notify) run inside a transaction with their step row | Never double-message a shopper |
| P86-6 | **Every evaluation is logged**, including "conditions not met" (`skipped`); the only trigger occurrence that creates no run is "not in plan" (P86-17). Runs/steps kept **90 days**, pruned daily; conversions 13 months (Q162) | AC "Trigger → action runs logged"; bounded storage |
| P86-7 | Customer messages from automations are **marketing**: P85-3 eligibility, suppression re-checked at send time, opt-out footer/link, shop prefix, ≤ **3 SMS parts** incl. prefix/footer, email plain text ≤ 3,000 chars, quiet hours. Exception for checkout recovery only: P86-11 | One consent model across campaigns and automations |
| P86-8 | **Allowances are shared** (Q157): automation SMS parts and emails count toward `campaign_sms_per_month` / `campaign_emails_per_month` (labels become **"Marketing SMS"** / **"Marketing emails"**). Out of allowance at send time → step `skipped/allowance` (no partial message), run continues to its next non-message step | One pool the merchant understands; no new limit keys |
| P86-9 | **Quiet hours** (Q158): 21:00–09:00 store time (P85-15). A message step that falls in quiet hours puts the run in `waiting` until 09:00; exit conditions are re-checked on resume. Not a merchant toggle (Figma's toggle shows on, disabled; copy "No messages 9 PM – 9 AM") | Same rule as campaigns; Figma's two different windows were inconsistent |
| P86-10 | **Frequency cap** (Q159): ≤ **2** automation marketing messages per (store, channel, address) per rolling 24 h across all automations; over → step `skipped/frequency_cap`. Campaign messages are not counted | Figma "Max 2 reminders per customer"; shopper goodwill |
| P86-11 | **Checkout recovery eligibility** (Q155): the checkout contact may receive the recovery flow's messages **without** `accepts_marketing` or a prior order, because they typed the number on a checkout page that says so (§10.6). Limits: only `checkout_recovery`, only that checkout, ≤ 2 messages, only inside the exit window; suppression and opt-out link still apply; "Skip risky customers" applies when the phone matches a customer | Recovery is the point of the recipe; bounded, disclosed, opt-out-able |
| P86-12 | **Checkout contact capture** (Q154): the storefront checkout sends the phone (required) and name/email (optional) to `PUT /storefront/cart/contact` when the phone field holds a valid BD mobile number and loses focus (and on name/email blur after that). Stored on the cart (`contact_*`), overwritten by later edits, deleted with the cart (90-day prune exists) | Figma "Phone captured at step 1 of checkout"; the cart is the only pre-order record |
| P86-13 | **Abandoned checkout** = an `active` cart with ≥ 1 line and a `contact_phone`, idle ≥ `delay_minutes` (default 30, 15–180) and not converted; **or** an online-payment order system-cancelled with `payment_timeout` (P5B-21) ("unfinished order"). Both start the same recovery flow; dedupe per (store, phone) per exit window (`checkout:{phone}:{first_seen_day}`), so one shopper gets one flow | Two real ways a BD checkout is left unfinished |
| P86-14 | **Exit**: the flow stops (`stopped/converted`) when the store receives an order from the same normalized phone after the run started (checked by the order-placed hook and again before each step), when the exit window ends (default 3 days, 1–7), on opt-out, or when the automation is turned off | Figma "Order placed or 3 days passed" |
| P86-15 | **Recovery attribution** (Q160): an order placed by the run's phone after the run's first message was `done` and before the window ends → one `automation_conversions` row (`UNIQUE(order_id)`), attributed to the **last** message step `done` before the order. Revenue = `total_amount` of non-cancelled orders (read time). The overview counts each order once (campaign and automation conversions may both exist) | Deterministic, no click tracking |
| P86-16 | **Cart-restore link** `{cart_link}` (Q156) = `https://{primary host}/r/{code}`; `code` 10 base62 per run, sha256 stored on the run. Opening it **clones** the cart into a new cart with a fresh token (never reveals or reuses the original token), re-prices lines, applies the step's coupon when active, sets `sp_cart`, 303 → `/checkout` (or `/cart` when a line has an issue). Unknown/expired/stopped → 303 → `/` | Figma message carries a cart link; cloning avoids cart takeover |
| P86-17 | **Plan** (Q161): `sms_automation` (Free –, Starter ✓, Growth ✓; seeded in Phase 7, enforced now — amends PHASE-7 §2.1). Create/enable → 402 `feature_not_in_plan`. After a downgrade, automations keep their settings and toggle state but **no run is created** and waiting runs end `stopped/plan`; the page shows "Paused — not in your plan" | Recipes need message allowances that Free doesn't have |
| P86-18 | Permission: **`marketing.manage`** covers automations (amends PHASE-8-3 §2.1 label → "Coupons, campaigns & automations"; still sensitive). Run lists show masked addresses; names of customers/contacts additionally need **`customers.view`** (else "Customer") | No new key; mass messaging is already sensitive |
| P86-19 | Team notifications (`notify_team`, Q163): **email** to O/A and members whose resolved permissions hold the recipe's permission (`inventory.adjust` for low stock), through the existing transactional mail (`notifications` queue). Not marketing, no allowance, no opt-out footer; deduped per (automation, subject) per 24 h | Figma "Push + email" / "WhatsApp owner": only email exists |
| P86-20 | Automation-originated changes (tags) use system actor **`automation`** (`audit_logs.actor_type = automation`, `actor_id` = automation id) only for config-level audit; per-action changes are recorded in the run log, not `audit_logs` (volume) | Run log is the record; audit stays readable |
| P86-21 | **Dry run** ("Test with an order", Figma `141:31433`): evaluates the automation against a chosen order/cart/product and returns what would happen (condition results, rendered messages, would-skip reasons). **No writes, no provider calls, no allowance use** | Safe preview |
| P86-22 | **Test message** ("Send test", 71:21017): sends one step's message to the actor (P85-26 rules: verified phone / account email, sample merge values, test unsubscribe code, counts toward allowance, 5/hour per user, audited `automation.test_sent`) | Same as campaigns |
| P86-23 | Execution: queue **`automations`** (new worker), jobs `TenantAware`, `$timeout` ≤ 240 s, `tries = 1` for message steps; scheduler: `automations:detect-abandoned` (5 min), `automations:resume-due` (1 min, conditional UPDATE `waiting → running WHERE resume_at <= now()`), `automations:reap-stuck` (5 min), `automations:prune-runs` (daily) | Same proven pattern as campaigns |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q152–Q166; proposed defaults, awaiting the PO)

| Q | Question | Proposed default |
|---|---|---|
| Q152 | Builder or recipes? | Fixed catalogue, one automation per recipe, editable parameters; no free-form builder or "Add a step" (P86-1) |
| Q153 | Which Figma recipes ship in 8.6? | 5: Win back unfinished orders, Thank-you message (SMS, not WhatsApp), Tag VIP buyers, Handle returns (flag only), Low stock alert (email). Hidden: Order received SMS, Hold risky COD, Auto-book courier, Close COD, Ask for a review, Cancel unpaid advance (P86-2) |
| Q154 | Capture the checkout phone before the order is placed? | Yes, on phone-field blur, with a one-line notice under the field; stored on the cart, deleted with it (P86-12, §10.6) |
| Q155 | May an unknown checkout contact get recovery SMS without prior consent? | Yes, only the recovery flow, ≤ 2 messages in the exit window, opt-out link, suppression honoured (P86-11) |
| Q156 | Cart link in recovery messages | `{cart_link}` → `/r/{code}` restores a copy of the cart on any device (P86-16) |
| Q157 | Separate allowance for automations? | No: shared with campaigns; rows relabelled "Marketing SMS" / "Marketing emails" (P86-8) |
| Q158 | Quiet hours (Figma shows 10 PM–9 AM and 10 PM–8 AM) | 21:00–09:00 like campaigns, always on; messages wait until 09:00 (P86-9) |
| Q159 | Frequency cap | ≤ 2 automation marketing messages per address per 24 h across automations (P86-10) |
| Q160 | Recovery attribution | Order by the same phone after the first reminder, inside the exit window (default 3 days); last reminder gets the credit (P86-15) |
| Q161 | Plan | `sms_automation` on Starter and Growth; Free sees a plan note; downgrade pauses without deleting (P86-17) |
| Q162 | Run log retention | 90 days runs/steps; conversions 13 months (P86-6) |
| Q163 | Team notification channel | Email only, to O/A + members with the relevant permission (P86-19) |
| Q164 | Figma metrics without data | Hide "Risky orders held", "Time saved", "Cost", "Clicked", "Read on WhatsApp"; compose "Messages sent" / "Carts recovered" tiles instead (§10) |
| Q165 | Unfinished online orders (`payment_timeout`) | Feed the same recovery flow as abandoned carts (P86-13) |
| Q166 | Mobile layout (no mobile frames) | Cards stack below `lg`; flow column above the side cards; tables scroll inside their card; 375 px usable |

## 2. Permission and plan

### 2.1 Permission (amends PHASE-8-3 §2.1, PHASE-8-5 §2.1)
`marketing.manage`: label **"Coupons, campaigns & automations"**, sensitive, `SystemRole` unchanged (O ✓, A ✓, S ✗).
Every §9.1 route `perm:marketing.manage`; run lists show contact/customer names only with `customers.view` too (field
`name` null otherwise, never 403). `RoutePermissionsTest` + parity fixture gain the §9.1 rows.

### 2.2 Plan (amends PHASE-7 §2.1 row `sms_automation`: "not enforced" → enforced)
| Key | Kind | Free / Starter / Growth | Checked at | Over limit |
|---|---|---|---|---|
| `sms_automation` | feature | – / ✓ / ✓ | create, enable, PATCH of an `on` automation, trigger time (no run), step time (waiting runs → `stopped/plan`), test message | 402 `feature_not_in_plan` `details.feature` |
| `campaign_sms_per_month` / `campaign_emails_per_month` | limit | as 8.5 | message step time (exact parts), test message | step `skipped/allowance`; test → 402 `plan_limit_reached` |

`CampaignAllowance::used()` (8.5) gains automation message steps `done`/`sending`/`unknown` in the calendar month (store
tz) and `automation.test_sent` audit rows. Plan & billing "Usage this month" labels change to "Marketing SMS this month"
/ "Marketing emails this month" (WEB).

## 3. Recipe catalogue (code: `App\Domain\Automations\Recipes\*`; UI order)

Each recipe defines: trigger, `dedupe_key`, allowed conditions, steps (fixed order), parameters with defaults/bounds,
default messages (bn + en). `settings` jsonb is validated by the recipe's schema; unknown keys → 422.

| Recipe (`key`, label, Figma tags) | Trigger (§4.1) | dedupe_key | Allowed conditions (§5) | Steps (in order) | Parameters (default; bounds) |
|---|---|---|---|---|---|
| `checkout_recovery` "Win back unfinished orders" · "Checkout left 30 min" → "Reminder SMS" | `checkout.abandoned` | `checkout:{phone}:{yyyy-mm-dd of first detection, store tz}` | skip risky (toggle) | 1 `send_message` (step 1), 2 `wait` "only if still no order", 3 `send_message` (step 2, optional coupon), exit | `delay_minutes` 30 (15–180); `step1.enabled` true; `wait_hours` 24 (6–48); `step2.enabled` true; `step2.coupon_id` null; `exit_days` 3 (1–7); `skip_risky` true; each message `{channel: sms|email, language, body, subject?}` (email only when the contact has an email) |
| `thank_you` "Thank-you message" · "Delivered" → "Thank-you SMS" | `order.delivered` | `order:{id}` | order total above/below; payment method; order channel; customer has / doesn't have tag | 1 `wait` (optional), 2 `send_message` | `delay_hours` 0 (0–72); message |
| `vip_tag` "Tag VIP buyers" · "5th delivery" → "Tag VIP + coupon" | `order.delivered` | `customer:{id}` (once per customer, ever while the automation exists) | customer delivered orders ≥ n (required, n default 5, 2–50); customer doesn't have tag (implicit) | 1 `add_tag`, 2 `send_message` (optional, `{coupon}` required when enabled) | `min_delivered` 5; `tag` "VIP" (1–40); `message.enabled` true; `coupon_id` (active coupon of the store, required if message enabled) |
| `return_flag` "Handle returns" · "Parcel returned" → "Flag buyer" | `return.received` | `return:{id}` | — | 1 `add_tag` | `tag` "Returned" (1–40). Restock stays the merchant's per-line choice in Returns (P5B-65); the row says "Restock stays in Returns" |
| `low_stock` "Low stock alert" · "Stock below threshold" → "Email the team" | `stock.low` | `inventory:{id}:{yyyy-mm-dd}` | — | 1 `notify_team` | none (threshold = the variant's effective low-stock threshold, P5-era inventory) |

New stores get no automations; the page offers every catalogue recipe as a tile ("Start from a recipe" → creates the
automation in `draft` with the defaults, opens the editor).

## 4. Triggers and runs (owner API)

### 4.1 Trigger sources
| Trigger | Source | Subject |
|---|---|---|
| `order.delivered` | `WebhookEventType::ShipmentDelivered` fan-out (P86-3) → the shipment's order | order (+ customer) |
| `return.received` | `WebhookEventType::ReturnReceived` fan-out | return request (+ order, customer) |
| `stock.low` | `WebhookEventType::StockLow` fan-out (already only on the crossing, `WebhookEvents::stock`) | inventory row (+ variant, product) |
| `checkout.abandoned` | `automations:detect-abandoned` every 5 min (carts, P86-13) **and** the order system-cancel with `payment_timeout` (one-line hook in `OrderService::systemCancel`, after commit) | cart or order (+ contact) |
| exit / attribution | `WebhookEventType::OrderCreated` fan-out | order |

`AutomationTriggers::handle` loads the store's automations with `status = on` whose recipe listens to the trigger;
for each, if the plan has `sms_automation`, it dispatches `EvaluateAutomation` (queue `automations`, `TenantAware`).
Detection marks a cart once: carts gain `recovery_detected_at`; the detect query is
`status='active' AND contact_phone IS NOT NULL AND recovery_detected_at IS NULL AND last_activity_at <= now() - delay`
with a conditional UPDATE, per store with an `on` recovery automation.

### 4.2 Run lifecycle
`running → waiting → running → completed`; terminal: `completed` (all steps evaluated), `skipped` (conditions not met
or no eligible address at the first message), `stopped` (`outcome_reason`: `converted`, `window_ended`,
`opted_out`, `automation_off`, `plan`), `failed` (unexpected error; `outcome_reason` `error`). `waiting` carries
`resume_at` and `next_step`. A run snapshots `context` jsonb at trigger time (order number/total, cart first line
name + image media id, line count, cart total, contact masked phone, customer id/name) so the log survives cart
pruning.

### 4.3 Evaluation (`EvaluateAutomation`, ≤ 240 s)
1. Insert run (P86-4); conflict → return.
2. Load subject; missing → `skipped/subject_missing`.
3. Conditions (§5) → any false → `skipped/conditions_not_met` with the per-condition results in `outcome_detail`.
4. Execute steps from `next_step`: `wait` → `waiting` + `resume_at`; message in quiet hours → `waiting` until 09:00;
   other steps per §6. Before every step re-check: automation `on`, plan, exit conditions (P86-14).
5. All steps done → `completed`; `last_run_at` on the automation updated.

### 4.4 Data (migrations, prefix `2026_12_03_`, forward-only; RLS in the create migration; tables added to `RlsTables::TENANT` and `database/sql/rls-emergency-off.sql`)
- **automations** (`000100`, `[S]`): id · tenant_id · store_id · recipe varchar(24) CHECK (5 keys) · name varchar(80) ·
  status varchar(8) CHECK (`draft`,`on`,`off`) · settings jsonb · last_run_at timestamptz null · created_by FK users
  null · revision int · timestamps. Unique `(store_id, recipe)`; index `(tenant_id, store_id, status)`.
- **automation_runs** (`000100`, `[S]`): id · tenant_id · store_id · automation_id FK(t,s) cascade · trigger varchar(24)
  · dedupe_key varchar(120) · subject_type varchar(16) CHECK (`order`,`cart`,`return`,`inventory`) · subject_id
  char(26) · customer_id FK(t,s) null set null · contact_address varchar(254) null (normalized phone/email used for
  exit matching and messages; masked in every response) · status varchar(10) CHECK (`running`,`waiting`,`completed`,
  `skipped`,`stopped`,`failed`) · outcome_reason varchar(32) null · outcome_detail jsonb null · next_step smallint
  default 0 · resume_at timestamptz null · recovery_code_hash char(64) null **U** · window_ends_at timestamptz null ·
  context jsonb · started_at, finished_at timestamptz · timestamps. Unique `(automation_id, dedupe_key)`; indexes
  `(tenant_id, store_id, created_at desc)`, `(tenant_id, store_id, automation_id, created_at desc)`, partial
  `(resume_at) WHERE status = 'waiting'`, `(store_id, contact_address) WHERE status IN ('running','waiting')`.
- **automation_run_steps** (`000100`, `[S]`): id · tenant_id · store_id · run_id FK(t,s) cascade · step_index smallint ·
  action varchar(16) CHECK (`send_message`,`add_tag`,`notify_team`) · status varchar(8) CHECK (`sending`,`done`,
  `skipped`,`failed`,`unknown`) · reason varchar(32) null · channel varchar(8) null · address varchar(254) null ·
  parts smallint default 0 · unsubscribe_code_hash char(64) null **U** · provider_message_id varchar(128) null · detail
  jsonb null · executed_at timestamptz · timestamps. Unique `(run_id, step_index)`; indexes `(tenant_id, store_id,
  channel, address, executed_at desc)` (frequency cap), `(tenant_id, store_id, executed_at)` (allowance).
- **automation_conversions** (`000100`, `[S]`): id · tenant_id · store_id · automation_id FK(t,s) cascade · run_id FK
  null set null · step_id FK null set null · order_id FK(t,s) cascade **U** · placed_at timestamptz · created_at.
  Index `(tenant_id, store_id, placed_at)`.
- **carts** (`000200`): + contact_phone varchar(13) null · contact_name varchar(80) null · contact_email varchar(254)
  null · contact_captured_at timestamptz null · recovery_detected_at timestamptz null; partial index `(store_id,
  last_activity_at) WHERE status = 'active' AND contact_phone IS NOT NULL AND recovery_detected_at IS NULL`.
- `sms_messages.purpose` gains `automation` (doc only); audit actor type `automation`; audit action catalogue gains
  `automation.created|updated|enabled|disabled|deleted|test_sent`.

## 5. Conditions (fixed list; `{field, op, value}`; evaluated on the subject at run time)
| Field | Ops | Value | Recipes |
|---|---|---|---|
| `order.total_amount` | `gt`, `lt` | minor units ≥ 0 | thank_you |
| `order.payment_method` | `is` | `cod` / `online` | thank_you |
| `order.channel` | `in` | subset of `Order::CHANNELS` (labels: Storefront = website, Landing pages, Facebook, Instagram, Phone / manual = phone + walk_in, Other) | thank_you |
| `customer.tag` | `has`, `not_has` | tag | thank_you |
| `customer.delivered_orders_count` | `gte` | 2–50 | vip_tag (required) |
| `customer.risk` | `is_not` | `risky` (toggle "Skip risky customers"; `CustomerRisk`, P85-25) | checkout_recovery |
≤ 5 conditions, all must hold (Figma "Match any of these" for the 8.8 risk recipe is not built). Unknown field/op → 422.

## 6. Actions
| Action | Behaviour | Step outcomes |
|---|---|---|
| `send_message` | Address = customer's (or checkout contact's) phone/email for the step's channel. Checks in order: eligibility (P85-3 or P86-11) → `not_eligible`; no address → `no_address`; suppression → `opted_out` (also stops a recovery run: `stopped/opted_out`); frequency cap → `frequency_cap`; allowance → `allowance`; then render (§8) and send via `CampaignMessenger` (8.5), SMS `sms_messages` row purpose `automation` | `done` (`provider_message_id`, `parts`), `skipped` (reason), `failed` (`provider_error`, `invalid_address`), `unknown` |
| `add_tag` | Adds the tag to the customer if absent (max 20 tags, P4: none added when full → `skipped/tags_full`); no customer → `skipped/no_customer`; already tagged → `skipped/already_tagged`; uses `CustomerService` with actor `automation` | `done` / `skipped` |
| `notify_team` | Email (P86-19) "Low stock: {product} · {variant} — {on_hand} left" with a dashboard link; recipients resolved at send time | `done` (`detail.recipients` count) / `skipped/no_recipients` / `failed` |
| `wait` | Sets `resume_at`; recovery step 2 waits "only if still no order" (exit check on resume) | — (not a step row) |

## 7. Checkout recovery specifics (owner API; storefront WEB)
- Carts gain `contact_phone` (normalized `8801XXXXXXXXX`), `contact_name` (≤ 80), `contact_email` (≤ 254, lower-case),
  `contact_captured_at`, `recovery_detected_at`. Contact is never returned by any storefront endpoint.
- `PUT /api/v1/storefront/cart/contact` (tenant from host + key; cart token as the other cart routes) `{phone, name?,
  email?}` → 204. Cart must be `active` with ≥ 1 line, else 404 `cart_not_found` (existing). Invalid phone → 422.
  Limiter `storefront-cart-contact` 10/min per shopper IP (`X-Storefront-Client-Ip`). Draft/coming-soon stores: 404.
- Unfinished online order: `payment_timeout` cancel with `customer_phone` → `checkout.abandoned` with subject order; same
  dedupe key space as carts, so a shopper whose cart was already detected doesn't get a second flow.
- Recovery merge fields: `{name}` (contact or customer name, fallback as 8.5), `{cart_link}` (P86-16), `{product}` (first
  cart line's product name + link), `{coupon}` (step 2 coupon code; step 2 with `{coupon}` and an inactive coupon at
  send time → step `skipped/coupon_inactive`), `{shop_link}`.
- Restore: `POST /api/v1/storefront/carts/recover {code}` → 201 `{cart_token, next: "checkout"|"cart"}`; storefront
  route handler `GET /r/{code}` calls it, sets `sp_cart` (same cookie attributes as cart creation), 303. Code invalid /
  run not `running|waiting|completed` / window ended → 404 `recovery_link_invalid` → handler 303 → `/`. Limiter 20/min
  per IP. Each open creates a new cart (link scanners create orphan carts, pruned by `carts:prune`).
- Recovered stats: per step `sent` (steps `done`), `recovered` (conversions credited), `revenue`; page KPIs over 30 days:
  carts left behind (runs created, worth = sum of context cart totals), recovered (conversions, rate = conversions ÷
  runs with ≥ 1 message done), revenue won back (+ average), messages sent (month, of allowance).

## 8. Messages (owner API; reuses PHASE-8-5 §4–§5)
- Renderer: `CampaignRenderer` gains merge fields `{order_no}` (thank_you), `{cart_link}`, `{product}` (cart/order first
  line) and a `max_parts` argument (3 for automations). Unknown field → 422 `campaign_unknown_merge_field` (reused).
- Unsubscribe: each message step gets a fresh code (sha256 in `automation_run_steps.unsubscribe_code_hash`, unique).
  The storefront unsubscribe API (8.5 §4.2) resolves a code from `campaign_recipients`, then `automation_run_steps`,
  then test codes (`campaign.test_sent` / `automation.test_sent` audit rows). Shape unchanged. Suppression source
  `link`, `campaign_id` null.
- Dev sink (8.5 §5.4) records automation messages too (`campaign_id` null, new field `automation_id`).
- Email: same fixed template, subject ≤ 150, body ≤ 3,000 chars; recovery email only when a `contact_email` exists.

## 9. Merchant API (amends PHASE-8-3 §3; openapi 1.14.0 binding)

### 9.1 Endpoints (all `auth:sanctum` + `surface:merchant,impersonation` + `tenant` + `store`; `perm:marketing.manage`)
| Method | Path (`/api/v1/stores/{store}`) | Notes |
|---|---|---|
| GET | `/automations` | `{data: Automation[], meta: {recipes: RecipeCard[] (catalogue incl. `added`), kpis: {active, drafts, total, runs_7d, runs_7d_succeeded_pct, messages_sent_month, carts_recovered_30d, recovered_revenue_30d}}}`; each automation has `runs_7d`, `last_run_at`, `paused_reason` (`plan`|null) |
| POST | `/automations` | `{recipe}` → 201 `draft` with recipe defaults; exists → 409 `automation_exists`; unknown → 422; plan → 402; audit `automation.created` |
| GET | `/automations/{automation}` | detail incl. `settings`, `recipe` (schema summary for the editor), `stats_7d {runs, completed, skipped, stopped, failed}` |
| PATCH | `/automations/{automation}` | `{name?, settings?, revision}` → validated per recipe; `revision_conflict` 409; audit `automation.updated` |
| POST | `/automations/{automation}/enable` | `draft|off → on`; validates settings complete (e.g. coupon for VIP message); plan 402; audit `automation.enabled` |
| POST | `/automations/{automation}/disable` | `on → off`; waiting runs → `stopped/automation_off`; audit `automation.disabled` |
| DELETE | `/automations/{automation}` | `draft` only (never run) else 409 `automation_not_draft` ("nothing is deleted" once used); audit `automation.deleted` |
| POST | `/automations/{automation}/dry-run` | `{order_id?, cart_id?, inventory_id?, return_id?}` (one, matching the trigger; default = latest matching subject) → `{conditions: [{label, passed, detail}], steps: [{action, would: "send"|"skip"|"tag"|"notify", reason?, rendered?: {text|subject+text, parts}}]}`; throttle 30/min per user; no side effects (P86-21) |
| POST | `/automations/{automation}/test-message` | `{step: 1|2}` → 202 `{to_masked}` (P86-22) |
| GET | `/automations/{automation}/stats` | `?days=14|30` → `{steps: [{step, sent, recovered, revenue_amount}], daily: [{date, recovered, revenue_amount}], kpis}` (recovery page) |
| GET | `/automation-runs` | filters `automation_id`, `recipe`, `status` (csv), `since`; cursor page 50, newest first → `AutomationRun[]` with `steps[]` |
| GET | `/automation-runs/{run}` | one run with steps |

Routes in `routes/automations.php`, included from `routes/api.php`. Storefront routes (§7) under the existing
`storefront` group conventions in the same file.

### 9.2 Shapes (summary; openapi binding)
- `Automation { id, recipe, name, status: draft|on|off, paused_reason, settings, trigger_label, action_label, runs_7d,
  last_run_at, created_at, updated_at, revision }` (`trigger_label`/`action_label` = the Figma tag texts).
- `RecipeCard { recipe, name, description, trigger_label, action_label, icon, added }`.
- `AutomationRun { id, automation {id, recipe, name}, trigger, status, outcome_reason, subject {type, id, label}
  (e.g. "GS-1048", "Cart · 2 items"), contact {masked_address, name|null}, context, steps: AutomationRunStep[],
  started_at, resume_at, finished_at, conversion {order {id, number, total_amount}}|null }`.
- `AutomationRunStep { index, action, status, reason, channel, masked_address, parts, detail, executed_at }`.
- `AutomationDryRun`, `AutomationStats` (§9.1). `MarketingOverview` (8.5) gains `kpis.carts_recovered`,
  `kpis.recovered_revenue_amount`, `series[].recovery_amount`, `counts.automations`; `revenue_amount` includes
  automation conversions (each order once).

### 9.3 Error codes (API-CONVENTIONS §3 gains them)
`automation_exists` (409), `automation_not_draft` (409), `automation_incomplete` (422, `details.fields`, enable with
missing required settings), `recovery_link_invalid` (404); reuse `validation_failed`, `revision_conflict`,
`feature_not_in_plan`, `plan_limit_reached`, `campaign_unknown_merge_field`, `campaign_too_long`,
`campaign_coupon_inactive`, `cart_not_found`.

## 10. Merchant dashboard + storefront (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`

Nav: Marketing children gain **Automations** `/marketing/automations` (after Campaigns). Pages need
`marketing.manage` (else Forbidden state). Free plan: plan note "Automations are part of the Starter plan." + See plans;
create/enable disabled. Automations whose `paused_reason = plan` show a warning pill "Paused — not in your plan".

### 10.1 Automations `/marketing/automations` — frame `140:30336` (Main `140:30338`)
Header "Automations" + subtitle as designed; header buttons (`140:30927`, `140:30929`): "Run log" → `/marketing/automations/runs`,
"+ New automation" → scrolls to "Start from a recipe".
KPI tiles (`39:9401`): **Active recipes** ("n draft · n total"), **Runs this week** ("n % succeeded" = completed ÷
non-skipped), **Messages sent** (composed: "this month · n left"), **Carts recovered** (composed: "৳ x · last 30 days").
Hidden: Risky orders held, Time saved.
"Your automations" card (`140:30980`): table RECIPE (name + trigger tag → action tag, `39:4554` info/brand), RUNS · 7
DAYS, LAST RUN ("Draft" for drafts), ON toggle (`21:202`; enable/disable; 402 → plan note). Row click → editor (or the
recovery page for `checkout_recovery`). Pill (`140:30981`) = "n on". Quiet-hours note (`140:31117`) copy: "Quiet hours 9 PM
– 9 AM: messages wait until morning. Max 2 automated messages per customer a day."
"Recent runs" card (`140:31122`): last 6 runs (icon by outcome: check = completed with a message, refresh = waiting,
alert = failed/skipped, users = tag, mail = notify), title "{subject label} · {automation name}", line = first step
outcome ("Sent to 01711-••••44", "Skipped · opted out", "Tagged VIP", "Emailed 2 team members"), time; "See all" →
run log.
"Start from a recipe" card (`140:31182`): tiles for catalogue recipes not yet added (`added=false`), button "Use recipe"
→ POST → editor. Tiles from Figma that are hidden recipes are not shown; texts for shipped recipes come from `RecipeCard`.

### 10.2 Recipe editor `/marketing/automations/:id` — frame `141:30622`
Header: name, breadcrumb line "Automations › Recipe · last edited by {name}, {date}"; buttons "Test with an order" (opens
dry-run panel focus) and "Save changes" (`141:31215`).
Flow column (`141:31218`): **When** step (`141:31219`) read-only trigger with description; order-channel chips
(`39:4594`) only for recipes allowing `order.channel` (Messenger/POS chips hidden). **If** step (`141:31289`):
condition rows (Token pattern) from the recipe's allowed list, "+ Add condition" limited to that list; recipes without
conditions hide the step. Connector tags "Yes" / "Otherwise". **Then** step (`141:31369`): the recipe's actions in fixed
order (no grip/drag), each with icon, title, description, optional toggle for optional steps; message actions show the
SMS preview block (`141:31307`: "SMS · {language} · n part(s)" + "Edit message" opening the 8.5 message editor component
with merge tags for that recipe and the 3-part counter). **Otherwise** step: "Nothing happens. The run is logged as
skipped."
Side: "Recipe settings" (`141:31402`): ON toggle, Name, recipe parameters as Fields (`39:4614`); "Test with an order"
(`141:31433`): subject picker (recent orders / carts / products) + results list (check / cross icons, rendered message);
"Last 7 days" (`141:31459`): summary line from `stats_7d` + outcome bar + legend pills.

### 10.3 Abandoned cart recovery `/marketing/automations/checkout-recovery` — frame `71:20614`
Header: title + subtitle as designed; pill "Automation on" / "Off" / "Draft"; "Send test" (P86-22) and "Save changes".
KPI tiles (`71:21021`): Carts left behind, Recovered, Revenue won back, and **Messages sent** (composed, replaces Cost).
Recovery flow card: TRIGGER row ("Checkout started, not finished" + "Phone captured at checkout · cart with items"),
wait pill "Wait {delay} minutes" (editable select 15/30/60/120/180), **Recovery/Step** (`71:20588`) step 1 (channel icon
SMS/email, title "Send SMS reminder", toggle, message box with first product photo + rendered sample, stats **Sent ·
Recovered · Revenue** — "Clicked" column hidden), wait pill "Wait {hours} hours · only if still no order", step 2
(title "SMS + coupon {code}" or "SMS reminder" when no coupon; coupon select), wait pill "Stop when an order is
placed", EXIT row ("Order placed or {n} days passed" + "Coupon expires automatically · no more messages" only when the
coupon has an end date, else "No more messages"). "Add a step" hidden.
Side: **Recent carts** (`71:21183`; polls 60 s): contact name (or "Customer") + "{first product}{ × n} · ৳ total",
pills: "Recovered · SMS|Email" (success), "Waiting · step n" (warning), "SMS sent" / "Email sent" (info), "Skipped ·
{reason}" (danger), "Opted out" (danger); "See all →" → run log filtered to this automation. **Recovered per day**
(14 bars from `stats.daily`). **Rules**: "Skip Risky customers" (toggle → `skip_risky`), "Quiet hours" (toggle shown on,
disabled; "No messages 9 PM – 9 AM"), "One coupon per phone" (read-only: on when the step-2 coupon has
`usage_per_customer = 1`, else hint "Set uses per customer to 1 on {code}" with a link).

### 10.4 Run log `/marketing/automations/runs` (composed: page header + filters + table, states `148:34032`)
Filters: automation, status chips (All / Completed / Waiting / Skipped / Stopped / Failed). Columns: time, automation,
subject, contact (masked), outcome pill + reason, steps summary; row expands to the step list. Cursor "Load more".

### 10.5 Marketing overview (amends PHASE-8-5 §8.1 hidden items)
Unhide: **Automations** tab (count = automations `on`) → `/marketing/automations`; **Carts recovered** tile; **Cart recovery**
chart series (`recovery_amount`); **Abandoned cart recovery** quick-create card → recovery page (creates the automation
when missing). Still hidden: Return on spend, Best week yet, WhatsApp broadcast.

### 10.6 Storefront (WEB owns the files in §14)
- Checkout form (`themes/modern-commerce/commerce/checkout-form.tsx`): on blur of a valid phone (and later name/email
  blur) call a server action → `PUT /storefront/cart/contact` (fire-and-forget; failures ignored, never block checkout).
  Notice under the phone field (Caption/12, muted): en "If you don't finish, we may text you a reminder. You can opt
  out any time." / bn "অর্ডার শেষ না করলে আমরা একটি রিমাইন্ডার SMS পাঠাতে পারি। যেকোনো সময় বন্ধ করতে পারবেন।"
- `GET /r/{code}` route handler (`app/r/[code]/route.ts`, outside `(store)` like `/u`): P86-16; `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`; proxy allowlist + private-path regex gain `/r/`.

States everywhere: loading/empty/error per `148:34032`. Tokens only; 375 px usable (Q166).

## 11. ARCH and types (owner ARCH)
openapi **1.14.0** (§7 storefront paths, §9.1 paths, schemas, error codes, `MarketingOverview` additions), `packages/types`
(`Automation`, `AutomationStatus`, `RecipeKey`, `RecipeCard`, `AutomationSettings` per recipe (discriminated union),
`AutomationCondition`, `AutomationRun`, `RunStatus`, `RunOutcomeReason`, `AutomationRunStep`, `StepAction`,
`StepStatus`, `StepReason`, `AutomationDryRun`, `AutomationStats`, `AutomationKpis`, inputs; `MarketingOverview`
additions; `DevSinkMessage.automation_id`; `AuditLog` actor type `automation`; `AutomationAuditAction`),
`packages/api-client` methods for every §9.1 and §7 endpoint, ADR 0020, DATABASE-DESIGN (new §5.6 replacing the §6
automations sketch; carts columns), SECURITY T36 (S127–S140), API-CONVENTIONS §3 codes + limiters, MULTI-TENANCY
(storefront cart-contact + recover paths, `automation` actor), PHASE-7 §2.1 row, PHASE-8-3 §2.1 label, PHASE-8-5 notes
(shared allowance, unsubscribe resolution), RUNBOOK (`queue-automations` worker `--timeout=250`, 4 scheduled
commands), OPEN-QUESTIONS Q152–Q166, FIGMA-INDEX Automations rows → built/omissions, roadmap 8.6. **Types first.**

## 12. Security checklist (S127–S140; each has a test)
- **S127** opt-out wins for automations: suppression created after the run started → step `skipped/opted_out`, provider
  never called; a recovery run then ends `stopped/opted_out`.
- **S128** consent scope: a non-customer checkout contact is messaged only by `checkout_recovery`, ≤ 2 messages, only
  in the window; a thank-you/VIP message to a customer with no consent and no order → `skipped/not_eligible`.
- **S129** idempotency: the same event twice, a retried `EvaluateAutomation`, two workers, `resume-due` twice → one run,
  each message step once; `unknown` never retried.
- **S130** isolation: automations, runs, steps, conversions, cart contact → cross-tenant / cross-store 404
  (`assertTenantIsolation`, `assertStoreIsolation`), RLS on Postgres for every new table.
- **S131** permissions: staff → 403 on every §9.1 route; names hidden without `customers.view`; addresses masked in
  every merchant response; impersonation can't PATCH/enable/test (read-only middleware → 403).
- **S132** cart contact: only with that cart's token; never echoed by any endpoint; 11th request/min → 429; invalid
  phone 422; contact deleted with the cart.
- **S133** recovery link: code stored as sha256 only; opening clones the cart (original token unchanged, original cart
  unchanged); store A's code on store B's host → 404; expired/stopped run → 404; 21st request/min → 429.
- **S134** quiet hours, frequency cap and exit window enforced server-side (frozen clock tests incl. store tz).
- **S135** plan: Free → 402 on create/enable/test; downgrade → no new runs, waiting runs `stopped/plan`; allowance
  exhausted → step `skipped/allowance`, zero sends; automation sends counted in the shared allowance.
- **S136** content: merge fields escaped in email HTML (S123 suite extended to automation messages); ≤ 3 parts; unknown
  merge field 422; header injection rejected.
- **S137** dry run: zero writes (row counts unchanged), zero provider calls, zero allowance use.
- **S138** team notify: only current members with the permission (a removed member stops receiving); email contains no
  customer PII.
- **S139** audit rows for create/update/enable/disable/delete/test with actor; per-action changes only in the run log.
- **S140** dev sink refuses production (8.5 S125 unchanged) and records automation messages only outside production.

## 13. Test requirements
**API (Pest; group `automations`; RLS items also `rls`, security `security`)**: every §9.1 route (happy, validation,
authz, isolation); each recipe end to end with the fake gateway + `array` mailer (trigger → run → steps → outcomes);
conditions matrix; dedupe; waits and `resume-due`; quiet-hours deferral; frequency cap; allowance shared with
campaigns (8.5 usage tests extended); exit on order (both cart and unfinished-order sources); attribution (window,
last step wins, cancelled excluded, one per order, overview counts once); cart contact + detect-abandoned; recovery
link clone; unsubscribe of an automation code; dry run; test message; reap-stuck; prune; plan downgrade; S127–S140.
**Web (Vitest)**: automations page from fixtures (hidden tiles/recipes absent, toggle → enable/disable, plan note),
editor (conditions limited to the recipe, message editor 3-part counter against the shared vectors, dry-run results),
recovery page (flow, step stats without Clicked, recent carts pills, rules), run log filters/expand, overview unhidden
items; storefront: checkout contact call on blur (not on invalid phone, never blocks submit), notice text bn/en, `/r`
handler (valid → cookie + 303 checkout, issue → cart, invalid → /).
**QA (Playwright `tests/e2e/specs/phase8-6.*.spec.ts`; `SMS_DRIVER=log`, `CAMPAIGN_MAILER=log`, `CAMPAIGNS_DEV_SINK=true`;
stack on :8010/:5183/:3010 locally)**: Starter shop enables "Win back unfinished orders" → shopper types phone at
checkout and leaves → `automations:detect-abandoned` (artisan, delay set to 15 and clock/dev trigger) → dev sink shows
reminder with `{cart_link}` → open `/r/{code}` in a fresh context → cart restored at checkout → place order → run
`stopped/converted`, conversion on the recovery page; opt-out via the message's `/u/{code}` → next step skipped;
Thank-you on delivery (fake courier advance to delivered) → message + run log; VIP tag after n deliveries; return →
tag; low stock → team email in Mailpit/log; Free plan note + 402; staff can't open Automations; 390 px screenshots of
automations, editor, recovery page, run log, checkout notice.
**QA infra**: `queue-automations` service in `docker-compose.yml` (`--queue=automations --tries=1 --timeout=250`) and the
e2e workflow fallback; CI Pest step for group `automations` (sqlite, Postgres, RLS).

## 14. File ownership for Phase 8.6

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**` only: `app/Domain/Automations/**` (recipes, triggers, evaluator, conditions, actions, recovery, conversions, jobs, console, controllers, requests, resources), `routes/automations.php` + its include line in `routes/api.php`, migrations `2026_12_03_000100`–`000200`, `Developer/Webhooks/WebhookEvents.php` (one fan-out line), `Orders/OrderService.php` (one hook line in `systemCancel`), `Cart/**` (contact columns, contact endpoint, recover endpoint, detect query), `Marketing/**` edits for reuse (renderer merge fields + `max_parts`, `UnsubscribeCodes` resolution, `CampaignAllowance::used`, dev sink field, overview additions), `Billing/FeatureGate` enforcement of `sms_automation`, `Tenancy/Authorization/Permission` (label), audit actor `automation`, `RlsTables` + `database/sql/rls-emergency-off.sql`, `config/automations.php`, `AppServiceProvider` limiters + local dev worker line, `routes/console.php` schedule lines, `tests/Feature/Automations/**`, `tests/Unit/Automations/**`, extended `tests/Feature/Marketing/**` where shared behaviour changes, RoutePermissionsTest + parity fixture rows |
| **WEB** | `apps/merchant-dashboard/**`, `packages/ui/**`, `apps/storefront/themes/modern-commerce/commerce/checkout-form.tsx` (+ its server action file), `apps/storefront/app/r/**`, the storefront proxy allowlist/private-path line for `/r/`, `apps/storefront/lib/commerce-api.ts` (two functions), `apps/storefront/tests/checkout-contact.test.ts`, `apps/storefront/tests/recover.test.ts` |
| **ARCH** | `docs/**` except `docs/reviews/**` and TESTING.md; `packages/types/**`, `packages/api-client/**` |
| **QA** | `tests/e2e/**` (`phase8-6.*`), `.github/**`, `docker-compose.yml` (`queue-automations` + env), `docs/development/TESTING.md`, `docs/reviews/phase-8-6-qa.md` |

Shared-read rules: API must keep the 8.5 public shapes unchanged except the additive `MarketingOverview` fields and
`DevSinkMessage.automation_id`. WEB reuses the 8.5 message editor and `smsParts()`; it passes `maxParts=3`. Re-read
`routes/api.php`, `WebhookEvents.php`, `OrderService.php`, the checkout form and `CampaignRenderer.php` before each Edit.

## 15. Order of work
1. ARCH: types + api-client first (§11), then openapi, ADR 0020, docs.
2. API: migrations (000100 automations/runs/steps/conversions, 000200 cart contact columns) +
   RlsTables → recipes + settings validation → automations CRUD/enable/disable → trigger fan-out + EvaluateAutomation +
   steps (tag, notify, message) → waits/resume/quiet hours/frequency cap → checkout contact + detect + recovery flow +
   exit + conversions + recover link → unsubscribe resolution + allowance + overview → dry run + test message → stats
   + run log → schedule + prune.
3. WEB: automations page + editor against §9.2 shapes (fixtures), recovery page, run log, overview items, storefront
   checkout notice + contact call + `/r` handler.
4. QA: specs + compose worker + CI group while the others build; gate after all are green.

## 16. Acceptance criteria
1. **Trigger → action runs logged:** every trigger occurrence of an `on` automation produces exactly one run with a
   terminal or waiting status and one step row per executed action with its outcome and reason (sent, skipped and why,
   failed, unknown); duplicates produce no second run (S129); the run log and Recent runs show them.
2. The 5 recipes work end to end on fake drivers; checkout recovery detects abandoned checkouts and unfinished online
   orders, sends ≤ 2 messages, restores the cart from the link, stops on order and attributes recoveries.
3. Customer messages respect opt-out at send time, eligibility, quiet hours, the frequency cap and the shared allowance
   (S127, S128, S134, S135); dry run has no side effects (S137).
4. Automations `140:30336`, editor `141:30622`, Abandoned cart recovery `71:20614`, run log and the overview items match
   Figma with the documented omissions; checkout notice on the storefront; loading/empty/error; 375 px usable.
5. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `automations`, `campaigns`, `rls`,
   `security`), Playwright `phase8-6.*` and `phase8-5.*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml`
   passes.

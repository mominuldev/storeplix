# Phase 8.2 contract: Platform analytics (binding for API, WEB, QA)

Status: **Accepted**, 2026-11-23 (PO accepted the proposed defaults for Q103–Q112 on 2026-11-23). Branch
`feat/phase-8-2-analytics` (from `phase-8-super-admin` @ 123ccdf, Phase 8.1 built and CI-green). Roadmap task **8.2**
"Platform analytics (GMV, MRR, churn); AC: nightly aggregates". Tasks 8.3–8.9 are **not** in this contract.

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, **PHASE-8-1-CONTRACT.md** and docs/api/API-CONVENTIONS.md
still applies (envelope, snake_case, ULIDs, cookie sessions, admin surface, `PlatformPermission`, paisa, RLS, the
`app/Domain/Admin/**` bypass rule). Where this file changes an earlier rule it says **"amends …"**.
Machine-readable spec: `docs/api/openapi.yaml` **v1.10.0** (2026-11-23). ADRs: **0016** (new: nightly analytics
snapshots), 0015 (admin surface), 0012 (RLS), 0008 (billing). Product defaults: OPEN-QUESTIONS **Q103–Q112**.

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-2-qa.md`). No external provider, no certification run.

| Area | Owner | Ships |
|---|---|---|
| **Nightly aggregates** | API | Two snapshot tables (`tenant_daily_metrics`, `platform_daily_metrics`), `analytics:aggregate` (hourly catch-up, real work once per Dhaka night), `analytics:backfill`, restatement of order flows for 35 days |
| **Dashboard metrics** | API / WEB | The Figma dashboard `15:123` KPI row (MRR/ARR, Active shops, Trial → paid, Merchant GMV, Revenue churn), range tabs, "Monthly recurring revenue by plan" chart, "Plan mix" donut; 8.1 widgets stay |
| **Revenue reports** | API / WEB | New page `39:12705`: 6 KPIs, MRR movement, cohort retention, revenue by plan, trial funnel, top paying merchants |
| **Merchant metrics** | API / WEB | Merchants list `32:5527` columns MRR, Orders 30d, GMV 30d, Last active + sort by MRR/GMV/last active; merchant detail `33:4851` tiles MRR, Orders · 30d, GMV · 30d and the "GMV & platform revenue" card |
| **Last active** | API | `tenants.last_active_at`, touched by merchant-surface requests (at most every 15 min per tenant) |
| **Permission** | API / WEB | New `view_analytics` (SA, BI, RO) for the platform-wide pages |

**Merchant dashboard and storefront: no change.** No merchant endpoint, page or response changes. The only merchant-path
change is the `last_active_at` touch inside `ResolveTenant` (API only, no response change).

**Out of scope** (hide, never fake; each has a Q row in §1.1): **health score** (Q105), **Integration health**
(`39:13048`, dashboard card) and **incidents** (`43:12377`) and the sidebar "Production · all systems normal" badge
(Q106, Phase 9.1); Export (CSV/PDF) of any analytics view (Q109); "upgrade nudges" note in Plan mix and every "Pro" row
(no such plan, Q111); "auto-pay", card brands and "next retry" (no auto-debit, Q83/Q97); "order overage" in MRR (no
overage billing); the merchants list District and Health filters, Health column; the dashboard "New and at-risk
merchants" orders column and at-risk logic (the 8.1 "New merchants" list stays); Needs-attention fraud and support
rows (8.8 / 8.9); a merchant-facing analytics view; real-time ("today so far") platform numbers; per-staff analytics.

### Conventions in this file
- Roles "SA / BI / SU / RO" as in PHASE-8-1. `D` = a **Dhaka day**: `[D 00:00, D+1 00:00)` in `Asia/Dhaka`
  (= `[D−1 18:00Z, D 18:00Z)`; Bangladesh has no DST, but code converts with the timezone, never a hard-coded offset).
- **As-of day** (`as_of`) = the latest `day` in `platform_daily_metrics`. In production that is yesterday once the night
  run finished. Every number in this contract is "as of the end of `as_of`"; nothing reads live tables for a metric
  except where a row says **live**.
- **Money** is integer paisa, `currency: "BDT"`. **Rates and shares** are JSON numbers in `[0, 1]` (not percent),
  rounded half-up to **4 decimals**; null when the denominator is 0 or data is missing. Averages of money are floored to
  paisa. UI formats with the existing Bangla-lakh/crore helpers (`৳ 18.4 L`, `৳ 9.6 Cr`).
- **Snapshot** = a stock value captured at the end of a day (MRR, plan, status). **Flow** = a sum over a day (orders,
  GMV). Stocks are never recomputed for a past day (they describe state that no longer exists); flows are restated.

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>` or
  commit. Touch only owned files (§12).
- New dependencies: **none** (API: query builder + Carbon; WEB: extend `packages/ui` `Charts.tsx`, no chart library).
- Postgres (Docker, roles script) with `TENANCY_RLS=true` for every `analytics` test that touches the DB on Postgres.
- Never `migrate:fresh` the local dev DB; use Pest or a scratch DB.

---

## 0. Summary and goals

1. Every morning (Dhaka) staff see yesterday's MRR, ARR, ARPA, GMV, orders, active shops, plan mix, trial → paid and
   churn for any range, computed by one idempotent night job from snapshot tables, never from ad-hoc cross-tenant
   queries per page view.
2. The numbers are defined once (§3), hand-checkable from fixtures, and identical on the dashboard, revenue report,
   merchants list and merchant detail.
3. History exists from the first night after deploy; earlier history is reconstructed once by `analytics:backfill` from
   paid invoices and orders, flagged as `backfill`.
4. Cross-tenant reads stay in `app/Domain/Admin/**` on `pgsql_admin`; the app role can't read the analytics tables at
   all; platform revenue is visible only with `view_analytics`.

---

## 1. Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| P82-1 | **Nightly snapshot tables, not live queries** (ADR 0016). `tenant_daily_metrics` (one row per tenant per Dhaka day) is the source; `platform_daily_metrics` (one row per day) is its sum plus counts. Every analytics endpoint reads only these two tables, `plans`, and (for the few **live** fields) billing/tenant tables. | Subscriptions are **mutated in place** (P7-2): yesterday's plan and status can't be queried later. Only a daily snapshot gives MRR movement, churn and cohorts. It also bounds the cost of a page view to a few thousand rows. |
| P82-2 | **Dhaka day boundaries** (`ANALYTICS_TIMEZONE=Asia/Dhaka`, not configurable per store). Months and ISO weeks (Monday start) are Dhaka calendar months/weeks. | One platform clock; every store is in Bangladesh (stores.timezone default `Asia/Dhaka`). |
| P82-3 | **Scheduler:** `analytics:aggregate` runs **hourly at :20** (`->hourlyAt(20)->timezone('Asia/Dhaka')->withoutOverlapping(60)->onOneServer()->runInBackground()`), in-process (no queue job, no new worker). Each run: (a) for every closed day `D` in the last 7 days without a `platform_daily_metrics` row, ascending: snapshot + flows; (b) if (a) created yesterday's row, restate flows for the `ANALYTICS_RESTATE_DAYS` (35) days before it. A run with nothing missing exits in < 1 s. The first run after midnight (00:20) does the work; later runs are the catch-up if it failed. | Hourly catch-up = self-healing without an ops page; in-process keeps the "one transaction per day" rule simple and avoids blocking `default`. |
| P82-4 | **Snapshot timing.** The stock part of day `D` (plan, interval, subscription status, tenant status, MRR) is captured from the **current** state when the run happens. `source = nightly` if the run starts before `D+1 06:00` Dhaka, else `late`. A day older than 7 days is never snapshotted from current state; only `analytics:backfill` fills it (`source = backfill`). | The 00:20 run sees end-of-day state ± 20 min of activity. A late run is still the best data available, but it is labelled. |
| P82-5 | **Idempotent upserts.** One DB transaction per day on `pgsql_admin`: `INSERT … SELECT … ON CONFLICT (tenant_id, day) DO UPDATE` for tenants, then the platform row from `SUM … GROUP BY` of that day's tenant rows (`ON CONFLICT (day) DO UPDATE`). Re-running a day whose row exists **restates flows only** (`orders_count`, `gmv_amount`, `computed_at`) and never overwrites stock columns, unless `--rebuild-stocks` (which uses the backfill reconstruction, P82-6). | Re-runs and crashes can't corrupt point-in-time data. |
| P82-6 | **Backfill** `analytics:backfill --from=YYYY-MM-DD [--to=] [--force]` (default `--to` = the day before the first `nightly` row). Flows: exact, from orders. Stocks: reconstructed from **paid, non-duplicate `billing_invoices`**: tenant `T` paid plan `P`/interval `I` on `D` iff an invoice with `period_start ≤ end(D) < period_end` exists (latest `paid_at` wins); trial = `trial_ends_at > end(D)` and `created_at ≤ end(D)` on any of T's subscription rows; else Free. `past_due` grace, comp plans and suspension history can't be reconstructed (counted as not paying / active). `source = backfill`. Refuses to overwrite `nightly`/`late` rows; `--force` required in production. | One-off history for the first charts (Q110); honest about what can't be known. |
| P82-7 | **MRR** (per tenant, at the end of `D`): `0` unless tenant `status = active` **and** current subscription `status ∈ {active, past_due}` **and** plan ≠ Free **and** not comp. Then month → `plans.price_amount`; year → `intdiv(plans.price_yearly_amount, 12)` (floored per tenant: Starter yearly `41583`, Growth yearly `124916`). List prices from `plans` at snapshot time (no discounts exist). `trialing` = 0 MRR. **Comp** = the current subscription row has no `billing_invoices` row with `status = paid` and that `subscription_id` (admin "Change plan → Now" or `billing:change-plan` from Free/trial); comp shops count in `comp_tenants`, not in MRR (Q103). **Suspended** shops contribute 0 (Q103). | Standard SaaS MRR: recurring list price of paying subscriptions, normalised to a month. `past_due` is still a customer until the grace ends (P7-4). |
| P82-8 | **ARR** = `MRR × 12`. **ARPA** = `floor(MRR / paying_tenants)` (null if 0). **Paying** ⇔ `mrr_amount > 0`. **LTV** = `ARPA × lifetime_months`, `lifetime_months = min(60, round(1 / avg_monthly_revenue_churn, 1))` where the average is the plain mean of the revenue churn rates of the **last 3 complete calendar months** before `as_of`'s month; null if any of them is null or the mean is 0. | Figma "ARPA ÷ churn · 29 mo". The 60-month cap keeps a near-zero churn month from printing absurd values. |
| P82-9 | **MRR movement** for a window `[a, b]` (a bucket or the whole range): per tenant compare `open` = `mrr_amount` on `a − 1` (0 if no row for that tenant) and `close` = `mrr_amount` on `b`. **new**: `open = 0 < close` (includes reactivation); **expansion**: `0 < open < close` (Δ); **contraction**: `0 < close < open` (Δ); **churned**: `open > 0 = close`. `net_new = new + expansion − contraction − churned = closing MRR − opening MRR` (asserted). Intra-window round trips are invisible. If `a − 1 < data_starts_on` or `b` has no platform row, every movement field of that window is **null**. | Snapshot-diff movement is exact, cheap and testable; a reconciliation identity guards it. **Amended 2026-11-23 (API build):** a missing platform snapshot on `a − 1` makes the movement `null` for that window (not only when `a − 1` is before `data_starts_on`). |
| P82-10 | **Churn.** **Revenue churn** of a window = `churned_amount / opening_mrr` (contraction not included, Figma "Churned MRR · % of opening MRR"). **Logo churn** = `churned_count / opening paying count`; "cancellations" in Figma = `churned_count`. Monthly churn = the window of one calendar month. | Matches both Figma screens; gross revenue churn is the conventional headline. |
| P82-11 | **GMV and orders** (flow, per tenant per day `D`): orders with `placed_at` in `D`, `status ∉ {pending_payment, cancelled}` and `currency = 'BDT'` (others counted in the platform row's `non_bdt_orders_count`, none exist today). `gmv_amount = Σ total_amount` (**gross**: delivery charge included, refunds not subtracted, `returned` orders included because they were sold). `orders_count` = count of the same set. **AOV** = `floor(gmv / orders)` (null if 0). Restated for 35 days, then frozen (Q104). | Platform GMV is the standard "gross merchandise value placed through the platform"; Phase 7 merchant Sales (shipped+delivered, net) answers a different question. Cancellations within 35 days are reflected; abandoned online holds never count. |
| P82-12 | **Active shops** = tenants with `status = active` at the end of `D` (every shop that exists and isn't suspended, Figma 3,482 = Plan mix total). Partition: `active = paying + trialing + comp + free` (asserted per day); `past_due ⊂ paying`. **Plan mix** = active tenants by **effective plan** (trial under its trial plan, comp under its plan, everyone else on Free). | Figma: "3,482 · 1,906 paying · 1,576 free" and the donut sum to the same total. |
| P82-13 | **Trial → paid** for a range `[from, to]`: `ended` = tenants whose trial ended in the range (min non-null `trial_ends_at` over the tenant's subscription rows, as a Dhaka day, in range and ≤ `as_of`); `converted` = those whose first paid non-duplicate invoice has `paid_at ≤ trial_ends_at + ANALYTICS_TRIAL_CONVERSION_DAYS` (7 d); `rate = converted / ended`. `trialing_now` = `trialing_tenants` on `as_of`. **Live** read of `subscriptions` + `billing_invoices` on `pgsql_admin` (these columns are not mutated after the trial). | Every shop starts a 14-day trial at signup (P7), so "trial outcome" is the honest conversion denominator; 7 days covers "paid right after the trial lapsed to Free". |
| P82-14 | **Cohort retention**: cohort = Dhaka month of the tenant's **first paid** non-duplicate invoice (`paid_at`); `retention[k]` = share of the cohort with `mrr_amount > 0` on the **last day of month cohort+k** (for the current month: `as_of`); null when that day has no snapshot. The last 12 cohorts ending with `as_of`'s month; independent of the range tabs. `m3_average` = cohort-size-weighted mean of non-null `retention[3]`. **Amends Figma** "by signup month" (Q107). | A signup cohort mixes shops that never paid (most stay on Free), so its "M0 = 100 %" in Figma only holds for a paid cohort. |
| P82-15 | **Trial funnel** (revenue report), over tenants **created** in the range: `signed_up`; `store_published` (store `published_at` not null now); `trial_ended` (trial ended ≤ `as_of`); `converted` (first paid invoice at any time ≤ `as_of`); `trial_to_paid_rate` (P82-13 rule within this cohort); `signup_to_paid_rate = converted / signed_up`; `median_days_to_paid` (whole days from `created_at` to first `paid_at`, median of converted, null if none). Figma step "Started 14-day trial" is **dropped** (= signed up for every shop). **Live** on `pgsql_admin`. | Same data as P82-13, cohort-shaped. |
| P82-16 | **Last active** = `tenants.last_active_at` (new, platform column): set by `ResolveTenant` after a successful **merchant-surface** membership check (never for `impersonation` or `admin` surfaces, never for storefront requests), at most once per 15 min per tenant (`Cache::add('sp:tenant-active:{id}', 1, 900)` then `UPDATE tenants SET last_active_at = now() WHERE id = ?` on the default connection; `tenants` is a platform table without RLS). Null = never since deploy (UI "—"). **Live.** | "Last active" in Figma means the merchant worked in the dashboard. A throttled column is one write per tenant per 15 min; sessions are pruned and can't answer it. |
| P82-17 | **Ranges.** `range` ∈ `30d` (30 days ending `as_of`), `quarter` (90 days ending `as_of`), `12m` (from the 1st of the month 11 months before `as_of`'s month to `as_of`), `custom` (`from`, `to` dates; `to` clamped to `as_of`; `from ≤ to`; ≤ 731 days; `from ≥ 2024-01-01`). Default granularity: `30d` → `day`, `quarter` → `week`, `12m` → `month`, `custom` → `day` ≤ 31 days, `week` ≤ 92, else `month`; `granularity` may override within caps (day ≤ 92 buckets, week ≤ 106, month ≤ 25; over → 422 `validation_failed`). Buckets are clipped to the range. **Previous period** = equal number of days immediately before `from` (`12m`: the 12 months before). Stocks of a bucket = value on its last day; flows = sum. | Figma tabs 30 days / Quarter / 12 months / Custom; "Compare to previous period". |
| P82-18 | **Permission `view_analytics`** (new `PlatformPermission` case, matrix SA ✓ BI ✓ SU ✗ RO ✓) gates `/admin/analytics/*` (platform-wide revenue). Per-tenant metrics (list columns, detail tiles, `/admin/tenants/{tenant}/metrics`) stay under `view_merchants`, so Support sees one shop's numbers while helping it (Q108). **Amends** PHASE-8-1 §2.1. | Company revenue is finance data; a single shop's GMV is support context. |
| P82-19 | **Cache.** Each analytics response is cached in the global cache under `sp:analytics:{endpoint}:{sha1(params)}:{as_of}:{computed_at}` for 1 h, so a night run or restatement invalidates by key. HTTP stays `Cache-Control: private, no-store` (8.1). `meta.as_of`, `meta.computed_at` and `meta.data_starts_on` are always present (null when there is no data yet → every metric null/empty, HTTP 200, never 404). | Cheap and correct; the UI can say "Data as of 22 Nov, updated 00:24". |
| P82-20 | **Where the code lives:** `app/Domain/Admin/Analytics/**` (aggregator, backfill, query services, controllers, commands, testing-only dev endpoint). Cross-tenant SQL only through `PlatformDb::connection()` with `// cross-tenant: platform analytics …`; the directory is already in the `RlsBypassArchTest` allowlist (P8-6). Query builder with bindings only; `SET LOCAL statement_timeout = '15s'` for request-path analytics queries and `'300s'` in the command. | No new bypass path; one directory to audit. |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q103–Q112; defaults accepted by the PO 2026-11-23)

| Q | Question | Proposed default |
|---|---|---|
| Q103 | MRR: count comp plans and suspended shops? | No to both (P82-7): comp shops in a separate count, suspended shops 0 MRR; `past_due` counts until it expires |
| Q104 | GMV definition | Gross `total_amount` of orders placed in the day, excluding `pending_payment` and `cancelled`; returns and refunds not subtracted; restated 35 days (P82-11) |
| Q105 | Merchant health score (Figma list column, detail tile, "at-risk") | Not built: needs a PO-defined formula and fraud signals (8.8). Columns/tiles hidden |
| Q106 | Integration health, incidents, "all systems normal" badge | Not built: needs uptime/latency monitoring of providers, which is Phase 9.1 observability |
| Q107 | Cohort retention grouped by signup month (Figma) or first paid month | First paid month (P82-14); subtitle reads "by first paid month" |
| Q108 | Who sees platform-wide revenue | New `view_analytics`: Super admin, Billing, Read-only; not Support. Per-shop numbers stay visible to every role |
| Q109 | Export (CSV) on dashboard and revenue reports | Not built (same stance as 8.1 audit/merchants export) |
| Q110 | History before the 8.2 deploy | One `analytics:backfill` from the first tenant's `created_at`, flows exact, stocks reconstructed from paid invoices and flagged `backfill` (P82-6) |
| Q111 | Figma "Pro" plan, upgrade nudges ("146 free shops passed 50 orders"), "auto-pay", "order overage" | Not shown: none exist. Charts and tables list the plans in `plans` (Free, Starter, Growth) |
| Q112 | Definition of "last active" | Last merchant-dashboard request by any member, 15-min resolution; impersonation and storefront traffic don't count (P82-16) |

---

## 2. Permissions

### 2.1 Platform permission matrix (amends PHASE-8-1 §2.1; `AdminPermissionTest` gains the rows)

| Permission | Endpoints | SA | BI | SU | RO |
|---|---|---|---|---|---|
| `view_merchants` (8.1) | + `GET /admin/tenants/{tenant}/metrics`; list/summary metric fields | ✓ | ✓ | ✓ | ✓ |
| **`view_analytics`** (new) | `GET /admin/analytics/overview`, `GET /admin/analytics/revenue` | ✓ | ✓ | | ✓ |

`PlatformRole::permissions()` adds `view_analytics` to `super_admin`, `billing`, `read_only`. `PlatformRoleMatrix` and `GET /admin/team` `meta.matrix` pick it up
automatically; the read-only matrix UI shows the new row "View analytics".

Missing permission → 403 `forbidden`. WEB hides the analytics widgets and the "Revenue reports" nav item without it;
the 8.1 dashboard widgets stay for every role.

---

## 3. Metric definitions (single source; one Pest unit test per bullet, §10)

All for tenant set = every row of `tenants` at the end of the day; amounts in paisa; day/month = Dhaka.

| Metric | Definition | Kind |
|---|---|---|
| `mrr_amount` (tenant, D) | P82-7 | stock |
| `is_comp` (tenant, D) | P82-7 | stock |
| MRR (platform, D) | Σ tenant `mrr_amount` | stock |
| MRR by plan | Σ tenant `mrr_amount` grouped by `plan_code` (paid plans only) | stock |
| ARR | MRR × 12 | stock |
| Paying / trialing / comp / free / past_due / suspended / active / total tenants | P82-12 partition; `total = active + suspended` | stock |
| Plan mix | active tenants by effective plan (P82-12) | stock |
| ARPA | `floor(MRR / paying)` | stock |
| Orders, GMV (tenant, D) | P82-11 | flow |
| AOV | `floor(GMV / orders)` over the same window | derived |
| New shops (D) | tenants with `created_at` in D | flow |
| Movement (window) | P82-9 | window |
| Revenue churn / logo churn | P82-10 | window |
| LTV | P82-8 | derived |
| Trial → paid | P82-13 | live |
| Funnel | P82-15 | live |
| Cohorts | P82-14 | snapshots + live first-paid |
| Lifetime paid | Σ `total_amount` of `paid` non-duplicate invoices (as 8.1 `AdminTenant.lifetime_paid_amount`) | live |
| Paid 12 mo | same with `paid_at ≥ as_of − 364 d` | live |
| Customer since | Dhaka date of the first paid non-duplicate invoice | live |
| Last active | P82-16 | live |

"Non-duplicate invoice" = an invoice paid by at least one `billing_payments` row with `status = succeeded` and
`is_duplicate = false`, or by `provider = manual`; in practice `billing_invoices.status = 'paid'` (duplicates never
create a second paid invoice, P7-14), so the rule is simply `status = 'paid'`.

---

## 4. Jobs and commands (owner API)

### 4.1 `analytics:aggregate {--date=} {--from=} {--to=} {--rebuild-stocks} {--force}`
- No options: P82-3 (missing closed days of the last 7 days, then the 35-day restatement).
- `--date` / `--from --to`: those days only (closed days only; a day ≥ today Dhaka → error exit 1, except in
  `local`/`testing` where today is allowed for e2e, marked `source = late`). Missing rows get stocks from current
  state **only** if the day is within 7 days, else exit 1 with "use analytics:backfill".
- `--rebuild-stocks`: overwrite stocks with the backfill reconstruction (P82-6); `--force` in production.
- Per day, in one transaction on `pgsql_admin`, `SET LOCAL statement_timeout = '300s'`:
  1. tenant stocks (amended 2026-11-23 from the API build: computed in PHP from one read and bulk-inserted in chunks, same
     rules and `ON CONFLICT DO NOTHING`, instead of one `INSERT … SELECT`) over `tenants` ⟕ store ⟕ current subscription (`status IN
     ('trialing','active','past_due')`, the P7 partial unique row) ⟕ `plans` ⟕ `EXISTS(paid invoice for that
     subscription)`; `ON CONFLICT DO NOTHING` (stocks never overwritten, P82-5);
  2. tenant flows: `UPDATE … FROM (SELECT tenant_id, count(*), sum(total_amount) FROM orders WHERE placed_at >= ? AND
     placed_at < ? AND status NOT IN (…) AND currency = 'BDT' GROUP BY tenant_id)`; tenants without orders get 0;
  3. platform row: sums/counts of that day's tenant rows + `new_tenants` + `non_bdt_orders_count`; upsert;
  4. assertions (throw → rollback, exit 1, log `analytics.aggregate_failed` with the day): partition identity
     (P82-12), MRR = Σ by plan.
- Logs one info line per day: day, tenants, MRR, GMV, duration. Audit: none (no tenant data changes).
- Performance budget: one day for 5 000 tenants and 200 000 orders/day < 30 s on CI Postgres (`perf` group).

### 4.2 `analytics:backfill --from= [--to=] [--force]` (P82-6)
Days ascending, same transaction shape, `source = backfill`. Prints a per-month summary. Production needs `--force`.
RUNBOOK §12 (QA writes): run once after the 8.2 deploy, `--from` = the oldest `tenants.created_at`.

### 4.3 Testing-only dev endpoint (not in openapi; API-CONVENTIONS §10.3 rules)
`POST /dev/analytics/aggregate {from?, to?}` — registered only when `APP_ENV ∈ {local, testing}`, admin surface + SA
session; runs `analytics:aggregate` for the days (default: today, allowed here) synchronously and answers 200
`{data: {days: string[], as_of}}`. Throttle 10/min. Used by Playwright to turn freshly created orders into numbers.
Full path `POST /api/v1/dev/analytics/aggregate`. **Amended 2026-11-23 (orchestrator, from QA prep):** when the
range includes **today** (Dhaka; only possible here and via `--date` in `local`/`testing`), today's tenant stock rows are
**recomputed and replaced** (not `ON CONFLICT DO NOTHING`) and the platform row is re-summed, so a shop that pays
between two same-day runs shows in MRR, counts and the funnel. Closed days keep P82-5 (stocks never overwritten).

### 4.4 Configuration
`ANALYTICS_TIMEZONE` (`Asia/Dhaka`), `ANALYTICS_RESTATE_DAYS` (35), `ANALYTICS_CATCHUP_DAYS` (7),
`ANALYTICS_TRIAL_CONVERSION_DAYS` (7), `ANALYTICS_CACHE_SECONDS` (3600). Scheduler gains `analytics:aggregate`
(P82-3). No queue or worker change.

---

## 5. Data (migrations, owner API) — prefix `2026_10_01_`, forward-only

### 5.1 New and changed tables

**`000100_create_analytics_tables`**

`tenant_daily_metrics` (**tenant table**: has `tenant_id`, so it is in `RlsTables::TENANT`, `ENABLE` + `FORCE` RLS
with the standard `tenant_isolation` policy via `RlsPolicies::enable`, and the emergency SQL script list; **plus
`REVOKE ALL ON tenant_daily_metrics FROM storeplix_app`** — no request path reads it as the app role; only
`pgsql_admin` reads/writes):
`tenant_id char(26)` FK tenants ON DELETE CASCADE · `day date` · `plan_code varchar(32) null` (effective plan; null
only in a `backfill` row before the tenant had a subscription) · `billing_interval varchar(8) null` CHECK IN
(`month`,`year`) · `subscription_status varchar(16) null` CHECK IN (`trialing`,`active`,`past_due`) (null = no current
subscription or unknown in backfill) · `tenant_status varchar(16)` CHECK IN (`active`,`suspended`) · `mrr_amount bigint
not null default 0` CHECK `>= 0` · `is_comp boolean not null default false` · `orders_count int not null default 0`
CHECK `>= 0` · `gmv_amount bigint not null default 0` CHECK `>= 0` · `currency char(3) not null default 'BDT'` CHECK
`= 'BDT'` · `source varchar(8)` CHECK IN (`nightly`,`late`,`backfill`) · `snapshot_at timestamptz` · `computed_at
timestamptz`. **PK `(tenant_id, day)`** (no ULID: the pair is the identity; same reasoning as `platform_counters.key`).
`IX(day, mrr_amount DESC)` (platform: top merchants, list sort), `IX(day) WHERE mrr_amount > 0`. CHECK `mrr_amount = 0
OR (tenant_status = 'active' AND NOT is_comp)`.

`platform_daily_metrics` (**platform table**, no `tenant_id`, in `RlsTables::PLATFORM`; `REVOKE ALL … FROM
storeplix_app`):
`day date PRIMARY KEY` · `total_tenants`, `active_tenants`, `suspended_tenants`, `paying_tenants`, `trialing_tenants`,
`comp_tenants`, `free_tenants`, `past_due_tenants`, `new_tenants int not null` · `mrr_amount bigint not null` ·
`mrr_by_plan jsonb not null default '{}'` (`{"starter": 4990000, "growth": …}`, paid plans with MRR > 0) ·
`tenants_by_plan jsonb not null default '{}'` (plan mix, active tenants) · `paying_by_plan jsonb not null default '{}'`
· `yearly_by_plan jsonb not null default '{}'` (paying tenants on yearly) · `orders_count int not null` · `gmv_amount
bigint not null` · `non_bdt_orders_count int not null default 0` · `currency char(3) default 'BDT'` · `source
varchar(8)` (worst of the day's tenant rows: `backfill` > `late` > `nightly`) · `computed_at timestamptz`. CHECK
`active_tenants = paying_tenants + trialing_tenants + comp_tenants + free_tenants`, CHECK `total_tenants =
active_tenants + suspended_tenants`.

No Eloquent models with `BelongsToTenant` (no tenant-context code path uses these tables); query builder on
`PlatformDb::connection()` only. sqlite: same tables without grants/RLS.

**`000200_add_last_active_at_to_tenants`** — `tenants.last_active_at timestamptz null`; `IX(last_active_at)`.

**`000300_analytics_indexes`** (pgsql: `CREATE INDEX CONCURRENTLY` outside a transaction, only if missing; platform
indexes, deliberately not tenant-led, read through `pgsql_admin`): `orders IX(placed_at)`; `billing_invoices
IX(tenant_id, paid_at) WHERE status = 'paid'`; `subscriptions IX(trial_ends_at) WHERE trial_ends_at IS NOT NULL`.

### 5.2 Bypass paths
| # | Path | Mechanism |
|---|---|---|
| B27 | `analytics:aggregate`, `analytics:backfill`, `/dev/analytics/aggregate` | `pgsql_admin` in `app/Domain/Admin/Analytics/**`, `// cross-tenant: platform analytics` |
| B28 | `/admin/analytics/*`, `/admin/tenants/{tenant}/metrics`, metric fields of `/admin/tenants` | as P8-6 |
| B29 | `ResolveTenant` touch of `tenants.last_active_at` | platform table without RLS, app connection, own tenant id only |

---

## 6. API endpoints (owner API)

Common: as PHASE-8-1 §6 (admin surface, `platform`, `platform.ip`, limiter `admin`, `pgsql_admin`, `no-store`).
No new error codes (bad params → 422 `validation_failed`; no data → 200 with nulls). Query params (analytics):
`range` (`30d` default for overview, `12m` default for revenue), `from`, `to` (required iff `range=custom`),
`granularity` (`day`/`week`/`month`, optional, P82-17).

### 6.1 Endpoints
| Method & path | Perm | Success |
|---|---|---|
| `GET /admin/analytics/overview` | `view_analytics` | 200 `{data: AdminAnalyticsOverview, meta: AnalyticsMeta}` |
| `GET /admin/analytics/revenue` | `view_analytics` | 200 `{data: AdminRevenueReport, meta: AnalyticsMeta}` |
| `GET /admin/tenants/{tenant}/metrics` | `view_merchants` | 200 `{data: AdminTenantMetrics, meta: AnalyticsMeta}` (range fixed: `30d`, `from`/`to` of the 30-day window) |
| `GET /admin/tenants` (exists) | `view_merchants` | + `sort` values `-mrr`, `mrr`, `-gmv_30d`, `-orders_30d`, `-last_active_at`, `last_active_at` (nulls last); each `AdminTenantSummary` + `metrics`, `last_active_at`; `meta.counts` unchanged; `meta.metrics_as_of` (date \| null) |
| every other `AdminTenantSummary` producer (overview newest, search, detail) | — | same two fields |

### 6.2 Shapes (openapi 1.10.0 is binding; summary)

`AnalyticsMeta {as_of: date|null, computed_at: date-time|null, data_starts_on: date|null, timezone: "Asia/Dhaka",
currency: "BDT", range: AnalyticsRange, granularity: AnalyticsGranularity, from: date, to: date, previous_from: date,
previous_to: date}` (with no data: `from`/`to` computed from today − 1).

`AdminAnalyticsOverview`:
- `mrr {amount, previous_amount, arr_amount}` — stock at `to` / at `previous_to`.
- `active_shops {total, paying, trialing, comp, free, past_due, previous_total}`.
- `trial_conversion {rate, previous_rate, converted, ended, trialing_now}` (P82-13 on range / previous range).
- `gmv {amount, previous_amount, orders_count, previous_orders_count, aov_amount}`.
- `revenue_churn {rate, previous_rate, churned_amount, cancellations, opening_mrr_amount}` (P82-10 on the range window).
- `mrr_series: AnalyticsMrrPoint[]` — one per bucket: `{bucket_start, bucket_end, mrr_amount|null, by_plan:
  Record<plan_code, int>}` (null when the bucket's last day has no row).
- `plan_mix: AnalyticsPlanCount[]` at `to`: `{plan_code, plan_name, count}` ordered by `plans.sort`.
- `plans: AnalyticsPlanRef[]` `{code, name, sort, monthly_price_amount}` (legend/colour order for the WEB).

`AdminRevenueReport`:
- `kpis {mrr, arr, net_new_mrr, churned_mrr, arpa, ltv}`: `mrr/arr {amount, previous_amount}`; `net_new_mrr {amount,
  previous_amount, new_amount, expansion_amount, contraction_amount, churned_amount}` (range window); `churned_mrr
  {amount, previous_amount, rate, previous_rate, opening_mrr_amount, count}`; `arpa {amount, previous_amount,
  paying}`; `ltv {amount, lifetime_months}` (P82-8; no previous).
- `movement: MrrMovementBucket[]` per bucket: `{bucket_start, bucket_end, opening_mrr_amount, new_amount,
  expansion_amount, contraction_amount, churned_amount, net_new_amount, closing_mrr_amount, counts {new, expansion,
  contraction, churned}}` (all money fields null together, P82-9).
- `cohorts {rows: RetentionCohort[], m3_average}`; `RetentionCohort {cohort: "YYYY-MM", size, retention: (number|null)[]}`
  (`retention.length` = months from cohort to `as_of`'s month + 1, max 12).
- `by_plan {rows: RevenueByPlanRow[], total}`: row `{plan_code, plan_name, monthly_price_amount, shops, mrr_amount,
  previous_mrr_amount, share, yearly_share}` for every plan in `plans` order **desc** (Growth, Starter, Free); Free row
  `shops = free_tenants`, MRR 0, share 0, `yearly_share` null; `total {shops, paying, mrr_amount, previous_mrr_amount}`.
- `trial_funnel {signed_up, store_published, trial_ended, converted, trial_to_paid_rate, signup_to_paid_rate,
  median_days_to_paid}` (P82-15, tenants created in the range).
- `top_merchants: TopPayingMerchant[]` (≤ 10, `mrr_amount` desc at `to`, then lifetime paid desc, name):
  `{tenant: AdminShopRef, primary_host|null, plan_code, billing_interval|null, last_payment_provider|null ("bkash"|
  "sslcommerz"|"manual"), orders_30d, mrr_amount, customer_since: date|null, lifetime_paid_amount}`.

`AdminTenantMetrics`: `{mrr_amount|null, is_comp, plan_code|null, billing_interval|null, orders_30d|null,
previous_orders_30d|null, gmv_30d_amount|null, previous_gmv_30d_amount|null, aov_30d_amount|null,
avg_orders_per_day_30d|null (1 decimal; `orders_30d / 30`, amended 2026-11-23), gmv_month_amount|null (current Dhaka month to as_of), paid_12m_amount
(live), monthly: {month: "YYYY-MM", gmv_amount|null, orders_count|null}[12]}` (null where no snapshot covers it;
previous = the 30 days before).

`AdminTenantSummary` += `last_active_at: date-time|null`, `metrics: {as_of: date, mrr_amount, is_comp, orders_30d,
gmv_30d_amount} | null` (null when the tenant has no row on `as_of`, e.g. created today).

`PlatformPermission` += `view_analytics`.

---

## 7. Apps

### 7.1 Super admin SPA (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`, page `5:189`
Screens are queried by frame id (never the page). Every widget: loading skeleton, error state with Retry, and empty
state from section `148:34032` ("No data yet — analytics are computed nightly"). A caption under each page header:
"Data as of {as_of, d MMM} · updated {computed_at, HH:mm}" (Dhaka); when `as_of` is null → the page-level empty
state. Bucket values null → empty bar slot with a "No data" tooltip; a note "History starts {data_starts_on}" when the
range starts before it. Deltas: green ↑ / red ↓ pills; for churn **down is good** (green ↓). Pills hidden when the
previous value is null or 0. 1280 px design width, usable at 1024 px.

**Dashboard `/` — frame `15:123`** (8.1 widgets keep their 8.1 behaviour for every role; the following need
`view_analytics`, otherwise the 8.1 layout stays as is):
| Widget (frame) | Data | Build notes |
|---|---|---|
| Range tabs `15:263` (30 days / Quarter / 12 months) | `range` | Default `30d`; kept in the query string `?range=`. Export `15:270` hidden (Q109) |
| KPI/MRR `15:273` | `mrr.amount`, delta % vs `previous_amount`, caption "ARR {arr_amount}" | |
| KPI/Active shops `15:281` | `active_shops.total`, delta absolute (`total − previous_total`), caption "{paying} paying · {free} free" (+ " · {trialing} trial" when > 0, " · {comp} comp" when > 0) | replaces the 8.1 Active shops tile |
| KPI/Trial → paid `15:289` | `trial_conversion.rate` %, delta in pts, caption "{trialing_now} trials running" | rate null → "—" |
| KPI/Merchant GMV `15:297` | `gmv.amount`, delta %, caption "{orders_count} orders" | |
| KPI/Revenue churn `15:305` | `revenue_churn.rate` %, delta pts (down = green), caption "{cancellations} cancellations" | |
| MRR chart `15:314` "Monthly recurring revenue by plan" | `mrr_series` stacked by plan (Starter, Growth in `plans` order; tones from the Figma legend `15:319`/`15:322`, no "Pro"); subtitle = range dates; y ticks via `niceCeil` | Title stays "… by plan" for every granularity; x labels `MMM` (month), `d MMM` (day/week) |
| Plan mix `15:387` | `plan_mix` in `DonutMeter`, centre = Σ count "shops" | Nudge box `15:416` hidden (Q111) |
| New and at-risk merchants `15:419` | 8.1 "New merchants" list (unchanged; orders column hidden, at-risk not built) | |
| Integration health `15:490` | — | hidden (Q106) |
| Needs attention `15:519` | 8.1 rows only | fraud/support rows hidden |

**Revenue reports `/revenue` — frame `39:12705`** (nav item "Revenue reports" under Overview, `view_analytics`):
| Widget (frame) | Data | Build notes |
|---|---|---|
| Page header `39:17079`: tabs `39:17083` (30 days `39:17084`, Quarter `39:17086`, 12 months `39:17088`, Custom `39:17090`), Compare toggle `39:17092`, Export `39:17096` | `range`, `from`, `to` | Default `12m`. Custom opens a date-range popover (composed from the existing date filter; max 731 days). Compare toggle shows/hides every delta pill and the previous values (client-side; the API always sends previous). Export hidden |
| KPIs `39:17098`: MRR `39:17099`, ARR `39:17106`, Net new MRR `39:17113`, Churned MRR `39:17120`, ARPA `39:17127`, LTV `39:17134` | `kpis.*` | captions: MRR "vs {previous} in {previous_to month}"; ARR "Run-rate · {paying} paying"; Net new "New + expansion − losses"; Churned "{rate} of opening MRR"; ARPA "Per paying account"; LTV "ARPA ÷ churn · {lifetime_months} mo" ("—" when null) |
| MRR movement `39:17141` (legend `39:17146`, chart `39:17159`, breakdown `39:17248`: New `39:17249`, Expansion `39:17256`, Contraction `39:17263`, Churn `39:17270`) | `movement` | Diverging stacked bars (new + expansion up, contraction + churn down) with the net label above each bar; breakdown cards = last bucket (`{counts.new} new paying shops`, `{counts.expansion} upgrades`, `{counts.contraction} downgrades`, `{counts.churned} cancellations`); the Figma "· overage" text is dropped |
| Cohort retention `39:18323` (scale `39:18328`, pill `39:18336`, heatmap `39:18338`) | `cohorts` | Rows = cohorts (label `MMM yyyy`, size), columns M0…M10 (max 12 columns: M0–M11), colour steps from the scale legend; null cells empty; pill "M3 avg {m3_average}" without a delta; subtitle "Share of paying shops still subscribed, by first paid month"; the Figma footnote text is dropped |
| Revenue by plan `39:18587` (rows `39:18598`… total `39:18649`) | `by_plan` | Rows from data (no Pro); sub-line "৳{monthly_price}/mo · {yearly_share} annual" (Free: "Free plan"); share bar; "vs prev." column = % change `mrr_amount` vs `previous_mrr_amount`; footer "Total · {total.paying} paying" |
| Trial funnel `39:18655` (steps from `39:18662`) | `trial_funnel` | Steps: Signed up → Store published → Converted to paid (the "Started 14-day trial" step removed, P82-15); drop-off lines = differences ("{n} never published a store", "{n} did not convert"); pill "{trial_to_paid_rate} trial → paid"; bottom stats "Median time to paid {median_days_to_paid} days", "Signup → paid {signup_to_paid_rate}" (no delta) |
| Top paying merchants `39:18704` | `top_merchants` | Columns Merchant (name + host), Plan pill, Billing "{provider label} · {monthly|yearly}" ("—" if no payment), Orders / 30d, MRR, Customer since (`MMM yyyy`), Lifetime paid; row click → `/merchants/:id`; "All merchants →" → `/merchants?sort=-mrr` |

**Merchants `/merchants` — frame `32:5527`** (8.1 page; additions): header caption "{n} shops · {paying} paying ·
{MRR} MRR" (MRR part only with `view_analytics`, from `GET /admin/analytics/overview?range=30d` → `mrr.amount`);
columns **MRR ৳** (`metrics.mrr_amount`, "Comp" text when `is_comp`), **Orders 30d**, **GMV 30d ৳**, **Last active**
(relative time, "—" when null) between Plan and Status; Sort select ("Sort" + options "Newest", "MRR · high to low",
"GMV 30d · high to low", "Orders 30d · high to low", "Last active · recent first") → `sort` query param; `metrics`
null → "—" in the three metric cells. District/Health filters, Health column, checkboxes and bulk bar stay hidden.

**Merchant detail `/merchants/:id` — frame `33:4851`** (8.1 page; additions; `GET /admin/tenants/{tenant}/metrics`):
| Widget (frame) | Data |
|---|---|
| Stat/MRR `33:5043` | `mrr_amount`, caption "{Plan} · {monthly/yearly}" or "Comp · not billed" / "Trial" / "Free" |
| Stat/Orders · 30d `33:5047` | `orders_30d`, caption "↑/↓ {pct}% vs previous 30 days" |
| Stat/GMV · 30d `33:5051` | `gmv_30d_amount`, caption "AOV {aov_30d_amount}" |
| Stat/Lifetime paid `33:5055` | 8.1 (unchanged) |
| Stat/Health score `33:5059` | hidden (Q105); the quick-stats row becomes 4 columns |
| GMV chart `33:5128` "GMV & platform revenue" (values `33:5135`, chart `33:5145`) | "GMV this month" `gmv_month_amount`, "Paid to Storeplix (12 mo)" `paid_12m_amount`, "Avg orders / day" `avg_orders_per_day_30d`; 12 bars `monthly` (current month highlighted, Figma `33:5179`); pill `33:5129` = GMV 30d % vs previous 30 d. Placed in the Overview tab left column after Usage, as designed |

Charts: extend `packages/ui` `Charts.tsx` (WEB owns) with a **stacked/diverging** mode for `BarChart` (segments per
bar, negative values below the zero line) and a small `Heatmap` component; reuse `DonutMeter`, `ChartLegend`,
`niceCeil`, `thinIndexes`. Tokens only, no raw hex.

### 7.2 Merchant dashboard, storefront
No change (§Scope).

---

## 8. Appendix A — `packages/types` additions (ARCH writes them from openapi 1.10.0; additive)
`PlatformPermission` gains `'view_analytics'`; `AnalyticsRange`, `AnalyticsGranularity`, `AnalyticsMeta`,
`AnalyticsQuery`, `AnalyticsPlanRef`, `AnalyticsPlanCount`, `AnalyticsMrrPoint`, `AdminAnalyticsOverview`,
`MrrMovementBucket`, `RetentionCohort`, `RevenueByPlanRow`, `TopPayingMerchant`, `AdminRevenueReport`,
`AdminTenantMetrics`, `AdminTenantMetricsSummary`; `AdminTenantSummary` gains `last_active_at` and `metrics`;
`AdminTenantSort`. `packages/api-client` (WEB) adds `admin.analyticsOverview(q)`, `admin.revenueReport(q)`,
`admin.tenantMetrics(id)` and the new `sort` values.

---

## 9. Security checklist (Phase 8.2; numbering continues S67–S82; each has a test in §10)

| # | Threat | Control | Test |
|---|---|---|---|
| S83 | **Platform revenue seen by the wrong staff** | `view_analytics` (SA, BI, RO) | Permission dataset: SU → 403 on both analytics routes; merchant session and guest → 403/401 |
| S84 | **App role reads cross-tenant analytics** (T1) | `REVOKE ALL` from `storeplix_app` on both tables + forced RLS on `tenant_daily_metrics` | `rls` group as `storeplix_app`: `SELECT` on each table → permission denied; catalogue check lists `tenant_daily_metrics` as forced with a policy |
| S85 | **Cross-tenant SQL outside the admin domain** | Code only in `app/Domain/Admin/Analytics/**` | `RlsBypassArchTest` unchanged and green; `ResolveTenant` touch uses no `PlatformDb` |
| S86 | **Injection / expensive queries via params** | Enum + date validation, 731-day cap, bucket caps, bindings only, `statement_timeout` 15 s | Invalid range/granularity/dates → 422; `from > to` → 422; 732 days → 422 |
| S87 | **Metrics leaking to merchants** | No merchant route returns platform or other-tenant metrics; `last_active_at` not in merchant resources | Route-list test: no merchant/storefront resource contains `mrr`, `gmv_30d`, `last_active_at` keys |
| S88 | **Impersonation inflating "last active"** | Touch only on `surface = merchant` | Impersonated GET leaves `last_active_at` unchanged; merchant GET sets it once per 15 min |
| S89 | **Corrupted history from re-runs** | Stocks insert-only; flows restated in one transaction; partition and MRR assertions | Re-run a day after a plan change → stocks unchanged, flows updated; assertion failure rolls back |
| S90 | **Dev aggregate endpoint in production** | Registered only in `local`/`testing`, SA session | Production route list has no `/dev/analytics/*` |

SECURITY.md T32 gains S83–S90 (ARCH follow-up after acceptance).

---

## 10. Test requirements

### API (Pest; group `analytics`; RLS items also in `rls`, security items in `security`, budgets in `perf`)
- **`AnalyticsDefinitionsTest` (unit-ish, hand-computed fixture; sqlite and Postgres).** Fixture (as_of
  `2026-11-22`, opening day `2026-10-31`), plans as seeded:

  | Tenant | 2026-10-31 snapshot | 2026-11-22 snapshot | MRR open → close |
  |---|---|---|---|
  | A | Starter month, active, paid | same | 49 900 → 49 900 |
  | B | Starter month, active, paid | Growth **year**, active, paid | 49 900 → 124 916 (expansion 75 016) |
  | E | Starter month, active | Starter month, **past_due** | 49 900 → 49 900 |
  | F | Growth month, active | same, tenant **suspended** | 149 900 → 0 (churn) |
  | G | Starter month, active | Free (expired) | 49 900 → 0 (churn) |
  | H | — (created 2026-11-05) | Growth month, active, paid | 0 → 149 900 (new) |
  | I | Growth month, active | Starter month (scheduled downgrade applied) | 149 900 → 49 900 (contraction 100 000) |
  | J | — | trialing (Starter) | 0 → 0 |
  | K | Free | Growth month **comp** (no paid invoice on the row) | 0 → 0, `comp_tenants` 1 |

  Expected (range `custom` 2026-11-01 … 2026-11-22, granularity month): opening MRR **499 400**; closing MRR
  **424 516**; paying 5 (A, B, E, H, I); past_due 1; ARR **5 094 192**; ARPA **84 903**; new 149 900 (1); expansion
  75 016 (1); contraction 100 000 (1); churned 199 800 (2); net new **−74 884** (= 424 516 − 499 400); revenue churn
  **0.4001**; logo churn 2 / 6 = **0.3333**; active = 9 − 1 suspended = 8 = paying 5 + trialing 1 + comp 1 + free 1 (G).
- **GMV fixture** (tenant A, day 2026-11-21 Dhaka): placed `2026-11-20T18:30Z` delivered 100 000 ✓; `2026-11-21T17:59Z`
  pending 50 000 ✓; `2026-11-21T18:00Z` 70 000 → **2026-11-22**; cancelled 30 000 ✗; pending_payment 20 000 ✗;
  returned 40 000 ✓ → GMV **190 000**, orders **3**, AOV **63 333**. Restatement: cancel the pending 50 000 order on
  2026-11-23, run `analytics:aggregate` for 2026-11-23 → 2026-11-21 GMV 140 000, orders 2; a day older than 35 days is
  not restated.
- Trial → paid: trials ending in range with first paid at `trial_ends_at + 6 d` (converted), `+ 8 d` (not), during the
  trial (converted), never (not) → rate 0.5. Funnel median and `store_published`. Cohorts: two cohorts with known
  month-end snapshots → retention arrays incl. nulls before `data_starts_on`; `m3_average` weighted. LTV: 3 complete
  months churn 0.02/0.03/0.04 → lifetime 33.3 months; one null month → null; mean 0 → null; cap 60.
- Yearly MRR floors (41 583, 124 916); comp detection; suspended → 0; `source` late/nightly by run time; buckets
  (ISO weeks clipped, 12m months, previous period lengths), stocks = last day, flows = sum, missing rows → null.
- **`AnalyticsAggregateTest`**: idempotency (two runs → identical rows), stocks insert-only, `--rebuild-stocks`,
  catch-up fills gaps ≤ 7 days and refuses older, refuses an unclosed day outside local/testing, assertion failure
  rolls back the day, backfill reconstruction from invoices (trial, paid month/year, gaps → Free), refuses to
  overwrite nightly rows, the scheduler entry exists with the timezone.
- **`AdminAnalyticsTest`**: shapes vs openapi (both endpoints, all ranges, custom validation, granularity caps),
  empty DB → 200 with nulls, cache key changes after a run, `/admin/tenants` sorts and metric fields (null metrics
  for a tenant created today), `/admin/tenants/{tenant}/metrics` (404 unknown tenant), queries on `pgsql_admin`
  (assert connection name).
- **`AdminPermissionTest`** (8.1 dataset) + the new routes × roles (S83). **`LastActiveTest`** (S88, throttling).
- **`rls` group** (Postgres, app role, `TENANCY_RLS=true`): S84, `RlsCoverageTest` and `RlsEmergencyScriptTest`
  include `tenant_daily_metrics`; the aggregate command works with RLS on (admin role).
- **`perf`** (Postgres only): aggregate budget (§4.1); `GET /admin/analytics/revenue?range=12m` p95 < 500 ms uncached
  with 5 000 tenants × 400 days of rows.

### Web (Vitest + Testing Library, super-admin)
Dashboard with/without `view_analytics` (8.1 layout vs analytics tiles), range tabs → query string, KPI formatting
(lakh/crore, pts, churn down = green), null/empty/loading/error states per widget, stacked + diverging bar and
heatmap rendering (null cells, negative bars), revenue page sections incl. custom range validation and compare toggle,
merchants list sort + metric columns + "—", merchant detail tiles and GMV card, nav item hidden for Support.

### QA (Playwright, `tests/e2e/specs/phase8-2.*.spec.ts`, admin seeded as in 8.1)
- `phase8-2.dashboard`: fresh merchant places orders (storefront COD) → `POST /dev/analytics/aggregate` → dashboard
  GMV and orders include them; range tabs switch; MRR/ARR tiles present; Support role sees no analytics tiles and
  gets 403 on `/admin/analytics/overview`.
- `phase8-2.revenue`: a fresh merchant pays a Starter (or Growth, so it reliably makes the top 10 on a busy dev DB) invoice on the fake billing gateway → aggregate → revenue report
  shows the shop in Top paying merchants and MRR ≥ ৳499; custom range and compare toggle; empty-state check on a range
  before `data_starts_on`.
- `phase8-2.merchant-metrics`: merchants list sort "MRR · high to low", metric columns, Last active updates after the
  merchant signs in; merchant detail tiles and GMV card.
- `phase8-2.visual`: 1280 px and 1024 px screenshots of `/`, `/revenue`, `/merchants`, `/merchants/:id`.

---

## 11. Configuration
§4.4 env keys (all with defaults; `.env.example` gains them). Scheduler: `analytics:aggregate` hourly at :20 Dhaka.
RUNBOOK §12 (QA): first backfill, re-running a day, reading `source`, what to do when the catch-up logs
`analytics.aggregate_failed`.

---

## 12. File ownership for Phase 8.2

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: migrations §5, `app/Domain/Admin/Analytics/**` (new), `PlatformPermission`/`PlatformRole` (`view_analytics`), `ResolveTenant` touch (P82-16), `TenantDirectory`/`AdminPresenter` (summary fields, sorts), `RlsTables`, emergency SQL script, routes, schedule, `.env.example`, config, e2e seeder hooks |
| **WEB** | `apps/super-admin/**` (§7.1), `packages/api-client/**` (analytics methods, sorts), `packages/ui/**` (stacked/diverging `BarChart`, `Heatmap`) |
| **QA** | `tests/e2e/**` (`phase8-2.*`), `.github/**` (Pest group `analytics` in sqlite/Postgres/`api-rls` jobs), `docs/development/TESTING.md`, `docs/reviews/phase-8-2-qa.md`, `docs/deployment/RUNBOOK.md` §12 |
| **ARCH** | This file, `openapi.yaml` 1.10.0, `packages/types` (§8, authorized for this task), ADR 0016, OPEN-QUESTIONS Q103–Q112, roadmap; after acceptance: DATABASE-DESIGN, MULTI-TENANCY §9.5 (B27–B29), SECURITY T32 (S83–S90), FIGMA-INDEX 8.2 rows |

The merchant dashboard and storefront have no owner in this phase (no change).

---

## 13. Order of work
1. **ARCH:** this contract, openapi 1.10.0, types, ADR 0016; PO reviews §1.1.
2. **API:** migrations → aggregator (definitions + fixture tests first) → commands + schedule → endpoints →
   summary fields/sorts → `last_active_at` → dev endpoint and e2e hooks → backfill.
3. **WEB:** first make `super-admin` typecheck again after the additive types (two known breaks:
   `src/lib/permissions.ts` needs a `view_analytics` label "View analytics", and the `src/test/utils.tsx` tenant
   fixture needs `last_active_at` and `metrics`); then against mocks from the types: chart components → dashboard tiles → revenue page → merchants
   list/detail; then against the API.
4. **QA:** CI group wiring, `phase8-2.*` specs, RUNBOOK §12 → QA gate `docs/reviews/phase-8-2-qa.md`.

---

## 14. Acceptance criteria
1. After one night (or the dev endpoint) every analytics number equals the §3 definitions; the §10 fixtures pass to
   the paisa on sqlite and Postgres.
2. Re-running any day changes no stock value; restatement updates GMV/orders for 35 days only; the partition and
   movement identities hold for every stored day.
3. `/admin/analytics/*` needs `view_analytics` (SA, BI, RO); per-shop metrics are visible to every staff role; no
   merchant or storefront response changes (S83, S87).
4. The app role can't read either analytics table; all cross-tenant SQL is in `app/Domain/Admin/**` (S84, S85).
5. Dashboard `15:123`, Revenue reports `39:12705`, Merchants `32:5527` and Merchant detail `33:4851` show the widgets
   of §7.1 with the documented omissions, every widget with loading/empty/error states; 1024 px usable.
6. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`, groups `analytics`, `admin`, `rls`,
   `security`), `perf` budgets, Playwright `phase8-2.*` green; `npx --yes @redocly/cli@1.25.11 lint
   docs/api/openapi.yaml` passes for 1.10.0.

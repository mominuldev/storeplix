# Phase 8.7 contract: Expenses + profit after expenses (binding for ARCH, API, WEB, QA)

Status: **Accepted, 2026-11-24 (PO accepted the proposed defaults for Q167–Q182; Q183 currency lock)**. Review findings
H1–H2, M1–M8, L1–L9 folded in 2026-11-24. Branch `feat/phase-8-7-expenses` (from `feat/phase-8-6-automations`,
Phase 8.6 accepted; rebase onto `main` once 8.5, 8.6 and `chore/dev-ports` merge).
Roadmap task **8.7** "Expenses (Figma 144:41613) + profit report"; AC: **"Expenses recorded with receipts reduce net profit in Profit & loss; every changed number is traceable; the store currency locks once the store has an order or an expense"** (§16).
Tasks 8.8–8.9 are **not** in this contract (suppliers, purchase orders, POS, Inbox, fake-order guard are 8.8).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-6 contracts and
docs/api/API-CONVENTIONS.md still applies (envelope, snake_case, ULIDs, cookie sessions, `BelongsToTenant` /
`BelongsToStore`, RLS, FeatureGate, `perm:` on every tenant route, audit log, money in minor units). **PHASE-7 §6.4
(report definitions, Q86) applies in full** except where this file says **"amends PHASE-7 §6.4"** — every amended
number is listed in §7.3. Machine-readable spec: `docs/api/openapi.yaml` **v1.15.0**. ADR **0021** (new: expenses
ledger, cash-date basis in Profit & loss, private receipts). Product defaults: OPEN-QUESTIONS **Q167–Q183**.

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-7-qa.md`). No new external provider, queue or dependency.

| Area | Owner | Ships |
|---|---|---|
| **Ledger** | API | `expenses`, `expense_recurrences`; CRUD, month list + filters, month summary, "Repeat every month" generation, CSV export (§4–§6) |
| **Receipts** | API | `media.purpose = expense_receipt` on the **private** disk (images + PDF, sniffed), upload, attach/replace/remove, signed 5-minute view link, orphan prune (§5) |
| **Currency lock** | API/WEB | `region.currency` refused with 409 `currency_locked` once the store has an order or an expense; `region.currency_locked` in `StoreSettings`; Store details select disabled with a note (P87-18, §6.4) |
| **Profit & loss** | API | `ProfitReport` gains ad spend and other expenses by expense date; `profit_before_expenses_amount`; cache invalidation on expense writes (amends PHASE-7 §6.4; §7) |
| **Permission** | API | new key `expenses.manage` (amends PHASE-8-3 §2.1 catalogue; §2) |
| **Expenses UI** | WEB | Expenses `144:41614` at `/reports/expenses`, Reports tab, add/edit card, receipts, by-category, export (§10.1) |
| **Profit tab** | WEB | Ad spend + Other expenses in KPI costs, waterfall, "Each ৳ 100", per order, daily table; ad-spend insight `63:15985` (§10.2) |
| **Docs + types** | ARCH | openapi 1.15.0, `packages/types`, `packages/api-client`, ADR 0021, DATABASE-DESIGN, SECURITY T37, API-CONVENTIONS, MULTI-TENANCY, PHASE-7 §6.4 note, PHASE-8-3 §2.1, OPEN-QUESTIONS, FIGMA-INDEX, RUNBOOK, roadmap (§11) |
| **QA** | QA | Playwright `phase8-7.*`, CI Pest group `expenses`, TESTING.md, gate report (§13) |

**Out of scope** (hide, never fake): custom expense categories and category management (Q167); budgets and
"Target 25 %" (no target setting, unchanged from PHASE-7 §8.3); importing ad spend from Meta/Google ad accounts (the
"Facebook ads" tile shows the **Ads** category instead, Q178); receipt OCR / auto-fill; spreading (amortizing) rent or
salaries across days (Q169); balances per "Paid from" account (it is a label only, Q175); expense approval workflows;
supplier bills / purchase orders (8.8); gateway fees (stay "Not tracked", Q86); Profit & loss header "Schedule email"
and "Export CSV · PDF", report tabs "Money & COD" and "Products" (Q85, unchanged); multi-currency expenses; super-admin
views of expenses.

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- "Expense" = one row in `expenses` (one payment the merchant made). "Occurrence" = an expense created by a
  recurrence. "Recurrence" = a "Repeat every month" series (`expense_recurrences`).
- "Expense date" = `expenses.spent_on`, a **calendar date in the store timezone** (no time part).
- "Month" = a calendar month in the store timezone, `YYYY-MM`.
- `[S]` = store-scoped table (`BelongsToStore`, composite FK `(tenant_id, store_id) → stores`).
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**, storefront **:3010** (`chore/dev-ports`).

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§14). Before every Edit of a shared-read file, re-read it (another agent may have
  changed it).
- New dependencies: **none** (PDF sniffing uses `finfo` + the `%PDF-` magic; no PDF library).
- Never `migrate:fresh` the local dev DB; use Pest or a scratch DB. RLS items run on Postgres with `TENANCY_RLS=true`.

---

## 0. Summary and goals
Merchants record what they spend outside the order flow — ads, packaging, salaries, rent and bills, courier charges not
on an invoice, other — with an optional receipt photo or PDF, and mark rent-like costs to repeat every month. The
Expenses page shows the month's spend, ad spend share, cost per delivered order and (for those who may see profit)
profit after expenses. **Profit & loss stops ignoring these costs**: ad spend fills the "Ad spend" line Phase 7 left
empty, every other category becomes a new "Other expenses" line, and net profit, margin and profit per order are after
both. Nothing changes for a store that records no expenses (§7.3).

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P87-1 | **Six fixed, code-defined categories** (Q167): `ads` "Ads", `packaging` "Packaging", `salaries` "Salaries", `rent_bills` "Rent & bills", `courier` "Courier", `other` "Other". Stored as `expenses.category` varchar + CHECK; **no `expense_categories` table** in 8.7 (amends the DATABASE-DESIGN §6 sketch). Custom categories are deferred | Figma shows exactly these six tags; P&L needs to recognise "ads" by code; no category-management UI in Figma |
| P87-2 | **Profit & loss subtracts every expense** (Q168): `ad_spend_amount` = Σ category `ads`; new `other_expenses_amount` = Σ the other five; `total_cost_amount` and `net_profit_amount` include both. New `profit_before_expenses_amount` = the Phase 7 net profit, kept so the old figure stays visible | Figma's Expenses tile "Profit after expenses = Delivered sales − costs" and the P&L "Ad spend" step; one net profit everywhere |
| P87-3 | **Cash-date basis** (Q169): an expense counts in the P&L on its `spent_on` local date — in `summary`, `previous`, `daily[]`, `weekly[]` — with no spreading across days. Orders keep counting by `delivered_at` (Q86 unchanged) | Simple, explainable ("you paid it that day"); matches how merchants enter rent and salaries |
| P87-4 | **No period locking** (Q170): adding, editing or deleting an expense dated in the past changes that past range's P&L. The report never caches across an expense write (P87-12). Every write is audited with before/after amount and date | A ledger the merchant corrects must flow through; the audit log explains changed numbers |
| P87-5 | **Permission `expenses.manage`** (Q171; new grantable key, group "Money & data", sensitive, O ✓ A ✓ S ✗, no prerequisites) covers every expense route incl. receipts and export. `profit_after_expenses_amount` in the summary additionally needs `reports.view` **and** `costs.view` **and** plan `profit_reports` (the same gates as the profit route), else `null` (never 403). `delivered_orders_count` and `cost_per_order_amount` are visible to every `expenses.manage` holder (a count, no cost data) | Staff entering cash purchases is a real need a custom role can grant without exposing cost prices; profit stays behind its Phase 7 gates |
| P87-6 | **No plan gate on the ledger** (Q172): expenses, receipts, recurrences and export work on every plan. Profit & loss (incl. its expense lines) stays Growth-only (`profit_reports`, unchanged) | Recording spend has value on its own; profit was already the Growth feature |
| P87-7 | **Receipts reuse the media domain** (Q173): new `MediaPurpose::ExpenseReceipt` (`expense_receipt`): JPEG/PNG/WebP + `application/pdf`, ≤ 5 MB, MIME sniffed from bytes, stored on the **private disk** (`storeplix.private_disk`) at the normal `tenants/{tenant}/media/{id}/original.{ext}` path. **Image receipts are re-encoded** by `ProcessMedia` (GD re-encode of the original strips EXIF/GPS; `variants() = []` for this purpose, so no variants), status `processing → ready`; **PDFs** are kept as uploaded, status `ready` at upload. The purpose is **not a library purpose**: `MediaPurpose::libraryCases()` (every case except `ExpenseReceipt`) drives the generic `/media` routes, which never list, show, accept, delete or present a receipt (§5.4) | Existing tenant-prefixed path builder, sniffing and re-encode; receipts are financial documents and must not sit on the public CDN or keep a phone's location |
| P87-8 | Receipt **viewing** = `GET …/expenses/{expense}/receipt` → a **signed 5-minute URL** to `GET /api/v1/expense-receipts/{media}/download` (tenant from the signature, like `documents.download`); response `attachment` for PDF, `inline` for images, `nosniff`, CSP `sandbox; default-src 'none'`, `no-store`. Image still `processing` → 409 `receipt_processing`. In an impersonation session the link endpoint answers 403 **`impersonation_receipt_hidden`** (a GET, so the read-only middleware would not stop it; the controller checks `ImpersonationSession::isImpersonating`) | Same proven pattern as documents/exports; impersonators see amounts, not documents |
| P87-9 | **Repeat every month** (Q174): turning it on creates an `expense_recurrences` row whose `day_of_month` = the expense's day; next occurrence = the first such date **after today**, where a `day_of_month` the month doesn't have (29–31) becomes that month's **last day** (31 → 30 Apr, 28/29 Feb; back to 31 in months that have it); the daily generator creates each due occurrence by copying the series' **latest** occurrence (category, paid from, amount, note; never the receipt). No catch-up for back-dated starts; outage catch-up only for `next_on ≤ today`. Turning it off on any occurrence stops the series; past rows stay | Editing the latest month's amount naturally carries forward; no template the merchant can't see |
| P87-10 | **No future dates** (Q176): `2020-01-01 ≤ spent_on ≤ today` (store tz) → else 422. Recurrence covers planned rent | P&L never shows spend that hasn't happened |
| P87-11 | **Currency = store currency at write time**: `currency` is set from `stores.currency` at create (never from input; a `currency` field ≠ store currency → 422). Until 8.7 the store currency was **not** locked (`region.currency` editable; `currency_locked` documented in PHASE-2 §3, API-CONVENTIONS §3 and openapi but never implemented) and `ProfitReport` does not filter orders by currency. So the reports **do not filter expenses by currency either** — orders and expenses are summed the same way (no FX). With the lock of P87-18 (Q183) the currency can no longer change after the first order or expense, so no filter is needed | Rule 9; consistent treatment of orders and expenses; no silent drop of rows |
| P87-12 | **Report cache invalidation**: every expense write (create/update/delete/occurrence) puts a fresh **ULID token** under the store's `expenses_rev` key in `TenantCache` (new `TenantCache::forever`), **inside `DB::afterCommit`**; `ReportController` includes the token (or `'0'` when absent) in the profit cache key (sales and delivery unaffected). A non-repeating token, not a counter (`TenantCache` has no increment; a counter could repeat after cache eviction) | A merchant who adds an expense and opens P&L sees it at once (PHASE-7 P7-18 caches 120 s) |
| P87-13 | **Hard delete** (Q181) with an audit row carrying the deleted expense's snapshot; the receipt object and media row are deleted after commit. No soft delete (DATABASE-DESIGN lists none) | Keeps the table simple; audit is the trail |
| P87-14 | **CSV export** = synchronous `GET …/expenses/export?month=` → `text/csv` attachment (envelope exception like document downloads; errors stay JSON), formula-safe cells via `CsvCell`, ≤ 5,000 rows (else 422 `export_too_large`), audited `expense.exported`. Not the async `exports` pipeline (that one is `data.export`, customer phones) | Figma "Export CSV" on the page; a month of expenses is small |
| P87-15 | **Expenses page compares** (Q179): "vs {previous month}" = this month to date vs the **same day span** of the previous month when the selected month is the current month (day 1 … today's day; when the previous month is shorter, the span is clamped to its last day, e.g. 31 Mar compares with 1–28/29 Feb); full month vs full month otherwise | Avoids "−80 % vs October" on the 3rd of the month |
| P87-16 | **Navigation** (Q177): `/reports/expenses`; the Reports tab bar gains **Expenses** (last, shown with `expenses.manage`); the Profit tab links "Add expenses" from the Ad spend/Other expenses lines. The Reports nav item shows with `reports.view` **or** `expenses.manage` (`nav.ts`); `ReportsIndex` (`/reports`) redirects to the **first allowed tab** (Sales, else Expenses) instead of always Sales; Sales/Profit/Delivery routes stay gated by `can.viewReports`. A member with only `expenses.manage` lands on Expenses and sees only that tab | Figma highlights Reports in the sidebar and adds no nav entry; avoids a dead end for expenses-only members |
| P87-17 | **Ad-spend insight** (`63:15985`, Q178): shown when `previous.ad_spend_amount > 0`, `previous.revenue_amount > 0`, ad spend growth ≥ 10 % and ad spend growth > revenue growth (both vs `previous`, whole percent). Copy without the platform name. Computed client-side from `summary` + `previous` | Figma tip now has real data; we don't know the ads were Facebook |
| P87-18 | **Store currency lock** (Q183, PO 2026-11-24): once the store has **at least one order (any status) or one expense**, a `PATCH /stores/{store}/settings` whose `region.currency` differs from the current one → **409 `currency_locked`** "Your shop's currency can't be changed after the first order or expense." (the same request with the unchanged currency succeeds). `StoreSettings.region` gains `currency_locked: boolean`. Implements the long-documented PHASE-2 §3 rule and extends it to expenses | Orders and expenses are summed without FX; a later currency switch would silently mix BDT and the new currency in every report |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q167–Q183; **answered 2026-11-24**: Q167–Q182 proposed defaults accepted, Q183 currency lock)

| Q | Question | Proposed default |
|---|---|---|
| Q167 | Expense categories | Six fixed: Ads, Packaging, Salaries, Rent & bills, Courier, Other; custom categories later (P87-1) |
| Q168 | Which expenses reduce profit in Profit & loss? | All; Ads in "Ad spend", the rest in a new "Other expenses" line; Phase 7 figure kept as "Profit before expenses" (P87-2) |
| Q169 | On which day does an expense count? | Its expense date (cash basis); no spreading of rent/salaries (P87-3) |
| Q170 | Back-dated expenses change past P&L? | Yes, no period locking; every change audited (P87-4) |
| Q171 | Who can record and see expenses? | New permission "Record & see expenses" (`expenses.manage`): owner + manager by default, grantable to custom roles; profit tile also needs "Sales and delivery reports" + "See product cost & profit" + Growth. Note: anyone who can see Profit & loss sees salary/rent days in the daily rows (P87-5) |
| Q172 | Plan | Ledger on every plan; profit lines stay Growth (P87-6) |
| Q173 | Receipts | JPG/PNG/WebP/PDF ≤ 5 MB, one per expense, private storage, 5-minute view link, deleted with the expense; photos are re-encoded and location metadata removed; impersonators can't open them (P87-7, P87-8) |
| Q174 | Repeat every month | Same day each month (last day for short months), copies the latest month's values, no receipt, starts next month, stop with the toggle (P87-9) |
| Q175 | "Paid from" options (Figma shows Card, Cash, Bank, bKash) | Cash, Bank, Card, bKash, Nagad, Other; a label only, no account balances |
| Q176 | Future-dated expenses | Not allowed; use Repeat every month for planned costs (P87-10) |
| Q177 | Where does Expenses live? | `/reports/expenses`, an "Expenses" tab in Reports; Reports nav shows for expenses-only members and `/reports` opens their first allowed tab (P87-16) |
| Q178 | Figma items that need data we don't have | "Facebook ads" tile → "Ads"; "Other" bar that lumps Courier → one bar per category; ad-spend tip without "Facebook"; Target 25 %, Schedule email, P&L export stay hidden (§10) |
| Q179 | "vs last month" on Spent tile | Same day span of the previous month for the current month; full months otherwise (P87-15) |
| Q180 | Mobile layout (no mobile frames) | Below `lg` the add card moves above the list (collapsed behind "+ Add expense"); table becomes cards; 375 px usable |
| Q181 | Deleting an expense | Hard delete with audit snapshot; no recycle bin (P87-13) |
| Q182 | Later expense features | Deferred: custom categories, budgets, ad-account spend import, receipt OCR, amortization, supplier bills (8.8), gateway fee import, per-store receipt binding if multi-store ever ships |
| Q183 | Store currency can still be changed in settings; reports sum orders and expenses without currency filter | **PO: lock the store currency once the first order or expense exists** → 409 `currency_locked`; reports keep no currency filter (P87-11, P87-18) |

## 2. Permission and plan

### 2.1 Permission (amends PHASE-8-3 §2.1 catalogue: 24 grantable keys + owner-only `billing.manage`)
New case `Permission::ExpensesManage = 'expenses.manage'`, placed after `ReportsView` in catalogue/UI order, group
`money`, label **"Record & see expenses"**, description "Expenses, receipts and export", `sensitive() = true`,
`requires() = []`, grantable. `SystemRole`: Owner (all) ✓, Admin (all grantable) ✓, Staff ✗. Existing custom roles do
not gain it (no data migration). Non-delegation (P83) applies unchanged. `PermissionKey` in `packages/types` and the
Staff & roles UI pick it up from the catalogue response (no WEB change beyond fixtures). Every §8.1 route
`perm:expenses.manage`; `RoutePermissionsTest` + parity fixture gain the §8.1 rows; `PermissionCatalogueTest`
(grantable count 23 → 24, sensitive list + `expenses.manage`) and `PermissionEnforcementTest` (role matrix row) are
updated.

The profit report route is unchanged (`perm:reports.view` + `costs.view` 403 + `profit_reports` 402).

### 2.2 Plan (PHASE-7 §2.1 gains one documentation row; no new key)
| Key | Kind | Free / Starter / Growth | Checked at | Over limit |
|---|---|---|---|---|
| — (expenses ledger) | — | ✓ / ✓ / ✓ | not gated | — |
| `profit_reports` | feature | – / – / ✓ | unchanged; plus `GET …/expenses/summary` computes `profit_after_expenses_amount` only when allowed (else `null`, no 402) | — |

## 3. Categories and payment sources (code: `App\Domain\Expenses\ExpenseCategory`, `PaidFrom`)

| `category` | Label (en / bn) | Tag tone (Figma) | P&L line |
|---|---|---|---|
| `ads` | Ads / বিজ্ঞাপন | info | **Ad spend** |
| `packaging` | Packaging / প্যাকেজিং | brand | Other expenses |
| `salaries` | Salaries / বেতন | neutral | Other expenses |
| `rent_bills` | Rent & bills / ভাড়া ও বিল | warning | Other expenses |
| `courier` | Courier / কুরিয়ার | info | Other expenses (hint: "Only charges not already on courier invoices — delivery and COD fees of delivered parcels are counted automatically.") |
| `other` | Other / অন্যান্য | neutral | Other expenses |

`paid_from`: `cash` Cash · `bank` Bank · `card` Card · `bkash` bKash · `nagad` Nagad · `other` Other (Q175). Order
above = UI order. Labels are UI copy (WEB); the API returns keys only.

## 4. Data (owner API; migrations prefix `2026_12_04_`, forward-only; RLS in the create migration; tables added to `RlsTables::TENANT` (docblock count "71 after Phase 8.7") and `database/sql/rls-emergency-off.sql`)

- **expense_recurrences** (`000100`, `[S]`, created first): id · tenant_id · store_id · day_of_month smallint CHECK
  1–31 · next_on date · status varchar(8) CHECK (`active`,`stopped`) · stopped_at timestamptz null · created_by FK users
  null set null · timestamps. Index partial `(next_on) WHERE status = 'active'`; `(tenant_id, store_id, status)`.
- **expenses** (`000100`, `[S]`): id · tenant_id · store_id · category varchar(16) CHECK (6 keys) · paid_from
  varchar(8) CHECK (6 keys) · amount bigint CHECK `amount > 0 AND amount <= 1000000000` (৳ 1 crore in poisha) ·
  currency char(3) · spent_on date · note varchar(200) null · receipt_media_id char(26) null **U**, FK
  `(tenant_id, receipt_media_id) → media(tenant_id, id)` restrict · recurrence_id null, composite FK `(tenant_id, store_id, recurrence_id) → expense_recurrences (tenant_id, store_id, id)
  ON DELETE SET NULL (recurrence_id)` (raw statement on Postgres, as `2026_12_03_000100` does for its nullable composite
  FKs; plain `set null` would null `tenant_id`/`store_id` too) · created_by FK users null set null · updated_by FK users null set null · timestamps. Indexes
  `(tenant_id, store_id, spent_on desc, id desc)` (list), `(tenant_id, store_id, spent_on, category)` (reports,
  covering `amount` via INCLUDE on Postgres), unique partial `(recurrence_id, spent_on) WHERE recurrence_id IS NOT NULL`
  (generator idempotency).
- **media**: `purpose` gains `expense_receipt` (varchar(24), no CHECK — doc only); `disk` = the private disk for that
  purpose; `width`/`height` 0 for PDF. `media` is tenant-level (no `store_id`); with one store per tenant the receipt is
  bound to the tenant and to the expense that attaches it (multi-store gap noted in Q182).
- `audit_logs` action catalogue gains `expense.created|updated|deleted|exported`, `expense.recurrence_started|
  recurrence_stopped`, `expense.repeated` (actor type `system`). `meta`: `{category, amount, currency, spent_on}` and on
  update `{changes: {field: [old, new]}}` for amount/category/spent_on/paid_from.

Retention: expenses kept while the store exists (store deletion cascades); receipts deleted with their expense;
unattached receipts deleted after 24 h (`expenses:prune-receipts`, daily).

## 5. Receipts (owner API)

### 5.1 Upload
`POST /stores/{store}/expenses/receipts` (multipart `file`) → 201 `ExpenseReceipt {id, mime, size_bytes,
created_at}`. Rules (`MediaPurpose::ExpenseReceipt`):
- size ≤ 5 MB (`maxBytes`), else 422 "The file may not be larger than 5 MB.";
- MIME from bytes only: images via the existing `ImageInspector` (finfo and `getimagesize` must agree; JPEG, PNG, WebP;
  sides 100–10,000 px; ≤ 40 MP, kept: `MAX_PIXELS` unchanged because GD re-encodes the whole bitmap in memory — over it →
  422 "This photo is too large (over 40 megapixels). Take it at a lower resolution or upload a screenshot."; WEB
  downscales photos client-side first, §10.1, so phone photos of 48–50 MP never reach it); PDF when finfo says
  `application/pdf` **and** the first 5 bytes are `%PDF-` **and** `%%EOF` occurs in the last 1 KB. This is a sanity
  check, not the safety boundary: finfo reports PDF for anything starting with `%PDF-`, so safety comes from §5.3
  (attachment, `nosniff`, CSP `sandbox`, private disk, never rendered by our pages). Anything else (SVG, HTML, GIF,
  HEIC, extension tricks) → 422 "Unsupported file type. Allowed: JPG, PNG, WebP, PDF.";
- stored on `TenantStorage::privateDisk()` at `TenantStorage::path($id, 'original.{jpg|png|webp|pdf}')`;
  `extensionFor` gains `application/pdf → pdf`;
- `media` row with purpose `expense_receipt`: **images** status `processing` and `ProcessMedia` dispatched (it re-encodes
  the original on its own disk — the private one — which strips EXIF/GPS and applies orientation; `variants()` returns
  `[]` for this purpose; on failure the row becomes `failed` and the object is deleted, so attaching it → 422);
  **PDFs** status `ready`, not processed;
- limiter `expense-receipts` 20/min per user.

### 5.2 Attach, replace, remove
`receipt_id` on create/PATCH must be a `media` row of this tenant with purpose `expense_receipt` that is not attached to
another expense and was uploaded by a member of this tenant, status not `failed` → else 422 `validation_failed` on `receipt_id`. PATCH with a
different `receipt_id` or `null` detaches the old receipt and deletes it after commit. One receipt per expense.

### 5.3 View
`GET /stores/{store}/expenses/{expense}/receipt` → 200 `{url, mime, size_bytes, expires_at}`; no receipt → 404
`receipt_not_found`; image still `processing` → 409 `receipt_processing`; impersonation session → 403
`impersonation_receipt_hidden` (added to the `ReadOnlyImpersonation` docblock list of GET routes with special handling;
the expenses CSV export is listed there as "reviewed and left readable", like other export downloads). `url` = `URL::temporarySignedRoute('expense-receipts.download',
5 min, {media})` with the tenant id in the signed parameters. `GET /api/v1/expense-receipts/{media}/download`
(`signed`, `throttle:60,1,expense-receipts.download`, no session): resolves tenant from the signature, loads the media
under that tenant, requires purpose `expense_receipt`, status `ready`, an attached expense, `disk` = the private disk and
`TenantStorage::ownsPath($media->path)` (as `DocumentController::download`), else 404; streams the object with
`Content-Type` = stored sniffed MIME, `Content-Disposition: attachment` (PDF) / `inline` (images) with filename
`receipt-{spent_on}.{ext}`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`,
`Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`. Bad/expired signature → 403; unknown → 404.

### 5.4 Isolation from the generic media library
Adding an enum case would otherwise leak through every generic path, so each one changes explicitly:
- `MediaPurpose::libraryCases()` (all cases except `ExpenseReceipt`) builds the `GET /media` `filter[purpose]` regex
  **and** the default query (`whereIn('purpose', libraryCases)`), so receipts are never listed;
- `UploadMediaRequest` uses `Rule::in(libraryCases)` instead of `Rule::enum` → `POST /media` with
  `purpose=expense_receipt` → 422 (no public-disk write, no `ProcessMedia`);
- `MediaPurpose` gets explicit `ExpenseReceipt` arms in `mimes()` (+ `application/pdf`), `maxBytes()` (5 MB),
  `sideBounds()` ([100, 10000]), `variants()` (`[]`), `displayVariant()` (none; never presented) and
  `extensionFor()` (`application/pdf → pdf`) — no reliance on `default` arms;
- `MediaPolicy::view` and `::delete` return **false** for `expense_receipt`, and `MediaController::show`/`destroy` check
  the purpose before the policy and answer **404** `not_found` (no existence leak); receipts are deleted only by the
  expenses domain;
- `MediaPresenter::media/ref/url` return no URL for `expense_receipt` (they build CDN URLs regardless of disk) — the
  expenses resource uses `ExpenseReceipt {id, mime, size_bytes}` only;
- `MediaController::inUse` unaffected (receipts are never deleted through it).

## 6. Ledger behaviour (owner API; `App\Domain\Expenses\*`)

### 6.1 Create / update / delete
- Create (`ExpenseService::create`, one transaction): validate (§8.3), set `currency`, `created_by`; if
  `repeat_monthly = true` → insert a recurrence (`day_of_month` = day of `spent_on`, `next_on` per P87-9) and set
  `recurrence_id`; bump `expenses_rev`; audit `expense.created` (+ `expense.recurrence_started`).
- Update: any field; a `spent_on` that collides with another occurrence of the same recurrence (UNIQUE
  `(recurrence_id, spent_on)`) → 422 `validation_failed` on `spent_on` ("This repeating expense already has an entry on
  that day."), checked first and the unique violation mapped to the same 422, never a 500; `repeat_monthly` true on a row without an active recurrence starts one (from this row's day);
  false on a row whose recurrence is active stops it (`status = stopped`, `stopped_at`); audit with `changes`.
- Delete: hard delete; if it was the only row of an active recurrence, the recurrence is stopped; receipt removed after
  commit; audit `expense.deleted` with snapshot.

### 6.2 Recurrence generator
Command `expenses:repeat` (scheduler hourly, `withoutOverlapping`): discovery runs **cross-tenant** on the platform
connection — `ExpenseRecurrence::withoutTenancy()` with a `// cross-tenant: scheduler discovery; generation runs inside
each tenant` comment (pattern `ResumeDueRuns`, `PruneDocuments`) — selecting `active` rows with `next_on ≤ UTC date + 1
day` (the widest store-tz "today"), distinct `(tenant_id, store_id)`; then per store, inside `TenantContext::run`, it
filters `next_on ≤ today in the store tz` and dispatches `GenerateRecurringExpenses` (`TenantAware`, queue `default`,
`$timeout` 60).
Per recurrence, in a transaction with `SELECT … FOR UPDATE` on the recurrence: while `next_on ≤ today` (max 12
iterations): take the latest remaining occurrence (`max(spent_on)`, then `max(id)`); none → stop the recurrence; insert
a copy with `spent_on = next_on`, `receipt_media_id = null`, `created_by = null` (`ON CONFLICT (recurrence_id, spent_on)
DO NOTHING`); advance `next_on` by one month (clamped: day 31 → Feb 28/29, then back to 31 in March). Audit
`expense.repeated` (actor `system`); bump `expenses_rev`.

### 6.3 Month summary (`ExpenseSummary`)
For month `m` (store tz; default current month): range `[first day, min(last day, today)]`. All expenses of the store in
the range are summed (no currency filter, P87-11).
- `total_amount`, `count`; `by_category[]` = `{category, amount, count, share}` for categories with amount > 0, sorted
  by amount desc (share of total, 4 decimals); `ads_amount`, `ads_share` (null if total 0).
- `compare`: `{label_month: "YYYY-MM", total_amount, change_pct}` per P87-15 (`change_pct` null when the previous total
  is 0; whole-number percent rounded half away from zero).
- `delivered_orders_count` = orders with status `delivered` and `delivered_at` in the range (PHASE-7 §6.4 rule, same
  query as `ProfitReport`); `cost_per_order_amount` = `floor(total_amount / delivered_orders_count)`, null if 0.
- `profit_after_expenses_amount` = `ProfitReport` `summary.net_profit_amount` for the same range when the actor has
  `costs.view` and the plan has `profit_reports`; else `null`. Must equal P&L for the same range (AC 3).
- `months[]` = months that have expenses plus the current month, newest first (for the month select), ≤ 36.

### 6.4 Store currency lock (P87-18; owner API, WEB for the settings page)
- `StoreSettingsUpdater` (in the update transaction, after locking the store row `FOR UPDATE`): when
  `region.currency` is present and differs from `stores.currency`, and `orders` or `expenses` has a row for the store
  (`EXISTS`, tenant + store filtered), throw `ApiException(409, 'currency_locked', …)`. `UpdateStoreSettingsRequest`
  keeps `in:BDT,USD`; the lock is a state rule, so it lives in the updater, not in validation. Expense create takes the
  same store row lock (`FOR SHARE`) before reading `stores.currency`, so a currency change and a first expense can't
  interleave.
- `StoreSettings` resource: `region.currency_locked` = the same EXISTS check (boolean, always present).
- Code **409**, not 422: PHASE-2 §3, API-CONVENTIONS §3 (409 "state conflict" list) and openapi
  `PATCH /stores/{store}/settings` 409 already name `currency_locked`; this contract aligns with them.
- WEB (`settings/StoreDetailsPage.tsx`): when `region.currency_locked` is true the Currency select is disabled with a
  Caption "Locked after your first order or expense."; a 409 `currency_locked` from save shows the message on the field.

## 7. Profit & loss (owner API; amends PHASE-7 §6.4 "Profit & loss")

### 7.1 Definitions (new or changed text in bold)
- Expenses of a range = rows of the store with `spent_on` in `[from, to]` (local dates; `spent_on` is already local, so
  no timezone conversion). No currency filter — orders aren't filtered either (P87-11, Q183).
- `ad_spend_amount` = **Σ amount of category `ads`** (0 when none; **no longer null**).
- `other_expenses_amount` (**new**) = **Σ amount of the other five categories**.
- `total_cost_amount` = product + delivery + COD fee **+ ad spend + other expenses** (gateway fee still null, not
  added).
- `profit_before_expenses_amount` (**new**) = revenue − (product + delivery + COD fee) — the Phase 7
  `net_profit_amount`.
- `net_profit_amount` = revenue − total cost (**now after expenses**); `margin` and `profit_per_order_amount` follow it.
- `per_order` gains `ad_spend_amount` and `other_expenses_amount` (each `floor(x / delivered_orders_count)`);
  `per_order.profit_amount` follows the new net profit. `per_order` stays null when no delivered orders, **even if
  there are expenses**.
- `daily[]`: each local day's expenses by `spent_on`; a day with expenses and no delivered orders has revenue 0, a
  negative net profit and `margin` null.
- `weekly[]`: expenses by the ISO week of `spent_on` over the same 12-week window; `net_profit_amount` and `margin`
  after expenses.
- `previous` uses the same definitions for the previous period.
- `data_quality` gains `expenses_count` (rows in range) — informational, used by the UI empty hint.

### 7.2 Implementation
`ProfitReport` adds one grouped aggregate per window: `expenses` filtered by `tenant_id` **and** `store_id`,
`spent_on BETWEEN`, `GROUP BY spent_on, category` (query builder with bindings), merged into the per-day rows in PHP.
Budget unchanged (p95 < 800 ms for 366 days / 50,000 orders + 5,000 expenses; `perf` test extended).
`ReportController::respond('profit')` cache key = `reports:profit:{hash}:{expenses_rev token or '0'}` (P87-12).

### 7.3 Changed numbers (PO must notice)
For a store **with no expenses** every Phase 7 number is identical; only `ad_spend_amount` changes from `null` to `0`
and the new fields appear (`other_expenses_amount` 0, `profit_before_expenses_amount` = `net_profit_amount`).
For any range (and its `previous`, `daily`, `weekly` rows) that contains expense dates, these change:
`summary.ad_spend_amount`, `summary.total_cost_amount`, `summary.net_profit_amount`, `summary.margin`,
`summary.profit_per_order_amount`, the same five in `previous`, `per_order.profit_amount` (+ new per-order expense
fields), `weekly[].net_profit_amount`, `weekly[].margin`, `daily[].ad_spend_amount`, `daily[].total_cost_amount`,
`daily[].net_profit_amount`, `daily[].margin`. Unchanged: revenue, delivered orders, product/delivery/COD costs,
`data_quality.items_without_cost|shipments_without_fee`, Sales and Delivery reports, the dashboard home.
Back-dating (P87-4) changes closed months; the UI says so (§10.1 hint) and the audit log records it.

## 8. Merchant API (openapi 1.15.0 binding)

### 8.1 Endpoints (inside the existing `/stores/{store}` tenant group as 8.6 — `auth:sanctum` + `surface:merchant,impersonation` + `tenant`, `{store}` scoped-bound to the tenant (404 otherwise; there is no `store` middleware alias) + `throttle:merchant`; `perm:expenses.manage` on each route)
| Method | Path (`/api/v1/stores/{store}`) | Notes |
|---|---|---|
| GET | `/expenses` | `filter[month]` (`YYYY-MM`, default current), `filter[category]` (csv), `cursor`; 50 per page, `spent_on desc, id desc` → `Expense[]`, cursor `meta` |
| GET | `/expenses/summary` | `month` → `ExpenseSummary` (§6.3) |
| POST | `/expenses` | `ExpenseInput` → 201 `Expense`; limiter `expenses-write` 60/min per user; audit |
| GET | `/expenses/{expense}` | `Expense` |
| PATCH | `/expenses/{expense}` | partial `ExpenseInput` → `Expense`; audit (impersonation → 403 by the read-only middleware) |
| DELETE | `/expenses/{expense}` | 204; audit |
| POST | `/expenses/receipts` | multipart → 201 `ExpenseReceipt` (§5.1) |
| GET | `/expenses/{expense}/receipt` | `{url, mime, size_bytes, expires_at}` (§5.3) |
| GET | `/expenses/export` | `month` → `text/csv` attachment `expenses-{store-slug}-{YYYY-MM}.csv`; columns `date, category, note, paid_from, amount, currency, receipt (yes/no), repeats (yes/no)`; amount in major units with 2 decimals (CSV only); audit `expense.exported` |

Public signed route (`routes/api.php` next to `documents.download`): `GET /api/v1/expense-receipts/{media}/download`.
Routes in `routes/expenses.php`, included from `routes/api.php`. Route order: `/expenses/summary`, `/expenses/export`,
`/expenses/receipts` before `/expenses/{expense}`.

### 8.2 Shapes (summary; openapi binding)
- `Expense { id, category: ExpenseCategory, paid_from: PaidFrom, amount, currency, spent_on: "YYYY-MM-DD", note|null,
  receipt: {id, mime, size_bytes}|null, repeat_monthly: boolean (true when the recurrence is active), recurrence_id|null,
  created_by: {id, name}|null (null = generated), created_at, updated_at }`.
- `ExpenseInput { amount, category, paid_from, spent_on, note?, receipt_id?|null, repeat_monthly? }` (create: first four
  required).
- `ExpenseReceipt { id, mime, size_bytes, created_at }`.
- `ExpenseSummary { month, from, to, currency, total_amount, count, ads_amount, ads_share|null, by_category: {category,
  amount, count, share}[], compare: {label_month, total_amount, change_pct|null}, delivered_orders_count,
  cost_per_order_amount|null, profit_after_expenses_amount|null, months: string[] }`.
- `ProfitSummary` (amends PHASE-7 Appendix A): `ad_spend_amount: number` (was `number | null`), **+**
  `other_expenses_amount: number`, **+** `profit_before_expenses_amount: number`. `ProfitReport.per_order` **+**
  `ad_spend_amount: number`, `other_expenses_amount: number`. `daily[]` inherits the summary fields.
  `ProfitReport.data_quality` **+** `expenses_count: number`.

### 8.3 Validation (`StoreExpenseRequest` / `UpdateExpenseRequest`; never `$request->all()`)
`amount` integer 1–1,000,000,000; `category` in 6; `paid_from` in 6; `spent_on` date `Y-m-d`, ≥ 2020-01-01, ≤ today
(store tz); `note` string ≤ 200, trimmed, control chars rejected, null when empty; `receipt_id` per §5.2;
`repeat_monthly` boolean; `currency` optional, must equal store currency; unknown fields ignored. `filter[month]` /
`month` `YYYY-MM`, ≥ 2020-01, ≤ current month.

### 8.4 Error codes (API-CONVENTIONS §3 gains them)
`receipt_not_found` (404), `receipt_processing` (409), `currency_locked` (409, now implemented; P87-18), `impersonation_receipt_hidden` (403), `export_too_large` (422,
`details.limit`); reuse `validation_failed`, `forbidden`,
`not_found`. Limiters (API-CONVENTIONS §8): `expenses-write` 60/min per user, `expense-receipts` 20/min per user,
`expense-receipts.download` 60/min per IP.

## 9. Scheduler and ops (owner API)
`routes/console.php`: `expenses:repeat` hourly `withoutOverlapping` (§6.2); `expenses:prune-receipts` daily 03:30 UTC:
cross-tenant discovery (`Media::withoutTenancy()`, `// cross-tenant:` comment) of `expense_receipt` rows older than 24 h,
then per tenant inside `TenantContext::run`: delete the **row first** with `WHERE NOT EXISTS (SELECT 1 FROM expenses
WHERE receipt_media_id = media.id)` (the FK RESTRICT is the backstop against an attach racing the prune), and delete the
object **after commit** only when the row delete affected 1 row and `ownsPath()` holds. Expense delete/replace uses the
same order (row, then object after commit). Both commands are in the `rls` test group (run under RLS on Postgres). No
new queue or worker. RUNBOOK lists both.

## 10. Merchant dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`

`can.manageExpenses` (permission `expenses.manage`). Page without it → Forbidden state. Query keys `[tenantId, storeId,
'expenses', …]`; after any write invalidate `[tenantId, storeId, 'expenses']` and `[tenantId, storeId, 'reports',
'profit']` (prefix match; the reports keys are `[tenantId, storeId, 'reports', type, from, to]`, `queries.ts`).
Navigation (P87-16): `layout/nav.ts` Reports item `requires: viewReports || manageExpenses`; `App.tsx` `ReportsIndex`
redirects to the first allowed tab; `/reports/expenses` gated by `can.manageExpenses`.

### 10.1 Expenses `/reports/expenses` — section `144:41613`, frame `144:41614`
Reports tab bar (composed, P87-16) above the page header; no range toolbar (the page uses its month select).
| Figma element | id | Build / hidden / composed |
|---|---|---|
| Page header "Expenses" + subtitle | `144:41619` | build (copy as designed) |
| Button "Export CSV" | `144:42207` | build → `GET …/expenses/export?month=` (download) |
| Button "+ Add expense" | `144:42209` | build → focuses the Add expense card (below `lg`: expands it) |
| KPI "Spent in {Month}" + "↑ n% vs {Prev}" | `144:42212` | build (`total_amount`, `compare`; arrow/tone by sign; hidden line when `change_pct` null) |
| KPI "Facebook ads" + "n% of expenses" | `144:42224` | **composed**: title **"Ads"** (Q178), `ads_amount`, `ads_share` |
| KPI "Profit after expenses" + "Delivered sales − costs" | `144:42236` | build when `profit_after_expenses_amount` ≠ null (links to `/reports/profit?from&to`); else **hidden** and the row shows 3 tiles |
| KPI "Cost per order" + "n delivered orders" | `144:42250` | build (`cost_per_order_amount`, "—" when null) |
| Toolbar month Select | `144:42266` | build (`months[]`) |
| Chips All / Ads / Packaging / Salaries / Rent & bills | `144:42270`–`144:42278` | build; **composed** chips Courier and Other appended (all six categories); multi-select off (one chip at a time, like Figma) |
| Expenses table DATE · CATEGORY · NOTE · PAID FROM · AMOUNT | `144:42315` | build; category Tag tone per §3; note line 2 "Receipt attached" (opens the receipt via §5.3) and **composed** "Repeats monthly" caption; row click → card switches to **Edit expense** (composed: title, same fields, "Delete" ghost danger button with confirm, "Cancel") |
| Total row "n expenses this month" / "Total ৳ x" | `144:42390` | build from summary (`count`, `total_amount`; filtered view shows "n {category} expenses" and the filtered total from `by_category`) |
| Card "Add expense": Amount, Category + Paid from, Date, Note | `144:42398`–`144:42423` | build (React Hook Form + Zod; amount in taka with 2 decimals → minor units; date ≤ today; Courier option shows the §3 hint) |
| Receipt drop "Add receipt photo" / "JPG, PNG or PDF · up to 5 MB" | `144:42429` | build; copy amended to "JPG, PNG, WebP or PDF · up to 5 MB"; images whose long side > 2,560 px are downscaled in the browser (canvas → JPEG 0.85) before upload; upload on pick → chip with file name + remove; "Processing…" until the receipt is ready (409 on view) |
| "Repeat every month" + toggle | `144:42436` / `144:42440` | build (`repeat_monthly`) |
| Button "Save expense" | `144:42442` | build |
| Card "By category" + month | `144:42444` | build: one bar per category with amount > 0 (**not** Figma's lumped "Other", Q178), bar = share of the largest |
| Sidebar "Reports" active | `144:41615` | build (nav item stays Reports) |
| Back-dating hint (Caption under Date when `spent_on` is in a past month) | — | **composed**: "This changes Profit & loss for {Month}." |

States per `148:34032`: loading skeletons, empty month ("No expenses in {Month}" + "Add expense"), error with retry;
upload errors inline under the drop zone (422 message).

### 10.2 Profit & loss tab (amends PHASE-7 §8.3) — frame `60:12264`
| Figma element | id | Change |
|---|---|---|
| KPI Total costs subtitle "Product, delivery, fees and ads" | `63:15793` | build: costs now include expenses; subtitle as designed |
| Waterfall "Ad spend" step | `63:15896` | **unhidden**: real bar (`ad_spend_amount`), note "Coming with Expenses" removed |
| Waterfall "Other expenses" step | — | **composed**: after Ad spend, before Net profit (`other_expenses_amount`) |
| "Each ৳ 100" Ad spend row + segment | `63:15965` / `63:15955` | **unhidden** |
| "Each ৳ 100" Other expenses row + segment | — | **composed** (after Gateway fees) |
| Insight "Ad spend grew n% but sales grew m%…" | `63:15985` | **unhidden** under P87-17; copy: "Ad spend grew {a}% but sales grew {b}%. Review your ads before raising the budget." |
| Per order "Ad spend" row | `63:16035` | **unhidden** (`per_order.ad_spend_amount`); **composed** "Other expenses" row |
| Daily table "AD SPEND" column | `63:16061` | **unhidden**; **composed** "OTHER EXP." column after it; total row includes both |
| Zero-expense hint | — | **composed**: when `data_quality.expenses_count = 0`, Caption under the waterfall "No expenses recorded for this period — add ads, rent and salaries in Expenses." with link (shown only with `expenses.manage`) |
| "Profit before expenses" | — | **composed**: line under the Net profit KPI value "৳ x before expenses" |
| Target 25 % line, "Schedule email", "Export CSV · PDF", tabs Money & COD / Products | — | **hidden** (unchanged) |

### 10.3 Mobile (Q180)
Below `lg`: KPI tiles 2-up; the Add expense card collapses behind "+ Add expense" and opens above the list; the table
becomes cards (date · category tag · amount, note second line); By category under the list; no horizontal page scroll
at 375 px.

## 11. ARCH and types (owner ARCH)
openapi **1.15.0** (§8.1 paths incl. the CSV and signed download, schemas, error codes; `ProfitSummary` at ~L24901–24921
`ad_spend_amount` non-null + the two new fields, and the `ProfitReport` daily row schema at ~L25014–25036 likewise, plus
`per_order` and `data_quality` additions; `StoreSettings.region.currency_locked` required boolean and the existing
`PATCH /stores/{store}/settings` 409 `currency_locked` description amended to "store has orders or expenses"), `packages/types` (`ExpenseCategory`, `PaidFrom`, `Expense`, `ExpenseInput`, `ExpenseReceipt`,
`ExpenseReceiptLink`, `ExpenseSummary`, `ExpenseAuditAction`, `PermissionKey` + `expenses.manage`, `ExpenseReceiptPurpose` = `'expense_receipt'` (the library `MediaPurpose` union stays unchanged so WEB can't
pass it to `/media`, §5.4), `StoreSettings.region.currency_locked: boolean`, `ProfitSummary`/`ProfitReport` changes per §8.2 — `index.ts` ~L1353 `ad_spend_amount: number`), `packages/api-client` (`expenses.list`, `summary`,
`get`, `create`, `update`, `remove`, `uploadReceipt`, `receiptLink`, `exportUrl`/`exportCsv`), ADR 0021, DATABASE-DESIGN
(new §5.7 replacing the §6 Expenses sketch row; media purpose note), SECURITY T37 (S141–S153), API-CONVENTIONS (§3
codes, §8 limiters, CSV envelope exception), MULTI-TENANCY (signed receipt download as a tenant-from-signature path;
private-disk receipts), PHASE-7 §6.4 + Appendix A pointer to this file, PHASE-8-3 §2.1 (catalogue row), RUNBOOK (2
scheduled commands), OPEN-QUESTIONS Q167–Q182, FIGMA-INDEX (Expenses row → built/omissions), roadmap 8.7.
**Types first.**

## 12. Security checklist (S141–S153; each has a test)
- **S141** isolation: expenses, recurrences and receipts → cross-tenant and cross-store 404 (`assertTenantIsolation`,
  `assertStoreIsolation`); RLS on Postgres for both new tables; store A's expenses never enter store B's P&L or summary.
- **S142** permissions: staff and custom roles without `expenses.manage` → 403 on every §8.1 route; a custom role with
  only `expenses.manage` can use them and gets `profit_after_expenses_amount: null`; missing `reports.view` or
  `costs.view`, or Free/Starter plan → null too; impersonation → 403 `impersonation_read_only` on writes and 403
  `impersonation_receipt_hidden` on receipt links; CSV export readable (audited with the impersonation actor).
- **S143** upload sniffing: SVG, HTML, GIF, PHP, a JPEG renamed `.pdf`, a PDF renamed `.jpg` with image Content-Type,
  a file starting with `%PDF-` but without `%%EOF` in the last 1 KB, a > 5 MB file, a > 40 MP image (message text
  asserted) → 422; stored only under `tenants/{tenant}/media/{id}/` on the private disk; an uploaded JPEG with EXIF GPS
  has no EXIF after processing (bytes of the stored object checked) and the link answers 409 while `processing`.
  A `%PDF-`-prefixed HTML/JS polyglot that passes the check is served only as `attachment` with `nosniff` + CSP
  `sandbox` (asserted on the download response).
- **S144** receipt delivery: no public URL anywhere (response scan of every expense/media endpoint); signed link
  expires after 5 min; tampered signature, other tenant's media id in a valid-looking link, detached receipt → 403/404;
  headers `nosniff`, CSP `sandbox`, `attachment` for PDF, `no-store`.
- **S145** media library separation: a dataset **generated from the live route list** (every route named `media.*` plus
  any route whose controller is `MediaController`) is exercised with a receipt id / `purpose=expense_receipt`: listing
  (with and without filter) never contains it, show/destroy → 404, upload → 422, no response carries a URL to the
  receipt object; a new media route added later is covered automatically.
- **S146** receipt binding: another tenant's media id, a product image id, a `failed` receipt, a receipt already on
  another expense → 422; replaced/removed/deleted receipts are deleted from storage (row first, object after commit);
  unattached receipts pruned after 24 h; a receipt attached between discovery and delete survives the prune
  (NOT EXISTS guard + FK RESTRICT); the download refuses a media row on the public disk or outside `ownsPath`.
- **S147** input: amount ≤ 0, > 1e9, decimal or string → 422; future date, < 2020 → 422; wrong currency → 422; note
  escaped in UI and CSV; no mass assignment (`tenant_id`, `store_id`, `currency`, `created_by` in the body are ignored).
- **S148** CSV export: cells starting with `=`, `+`, `-`, `@`, tab, CR are neutralized (`CsvCell`); only that store and
  month; > 5,000 rows → 422; audited.
- **S149** recurrence idempotency: running `expenses:repeat` twice, two workers, or a retried job → one occurrence per
  (recurrence, date); stopped recurrences generate nothing; generated rows carry no receipt; frozen-clock tests in store
  tz incl. day 31 and Feb 29 and a store whose local date is ahead of UTC; a PATCH moving an occurrence onto another
  occurrence's date → 422, never 500; discovery runs cross-tenant, generation under each tenant (RLS on).
- **S150** report integrity: an expense write is visible in the next profit report response (cache keyed by the
  `expenses_rev` ULID token, written after commit; a rolled-back write leaves the token unchanged); P&L totals recomputed from fixtures in PHP equal the API (§7.1), and summary
  `profit_after_expenses_amount` equals P&L `net_profit_amount` for the same range.
- **S151** audit: create/update (with changes)/delete (with snapshot)/export/recurrence start/stop by user; generated
  occurrences by `system`.
- **S152** limiters: 61st write/min, 21st upload/min, 61st download/min → 429.
- **S153** currency lock: a store with one order (any status, incl. cancelled) or one expense → `PATCH settings` with a
  different `region.currency` → 409 `currency_locked`, currency unchanged; same currency → 200; a store with neither →
  200 and the change applies; `region.currency_locked` matches in each case; concurrent first-expense + currency change
  never leaves an expense in a currency ≠ the store's.

## 13. Test requirements
**API (Pest; group `expenses`; RLS items — incl. `expenses:repeat` and `expenses:prune-receipts` — also `rls`, security
items also `security`, P&L items also `reports`)**: every
§8.1 route (happy, validation, authz, isolation); summary maths incl. compare rule (current vs past month), ads share,
cost per order, profit gate matrix (role × plan × `reports.view`); recurrence generator (start, copy-latest, edit-carries-forward, stop,
delete-last stops, clamping, outage catch-up, idempotency); receipts (upload matrix, attach/replace/remove, link,
download headers, prune); CSV export contents and injection; Profit & loss: the Phase 7 fixture suite unchanged with
no expenses except the null expectations (`tests/Feature/Reports/ReportsTest.php` L127, L143: `ad_spend_amount` null →
0, plus the new fields), plus a fixture with expenses on order days, non-order days, outside the range,
in the previous period and in another store — recomputed in PHP for summary, previous, per_order, daily, weekly; cache
invalidation; `perf` test with 5,000 expenses; currency lock (`tests/Feature/Stores/**` settings tests extended, S153);
S141–S153.
**Web (Vitest)**: update the null-expecting fixtures and code (`src/__tests__/phase7.fixtures.ts` L257, L280;
`ProfitTab.tsx` L34 "Coming with Expenses", L268 and L285 `ad_spend_amount === null` branches); Expenses page from
fixtures (tiles incl. hidden profit tile, chips incl. Courier/Other, table + total,
add/edit/delete flows, amount ↔ minor units, receipt upload states, repeat toggle, by-category bars, back-dating hint),
Reports tabs by permission (expenses-only member: nav item visible, `/reports` → `/reports/expenses`), client-side
photo downscale (> 2,560 px), query invalidation of `[tenantId, storeId, 'reports', 'profit']`, Profit tab waterfall labels now `['Revenue', 'Product cost',
'Delivery charges', 'Courier COD fee', 'Gateway fees', 'Ad spend', 'Other expenses', 'Net profit']`, insight rule
(P87-17 boundary cases), per-order rows, daily columns, zero-expense hint.
**QA (Playwright `tests/e2e/specs/phase8-7.*.spec.ts`; stack on :8010/:5183 locally)**: first update
`tests/e2e/specs/phase7.reports.spec.ts` L279 (`ad_spend_amount: null` → 0 and the new fields). Growth owner adds an Ads expense
with a JPG receipt and a Rent expense with Repeat on → list, total, by-category and tiles update → open receipt link
(200, inline image) → Profit tab shows Ad spend and Other expenses and net profit lower by exactly their sum for the
month → edit amount → P&L follows → delete → P&L back; artisan `expenses:repeat` with the clock moved one month →
occurrence appears without receipt; PDF receipt downloads as attachment; staff can't open Expenses; custom role with
only `expenses.manage` sees Expenses but no profit tile and no Profit tab; Starter owner sees Expenses with 3 tiles;
the Courier category shows the hint "Only charges not already on courier invoices…" (§3); CSV export downloads; a
JPG with GPS EXIF uploaded and re-downloaded has no GPS; 390 px screenshots of Expenses (list, add card) and the Profit tab.
**QA infra**: CI Pest step for group `expenses` (sqlite, Postgres, RLS); e2e scheduler/clock helper reused from 8.6.

## 14. File ownership for Phase 8.7

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**` only: `app/Domain/Expenses/**` (models, categories, service, recurrence generator, summary, export, receipts, jobs, console, controllers, requests, resources, policies), `routes/expenses.php` + its include line and the signed download route in `routes/api.php`, migration `2026_12_04_000100_create_expense_tables.php`, `Media/MediaPurpose.php` (+ `ExpenseReceipt` explicit arms, `libraryCases()`, PDF), `Media/Http/Controllers/MediaController.php` (library filter, 404 for receipts) + `Media/Http/Requests/UploadMediaRequest.php` (`Rule::in(libraryCases)`), `Media/Policies/MediaPolicy.php` (receipts false), `Media/Http/Resources/MediaPresenter.php` (no URL for receipts), `Media/Jobs/ProcessMedia.php` (only if needed for `variants() = []`), `Media/TenantStorage.php` (private disk reuse), `Tenancy/Support/TenantCache.php` (+ `forever`), `Admin/Impersonation/Http/ReadOnlyImpersonation.php` (docblock list only), `Stores/**/StoreSettingsUpdater.php` + `Stores/Http/Requests/UpdateStoreSettingsRequest.php` + the `StoreSettings` resource (currency lock, `region.currency_locked`, §6.4), `tests/Feature/Stores/**` settings tests (S153), `Reports/ProfitReport.php`, `Reports/Http/ReportController.php` (cache key), `Tenancy/Authorization/Permission.php` (+ key) and `SystemRole.php` if needed, `tests/Feature/Staff/Roles/PermissionCatalogueTest.php` + `PermissionEnforcementTest.php`, `RlsTables` + `database/sql/rls-emergency-off.sql`, `AppServiceProvider` limiters, `routes/console.php` schedule lines, `tests/Feature/Expenses/**`, `tests/Unit/Expenses/**`, `tests/Feature/Reports/**` (profit additions; `ReportsTest.php` L127/L143 null → 0), RoutePermissionsTest + parity fixture rows, media tests touched by §5.4 |
| **WEB** | `apps/merchant-dashboard/**` (`src/expenses/**` new, `src/reports/ReportsPage.tsx`, `ProfitTab.tsx`, `queries.ts`, `src/lib/permissions.ts`, `App.tsx` route + `ReportsIndex` first-allowed-tab redirect, `src/layout/nav.ts` Reports `requires`, fixtures/tests incl. `src/__tests__/phase7.fixtures.ts` L257/L280 and `ProfitTab.tsx` L34/L268/L285 null branches), `src/settings/StoreDetailsPage.tsx` (Currency select locked state + 409 message, §6.4), `packages/ui/**` (only if a new shared piece is needed, e.g. file drop zone) |
| **ARCH** | `docs/**` except `docs/reviews/**` and TESTING.md; `packages/types/**`, `packages/api-client/**` |
| **QA** | `tests/e2e/**` (`phase8-7.*`; `specs/phase7.reports.spec.ts` L279 null → 0), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-7-qa.md` |

Shared-read rules: API keeps every Phase 7 `ProfitReport` field and meaning except those listed in §7.3, and keeps
`/media` shapes unchanged. WEB reuses `RangeToolbar`-free layout for Expenses and the existing chart components.
Re-read `routes/api.php`, `Permission.php`, `ProfitReport.php`, `MediaController.php` and `ProfitTab.tsx` before each Edit.

## 15. Order of work
1. ARCH: types + api-client first (§11), then openapi 1.15.0, ADR 0021, docs.
2. API: migration + RlsTables → permission key + route map → expenses CRUD + validation + audit → receipts (purpose,
   upload, attach, link, download, media exclusion, prune) → summary → recurrences + generator → ProfitReport +
   cache key → export → currency lock (§6.4) → limiters + schedule.
3. WEB: Expenses page against §8.2 fixtures → Reports tab + permission → Profit tab changes → Store details currency lock state → mobile.
4. QA: specs + CI group while the others build; gate after all are green.

## 16. Acceptance criteria
Roadmap AC: **"Expenses recorded with receipts reduce net profit in Profit & loss; every changed number is traceable; the store currency locks once the store has an order or an expense"**.
1. A member with `expenses.manage` records, edits and deletes expenses in six categories with an optional private
   receipt (image or PDF) and an optional monthly repeat; every write is audited; staff without the key get 403.
2. Profit & loss subtracts expenses by expense date: Ad spend = Ads category, Other expenses = the rest; net profit,
   margin, per order, daily and weekly follow; with no expenses every Phase 7 number is unchanged (§7.3).
3. The Expenses "Profit after expenses" tile equals P&L net profit for the same month; it is hidden without
   `costs.view` or the Growth plan.
4. Receipts are never publicly reachable, never in the media library, and open only through a 5-minute signed link
   (S143–S146).
5. Recurrences generate exactly one occurrence per month and date (S149).
6. The store currency can't change once the store has an order or an expense (409 `currency_locked`, S153); Store
   details shows the locked state.
7. Expenses `144:41614` and the Profit tab items in §10.2 match Figma with the documented omissions and composed items;
   loading/empty/error; 375 px usable.
8. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `expenses`, `reports`, `rls`,
   `security`), Playwright `phase8-7.*` and `phase7.*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml`
   passes.

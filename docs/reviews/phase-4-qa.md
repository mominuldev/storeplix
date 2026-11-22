# Phase 4 QA Review (Merchant dashboard, catalog and operations)

- Date: 2026-11-22 (+06)
- Branch: `phase-4-merchant-dashboard`. The Phase 4 work is uncommitted in the tree (API, WEB, SF, QA). All of 4.7a–c
  has landed: cookie sessions only, Bearer removed.
- Spec: `docs/development/PHASE-4-CONTRACT.md` (§7, §10, §12, §13, §15); `docs/api/openapi.yaml` 1.4.0.
- Live target: the running dev stack.
  - API :8000 (`php artisan serve`, sqlite) with one queue worker on `default,media,bulk`.
  - Storefront `http://demo.localhost:3000`, merchant :5173 (Vite proxy for `/api` and `/sanctum`), admin :5174.
  - Local env: `THROTTLE_MERCHANT_BULK_PER_HOUR=1000`.
- Second tenant: throwaway "Eve" merchants, registered through the SPA flow (`createTenant()`). One store per Eve,
  made public on `{slug}.localhost` with a test-only DB write where a check needed it. Every Eve was deleted after use.
- **Data restored.** I backed up the demo sqlite before Phase B, outside the repo. The final row counts equal the
  pre-run snapshot:
  - 1 tenant, 1 user, 1 store, 8 products, 13 variants and 13 inventories;
  - 3 categories, 5 customers, 0 notes, 11 ledger rows, 8 media;
  - 0 imports, 0 exports, 0 invitations, 2 store domains.

  **Not restored:** `audit_logs` (252 → 772; this also includes the other agents' activity during the window).

**Verdict: PASS (ship). No Critical, High or Medium findings; 6 Low.**

- Every §10 control I attacked held on the live stack. This covers cross-tenant ids in routes and payloads, IDOR,
  mass assignment, price manipulation, CSV formula and content injection, upload hardening, plan limit, CSRF,
  session handling, staff PII/cost and draft-store exposure.
- The Phase A contract gaps G1, G2, G4 and G5 are resolved (§0.1).
- All suites are green. The e2e suite is green in cookie mode, apart from load flakes that pass on re-run (§1).

## 0. QA deliverables (§13)

| Area | Change |
|---|---|
| `tests/e2e/support/api.ts` | **Cookie-only auth** (§7.4). Bearer helpers are removed.<br>• `demoSession()`: `GET /sanctum/csrf-cookie`, then `POST /api/v1/auth/login` through the merchant origin. The storage state is cached in `.auth/demo.json` and validated with `/auth/me` (`session_expires_at` must be more than 1 h away).<br>• `api()` / `apiCall()`: go through `http://localhost:5173/api/...` with the cookie jar, and send `X-XSRF-TOKEN` on writes. `omitCsrf` covers the negative tests.<br>• `createMember()`: throwaway staff or admin, via invite + accept.<br>• `createTenant()`: throwaway merchant with a store, plus `activateStorefront()`.<br>• `tinker()`, `deleteE2eTenant()`. `deleteE2eUser()` now handles users without `HasApiTokens` (4.7c). |
| `tests/e2e/support/catalog.ts` | • Run tag, PNG and CSV builders, RFC 4180 parser, formula-trigger check.<br>• `Tracker`: API cleanup that detaches images first, plus an export-row purge.<br>• `purgeRun()`: hard-deletes this run's soft-deleted rows; categories go deepest first because of the RESTRICT parent FK.<br>• Import/export pollers, storefront feed client. |
| `tests/e2e/specs/phase4.*` | 13 files, 54 tests (3 of them are the opt-in visual pass).<br>• `phase3.pages-nav-seo` gets a retry on the "New page" click.<br>• `playwright.config.ts`: `expect.timeout` 10 s. |
| `docker-compose.yml` | • Session/Sanctum env (§7.2).<br>• `VITE_API_URL` and `CORS_ALLOWED_ORIGINS` now default to **empty** (same-origin).<br>• `VITE_API_PROXY_TARGET=http://nginx:8000`.<br>• `queue-bulk` worker.<br>• `REDIS_QUEUE_RETRY_AFTER=360`, `THROTTLE_MERCHANT_BULK_PER_HOUR` passthrough. |
| `infrastructure/nginx` | • `api.conf`: the import route accepts 12m.<br>• `spa.conf`: `app.localhost` / `admin.localhost` serve the SPA and proxy `/api/` + `/sanctum/csrf-cookie` same-origin; CSP `connect-src 'self'`. |
| `.github/workflows` | • `api-perf` job (Postgres; fails on an empty group).<br>• `security` group also runs on Postgres.<br>• `e2e.yml`: cookie-only, `THROTTLE_MERCHANT_BULK_PER_HOUR=1000`, `visual` input. |
| Local `apps/api/.env` | Session env, `SANCTUM_STATEFUL_DOMAINS=localhost:5173,localhost:5174`. `CORS_ALLOWED_ORIGINS` is now empty (the SPAs are same-origin). |
| `docs/development/TESTING.md` | Phase 4 specs, cookie auth, `bulk` worker, throwaway tenants, cleanup, throttle, perf job, T-32…T-40. |

### 0.1 Phase A gaps: status

| # | Gap | Status |
|---|---|---|
| G1 | `merchant-bulk` 10/h made e2e unrepeatable | **Resolved**: `THROTTLE_MERCHANT_BULK_PER_HOUR` (config `storeplix.bulk_per_hour`). |
| G2 | 4.7a→4.7b CSRF window | **Moot**: 4.7a–c landed together; Bearer is no longer read. |
| G3 | §7.1 docker proxy target `api:8000` | Compose uses `nginx:8000`. |
| G4 | php-fpm upload limits | **Resolved**: `apps/api/Dockerfile:19-20` adds `docker/php-uploads.ini` (12M/13M). |
| G5 | `ImportSummary` rows vs products | **Resolved**: rows. A product with any error row is skipped as a whole. |
| G6 | Foreign `filters.ids` in exports | Accepted (202). The file has **0 rows**, so nothing leaks (A2). |
| G7 | Template for staff | 403 (BulkData), as assumed. |
| G8 | Local worker without `bulk` | Resolved by the orchestrator. |

## 1. Command results

| Command | Result |
|---|---|
| `php artisan test` | **PASS**: 307 tests (305 passed, 2 skipped as Postgres-only), 3 525 assertions |
| `php artisan test --group=tenancy` | **PASS**: 58 tests, 606 assertions |
| `php artisan test --group=security` | **PASS**: 135 tests (133 passed, 2 skipped as Postgres-only), 978 assertions |
| `php artisan test --group=perf` (sqlite) | **PASS**: 1 passed, 1 skipped (the Postgres concurrency test). 5 000-row import: validate + run **3.4–7.8 s** (budget 120 s). The Postgres run is CI `api-perf` |
| `vendor/bin/pint --test` | **PASS** |
| `pnpm -r typecheck` | **PASS** |
| `pnpm -r lint` | **PASS**: 0 errors, 41 warnings (ui 12, super-admin 1, merchant-dashboard 28) |
| `pnpm -r test` | **PASS**: 695 tests. merchant-dashboard 191, storefront 272, themes 125, api-client 66, ui 34, super-admin 6, config 1 |
| `cd tests/e2e && pnpm exec tsc -p .` | **PASS** |
| e2e: Phase 1–3 in cookie mode | **PASS**: 12/12 |
| e2e: full suite, one run (29.7 min) | 66 tests: **59 passed, 4 failed, 3 skipped** (`phase4.visual`, opt-in). Every failure was a timing stall on the single-threaded local stack, and all four files passed on re-run (**22/22**, see below) |
| e2e: `phase4.visual` (`E2E_VISUAL=1`) | **PASS**: 3/3. Soft checks: 0 horizontal overflow and 0 page errors on 8 screens × 3 widths |

The four full-run failures, all of which passed in isolation:
- `phase3.pages-nav-seo` "New page": the click was dropped before hydration. The spec now retries the click.
- `phase4.inventory` UI: the Stock movements list was still loading after 5 s.
- `phase4.mobile` customers: the page rendered too late.
- `phase4.security` XSS import: stuck in `importing` for 60 s, because `bulk` is served after `default`
  (revalidation jobs) on the one shared worker.

After them, `expect.timeout` was raised to 10 s and import waits to 120 s.

Per-file results during the pass (each file run alone):
- catalog 6/6, categories 3/3, inventory 4/4, import-export 4/4, customers 4/4, staff 4/4 (including one
  expected-fail, F-L1);
- dashboard 2/2, storefront 3/3, onboarding05 2/2, mobile 9/9, security 6/6, auth-cookie 4/4.

## 2. Live security checks (§10, checklist A1–A20)

| # | Check | Result |
|---|---|---|
| A1 | Eve on 40 demo routes (products, categories, inventory, customers, notes, imports incl. rows/error-report/validate/run/delete, exports), under both the demo and her own store id. Also demo list/dashboard routes | **404 on every one**, never 403 ✓. Spoofed `X-Tenant-Id` → 403 `tenant_forbidden` ✓. Demo data unchanged ✓ |
| A2 | Demo ids inside Eve's payloads: `category_ids`, `images.*.media_id`, `variants.*.image_media_id`, `variants.*.id`, `parent_id`, category `image_media_id`, adjustment `variant_id`, bulk `ids` / `category_ids` | **422 with the field path** ✓. Export `filters.ids` with demo ids → 202, but the file has **0 rows** ✓ |
| A3 | Triple composite FKs | Present, e.g. `product_variants (tenant_id, store_id, product_id) → products` ✓. Partial unique `lower(sku)` and the combination unique index exist ✓ |
| A4 | Same SKU and slug in Eve | Allowed. Eve's search returns only her product; the demo feed never has it ✓ |
| A5 | IDOR | Another product's variant id in PATCH → 422. A note under the wrong customer → 404. `inventory/{variant}` of another store → 404 ✓ |
| A6 | Mass assignment (`tenant_id`, `store_id`, `price_*`, `revision`, `published_at`, `currency`, `on_hand`, `committed`, `orders_count`, `total_spent_amount`, `last_order_at`, `source`) | All ignored. The row belongs to the demo; `revision` 1, `currency` BDT, `on_hand` = `initial_on_hand` ✓ |
| A7 | Price manipulation: −1, 1e9+1, 10.5, `"100"`, `null`, `true`, 1e21, `"1e3"`, compare ≤ price, cost < 0, weight / initial stock out of range | **422** on every one ✓. No storefront write route (POST `/storefront/products` refused) ✓. Feed key set is exact; no cost/SKU/stock ✓ |
| A8 | Stock integrity | `InventoryMovement` update → blocked (MassAssignmentException); delete → LogicException ✓. 20 parallel −1 on 10 → exactly 0, 11 ledger rows ✓. Mixed request with one negative line → 422, nothing written ✓. *Locally these requests are serialised (single-process server + sqlite); the true race proof is the Postgres Pest test in CI `api-perf`.* |
| A9 | Formula injection | Product export: `= + - @ ＝` and a leading space → every cell prefixed; BOM, CRLF, all fields quoted ✓. Error report: `=HYPERLINK(…)` → `'=HYPERLINK…` ✓. Template safe ✓. Customer export with `=` `+` `-` `＠` names and `@` areas → 0 unsafe cells ✓. TAB/CR leads are stripped on input (control chars) ✓ |
| A10 | Upload hardening (Eve), via the API | zip / gzip / OLE / pdf / xlsx magic, NUL, latin-1 → `unsupported_file`. Header only → `empty_file`. Duplicate or blank header → `validation_failed`. 51 cols → `too_many_columns`. 10 001-char cell → `cell_too_long`. 64 KB + 1 line → `line_too_long`. 5 001 rows → `too_many_rows`. 10 MB + 1 → **413 `payload_too_large`** ✓. Exactly 5 000 rows with BOM and `;` → 201 ✓. Filename sanitised ✓. A second upload while one validates is refused ✓. *Nginx 413 / `app.localhost` were not live-tested: the docker daemon was off. `nginx -t` passes.* |
| A11 | CSV content injection | `<script>`/`<img onerror>` description → text only, warning "Formatting was removed." ✓. `image_urls` pointed at a local listener → **0 hits**, warning "Photos from links aren't imported yet." ✓ |
| A12 | CSRF | Same-origin write without `X-XSRF-TOKEN` (non-browser, no `Sec-Fetch-Site`) → **419 `csrf_token_mismatch`** ✓. Cross-site Origin with the session cookie → 401 (not stateful) ✓. A forged `Sec-Fetch-Site: same-origin` with a foreign Origin → 401 ✓. CORS preflight from the storefront origin → no ACAO ✓. From the merchant origin: ACAO was still returned until I emptied the local `CORS_ALLOWED_ORIGINS` (F-L4) |
| A13 | Session security | Login regenerates the session id ✓. Cookie `sp_session` HttpOnly, SameSite=Lax, host-only ✓. No token in the login body ✓. `/auth/me` `meta.session_expires_at` = +7 days ✓. Password change → other session 401, current one 200 ✓. Logout → 204, and replaying the old cookie → 401 ✓. Non-stateful login → 400 `stateful_required`; Bearer → 401 ✓. No token key in `sessionStorage`/`localStorage` ✓. *Absolute expiry is covered by Pest (§7.5), not live.* |
| A14 | PII / exports | Staff export/import/template/delete → 403 ✓. Signed URL: no signature → 403; past `expires` → 403; tampered signature → 403 ✓. Direct `/storage/tenants/.../exports/*.csv` → 403 ✓. `customer.exported` audited ✓. `laravel.log` holds no row values after a customer import (phone and name absent) ✓. In-file duplicate phone → "Same phone as row 2." ✓ |
| A15 | Staff cost | `cost_amount` null in product, list and inventory; summary and dashboard `stock_value_cost_amount` null ✓. Cost sent by staff is ignored on PATCH and create ✓. UI hides Cost, profit, Export, Import and Delete ✓, apart from the sidebar Import link (F-L1) |
| A16 | Plan limit (Eve on Free = 100) | 3 creates at 99 → `[201, 402, 402]` ✓. Duplicate at the limit → 402 `plan_limit_reached` ✓. Import at the limit → summary `over_limit: 2`; run → 402 "room for 0 more"; with `allow_partial` → completed, both rows error ✓. Final count 100 ✓. *The parallel race is serialised locally (see A8).* |
| A17 | Draft store (T22) | Eve's draft feed → 404 ✓. With her preview token → 200, `no-store, private`, `has_products:false` ✓. Her token on the demo host → public data, `public, s-maxage=60` ✓ |
| A18 | Queue tenant isolation | The demo's import id under Eve's session (both store ids, all import routes) → 404 (A1) ✓. Imports in both tenants completed into their own store only: Eve's products never appear in demo lists or feeds, and vice versa ✓. The job-context tests are Pest `tenancy` |
| A19 | Revalidation | A new active product reached the public home in **< 5 s**, and left again on archive within 5 s (`phase4.storefront`) ✓ |
| A20 | Nginx headers / CSP | Config reviewed and `nginx -t` passes; not live (no docker daemon) |

## 3. Visual pass (Figma `2W1wMKN79hhcr1czQS63oN`; 1440 / 834 / 390)

I took 24 screenshots (8 screens × 3 widths) and compared them with frames 60:8984, 10:600, 11:589 and 139:1077
via the Figma MCP. Images are kept outside the repo.

- **Products list (60:8984):** it matches the frame in the header actions, the tabs with counts, the 4 KPI cards and
  the toolbar. The rows have the thumbnail, name, SKU · category, variants, stock with the Low line, price with
  compare-at struck through, profit with %, the status badge and the edit/••• actions.
  - The deferred items are correctly absent: SOLD column, Top seller (replaced by "Products on your plan"),
    barcode scan, More filters, Best selling sort and the Facebook bulk action.
  - Numeric columns are right-aligned, while Figma left-aligns them (F-L5, since fixed).
- **Dashboard (10:600):** greeting with "{store} · N products, M low on stock", the empty money card ("No sales yet",
  Share link, Preview shop), "—" tiles with "Starts with your first order", "Needs you today" with only Restock, the
  catalog card and the setup checklist. The deferred charts and courier/money cards are absent ✓. See F-L2 for the
  subtitle wording.
- **Mobile products (139:1077):** card list, filter chips, toggles and the tab bar with Products active all match.
  The deferred filter icon, sort, stock value and reorder banner are absent ✓.
- All screens at all widths: **no horizontal overflow and no page errors**. The tables stack under `md`.

## 4. Acceptance criteria (§15)

| # | Criterion | Status |
|---|---|---|
| 1 | Categories: 3-level tree, 4th level refused, parent delete refused, reorder, isolation | ✓ (API + UI + tenancy) |
| 2 | Products: simple and variable (2 options, 6 variants), editor with photos, duplicate, archive, delete; SKU uniqueness case-insensitive; image order and cover; staff never see cost; Free plan 402 at 100 | ✓ |
| 3 | Inventory: atomic receive/set/damage, ledger with actor and reason, never negative, badges follow the threshold | ✓ (concurrency proof: Postgres Pest in CI) |
| 4 | CSV: 5 000 rows < 2 min, dry-run changes nothing, re-import unchanged with no ledger rows, export round-trips and is formula-safe, archives and oversize rejected | ✓ |
| 5 | Customers: manual and CSV, `01556-120987` → `8801556120987`, search, notes, staff can't export/import/delete | ✓ |
| 6 | Dashboard: real numbers, empty states, loading/error states | ✓ |
| 7 | Onboarding 05: quick-add with sizes → variable, Bangla digits, checklist done, Back/Skip | ✓ |
| 8 | Storefront: real products, placeholders for a new store, change visible < 5 s, no cost/stock in the feed | ✓ |
| 9 | Mobile 390 px: every screen, no horizontal scroll, Products tab | ✓ |
| 10 | Auth: no token in storage, HttpOnly cookie, 419 without CSRF, logout → `/login`, e2e on storage state, no token after 4.7c | ✓ (super-admin login was not re-checked by QA in this pass) |
| 11 | Suites green, perf job | ✓ locally; `api-perf` and `security (postgres)` first run in CI |

## 5. Findings

**Critical:** none. **High:** none. **Medium:** none.

| # | Sev | Where | Finding | Repro / fix |
|---|---|---|---|---|
| F-L1 | Low · **fixed** | `apps/merchant-dashboard/src/layout/nav.ts:58` | The Products → **Import** child link shows for staff. The page then says "Imports are for owners and managers". §9 says bulk-data controls are hidden for staff. | Sign in as staff, open `/products`: the sidebar shows Import. Gate the child on `scope.canBulkData`. A `test.fail()` in `phase4.staff` flips when it's fixed. |
| F-L2 | Low · **fixed** | `apps/merchant-dashboard/src/pages/DashboardPage.tsx:33-34` | The greeting says "8 products, **6 low on stock**", but 6 = low (4) + out (2), and the Low stock tile next to it says 4. | Say "6 low or sold out" or use low only. |
| F-L3 | Low · open (ops) | Local stack | Under full-suite load, pages occasionally render more than 5 s late, and a `bulk` import waited more than 60 s behind `default` jobs (`php artisan serve` is a single process, sqlite, one shared worker). This caused all 4 full-run flakes. | Ops: run `queue-bulk` separately (compose does) and/or `PHP_CLI_SERVER_WORKERS=4`. The specs now allow 10 s / 120 s. |
| F-L4 | Low · **fixed** | `apps/api/config/cors.php:22`, `apps/api/.env.example:76` | The CORS default is still `http://localhost:5173,http://localhost:5174`. §7.2: empty after 4.7b. Harmless (`supports_credentials` is false and the SPAs are same-origin), but it is a needless allow-list. | Default to `''`. The local `.env` is emptied, and compose already defaults to empty. |
| F-L5 | Low · **fixed** | `apps/merchant-dashboard/src/products/ProductsPage.tsx:150-185` | The numeric columns (variants, stock, price, profit) are right-aligned; Figma 60:8984 left-aligns them. | Visual nit; align with Figma or record the deviation in FIGMA-INDEX. |
| F-L6 | Low · **fixed** | Contract §5 / `DataImportRow.row_number` | `row_number` is the **spreadsheet line** (header = 1), so data row 1 = 2. This is not stated in the contract or openapi. It's sensible (it matches what users see in Excel). | ARCH: document it in openapi `DataImportRow.row_number`. |

### Follow-up fixes (2026-11-22)

Five of the six Low findings are fixed. F-L3 is a local-stack ops note and stays open.

| # | Fix |
|---|---|
| F-L1 | `NavChild.requires: 'bulkData'` in `layout/nav.ts`. `Sidebar.tsx` hides the Import child unless `useStoreScope().canBulkData`. The `test.fail()` in `phase4.staff` is now a normal test and passes. |
| F-L2 | The greeting reports the two counts separately: "8 products, 4 low on stock, 2 out of stock". The out-of-stock part only shows when it is above 0, and the unit test is updated. |
| F-L4 | `config/cors.php` and `apps/api/.env.example` now default `CORS_ALLOWED_ORIGINS` to empty. |
| F-L5 | The cause was in the shared `packages/ui` `DataTable`, not the Products page. The desktop reset `md:text-[inherit]` compiled to a colour, so the mobile `text-right` carried over to desktop. Values now follow the column's `align` from `md` up (left by default), which matches Figma 60:8984. Inventory and Customers use the same component, so their tables change too. |
| F-L6 | `DataImportRow.row_number` in openapi now has `minimum: 2` and a description: it is the spreadsheet line, and the header is line 1. |

Re-verified: typecheck passes; lint has 0 errors; vitest passes; Pest 305 passed and 2 skipped; pint passes; and the OpenAPI
file validates (redocly). e2e: `phase4.staff` and `phase4.dashboard` passed 6/6. A desktop Products screenshot at 1440 px
shows the left-aligned values.

Notes (not findings):
- The signed export URL is a 5-minute bearer capability: anyone holding it can download (ADR 0009, by design).
- The intermittent tab stalls in F-L3 never reproduced in isolation. A targeted probe of the list searches
  (products, inventory, customers; typed and filled, 4 values) found no render loop.

## 6. Data restored

- **Demo:** row counts equal the pre-run snapshot (see the header). The leftovers from runs interrupted by the
  React agent's session reset were removed through the API and purged: 4 products, 9 soft-deleted categories,
  1 customer, 1 media item and 7 export rows with their files.
- Pages, menus, SEO and theme were restored by the Phase 3 specs.
- **Throwaway accounts:** every Eve tenant (cascade + files) and every `@e2e.storeplix.test` user and membership
  was deleted, along with the cached `.auth` states.
- **Kept:** `audit_logs` growth; `tests/e2e/.auth/demo.json` (git-ignored); the sqlite backup and screenshots
  outside the repo.

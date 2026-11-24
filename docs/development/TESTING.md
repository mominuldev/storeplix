# Testing Strategy

Owner: QA agent. Applies to every app in the monorepo. Tenant isolation is the #1 risk in a
shared-DB/shared-schema SaaS, so it has its own **required** CI gate.

## 1. Test pyramid

| Layer | Tooling | Location | Runs in CI |
|---|---|---|---|
| Unit (PHP) | PHPUnit / Pest via `php artisan test` | `apps/api/tests/Unit` | yes (sqlite) |
| Feature / HTTP (PHP) | Laravel HTTP tests, `RefreshDatabase` | `apps/api/tests/Feature` | yes (sqlite) |
| **Tenant isolation (PHP)** | Feature tests in group `tenancy` | `apps/api/tests/Feature/**` | yes, **required**, sqlite **and** Postgres |
| Migrations | `migrate:fresh --seed`, rollback, re-migrate | — | yes (Postgres 16 service) |
| Perf (Phase 4) | Pest group `perf`: 5 000-row product import validate + run < 120 s, parallel stock adjustments | `apps/api/tests/**` | yes, job `api-perf` (Postgres 16), fails when the group is empty **or anything in it is skipped** |
| **Race tests (Phase 5a)** | Fork-based Pest tests (`pcntl`): S2 oversell (stock 5, 20 parallel checkouts → 5 orders) and mixed-cart deadlock, S3 coupon usage limit, S4 same `Idempotency-Key`, S17 manual-order plan limit, Phase 4 A8/A16 | `apps/api/tests/Feature/{Commerce,Catalog}/*SecurityTest.php` | yes, `api-perf` step "race tests": one process per test, `CACHE_STORE=array`, **fails when a test skips** (they skip without pgsql + pcntl). Excluded from `security (postgres)` because they commit their data |
| Unit / component (TS) | Vitest + Testing Library | `apps/*/src/**/*.test.ts(x)`, `packages/*/src` | yes |
| Type contracts | `tsc --noEmit` against `@storeplix/types` | all TS packages | yes |
| Bundle secret scan | grep build output for `STOREFRONT_API_KEY` | `.next/static`, `dist/` | yes |
| Theme schema parity (Phase 3) | Vitest + AJV (`packages/themes`), storefront Zod (`tests/theme.test.ts`), PHP opis (`tests/Feature/Themes`) + `ThemeSchemaSyncTest` | `packages/themes/fixtures` | yes, `themes` job (also when only `packages/themes` changes) |
| **RLS (Phase 5b-1)** | Pest group `rls` (raw-SQL probes, coverage, definer functions, GUC lifecycle) + the whole `tenancy` and `security` groups, the race tests and the checkout p95 test, all with the app connected as `storeplix_app` and `TENANCY_RLS=true` | `apps/api/tests/**` | yes, job `api-rls` (Postgres 16, roles from `01-roles.sql`, migrations as `storeplix_owner`). Fails when `rls` is empty **or anything in it skips**, when a race test or the checkout p95 test doesn't run, and when a `tenant_id` table lacks forced RLS. See §2d |
| **Documents (Phase 5b-4)** | Pest group `documents` against a real Gotenberg (pinned in `docker-compose.yml`): Bangla font embedded (`pdffonts`), text round-trip (`pdftotext`, whitespace-insensitive), every kind × language with the expected pages, the queued job stores a PDF, 100 labels < 20 s. Skips without `GOTENBERG_URL` + poppler-utils | `apps/api/tests/Feature/Commerce/DocumentsGotenbergTest.php` | yes, job `api-documents` (fails when the group is empty or anything skips) |
| **Phase 7 groups** | Pest groups `billing`, `plans`, `reports` (security items also in `security`, definer function + billing RLS in `rls`, races in `race`, report p95 in `perf`) | `apps/api/tests/**` | yes: `api` (sqlite, each group must be non-empty), `api-postgres`, `api-rls` (RLS on) |
| **Phase 8.1 groups** | Pest groups `admin`, `impersonation` (security items also in `security`, RLS cases also in `rls`) | `apps/api/tests/Feature/Admin/**` | yes: `api` (sqlite, each group must be non-empty), `api-postgres`, `api-rls` (RLS on; admin reads on `pgsql_admin`) |
| **Phase 8.2 group** | Pest group `analytics` (§3 definitions fixture to the paisa, GMV/restatement fixture, aggregate/backfill idempotency, `/admin/analytics/*` shapes; RLS cases also in `rls`, S83–S90 also in `security`, the aggregate and revenue p95 budgets in `perf`) | `apps/api/tests/**` | yes: `api` (sqlite, must be non-empty), `api-postgres`, `api-rls` (RLS on, `pgsql_admin`); budgets in `api-perf` |
| **Phase 8.3 group** | Pest group `roles` (`PermissionParityTest`: every merchant tenant route × owner/admin/staff against `tests/Fixtures/permission-parity.json`, recorded on pre-8.3 code; `RoutePermissionsTest` route ↔ §3 map; catalogue, per-key enforcement dataset, roles API, N1–N9, staff/invite `role_id`, `/auth/me` permissions, backfill migration (sqlite only); RLS member-read policy in `rls`, S91–S99 also in `security`) | `apps/api/tests/Feature/Staff/Roles/**` | yes: `api` (sqlite, must be non-empty), `api-postgres`, `api-rls` (RLS on) |
| **Phase 8.4 group** | Pest group `developer-api` (API keys CRUD/validation/authz/isolation, `developers.manage`, scope non-delegation (S105), sha256-only storage + log scan (S100), identical 401s (S101); every `/api/v1/external` route: happy path, scope deny `api_key_scope_missing`, cross-tenant 404, one `scope:` per route (S103), merchant routes refuse keys / external refuse cookies (S104), 120/min per key (S111); webhooks: one emission test per §4.1 event, payload `2026-12-01`, signature vector (fixed secret/body/t → known hex) + rotation overlap (S108), retry schedule P84-9 with a frozen clock, auto-disable 72 h, prune 30 d, resend / resend-failed, SSRF refusals on save and send (S107), plan gating (S106), fake/allow-http refused in production (S112); RLS items also `rls`, security items also `security`) | `apps/api/tests/Feature/Developer/**` | yes: `api` (sqlite, must be non-empty), `api-postgres`, `api-rls` (RLS on) |
| **Phase 8.5 group** | Pest group `campaigns` (CRUD/validation/authz/isolation for every §6.1 route, storefront unsubscribe routes, state machine, one test per audience segment + exclusions, P85-3 eligibility matrix, risk classes, SMS parts against `docs/api/sms-parts-vectors.json`, renderer (prefix, bn/en footer, merge fields, unknown field 422), pipeline with the fake gateway + `array` mailer, quiet-hours pause/resume (frozen clock, store tz), cancel while sending, reap-stuck, attribution (7-day window, latest wins, cancelled excluded), overview numbers, allowances (S122), S113–S126, prune; RLS items also `rls`, security items also `security`) | `apps/api/tests/Feature/Marketing/**`, `apps/api/tests/Unit/Marketing/**` | yes: `api` (sqlite, must be non-empty), `api-postgres`, `api-rls` (RLS on) |
| **Phase 8.6 group** | Pest group `automations` (every §9.1 route: happy/validation/authz/isolation; each of the 5 recipes end to end with the fake gateway + `array` mailer (trigger → run → steps → outcomes); conditions matrix; run dedupe (S129); waits + `automations:resume-due`; quiet-hours deferral and frequency cap (frozen clock, store tz, S134); allowance shared with campaigns (8.5 usage tests extended); exit on order for carts and unfinished online orders; attribution (window, last step wins, cancelled excluded, one per order, overview counts once); cart contact + detect-abandoned; `/carts/recover` clone (S133); automation unsubscribe codes; dry run (S137); test message; reap-stuck; prune; plan downgrade (S135); S127–S140; RLS items also `rls`, security items also `security`) | `apps/api/tests/Feature/Automations/**`, `apps/api/tests/Unit/Automations/**` | yes: `api` (sqlite, must be non-empty), `api-postgres`, `api-rls` (RLS on) |
| **Phase 8.7 group** | Pest group `expenses` (every §8.1 route: happy/validation/authz/isolation; summary maths incl. the P87-15 compare rule, ads share, cost per order and the profit gate matrix (role × plan × `reports.view`); recurrence generator (start, copy-latest, edit carries forward, stop, delete-last stops, day 31 / Feb 29 clamping, outage catch-up, idempotency with a frozen clock in store tz, S149); receipts (upload/sniff matrix, EXIF stripped from stored bytes, attach/replace/remove, signed 5-min link, download headers, media-library separation from the live route list (S145), prune race (S146)); CSV export contents + formula injection (S148); Profit & loss with expenses recomputed in PHP (summary, previous, per_order, daily, weekly) and the `expenses_rev` cache token (S150); store currency lock (S153, `tests/Feature/Stores/**`); S141–S153; RLS items (incl. `expenses:repeat`, `expenses:prune-receipts`) also `rls`, security items also `security`, P&L items also `reports`, 5,000-expense p95 in `perf`) | `apps/api/tests/Feature/Expenses/**`, `apps/api/tests/Unit/Expenses/**`, `apps/api/tests/Feature/Reports/**` | yes: `api` (sqlite, must be non-empty), `api-postgres`, `api-rls` (RLS on) |
| **Phase 8.8a group** | Pest group `fraud` (every §8.1 route: happy/validation/authz/isolation; P88-4 tier vectors (0, < `min_parcels`, thresholds ±1) and SQL = PHP parity for random fixtures (S163); decision matrix (duplicate, risky × hold on/off, careful × advance on/off × gateway, `no_gateway`); hold enforcement on single + bulk confirm, external API confirm, single + bulk booking and `markReady` → 409 `order_held` (S156); check idempotency and the stale-`checking` sweep (S157); advance paid → released + confirmed once, expired → `call_first` (S158); blocklist + repeat-returner auto block once, unblock remembered (S164); storefront OTP (hashed, TTL, attempts, resend, limiters → 429, no oracle, fail-open → held `otp_unavailable`) and checkout errors `cod_unavailable` / `order_limit_reached` / `otp_required` / `otp_invalid` with phone normalisation (S159, S160); no external call (S161); check-a-number limiter + masked audit (S162); audit (S165); Free plan (S166); the updated 8.5/8.6 risk fixtures (`AudienceTest::test_risk_classes`, `EngineSafetyTest`, `AutomationsApiTest`); RLS items (incl. `fraud:resolve-stale`, `fraud:prune`) also `rls`, security items also `security`, order-flow items also `orders`) | `apps/api/tests/Feature/FraudGuard/**`, `apps/api/tests/Unit/FraudGuard/**` | yes: `api` (sqlite, must be non-empty), `api-postgres`, `api-rls` (RLS on) |
| **Phase 8.8b group** | Pest group `purchasing` (every §8.1 route: happy/validation/authz/isolation incl. cross-tenant and cross-store 404 for suppliers, POs, lines, receipts, payments and invoices (S167); state machine matrix (draft → ordered → partially_received → received / closed / cancelled, delete draft only, `invalid_state_transition`, `revision_mismatch`); receipts incl. partial, damaged, `over_receive`, Idempotency-Key replay = one receipt + one movement per line (S170), stock only through `InventoryService` with `purchase_order` references (S171); weighted-average + landed-cost vectors (null old cost, on_hand ≤ 0, rounding half up, transport − discount share, remainder to the largest line) and past order snapshots / earlier P&L unchanged (S172); totals recomputed server-side, discount ≤ subtotal + shipping, store currency (S173); payments, payment status, owed / overdue / due this week, both summaries (S174); no `expenses` rows, ProfitReport / ExpenseSummary unchanged (S175); invoice uploads sniffed, private disk, never in `/media` (S176); supplier CSV import (phone normalisation, tenant-scoped matching, formula-safe error report, S177); quick purchase; PO PDF with the fake driver; reorder suggestions from fixtures; `adjust`-only receivers see quantities only (S168); Free plan writes 402 (S169); audit + impersonation read-only (S178); `CustomerRisk` alias removed; RLS items also `rls`, security items also `security`, concurrent receipts in `race` (Postgres)) | `apps/api/tests/Feature/Purchasing/**`, `apps/api/tests/Unit/Purchasing/**` | yes: `api` (sqlite, must be non-empty), `api-postgres`, `api-rls` (RLS on) |
| **Phase 8.8c-A group** | Pest group `locations` (every PHASE-8-8C §9 part-A route: happy/validation/authz/isolation incl. cross-tenant and cross-store 404 for locations and a foreign `location_id` in adjust / PO / `filter[location_id]` → 404/422 (S179); location writes `settings.manage`, adjust with a location `inventory.adjust` (S180); `multi_warehouse` for a 2nd location + unarchive, downgrade keeps reads/adjust/archive (S181); backfill migration test on a seeded fixture: every inventory/movement/PO/receipt row has the default location, Σ on_hand per variant unchanged (S182); online isolation: storefront/cart/checkout read only the online row (S183); online-location change matrix: cancel/ship/return after make-default hit the stored row (S184); reader parity matrix (every §5.3 total reader = Σ, every online reader = online row) + the static test failing on a 1:1 `join('inventories'` outside the allow-list (S185); weighted average over total on hand, past snapshots unchanged (S186); archive rules (`location_in_use`), `location_name_taken`, `location_locked`; external inventory shape; `stock.low` per location; RLS items also `rls`, security items also `security`, the checkout-vs-online-location oversell race in `race` (Postgres)) | `apps/api/tests/Feature/Inventory/Locations*`, `apps/api/tests/**` tagged `locations` | yes: `api` (sqlite, must be non-empty), `api-postgres` (must be non-empty), `api-rls` (RLS on); the two `LocationRaceTest` races (`test_parallel_checkouts_sell_only_the_online_locations_stock`, `test_parallel_location_writes_keep_the_cap_and_one_default`) run one per process in the `api-perf` and `api-rls` race lists; the `api-perf` step "phase 8.8c-A race list complete" discovers `locations` ∩ `race` from the test files and fails when it is empty or a discovered test is missing from either list. The two backfill tests skip under RLS by design |
| E2E smoke + flows | Playwright | `tests/e2e` | manual (`e2e.yml`) until stable |

Rough ratio target: many unit tests, a solid layer of API feature tests (every endpoint has at least
happy path + validation + authz + cross-tenant case), a handful of E2E smoke flows.

## 2. Commands

```bash
# API
cd apps/api && php artisan test                      # full suite
cd apps/api && php artisan test --group=tenancy      # tenant-isolation gate only
cd apps/api && php artisan test --group=perf         # Phase 4: 5 000-row import < 120 s, stock race (Postgres; CI job api-perf)
# Phase 5a race tests: Postgres + pcntl only (they SKIP on sqlite; sqlite passing is not evidence).
#   Needs a database whose name ends in _test/_testing/_perf (raceCleanup() TRUNCATEs it): see §2d for storeplix_test.
#   DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_DATABASE=storeplix_test DB_USERNAME=storeplix DB_PASSWORD=storeplix CACHE_STORE=array \
#     php artisan test --filter='::test_concurrent_checkouts_never_oversell$'   # one process per race test (see ci.yml)
# Phase 5b-1 RLS suites (app role, TENANCY_RLS=true): see §2d.
# Phase 5b-4 documents against a real Gotenberg (needs poppler-utils: pdffonts, pdftotext, pdfinfo):
#   docker compose up -d gotenberg   # or: docker run -p 127.0.0.1:53000:3000 -e GOTENBERG_API_BASIC_AUTH_USERNAME=u -e GOTENBERG_API_BASIC_AUTH_PASSWORD=p <image from docker-compose.yml> gotenberg --api-enable-basic-auth
#   GOTENBERG_URL=http://127.0.0.1:53000 GOTENBERG_USERNAME=u GOTENBERG_PASSWORD=p php artisan test --group=documents
cd apps/api && php artisan test --group=developer-api   # Phase 8.4: API keys, external API, outbound webhooks
cd apps/api && php artisan test --group=campaigns       # Phase 8.5: SMS/email campaigns, opt-out, allowances, quiet hours
cd apps/api && php artisan test --group=automations     # Phase 8.6: automations, checkout recovery, run log
cd apps/api && php artisan test --group=expenses        # Phase 8.7: expenses, receipts, recurrences, P&L after expenses, currency lock
cd apps/api && php artisan test --group=fraud           # Phase 8.8a: fake-order guard, holds, advance, checkout OTP + rules
cd apps/api && php artisan test --group=purchasing      # Phase 8.8b: suppliers, purchase orders, receiving + cost, supplier payments
cd apps/api && php artisan test --group=locations       # Phase 8.8c-A: locations, per-location stock, online location, Receive at
cd apps/api && vendor/bin/pint --test                # code style

# JS workspace (root)
pnpm install
pnpm -r --if-present run typecheck
pnpm -r --if-present run lint
pnpm -r --if-present run test
pnpm -r --if-present run build

# Theme schema parity (Phase 3; the CI `themes` job runs exactly this)
for e in registry.json fonts.json modern-commerce fixtures; do diff -r packages/themes/$e apps/api/resources/themes/$e; done
pnpm --filter @storeplix/themes test                                  # AJV: valid fixtures pass, invalid fail at `expect`
pnpm --filter @storeplix/storefront exec vitest run tests/theme.test.ts  # Zod resolver never throws on fixtures
cd apps/api && php artisan test tests/Feature/Themes tests/Unit/SafeHrefTest.php   # opis parity + sync + upgrader

# E2E (stack must be running + seeded; see docker-compose.yml header and §2c)
cd tests/e2e && pnpm install --ignore-workspace && pnpm exec playwright install chromium && pnpm test
E2E_VISUAL=1 pnpm exec playwright test phase4.visual   # Figma visual-pass screenshots → test-results/
```

## 2b. Browser testing: Playwright only (product owner rule)
- Whenever a change needs checking in a real browser (visual check, click-through, screenshots, console errors), use
  **Playwright**: the `tests/e2e` project (`pnpm exec playwright test`) or a one-off Playwright script.
- Do **not** use the Claude in Chrome extension or the user's own Google Chrome for testing.
- Install once: `cd tests/e2e && pnpm install --ignore-workspace && pnpm exec playwright install chromium`.
- Ad-hoc check example (screenshot + console errors):
  ```bash
  cd tests/e2e && pnpm exec playwright screenshot --full-page http://demo.localhost:3010 /tmp/home.png
  ```
  For flows (login, editor, preview), write a spec under `tests/e2e/specs/` and run it with `pnpm exec playwright test <spec>`.
- Save screenshots and traces outside the repo (or under the git-ignored `tests/e2e/test-results/`).

## 2c. E2E flow specs (`tests/e2e/specs`)

| Spec | Covers |
|---|---|
| `api.health`, `merchant.login`, `storefront.home` | Phase 1 smoke |
| `phase2.auth-flows` | invite → accept (mailed link, UI form) and password reset (mailed link → new password → UI sign-in) |
| `phase2.settings-logo` | Settings → Store details logo upload → storefront header shows it |
| `phase3.theme-editor` | edit hero in the editor → iframe preview updates; public unchanged until Publish; Publish → public in < 5 s |
| `phase3.pages-nav-seo` | page create (dialog) → publish → `/pages/{slug}` (+ breadcrumb, canonical, sitemap; draft 404); main-menu item → header link; "Hide the whole shop from Google" → robots `Disallow: /` + noindex |
| `phase4.catalog` | API: simple + variable (2 options × 6 variants), type derived, SKU unique case-insensitively, money/option rules, revision 409, variant replacement (ids kept, SKU freed), stock only via the ledger, duplicate, bulk (foreign id → nothing applied). UI: editor with 2 photos → list shows it with its cover → archive / activate / duplicate |
| `phase4.categories` | 3-level tree, 4th level / self-nesting / too-deep move → 422, parent delete → 409, leaf delete detaches products, reorder (stale list, cycle); UI tree + side panel |
| `phase4.inventory` | delta / set / `expected_on_hand` 409 / all-or-nothing 422 / zero delta no row / thresholds incl. untracked / 20 parallel −1s never negative; UI Adjust → Stock movements row, low badge |
| `phase4.import-export` | template; UI upload → fix the column map → dry-run (nothing written) → error rows → error report (formula-safe) → run; same file again → all `unchanged`, no ledger rows; export formula-safe (= + - @, full-width, leading space), BOM/CRLF/quoted, round-trip columns, tampered signature refused |
| `phase4.customers` | phone normalisation, duplicates, search (01… / 8801… / digits / email / name), revision 409, notes; UI add → search by phone → detail (WhatsApp link) → note |
| `phase4.staff` | throwaway staff member: cost null everywhere and ignored on write, stock value at cost null; delete / bulk delete / import / export / template → 403; note delete rules; UI hides Export, Import, Cost, Delete |
| `phase4.dashboard` | shape, `no-store`, numbers follow the data (active-only stock); UI "—" tiles + "No sales yet" before the first order, real order KPIs after (Phase 5a), Restock task, checklist |
| `phase4.storefront` | feed: active + enabled only, exact card keys, cheapest enabled variant, on_sale, cache headers; demo home shows a new product < 5 s and drops it on archive, cards link to `/products/{slug}` (Phase 5a); a new store's feed 404 (draft) / `has_products:false` (live) → placeholders |
| `phase4.onboarding05` | new throwaway shop: quick-add with sizes (variable, stock per size) + simple (Bangla digits) → `/onboarding/delivery` (Phase 5a); checklist "Add products" done; Back / Skip |
| `phase4.mobile` | 390×844: dashboard, products, editor, categories, import, inventory, customers, onboarding 05 have no horizontal overflow (screenshots); tab bar Products active; mobile chips |
| `phase4.security` | adversarial §10: second tenant (Eve) on demo routes → 404, spoofed tenant → 403, demo ids in Eve payloads → 422, same SKU/slug allowed across tenants, mass assignment, price manipulation, CSV upload hardening (magic bytes, NUL, latin-1, 51 cols, 10 001-char cell, 64 KB line, 5 001 rows, 10 MB + 1 → 413), `<script>` description stays text |
| `phase4.auth-cookie` | no token in JS storage, HttpOnly/Lax/host-only session cookie, write without CSRF → 419, storefront origin not stateful, logout → 401 + `/login`; non-stateful login 400 `stateful_required`; Bearer → 401 |
| `phase4.visual` | (`E2E_VISUAL=1`) every Phase 4 screen at 1440 / 834 / 390 px, files named after the Figma frame they are compared with |
| `phase5.storefront-buy` | throwaway shop on `{slug}.localhost`: PLP `/c/{slug}` → price filter → PDP variant chip → Add to cart (`sp_cart` httpOnly/Lax, not in `document.cookie`) → cart coupon (bad code text, 10 % capped at ৳ 100) → checkout COD (`Place order — ৳ 1,360`) → thank-you (`sp_order`) → Track this order (number prefilled + phone; wrong phone → generic text). PDP HTML has no SKU/stock/cost. Demo store browsed read-only (key sets, robots `Disallow`, search `noindex`) |
| `phase5.merchant-orders` | dashboard UI: order appears with Pending count → Confirm → Mark packed → Mark shipped (courier, tracking code, https-only link) → Mark delivered (COD paid, customer counters) → Record refund (partially refunded, spent − refund); ledger `order_shipped`; Cancel dialog releases `committed` and `orders_count`; Returned dialog with restock stepper → `order_returned`, COD charge cancelled; bulk confirm skips invalid states; dashboard `orders` block |
| `phase5.manual-order` | Create order: WhatsApp chip, phone, address, product picker, quote total, delivery override to ৳ 0 ("set by hand"), SMS off; Free-plan throwaway at 50 orders → 402 `plan_limit_reached` + upgrade dialog while a storefront order is still accepted (P5-27) |
| `phase5.coupons-shipping` | coupon editor (percentage 15 % capped ৳ 150, total uses 1) → second checkout "This code has been fully used."; list `1 / 1` + revenue; `coupon_in_use` 409; code frozen; cancel releases the redemption; per-phone, first-order, minimum, product eligibility, auto-removal notice; zones thana → district → fallback, free delivery after discount, free-shipping coupon, area clash 422 |
| `phase5.onboarding-golive` | throwaway tenant: checklist + `launch_blocked` details → 07 "Finish setup" shows the blocker list with links → fix → 05 → 06 (defaults ৳ 70 / ৳ 130, 50 Dhaka city thanas) → 07 → publish → 08 "You're live"; Coming soon disappears < 5 s; re-publish 200 |
| `phase5.security` | §10 live: S1 tampering, S4 idempotency (replay, mismatch, missing/malformed key), S5 cross-store cart token + sha256 at rest + log scan, S6 foreign ids (Eve routes 404, payloads 422, spoofed tenant 403, bulk 422), S7 key sets (catalog, availability, cart, confirmation, track; staff cost null), S8 identical 404s + 429, S9 per-IP and per-phone limiters, S16 draft 404 / preview no-store / `store_not_live`, S10 state machine + staff 403s + refunds (partial, idempotent replay, full, over) |
| `phase5.mobile` | 390 × 844: PDP, PLP, cart, checkout, track, dashboard Orders, Create order — no horizontal overflow (screenshots); order detail is a `test.fail()` until QA F-L4 is fixed |
| `phase5b.documents` | throwaway shop, 2 confirmed orders: Invoices & labels lists them under Not printed · 2, sandboxed preview iframe shows a real order (Bangla name), Print 2 labels → popup on the signed URL (html driver) with both orders → `label_printed_at` set, Printed today · 2; S35 unsigned/tampered URL 403, `no-store` |
| `phase5b.edit-and-return` | Edit items (+1 M) in the UI → committed by the difference, totals/due re-priced, revision++, timeline "changed the items · 1 → 2"; ship + deliver; Create return → Exchange M→L → Approve → Mark received (M back on the shelf) → Create exchange order (৳ 200 difference, credit as discount, tag `exchange`, `source_order_id`, L committed). The payment link for the difference is 5b-2 |
| `phase5b.mobile` | 390 × 844: Returns list, return detail, Edit items, Invoices & labels; storefront payment result (paid, failed) and `/pay/{token}` (valid, invalid); 5b-3 Shipments list (KPIs, Needs attention, cards) and shipment detail — no horizontal overflow (screenshots) |
| `phase5b.couriers` | fake courier (5b-3): Integrations → Connect Steadfast Courier (Sandbox, keys) → Booking rules → Status updates (webhook URL + 40-char Bearer token shown once; bad keys 422 `credentials_invalid`; no secret in any read; Test → balance) → order detail **Book with Steadfast** → `ready_to_ship`, `FK…` consignment, second booking 409 `shipment_booked` → Steadfast-style webhook (Bearer) `in_transit` → `shipped` → S32 `delivered` while the courier API says `in_transit` → no effect → courier agrees → `delivered`, COD charge `succeeded` ৳ 1,060, events `webhook` → Shipments KPIs (Delivered this week, COD held); S25 wrong/no bearer 401, unknown key / provider 404, replayed event once, A's consignment on B's key ignored; poll: Sync now (`poll` event, 429 inside a minute) and Refresh (`user`); dev fake-advance end to end; bulk book 3 (Starter) → batch `completed` 3/0/0, unknown id 422 `order_ids.1`; Free plan 402 `feature_not_in_plan`; `/track` shows the courier status |
| `phase5b.online-checkout` | fake gateway (5b-2): checkout lists COD + bKash → bKash → fake page **Pay** → payment result "Paid ৳ 560", order `confirmed` + `paid` (system actor); **Fail** → "Payment didn't go through" → Try again → Pay; **Cancel** → "Pay on delivery instead" → `pending` COD, charge cancelled; API: 30-min hold, expiry → `cancelled` `payment_timeout`, stock released, retry 409 `payment_not_pending`; advance delivery charge (`advance_required` 422, ৳ 60 paid → `confirmed` `partially_paid`, no COD switch) |
| `phase5b.payment-link` | order detail → Ask for an advance (Delivery charge, bKash, 2 h, cancel if unpaid) → shopper `/pay/{token}` (no-store, noindex) → fake Pay → order `confirmed`, due −৳ 60, link `paid`, used link → "isn't valid any more"; API: one active link (409), 25 % amount, link expiry cancels the order (`payment_link_expired`) and releases stock, expired = unknown token byte for byte |
| `phase5b.refund` | bKash-paid order → Payments card Refund ৳ 200 → refund row `gateway` `succeeded`, charge/order `refunded_amount`, `partially_refunded`; over the charge balance 422; Idempotency-Key replay → same refund |
| `phase5b.payments-security` | §12 live: S22 forged `status=success` on a failed payment and unsigned/tampered/`?next=` returns (403, no redirect); S23 17-paisa amount mismatch → `failed` `amount_mismatch`, 13-paisa → failed; S24 replayed return paid once, unknown IPN key 404; S26/S38 secrets in no response, DB column or log, staff read-only; S27 no host field; S30 staff refund 403, foreign `payment_id` 422, B on A's order/payment result/token 404; S28 identical 404s, DB has no raw token, 429 |
| `phase6.domains` | fake DNS + fake Cloudflare (6.1–6.5, PHASE-6-CONTRACT §10 QA): **fresh shop** (never the demo store) on Starter; UI Connect `https://SHOP-x.localhost/` (client strip) → "Waiting for DNS", TXT `_storeplix-verify.{host}` = `sp-verify={52 chars}` + CNAME → `meta.cname_target`, no provider fields; S42 config 404 + `ask` 404 while pending → dev DNS correct → **Check now** → "Securing" (`ask` 200, config still 404) → dev provider active → Check now → "Connected" → **Make primary** (confirm copy) → `redirect_host` on both platform hosts, null on the primary → `{slug}.localhost` and `{slug}.storeplix.test` (raw Host header) **308** to `http://shop-x.localhost:3010{path}?{query}`, HEAD 308, robots/sitemap **301**, forged `?next=` keeps the target, canonical + robots `Sitemap:` on the custom host, browser lands there; `ask` 401 (no/wrong key), byte-identical 404s; taken (same + other tenant), invalid, reserved codes + inline dialog errors; S47 staff read-only (UI + 403s); S48 other tenant 404 on every route + dashboard detail; 390 px list + records; failures: wrong TXT → mismatch "We found", `age 73` → "Failed" → Check now → fresh 72 h, 3rd domain 402 `plan_limit_reached` + disabled CTA, 409 `domain_not_active` / `platform_domain_locked`; expiry (DNS missing + `age 169`) → "Disconnected", primary falls back, redirect stops; re-activate → primary → **Remove** in the UI → platform primary, platform host 200 |
| `phase7.billing` | fake platform gateway (PHASE-7-CONTRACT §11 QA; `BILLING_FAKE=true`, dev clock): **upgrade** — fresh shop → `dev clock trial_ended` (Free) → plans with yearly prices, quotes per kind, `plan_unavailable` / `plan_unchanged`, Idempotency-Key required → UI Upgrade to Starter monthly → quote dialog ৳ 499 → Pay (bKash) → fake **Pay** → "You're on Starter", invoice `SP-YYYY-NNNNNN` Paid (VAT 15 % inclusive), PDF attachment `no-store` (`%PDF` with Gotenberg, HTML with the e2e `html` driver); S61/S62 idempotent change-plan + pay, posted amount/status/period ignored, `invoice_not_open`; Starter → Growth prorated (ceil to taka, period unchanged, superseded open invoice) via fake SSLCommerz, 303 to `/settings/plan?payment=`. **failures** — UI Fail → "Payment didn't go through … haven't been charged" + Pay again; S54 Pay wrong amount → `amount_mismatch`; Cancel; S53/S59 forged/tampered/unknown returns → merchant app only (`payment_error=1`); "Pay, then time out" → pending → paid by the status query. **renewal** — Starter (paid) + active primary custom domain → `renewal_due` → banner "renews on" → Pay now (SSLCommerz) → period from the old end +1 month; `renewal_due` → `period_ended` → `past_due` (features kept, 409 `invoice_overdue`, banner 148:35383) → `grace_ended` → Free, invoice Void `unpaid`, domain `expired` `plan_limit`, platform primary, platform host 200, S66 re-check 402 `upgrade_plan [starter]`. **downgrade** — Growth (paid) → UI Switch to Starter (no charge) → "Switches to Starter on" → Keep Growth → API switch again → `period_ended` → Starter; cancel to Free scheduled |
| `phase7.billing-security` | S57 admin reads billing, 403 on change-plan / pay / scheduled-change, `can_pay` false; staff 403 on every billing read, `/features` 200; reports Sales/Delivery all roles, Profit staff 403. S56 other tenant 404 on invoice / pdf / pay / payment and on the store's three reports, spoofed tenant 403. Dev clock: staff 403, bad state 422. UI: admin read-only ("Only the shop owner can change the plan"), staff empty state |
| `phase7.limits` | P7-17: Free shop filled to 100 products (test-only row copies) → API 402 `plan_limit_reached` `upgrade_plan [starter]` → UI Save product → 402 dialog "Upgrade to Starter"; second courier 402, bulk booking `feature_not_in_plan`, profit `upgrade_plan [growth]`, domain on Free `[starter]`; Starter with 2 domains → third 402 `upgrade_plan [growth]` + "Upgrade to Growth" on the Domains page |
| `phase7.reports` | fresh store, orders through the real APIs: courier delivered (A) and returned (B, fake courier), manual delivered no-cost item + ৳ 50 refund (C), shipped (D), fake-order cancel (E), pending (F), and two test-only `placed_at` moves across the month boundary in Asia/Dhaka (G: prev-month last day 05:30 = UTC day before; H: 1st 00:15 = UTC prev month). Sales this month / last month equal an independent recomputation from the order API (counts, net sales, AOV, items/order, daily incl. the 1st, previous period, channels, inside-Dhaka share, top product units), range validation + `to` clipped; Delivery: 2 courier parcels, 50 % / 50 %, courier shares, returning[] key set; Profit: staff 403, Starter 402 + upgrade card, staff tab hidden, Growth owner recomputed revenue/cost/fees/margin, `items_without_cost` 1, notice; UI Sales total + range picker → URL `from`/`to` |
| `phase7.mobile` | 390 × 844: Plan & billing (Free + open invoice, Monthly and Yearly) and Reports Sales / Profit (Growth) / Delivery — no horizontal overflow (screenshots) |
| `phase8.admin-auth` | PHASE-8-1 §10 QA, S67–S70: seeded super admin (`PlatformStaffE2eSeeder`, fixed TOTP secret, codes computed in `support/admin.ts`) signs in through the UI (password → TOTP → Platform overview, survives reload); wrong code → "1 incorrect code · 4 attempts left"; wrong password and unknown email answer the same 422, no session before TOTP; merchant session refused on `/admin/*`, admin session refused on merchant routes; five wrong codes lock the account (generic 422 afterwards). The seeder re-runs before/after (clears the lock and the `admin-login` throttle) |
| `phase8.merchants` | Fresh shop found by owner phone, email and slug; detail with owner and tabs; extend trial +7 days (reason required); comp change to Growth now (Idempotency-Key); void an open change invoice, mark the next one paid (replay 409 `invoice_not_open`); every action on the shop audit log with `actor.type: platform_user`; merchant audit API shows the platform actor and never the staff name/email/id (S81). See QA finding P8-QA-1: no merchant UI lists these rows |
| `phase8.impersonation` | S71–S74: ticket needs a reason; link consumed once (hash cleared, reuse → "This link has expired…"); banner with shop, reason, Read-only, mm:ss; Orders and Plan & billing read; create action disabled (`data-read-only`); store-details save → 403 `impersonation_read_only` → toast; Exit → "Impersonation ended"; revoke from admin ends a second session at its next request; start/end audited on the shop |
| `phase8.suspension` | S80: suspend needs `reason_code` + reason, double suspend 409; merchant API 403 `tenant_suspended` and the "Your shop is suspended" screen; storefront platform host → bare 503 page (`Retry-After: 86400`, `no-store`, `noindex`, no shop name) on every route, config `{availability: suspended}`, cart 404 `store_not_found`; reactivate → storefront 200 (≤ 15 s proxy TTL), COD checkout works, dashboard back; both on the audit log |
| `phase8.team` | P8-16, S79: invite a Billing staff member (duplicate 422) → mailed `/accept-invite#token=` link → name + password → TOTP enrolment from the setup key → 10 recovery codes → Platform overview; signed in as Billing: Change plan visible, Suspend and Impersonate hidden, suspend API 403 `forbidden`; join on the platform audit log |
| `phase8-2.dashboard` | PHASE-8-2 §10 QA, P82-11/12, S83: fresh shop, three storefront COD orders, one cancelled → dev aggregate (baseline and after, same Dhaka day) → platform `gmv.amount` / `orders_count` grow by exactly the two kept orders' `total_amount`, AOV floored; ARR = 12 × MRR, partition `active = paying + trialing + comp + free`, plan mix = active, MRR = Σ by plan, 30 daily buckets; the shop's `/admin/tenants/{id}/metrics` = 2 orders, its GMV, 0 MRR (trialing). UI: KPI tiles (Merchant GMV + "{n} orders", MRR + ARR, Active shops caption, Trial → paid, Revenue churn), MRR chart, Plan mix, "Data as of", no Integration health / Export / Pro; range tabs → `?range=quarter|12m|30d` with the matching numbers. Support: 403 `forbidden` on both analytics routes, no analytics tiles or "Revenue reports" nav, per-shop metrics 200; Read-only 200; merchant 401/403, guest 401 |
| `phase8-2.revenue` | P82-7/8/9/13/14/15: baseline aggregate → fresh published shop → `dev clock trial_ended` → pays **Growth monthly** on the fake gateway → aggregate → MRR +149 900, paying +1, ARPA = ⌊MRR / paying⌋, Growth row +1 shop/+MRR, by-plan rows Growth, Starter, Free summing to MRR, funnel signed up/published/trial ended/converted +1 each, trial → paid ended/converted +1, movement identities per bucket; Top paying merchants row (growth, month, bkash, MRR, customer since today, lifetime paid = invoice total), current-month cohort. UI: KPIs, sections, top-merchant row (+ click → detail); custom range (`?range=custom&from&to`) and compare toggle ("vs …" shown/hidden; the previous period's last day is aggregated first); a range before `data_starts_on` → null KPIs/movement, "History starts" note, "—" |
| `phase8-2.merchant-metrics` | §6.1/§6.2, P82-16: fresh shop pays Starter monthly, two COD orders → aggregate → `AdminTenantMetrics` (MRR 49 900, not comp, orders 2, GMV, AOV, month GMV, 0.1 orders/day, paid 12 mo, 12 monthly bars), unknown tenant 404; list `metrics` and `meta.metrics_as_of`; sorts `-mrr`, `-gmv_30d`, `-orders_30d`, `-last_active_at` ordered with nulls last. UI: Sort "MRR · high to low" → `sort=-mrr`, MRR / Orders 30d / GMV 30d / Last active cells; Last active "—" after a test-only reset, set after the merchant signs in (API timestamp now ± 1 min, relative time in the cell); detail tiles MRR "Starter · monthly", Orders · 30d, GMV · 30d + AOV, Lifetime paid, no Health score, "GMV & platform revenue" card values |
| `phase8-2.visual` | Acceptance 5: `/`, `/?range=12m`, `/revenue`, `/merchants?sort=-mrr`, `/merchants/:id` (demo shop) at 1280 and 1024 px: widgets rendered (no skeletons), no horizontal page overflow, no console errors; screenshots in `test-results/admin-visual-8-2/{width}/` (or `$ADMIN_VISUAL_DIR/8-2`) |
| `phase8-3.roles` | PHASE-8-3 §10 QA, AC 3/5, S97: fresh Growth shop; owner creates "Order staff" in `/staff/roles/new` (prerequisite auto-tick, `billing.manage` disabled) → invites a member with it in the invite modal (3 radios, no warehouse / per-person permissions) → accepts via the mailed link; API: 200 on orders/shipments/base, 403 `forbidden` on customers/reports/staff/roles/audit/subscription/settings/product create, cost null; UI: nav shows Orders/Shipments, hides Customers/Reports/Staff/Import, no Cost field, deep links `/customers`, `/reports/*` → no-access, `/staff*` → "You can’t manage staff", **no 403 from the SPA itself**; owner adds `customers.view` in the editor → member's API 200 at once and, after a tab `visibilitychange` (focus refetch of `/auth/me`), the Customers nav appears in place; row menu "Change role" → Staff → back; audit rows |
| `phase8-3.delegation` | N1–N7, S92–S95, S99: a member whose custom role holds only `staff.manage` gets 403 `permission_not_held` on granting `costs.view`, inviting Manager/Staff (also legacy `role: admin`), promoting, demoting/removing a Manager, revoking/resending a Manager invitation, editing/deleting a bigger custom role, deleting with `reassign_to` Manager/Staff; `cannot_edit_own_role` / `cannot_change_own_role`; owner role → 422; system roles 409 `system_role_locked` (owner too); unknown / owner-only keys and "manager" name → 422. UI: invite modal and role picker disable Manager/Staff ("Has permissions you don’t have"), no actions on a Manager row or invitation, own row "Leave shop" only, own role page read-only, toggles not held disabled |
| `phase8-3.plan` | P83-8, N9, S98: Free shop → `/roles` system only, `custom_roles_enabled: false`, POST 402 `feature_not_in_plan` (`upgrade_plan: [growth]`); "+ Custom role" opens the upgrade dialog, `/staff/roles/new` shows the upgrade panel, invite modal lists 2 roles, matrix read-only. Growth → Free downgrade: the custom-role member keeps exactly `P(role)` (no escalation to Staff), create/edit/assign/invite → 402, delete without `reassign_to` → 409 `role_in_use`; UI read-only with the Growth note, delete with "Move people to" Staff → 204 and the member is Staff |
| `phase8-3.editor` | P83-9/10, §7.2–7.3, S96: delete in use → 409 with member + invitation ids; `reassign_to` self/owner/foreign/unknown → 422; foreign `role_id` → 422; another tenant's role 404 on GET/PATCH/DELETE; role detail revision conflict → 409 toast, latest loaded, nothing overwritten; matrix stage/Discard, prerequisite auto-tick, conflict toast, clean save revision + 1; Duplicate role → "{name} copy" with the same toggles; delete with "Move people to" the copy moves the member **and** the open invitation, `role.deleted` audit meta; 21st custom role → 409 `role_limit_reached` |
| `phase8-3.visual` | AC 5 / Q125: `/staff`, invite modal, `/staff/roles/:id`, `/staff/roles/new` at 1280, 390 and 375 px: no horizontal page overflow, no console errors, screenshots in `test-results/phase8-3-visual/{width}/`; member no-access page + mobile More at 390 px; **matrix checkbox reachable at 390/375 px** (fails until QA P83-QA-1 is fixed) |
| `phase8-4.api-keys` | PHASE-8-4 §10 QA, §3, S100–S104: fresh Growth shop + one storefront order. UI "+ Create API key" (name, "Orders · read") → success step shows the `sp_live_…` key once with Copy + "I’ve stored it"; afterwards only `sp_live_••••<last4>` in the row and the list API (no `plain_key`). `GET /external/me` (key id, name, scopes, tenant, store) and orders list/detail with `Authorization: Bearer` (item keys identical to the merchant list); products and status change → 403 `api_key_scope_missing`; other tenant's store / unknown order → 404, `X-Tenant-Id` ignored; merchant route with the key → 401, external route with the session cookie → 401, malformed key 401. UI row menu Revoke → "Revoked" pill; key → 401 `invalid_api_key`, error body identical to a never-issued key; DELETE again 200 |
| `phase8-4.webhooks` | §4, P84-8, S108, AC 1 (fake driver): UI "+ Add endpoint" (fake-sink URL, `order.created`, description) → storefront order → delivery `succeeded` (attempt 1, 200, `subject_label` = order number). The request recorded by the dev sink: `X-Storeplix-Event`, `X-Storeplix-Delivery` = delivery id, `User-Agent: Storeplix-Webhooks/1.0`, JSON payload (`id` = event id, `type`, `api_version 2026-12-01`, `store_id`, `data.object.id` = order id); `X-Storeplix-Signature` `t=…,v1=…` verified **in the spec** as hex HMAC-SHA256(secret, `"<t>.<raw body>"`) with the revealed secret, `t` within 5 min; tampered body, wrong secret, altered `t` fail. Detail redacts the signature. Rotate → `previous_expires_at` ≈ +24 h → test event (`ping`) carries two `v1=`, valid for the new and the previous secret. UI Recent deliveries "order.created · <number>" + 200 |
| `phase8-4.retries` | §4.4, P84-9, AC 2: endpoint on `…/fail-503`; row menu "Send test event" (202) and a storefront order → both `retrying` (attempt 1, 503, `http_error`, next attempt +1 min ± 15 s); row "Failing since" + "% · failing"; API resend → 202 new delivery id, same event id (also in the sink body), same stored payload, original unchanged; delivery forced to `failed` by a test-only tinker write → UI "Resend failed (1)" → `{count: 1}` and a new delivery for the same event |
| `phase8-4.access` | P84-6, P84-13, S105, S106, S109: staff → 403 on all 12 developer routes incl. the dev sink and secret reveal/rotate, no `developers.manage` in `/auth/me`; UI no-access state on `/integrations/developer`, no Developer banner on `/integrations` (the owner's banner links there). Free shop: reads 200, key/endpoint create 402 `feature_not_in_plan` (`upgrade_plan` growth); UI plan note "API keys and webhooks are part of the Growth plan." + See plans → `/settings/plan`, create buttons disabled. Growth → Free: external API 402, key and endpoint kept, writes 402, a new order creates no delivery |
| `phase8-4.visual` | AC 5 / Q137: Developer page (2 keys, a healthy and a failing endpoint, deliveries) and the create-key modal at 1280, 390 and 375 px: four cards visible, no horizontal page overflow, no console errors; screenshots in `test-results/phase8-4-visual/{width}/` for the Figma review against `144:40726` |
| `phase8-5.campaigns` | AC 1 "Opt-out respected" (§14.1, S113–S116, S118): Starter shop (store tz → ~13:00 local) with A, B consenting, C a storefront order only, D no consent/no order, E merchant "Stop marketing", F email only. Customer `marketing` block per P85-3; audience preview All → 3. Composer UI: SMS · English · Send now → confirm → `sent` 3/3; dev sink has one SMS per A/B/C, each `"{shop}: "`-prefixed, last line `STOP: {host}/u/{code}`, distinct codes. A opens `/u/{code}` on `{slug}.localhost`: `no-store` + `noindex`, GET changes nothing, Unsubscribe → "You’re unsubscribed" + Subscribe again; customer `unsubscribed` (`link`), campaign `stats.unsubscribed` 1. A deleted + re-created with the same phone → still unsubscribed; merchant DELETE → 409 `suppression_customer_owned`; PATCH `accepts_marketing` → still out; E’s merchant suppression removable. Campaign 2 → B, C, E messaged, nothing to A; A’s recipient row (if kept) `skipped/opted_out`, shown on the detail page; addresses masked |
| `phase8-5.email` | P85-6/19/26, §4.2, §8.6, S115–S117, S123: email campaign to 2 customers → sink copies with subject, `https://{host}/u/{code}` link, escaped `<script>`/HTML; RFC 8058 POST `/u/{code}/one-click` → 200, email unsubscribed, SMS untouched, idempotent; page "Subscribe again" → subscribed. Unknown / malformed / other-store code → identical 404 `unsubscribe_link_invalid`, page "This link isn’t valid". "Send test to me" → one email to the owner, `is_test` code: POST 200 no change, page "This was a test message"; campaign stays draft. 21st unsubscribe request/min from one shopper IP → 429 |
| `phase8-5.schedule` | P85-15/16/17, S124 (no campaign dev clock: the store timezone is moved instead): day shop schedule 15:00 local → `scheduled` (list filter), unschedule → draft, reschedule, Cancel on the detail page → `cancelled`, cancel/edit again 409 `invalid_state_transition`; 22:30, 21:00 and tomorrow 08:30 local → 422 `campaign_quiet_hours` (`details.allowed_from`); < now+5 min, > now+90 d → 422; no `Idempotency-Key` → `idempotency_key_required`. Night shop (~02:00 local): Send now → 422 `campaign_quiet_hours`, composer shows the inline error; scheduling at 10:00 works |
| `phase8-5.access` | §2, P85-13, S120, S122: Free shop → drafts allowed, send/schedule/test 402 `plan_limit_reached` (`upgrade_plan` starter, `details.campaign_sms_per_month` / `campaign_emails_per_month` limit 0); UI plan note "Campaigns are part of the Starter plan." + See plans → `/settings/plan`, primary action and "Send test to me" disabled. Starter estimate → allowance 1 000 SMS parts / 5 000 emails, UCS-2 for Bangla. Staff → 403 on all 16 campaign routes + dev sink, no `marketing.manage` in `/auth/me`, `/marketing` falls back to Coupons, no-access state on list/composer/detail; the customer opt-out toggle (`customers.edit`) is allowed for Staff |
| `phase8-5.regressions` | Gate findings, one independent test each (fail until fixed): P85-QA-1 composer confirm dialog recipients = "N customers will get this message"; P85-QA-2 storefront Unsubscribe / Subscribe again re-render the page in place (no 404) |
| `phase8-5.visual` | AC 3 / Q151: overview, campaigns list, composer (SMS bn + email), detail and the storefront unsubscribe page at 1280, 390 and 375 px: no horizontal page overflow, no console errors, hidden 8.5 items (WhatsApp, Automations, Carts recovered, Return on spend, Top up, Best week yet) absent; screenshots in `test-results/phase8-5-visual/{width}/` for the Figma review against `66:19179` / `70:19774` |
| `phase8-6.recovery` | AC 1 + AC 2 for `checkout_recovery` (P86-11–P86-16, S132, S133): Starter shop (~13:00 local) enables the recipe with `delay_minutes` 15. Checkout page shows the phone notice; an invalid phone is not captured, a valid one is stored on the cart on blur (tinker read; never echoed by `GET /cart`); `PUT /cart/contact` 422 / 404 `cart_not_found`. Cart aged 20 min + `automations:detect-abandoned` → one run (subject cart, `waiting`, step 1 `send_message` `done`, ≤ 3 parts, masked contact); sink SMS with prefix, `{cart_link}` `/r/{code}` and the opt-out footer; a second detect adds no run. `/r/{code}` in a fresh context → `/checkout` with the product, new httpOnly `sp_cart` ≠ original, original cart still `active`; unknown code → `/`, API 404 `recovery_link_invalid`. Checkout of the restored cart by the same phone → run `stopped/converted` with the conversion order, `/stats` step 1 sent 1 / recovered 1, recovery page "Recovered · SMS". Online order expired (`payment_timeout`) → a recovery run with subject order and one message |
| `phase8-6.recipes` | AC 1 + AC 2 for the other four recipes: catalogue = 5 recipes, duplicate 409 `automation_exists`, hidden recipe keys 422. Thank-you: delivered order (manual ship creates the shipment) → run `completed`, `send_message` `done` (sms, masked) + sink SMS. Tag VIP (`min_delivered` 2, message off): 1st delivery `skipped/conditions_not_met` with detail, 2nd → `add_tag` `done`, customer tagged. Handle returns: received return → `add_tag` `done`, "Returned". Low stock: stock 8 → 4 (threshold 5) → `notify_team` `done` (`detail.recipients` ≥ 1), owner mail "Low stock" in laravel.log without shopper PII. Thank-you condition `order.total_amount gt` 10 000 000 → `skipped/conditions_not_met`, no message. Dry run → condition/step results, run count and sink unchanged. UI: Automations table rows, hidden recipes/tiles absent, Recent runs "Tagged VIP", run log rows + Skipped filter |
| `phase8-6.rules` | AC 3 (S127, S134, P86-9, P86-10): opt-out through the automation message's `/u/{code}` (8.5 unsubscribe API resolves automation codes) → `resume-due` → run `stopped/opted_out`, no second message. Three delivered orders by one phone with Thank-you on → `done`, `done`, `skipped/frequency_cap`; sink has 2. Night shop (~02:00 local): thank-you run `waiting` with `resume_at` = 09:00 store time, nothing sent; a forced resume inside quiet hours waits again |
| `phase8-6.access` | P86-17, P86-18, S131, S135: Free → create 402 `feature_not_in_plan` (`details.feature` `sms_automation`), reads 200, UI plan note "Automations are part of the Starter plan." + See plans, "Use recipe" disabled. Starter → Free downgrade: automation stays `on` with its settings, `paused_reason` `plan`, a new delivery creates no run, the waiting run ends `stopped/plan` at `resume-due`, enable 402, UI pill "Paused — not in your plan". Staff → 403 on all 12 §9.1 routes, no `marketing.manage` in `/auth/me`, no-access state on Automations, editor, recovery page and run log |
| `phase8-6.visual` | AC 4 / Q166: Automations, Thank-you editor, Abandoned cart recovery, run log and the storefront checkout notice at 1280, 390 and 375 px: no horizontal page overflow, no console errors, quiet-hours note present, documented omissions (WhatsApp, Time saved, Risky orders held, Clicked, Cost, Add a step) absent; screenshots in `test-results/phase8-6-visual/{width}/` for the Figma review against `140:30336` / `141:30622` / `71:20614` |
| `phase7.reports` (8.7 update) | PHASE-8-7 §7.3: with no expenses the Profit summary has `ad_spend_amount` 0 (was null), `other_expenses_amount` 0, `profit_before_expenses_amount` = `net_profit_amount`, `per_order` expense fields 0, `data_quality.expenses_count` 0; every Phase 7 number unchanged |
| `phase8-7.ledger` | §13 QA main flow, AC 1–3 (P87-2/3/4/12/14, S147, S148, S150, S151): Growth shop with one delivered order; no expenses → P&L lines 0 and summary profit = P&L net. UI empty month state → "+ Add expense" Ads ৳ 1,500 (bKash, JPG receipt) and Rent & bills ৳ 8,000.50 (Bank, Repeat every month) → rows with "Receipt attached" / "Repeats monthly", "2 expenses this month", total, tiles (Spent in {Month}, Ads + share, Profit after expenses = P&L net, Cost per order + "1 delivered order"), By category. Summary maths (§6.3). Receipt link → signed URL, 200 inline `image/jpeg`, `nosniff`, CSP `sandbox`, `no-store`, `receipt-{date}.jpg`, ~5 min expiry; no receipt → 404 `receipt_not_found`. P&L: Ad spend = Ads, Other expenses = rest, `profit_before_expenses_amount` = Phase 7 net, net lower by exactly their sum, per_order + daily row, identities. Profit tab shows Ad spend / Other expenses / "before expenses" / AD SPEND + OTHER EXP. columns, no "Coming with Expenses". UI edit (row → Edit expense → ৳ 2,000) → next P&L response follows (no 120 s cache). UI delete with confirm → 204, P&L back. Courier hint + all six chips. Validation matrix (S147) and mass-assignment. CSV export: `text/csv` attachment `expenses-{slug}-{YYYY-MM}.csv`, contract columns, `8000.50`, formula note neutralized, other month excluded; "Export CSV" button downloads. Audit created/updated (old/new amount)/deleted/exported/recurrence_started |
| `phase8-7.receipts` | AC 4 (P87-7, P87-8, S143–S146): JPG with a hand-built GPS EXIF APP1 → upload (no URL in any response) → link polled through 409 `receipt_processing` → download and the stored private-disk object (tinker, `tenants/{tenant}/media/{id}/original.jpg`, disk ≠ public) carry no EXIF. PDF → ready at once, `attachment`, `nosniff`, CSP `sandbox; default-src 'none'`, `no-store`, `no-referrer`; tampered / missing signature → 403. Sniffing: SVG, HTML, GIF, PHP, JPEG named `.pdf`, `%PDF-` without `%%EOF`, > 5 MB → 422 with the contract messages. `/media` list/filter never shows it, show/destroy 404 `not_found`, `POST /media purpose=expense_receipt` 422. Binding: product image id / receipt on another expense → 422 on `receipt_id`; replace deletes the old row + object; remove → link 404. Another tenant → 404 on list/show/link/summary, its receipt id → 422 |
| `phase8-7.repeat` | AC 5 (P87-9, §6.2, S149): back-dated series (1st of last month, with receipt) → recurrence `active`, `day_of_month` 1, `next_on` = 1st of next month, `expenses:repeat` adds nothing. Latest row edited, then "clock moved one month" (test-only `next_on` → today) → exactly one occurrence copying the latest (amount, category, paid from, note), no receipt, `created_by` null, `next_on` advanced; a second run adds nothing; P&L other expenses + net follow; `expense.repeated` audited as system. PATCH an occurrence onto another's date → 422 on `spent_on`. Toggle off on the occurrence → recurrence `stopped`, generator adds nothing, `expense.recurrence_stopped` |
| `phase8-7.access` | P87-5, P87-6, P87-16, S142: staff → 403 `forbidden` on all 9 §8.1 routes, no `expenses.manage` in `/auth/me`, no Expenses tab, no-access state on `/reports/expenses`. Custom role with only `expenses.manage`: records an expense, summary `profit_after_expenses_amount` null, CSV 200, profit report 403; UI Reports nav item visible, `/reports` → `/reports/expenses` (not Forbidden), only the Expenses tab, no profit tile, `/reports/profit` gated. Starter owner: ledger works, summary profit null, profit report 402, Expenses shows 3 tiles ("—" cost per order). Free: create still 201 |
| `phase8-7.currency` | AC 6 (P87-18, §6.4, S153): no orders/expenses → `region.currency_locked` false, BDT → USD → BDT 200. One expense → locked, USD 409 `currency_locked` with the contract message, currency unchanged, BDT 200; delete it → unlocked. One cancelled order → locked + 409. Store details: Currency select disabled + "Locked after your first order or expense." |
| `phase8-7.visual` | AC 7 / Q180: Expenses (list; add card open with "JPG, PNG, WebP or PDF · up to 5 MB") and the Profit tab with expenses at 1280, 390 and 375 px: no horizontal page overflow, no console errors, omissions absent (Facebook ads, Target 25 %, Schedule email, Export CSV · PDF, Coming with Expenses, Money & COD); screenshots in `test-results/phase8-7-visual/{width}/` for the Figma review against `144:41614` / `60:12264` |
| `phase8-8.hold` | §13 QA held order + duplicate, AC 1–2 (P88-2/4/5/12, §5.3, §5.5, S156, S157): Growth shop with the guard on (`block_after_returns` raised to 5 so the third return doesn't auto-block), Steadfast fake connected; a phone with 2 delivered / 3 returned (real manual orders → ship → deliver/return) places a storefront COD order → after the check `pending` with hold `call_first`, decision `hold`, tier `risky`, rate 40, reason `rate_below_hold`, record sources = [`shop` 2/5] only, exactly one `guard` timeline event; the customer's `risk.tier` is also `risky`; `held` in the decision log. Confirm (owner and staff), bulk confirm (skipped `order_held`) and booking → 409 `order_held`. UI 390 px: Pending + "Call first" tag, "Held for a call" banner, Delivery record with "Your shop" only (no Steadfast/Pathao/RedX bars, no "Buyer: n of m delivered"), no page overflow, screenshot `test-results/phase8-8-visual/390/order-held-risky.png` → "Release and confirm" (release 200 + confirm 200) → Confirmed → booking 201, `released` logged. Staff (orders.process) releases a second hold by API, again → 409 `order_not_held`, then confirms. Duplicate: a known good number's first order → `none`/`good`, the same variant again → `call_first` + `duplicate`; `filter[guard_hold]=1`, `meta.counts.held`, `filter[risk]=risky`, `duplicate` event, overview (`rules_total` 6, stopped held/duplicates, `orders_checked`) |
| `phase8-8.advance` | §13 QA careful buyer → advance, AC 1–2 (P88-5, §5.2, §5.3, S158): fake bKash connected; 1 delivered / 1 returned → COD order held `advance`, tier `careful`, reasons non-empty, `payment_link_id` = the one active link (`delivery_charge` ৳ 60, 1 440 min, cancel-if-unpaid); confirm 409 `order_held`; `advance_asked` logged. UI: "Waiting for advance" tag + "Confirm without advance" and Resend/Copy link. Storefront `POST /payment-links/{token}/pay` → fake page "pay" → order `confirmed` exactly once, hold cleared, `partially_paid` ৳ 60, link `paid`, `advance_paid` logged, overview `advance_collected_amount` ≥ 6000 |
| `phase8-8.checkout` | §13 QA checkout rules, AC 3 (§7, §10.4, P88-9/11/13, S159, S160): blocked number (known: one delivered parcel) → COD 422 `cod_unavailable` for `017…`, `+88017…`, `88017…` with a neutral message, online 201 + redirect, `blocked_checkout` logged; browser: COD option disabled with "Cash on delivery isn't available for this number. Please pay online.", bKash preselected, fake gateway pays. Daily limit: 3 COD orders (different variants) → the 4th 422 `order_limit_reached` with the P88-11 message, shown on the checkout page, online still 201, `limit_reached` logged. New number (API): 422 `otp_required` → `/checkout/otp` `{required: true, expires_at, resend_after_seconds}` without the code → code read from the dev message sink (fallback: `sms.log_driver` line) → wrong 422 `otp_invalid` → right 201, check tier `new`, not held; `/otp` for a blocked number has the same keys (no oracle). New number (browser, 390 px): Place order → OTP step ("We sent a 6-digit code to …", resend timer) → screenshot `test-results/phase8-8-visual/390/storefront-otp.png` → code → thank-you |
| `phase8-8.access` | P88-14, P88-15, §2, S155, S162, S166: staff → 403 `forbidden` on all 9 `fraud.manage` routes (settings get/patch/reset, overview, events, blocked list/add/delete, check), settings unchanged, no `fraud.manage` in `/auth/me`, no "Fake order guard" nav item, no-access state on `/orders/fraud-guard`. Custom role `orders.view` + `fraud.manage`: settings read + PATCH (`advance_below < hold_below` → 422), check a number (`new`, 0/0, not blocked), block 201 then the same number in another spelling 409 `already_blocked`, release 403 (needs `orders.process`); UI nav item + page with "Protection on". Owner UI: "Limit orders per phone" switch autosaves (PATCH 200, `daily_limit_enabled` false), "Reset to recommended" → defaults (3, 60, 75, 3). Free shop: reads 200, PATCH / block / check 402 `feature_not_in_plan`, a new number's COD order needs no OTP and is never held; UI plan note "Fake order guard is on Starter and Growth." + "See plans" |
| `phase8-8.visual` | AC 6: Fake order guard (`39:11233`; one blocked number, one duplicate hold) and the held order at 1280, 390 and 375 px: "Protection on", "n of 6 rules on" + "checking your own orders", KPI tiles Orders protected this month / Fake orders stopped / Advance collected, the six rule cards, blocked number note, "Duplicate caught" decision, "Your data stays yours", Check/Block a number buttons; omissions absent (VPN rule, courier-record rule, Delivery charges saved, cross-shop record, Risk network); order detail "Call first" + hold banner; no page overflow, no console errors; screenshots in `test-results/phase8-8-visual/{width}/` |
| `phase8-8b.flow` | §13 QA main flow, API level, AC 1–4 (P88B-2/3/4/5/6/8/10/14/18, S170–S175, S178): landed-cost / weighted-average helper vectors; supplier (phone stored `8801…`) → draft PO, 2 lines (wrap 10 × ৳ 250, kurta M 5 × ৳ 600) + transport ৳ 121 − discount ৳ 11 → `PO-n`, totals recomputed (client totals + `USD` ignored), line landed ৳ 255 / ৳ 612, draft not incoming; discount > subtotal + shipping and a duplicate variant → 422. PO PDF 200 inline `PO-n.pdf` (`.html` under DOCUMENTS_DRIVER=html; then the HTML carries number, products, supplier) → send `sent_via: pdf` → ordered, `sent_at`, events created + sent, `incoming` 10 / 5; send again 409. Over-receive 422 `over_receive` (no movement) → receive wrap 4 + 1 damaged, kurta 2 → `partially_received`, receipt lines with landed / cost before / cost after / on_hand_before, variant cost = weighted average, on hand +4 / +2, two `received` movements referencing the PO (note has the number), incoming 5 / 3; same Idempotency-Key again → same receipt, still 2 movements. An order placed before keeps cost ৳ 200, a new order snapshots the new cost. Payment ৳ 1,000 linked → `partially_paid`, balance, supplier `owed_amount` = received value − paid, both summaries. Receive the rest → `received`, second weighted average, incoming 0, 4 movements; further receipt / cancel 409, delete 409. Second PO: stale revision 409 `revision_mismatch`, PATCH recomputes totals, close from draft 409, mark-ordered (sent_via null) → receive 1 → close → incoming 0, stock kept, cancel 409; draft cancel 200, draft delete 204. No expense rows; audit actions `purchasing.*` incl. exactly 3 `receipt_recorded` |
| `phase8-8b.ui-flow` | §13 QA main flow in the dashboard (§10.2–§10.4): Suppliers "+ Add supplier" dialog → POST 201 → row → detail panel; New purchase order: supplier picker ("Delivers in ~5 days"), two "+ Add product" lines, Quantity / Unit cost in taka, Transport ৳ 121, Supplier discount ৳ 11, "Stock value goes up by ৳ 5,610" + "Cost prices update automatically", no approval note / Receive at; "Send to supplier" offers WhatsApp + PDF (no Email) → PDF: POST create 201 + POST send 200 `{sent_via: pdf}` → API totals as typed. PO detail: Receiving now 4 + Damaged 1 (wrap), 2 (kurta), footer "Adding 6 units to stock" / "1 damaged, not added to stock" / "cost prices updated" → "Receive 6 units" (Idempotency-Key header) → "Partly received"; Stock movements tab shows "Received · PO-n" + supplier. "Record payment" ৳ 1,000 → POST `{amount: 100000, purchase_order_id}` 201 → "Partly paid"; "Receive all remaining" → "Receive 8 units" → "Received", no page overflow |
| `phase8-8b.quick` | P88B-13, §5.5: quick purchase 6 × ৳ 300 (1 damaged) + ৳ 1,500 cash → 201 PO `received`, sent_via null, total ৳ 1,800, received value ৳ 1,500, `partially_paid`, one receipt (invoice ref kept), one payment, event `quick_received`; stock +5 through one `received` movement, weighted-average cost; supplier owed 0 (damaged not owed); same key → same PO, nothing doubled; no key → 400/422; Profit & loss (today) and the expense summary identical before/after, no expense rows (S175); one `purchasing.quick_received` audit row. UI: "Quick purchase" dialog (supplier, + Add product, transport, discount, payment) opens and closes |
| `phase8-8b.access` | P88B-11/12, S168, S169: owner has `purchasing.manage`; system Staff and a custom role with only `inventory.adjust` → 403 `forbidden` on all 17 money routes (suppliers CRUD/archive/payments, summaries, create / quick / PATCH / close / cancel, PDF, reorder suggestions), PO unchanged. Adjust-only: PO list + detail 200 with every `*_amount` null, `payment_status` null, payments `[]`; receives 201 with sent cost fields ignored (owner sees cost from the PO's landed cost, receipt value = 3 × landed); UI: Purchase orders tab shown, Suppliers tab hidden, no ৳ on the list or the PO page, no Record payment / Total / Paid / Due, "Receive all remaining" → "Receive 3 units" → Received, `/inventory/suppliers` no-access state. Free shop (fixtures made on Growth, then `setPlan(free)`): 7 reads 200; supplier create/PATCH/payment, PO create/PATCH/send/receipt and quick → 402 `feature_not_in_plan`, stock unchanged; UI plan note "… on Starter and Growth." + "See plans" on PO list and Suppliers |
| `phase8-8b.suppliers` | P88B-15, §4, §6.1, §10.4, S177: empty state "No suppliers yet"; supplier CSV (`type = suppliers`) with a new row (`+880…` → `8801…`), a phone match (updates city), a case-insensitive exact-name match, a bad phone and a formula-looking name with lead time 999 → validate {create 1, update 2, errors 2} → error report formula-safe → run → completed, error rows not created, `suppliers_count` 3, audit `purchasing.suppliers_imported`. UI: KPI tiles Suppliers / You owe (৳ 400) / On the way / Bought this month (no "vs last month"), row with city, detail panel ("You owe ৳ 400", recent PO number, Record payment), search, "Import" → `/products/import?type=suppliers` "Import suppliers from CSV" |
| `phase8-8b.reorder` | §7, P88B-16: no shipped units → `[]`; wrap bought from a supplier with lead time 5 (PO 2 received → on hand 8), 3 manual orders × 2 shipped → one group for that supplier with the wrap only: available 2, incoming 0, sold_30d 6, days_left 10, suggested 4, last unit cost ৳ 250. UI: Reorder suggestions card on Inventory and the PO list ("Sells out in 10 days") → "Create PO for 1 item" → POST 201 draft for that supplier, quantity 4 at ৳ 250 |
| `phase8-8b.visual` | AC 5: Purchase orders `35:5619` (KPI tiles Open orders / Units coming / Owed to suppliers / Late deliveries, "+ New purchase order", "Quick purchase"), New PO `35:6210`, PO detail / Receive `36:6607` (partly received PO), Suppliers `153:35999` (four KPI tiles) and Inventory (INCOMING column) at 1280, 390 and 375 px: no page overflow, no console errors, omissions absent (Receive at, Transfer stock, Stock count — Warehouses left the list in 8.8c-A, approval note, Approved by, vs last month); empty PO list "No purchase orders yet" at 390 px; screenshots in `test-results/phase8-8b-visual/{width}/` (`po-list`, `po-new`, `po-receive`, `suppliers`, `inventory`, `po-list-empty`) |
| `phase8-8c-a.single` | PHASE-8-8C §13 (a), AC 1, S181, S182: Starter shop (stock 4) has exactly one location "Main warehouse" (warehouse, default) holding all 12 units; a 2nd location → 402 `feature_not_in_plan`; adjust without `location_id` lands there (movement `location` = Main), All-locations row = that location, storefront `low_stock` 5; 8.8b smoke: PO without `location_id` defaults to Main → send → receive 3 → on hand 8. UI: no location selector / "All locations" / Transfer stock / Receive at on Inventory, adjust dialog without Location, Warehouses tab lists Main with "Online orders ship from here" + the upgrade note (Growth) |
| `phase8-8c-a.online` | §13 (b) + (c), AC 2, P88C-2/3/4/5, S183, S184: Growth shop (stock 4, wrap threshold 5): Warehouses "+ Add location" → "Dhanmondi shop" (POST 201, listed after the default) → Inventory location selector visible → adjust dialog Location = Dhanmondi, +3 (request carries `location_id`) → Dhanmondi 3 / Main 4 / total 7 with `locations[]`, one movement at Dhanmondi; storefront availability `low_stock` 4, cart of 5 → 422 `out_of_stock`, PDP "Only 4 left". Two storefront orders commit at Main (2 committed, storefront 2) → row menu "Make default" on Dhanmondi (POST 200, "Online orders ship from here" moves) → storefront 3, cart of 4 refused, PDP "Only 3 left", product `inventory` block `location_id` Dhanmondi, `total_on_hand` 7, `other_locations_on_hand` 4. Ship A / cancel B after the switch → Main 3 on hand, 0 committed, Dhanmondi untouched, `order_shipped` movement at Main; a new order commits at Dhanmondi |
| `phase8-8c-a.receive-at` | §13 (d), §6, §10.3, P88C-8, S186: Growth shop, Dhanmondi added; New purchase order shows "Receive at" listing Main warehouse + Dhanmondi shop; PO 5 × kurta L @ ৳ 600 with `location_id` Dhanmondi (editable while no receipts) → send → PO page "Receive at Dhanmondi shop" → Receiving now 2 → footer "Adding 2 units to Dhanmondi shop" → "Receive 2 units" (201) → Dhanmondi 2, Main 4, cost = weighted average over the total (4 @ ৳ 800 + 2 @ ৳ 600 → ৳ 733.33); PATCH location now → 422 `location_locked`; receive 3 more → Dhanmondi 5, cost ৳ 688.89, both PO movements and receipts at Dhanmondi; quick purchase with `location_id` stocks Dhanmondi only |
| `phase8-8c-a.access` | S179, S180, S181, P88C-17, §4: shop B's location id in A's adjust / PO / `filter[location_id]` → 404/422 (nothing written), B's location via A's routes → 404, A's location via B → 404, cross-tenant list 404; system Staff: GET 200, create/PATCH/make-default/archive → 403 `forbidden`, adjust at Dhanmondi 200; `location_name_taken` (case-insensitive), archive default / with stock → 409 `location_in_use`, archived → make-default 409; downgrade to Starter: list, adjust at Dhanmondi 200, new location + unarchive → 402, archive once emptied 200; UI upgrade note, no enabled "+ Add location" |
| `phase8-8c-a.visual` | §13 (e), §10.2, §10.6: Warehouses (two locations, Default + "Online orders ship from here", Dhanmondi units 3, "+ Add location" dialog) and Inventory with the location selector at 1280, 390 and 375 px — no page overflow, no console errors, no Transfer stock (part B); Starter one-location Warehouses at 390 px (upgrade note); screenshots in `test-results/phase8-8c-a-visual/{width}/` (`warehouses`, `warehouses-add`, `inventory-all-locations`, `warehouses-starter`) |

How they run:
- **Against the running stack** (API :8010 with a queue worker, storefront `http://demo.localhost:3010`, merchant :5183,
  seeded demo store). Override with `API_URL`, `MERCHANT_URL`, `STOREFRONT_URL`. The queue worker is required:
  mail and storefront revalidation are queued.
- **Idempotent and self-cleaning.** Each spec snapshots what it changes and restores it in `finally`/`afterAll`
  (theme draft + published config, menus, SEO flag, logo, created pages, invited user). Unique names per run.
- **Serial** (`workers: 1`): the specs share the demo store.
- **Sign-in (cookie sessions only, PHASE-4-CONTRACT §7.4; Bearer was removed in 4.7c):** one login per run at most.
  `GET /sanctum/csrf-cookie` → `POST /api/v1/auth/login` through the **merchant origin** (Vite proxy); the Playwright
  storage state is cached in `tests/e2e/.auth/demo.json` (+ `demo.meta.json` for tenant/store ids) and reused while
  `/auth/me` says the session has > 1 h left. Every helper call (`api()` / `apiCall()`) goes through
  `http://localhost:5183/api/...` with that cookie jar and sends `X-XSRF-TOKEN` on writes. Playwright's request
  client never sends `Sec-Fetch-Site`, so Laravel's same-origin CSRF shortcut never applies to helper calls; 419
  tests therefore work from the request client. Browser specs get the cookies via `signInDashboard()`.
  `throttle:auth` limits auth calls per IP; `phase2.auth-flows` uses 5 and `phase4.staff`, `phase4.storefront`,
  `phase4.onboarding05`, `phase4.security` 1 each, so **wait ~60 s between back-to-back full runs**. If another
  process changes the demo password or logs sessions out, the cached state is detected as dead and replaced.
- **Phase 4 needs a worker on the `bulk` queue** (imports/exports). Locally, `composer dev` in `apps/api` starts
  a 4-worker server, a `default,media` worker, a separate `bulk` worker and the scheduler (QA F-L3). On SQLite also
  set `DB_JOURNAL_MODE=wal` and `DB_BUSY_TIMEOUT=5000`. Docker compose runs `queue-bulk`. Without it `phase4.import-export` / `phase4.security` time out with
  "is a queue worker consuming the `bulk` queue?".
- **`tinker()` under RLS (Phase 5b-1):** on Postgres the helper switches to the `pgsql_admin` connection (BYPASSRLS) before running test-only code, because tinker has no tenant context and the app role would read nothing / be refused. No-op on sqlite.
- **Documents (Phase 5b-4)** need a worker on `documents` (compose: `queue-documents`). The e2e specs use `DOCUMENTS_DRIVER=html`; with the compose default `gotenberg` the popup gets a PDF instead.
- **Payments (Phase 5b-2) run on the fake gateway** (`PAYMENTS_FAKE=true`, P5B-29; never a real gateway). The API
  needs `PAYMENTS_FAKE=true`, an `INTEGRATION_CREDENTIALS_KEY` (`base64:` + `openssl rand -base64 32`; compose has a
  dev-only default), `PUBLIC_API_URL` and `APP_URL` = the API origin the browser reaches (the fake page is
  `{APP_URL}/api/v1/dev/fake-gateway/{payment}`), a worker on `webhooks` (compose: `queue-webhooks`) and, for real
  expiry, the scheduler (compose: `scheduler`). Fake outcomes are deterministic: an amount ending in 13 paisa fails,
  17 is an amount mismatch, 19 is an Execute timeout then Query `Completed`. Helpers (`support/commerce.ts`):
  `connectFakeGateway`, `placeOnlineOrder`, `placeAndPay`, `fakeGatewayOutcome` (server-side click: outcome POST →
  signed return → first URL outside the API), `fakeGatewayReturnUrl` (the signed return without calling it, for
  forgery/replay), `expireHolds` (the testing-only time travel `POST /api/v1/dev/payments/{payment}/expire-now`, 404 unless
  `PAYMENTS_FAKE=true`; a link nobody tried to pay uses a test-only DB write + `payment-links:expire`), `mapStoreHost` (the API redirects returns and builds link URLs from the
  store's primary host — local env `http://{primary}:3010` — and Playwright doesn't route redirect targets, so browser
  specs make `{slug}.localhost` primary with a test-only DB write; `sp_order` lives there). Browser flows need the Next storefront
  pointed at the same API (`STOREFRONT_API_URL`, `STOREFRONT_API_KEY`). Selectors written before the UI existed
  are isolated in one helper each (`paymentOption`, `clickFakeGateway`, `askForAdvance`, `refundFromPaymentsCard`).
  ```bash
  # API with the fake gateway (Docker Postgres + RLS as in §2d), then:
  PAYMENTS_FAKE=true INTEGRATION_CREDENTIALS_KEY=base64:$(openssl rand -base64 32) APP_URL=http://localhost:8010 \
    PUBLIC_API_URL=http://localhost:8010 php artisan serve --port=8010
  php artisan queue:work --queue=default,media,bulk,notifications,documents,webhooks
  STOREFRONT_API_URL=http://localhost:8010 STOREFRONT_API_KEY=<apps/api .env value> pnpm --filter @storeplix/storefront dev
  cd tests/e2e && pnpm exec playwright test phase5b.online-checkout phase5b.payment-link phase5b.refund phase5b.payments-security
  ```
- **Couriers (Phase 5b-3) run on the fake courier** (`COURIERS_FAKE=true`, §15; never a real courier). The API and the
  queue worker need `COURIERS_FAKE=true` and `INTEGRATION_CREDENTIALS_KEY`; webhook events are processed on `webhooks`,
  "Sync now" polls on `default`, bulk batches on `bulk` (compose: `queue`, `queue-webhooks`, `queue-bulk`; the
  `scheduler` runs `couriers:sync` every 15 min and `couriers:reconcile-bookings` every 2 min). Helpers
  (`support/commerce.ts`): `connectFakeCourier` (PUT + default; returns the once-shown webhook secret), `ensurePickup`,
  `setPlan` (test-only subscription write), `confirmedOrder`, `bookShipment`, `steadfastWebhook` (Bearer POST to the
  account's `webhook_url`, re-pointed at `API_URL`), `fakeAdvance` (testing-only `POST /api/v1/dev/shipments/{id}/advance`,
  404 unless `COURIERS_FAKE=true`: moves the fake parcel and delivers it like a signed webhook), `fakeParcelState`
  (tinker: changes what the fake courier's status API answers **without** telling Store Plix, for re-query/S32 and
  poll checks). The fake keeps parcels in the API's tenant cache: helpers that call `Cache::flush()` (`browserHost`,
  `setPlan`, `mapStoreHost`) must run **before** any booking, or the fake forgets its parcels.
- **Custom domains (Phase 6) run on the fake drivers** (`DOMAINS_FAKE=true`, P6-13; CI never calls Cloudflare or a
  public DoH resolver). The API needs `DOMAINS_FAKE=true` (accepts `*.localhost` custom hosts, registers
  `POST /api/v1/dev/domains/{id}/{dns|provider|age}[?check=1]`) and `DOMAINS_ASK_KEY` (the spec reads it from the env,
  else `apps/api/.env`, else the compose default `dev-domains-ask-key-change-me`); queue + scheduler for
  `domains:check` (compose: `queue-domains`, `scheduler`) and the `default` worker for storefront revalidation after a
  primary change. Fake DNS/provider state lives in the API cache store: `browserHost`/`setPlan` (cache flush) run in
  `beforeAll` before any fake answer. Helpers: `support/domains.ts` (`devDns`, `devProvider`, `devAge`, `ask`,
  `storefrontGet` = raw request with a `Host` header so `{slug}.storeplix.test` needs no resolver rule, UI selectors in
  one helper each). The certification spec `phase6.cloudflare.spec.ts` (real Cloudflare, manual only) is written during
  certification (RUNBOOK §9.6).
  ```bash
  DOMAINS_FAKE=true DOMAINS_ASK_KEY=dev-domains-ask-key-change-me php artisan serve --port=8010   # + the 5b env above
  php artisan queue:work --queue=default,media,bulk,notifications,documents,webhooks,domains
  cd tests/e2e && pnpm exec playwright test phase6.domains
  ```
- **Platform billing (Phase 7) runs on the fake platform gateway** (`BILLING_FAKE=true`, P7-20; CI never calls bKash or
  SSLCommerz). The API needs `BILLING_FAKE=true` (hosted page `{APP_URL}/api/v1/dev/fake-billing-gateway/{payment}` with
  Pay / Pay wrong amount / Fail / Cancel / Pay, then time out, and the testing-only `POST /api/v1/dev/billing/clock`
  `{state}` that moves the session tenant's subscription dates and runs `ProcessSubscriptionJob` inline),
  `PUBLIC_API_URL` = `APP_URL` = the API origin the browser reaches, and `MERCHANT_APP_URL` = the dashboard origin the
  specs use (the billing return 303s **only** there). The clock runs the lifecycle synchronously, so the specs need no
  `billing` worker; `queue-billing` + the scheduler matter for real time (renewals, reconcile). "Pay, then time out"
  is settled by `GET /billing/payments/{id}` (it queries the fake once the last query is > 10 s old). Every spec uses
  fresh shops (`setupShop` → `dev clock trial_ended` for Free; paid plans through the real fake payment, `setPlan` only
  where the plan itself isn't under test). Helpers: `support/billing.ts` (`clock`, `quote`, `changePlan`, `payInvoice`,
  `subscribe`, `fakeBillingOutcome`, `fakeBillingReturnUrl`, `waitBillingPayment`, `binaryGet`, `report`, Dhaka date
  helpers; UI selectors one per helper). Reports are cached 120 s per tenant + range: the reports spec writes all data
  (incl. the test-only `placed_at` moves) before the first report call.
  ```bash
  BILLING_FAKE=true MERCHANT_APP_URL=http://localhost:5183 php artisan serve --port=8010   # + the 5b and Phase 6 env above
  cd tests/e2e && pnpm exec playwright test phase7.
  ```
- **Platform analytics (Phase 8.2)** need the Phase 7 setup (`BILLING_FAKE=true`, `MERCHANT_APP_URL`, `APP_URL` =
  `PUBLIC_API_URL`) plus the super-admin SPA on :5184 (`ADMIN_URL`) and `APP_ENV=local` (or `testing`): only then is the
  testing-only `POST /api/v1/dev/analytics/aggregate {from?, to?}` registered (admin surface, super-admin session,
  10/min; default day = today Dhaka, allowed only here; answers `{data: {days, as_of}}`). It runs
  `analytics:aggregate` inline, so no queue worker or scheduler is needed for the numbers (the scheduler's hourly
  `:20` catch-up is harmless). Platform totals include every other shop in the DB, so the specs assert **deltas between
  two aggregate runs of the same Dhaka day** (flows are restated on a re-run, P82-5) and exact per-shop values; they
  wait out the last minutes before Dhaka midnight (18:00Z). Each spec makes ≤ 3 aggregate calls (the helper retries
  once after a 429). Role checks use fixed-secret staff seeded by tinker (`e2e-support82@`, `e2e-readonly82@`,
  `e2e-visual@storeplix.com`, `support/analytics.ts` `seedStaff`); `resetLastActive()` clears
  `tenants.last_active_at` + the `sp:tenant-active:{id}` throttle key (test-only). The aggregate writes snapshot rows
  for today (and, in `phase8-2.revenue`, today − 4) into the dev DB as `source = late`; that is expected and harmless.
  Helpers: `support/analytics.ts` (`aggregate`, `overview`, `revenue`, `tenantMetrics`, `tenantsList`, money/count
  formatting mirrored from `@storeplix/ui`, UI selectors one per helper: `kpi` (prefers `role="group"` named by the
  Figma label), `card` (by heading), `rangeTab`, `compareToggle`, `setCustomRange`, `sortMerchants`, `merchantCell`,
  `topMerchantRow`, `gmvCard`, `dataAsOf`, `historyStarts`). On sqlite set `DB_JOURNAL_MODE=wal` and
  `DB_BUSY_TIMEOUT=5000`; run the four files on their own rather than inside the full suite ("database is locked").
  ```bash
  APP_ENV=local PAYMENTS_FAKE=true COURIERS_FAKE=true DOMAINS_FAKE=true BILLING_FAKE=true \
    MERCHANT_APP_URL=http://localhost:5183 APP_URL=http://localhost:8010 PUBLIC_API_URL=http://localhost:8010 \
    php artisan serve --port=8010                       # + INTEGRATION_CREDENTIALS_KEY etc. as for 5b
  pnpm --filter @storeplix/super-admin dev              # :5184 (ADMIN_URL)
  cd tests/e2e && pnpm exec playwright test phase8-2.
  ```
- **Custom roles (Phase 8.3)** need only the Phase 4/7 stack (API with the fake drivers, a queue worker, merchant :5183)
  and `MAIL_MAILER=log` for the invitation links. Every spec uses throwaway tenants (`support/roles.ts` `shopOn(plan)`:
  `createTenant` + the test-only `setPlan`), so the demo shop is never touched. `createMember(owner, { role_id })` and
  `acceptInvitation(owner, email, mark)` (invite through the UI, accept through the mailed link) live in `support/api.ts`.
  The dev DB must have the `2026_11_01_*` migrations (`php artisan migrate`, additive). Focus refetch: TanStack Query
  listens to `visibilitychange` on `window`, so the spec dispatches a bubbling `visibilitychange`, not `focus`.
  ```bash
  cd tests/e2e && pnpm exec playwright test phase8-3.
  ```
- **Developer API + webhooks (Phase 8.4)** need the API with **`WEBHOOKS_OUT_FAKE=true`** (plus the earlier fake flags)
  and a worker on the **`webhooks-out`** queue: `php artisan queue:work --queue=webhooks-out` locally (`composer dev`
  doesn't listen on it); the e2e workflow starts one in the `api` container unless compose defines
  `queue-webhooks-out`. The fake driver never sends HTTP: it records every request (URL, headers, raw body) in the dev
  sink `GET /api/v1/dev/webhook-sink` (non-production, `developers.manage`) and answers by URL path suffix: `/fail-503`
  → 503, `/timeout` → timeout, otherwise 200. Specs use unique `https://example.com/storeplix-e2e/<tag>[/fail-503]`
  URLs and filter the sink by URL + `X-Storeplix-Delivery`. Signatures are verified receiver-side in the spec
  (`support/developer.ts` `verifies()`, P84-8). Retries beyond attempt 1 are not waited for (≈ 20.6 h): the spec forces
  one delivery to `failed` with a test-only tinker write to exercise "Resend failed". Every spec uses throwaway shops
  (`devShop(label, plan)` = `setupShop` + `setPlan`). The dev DB needs the `2026_12_01_*` migrations (`php artisan migrate`).
  ```bash
  APP_ENV=local PAYMENTS_FAKE=true COURIERS_FAKE=true DOMAINS_FAKE=true BILLING_FAKE=true WEBHOOKS_OUT_FAKE=true \
    php artisan serve --port=8010                       # + the 5b/7 env as above
  php artisan queue:work --queue=webhooks-out           # second terminal (apps/api)
  cd tests/e2e && pnpm exec playwright test phase8-4.
  ```
- **Marketing campaigns (Phase 8.5)** need the API with **`SMS_DRIVER=log CAMPAIGN_MAILER=log CAMPAIGNS_DEV_SINK=true`**
  (plus the earlier fake flags) and a worker on the **`campaigns`** queue (`php artisan queue:work --queue=campaigns --timeout=250`, jobs run up to 240 s;
  compose runs `queue-campaigns`; the e2e workflow starts one only if compose lacks it). Nothing is sent: the dev
  sink `GET /api/v1/dev/stores/{store}/message-sink` (non-production, `marketing.manage`, cache list of the last 200 per
  store) keeps the rendered SMS/email and its unsubscribe URL; specs match their messages by `campaign_id` or a unique
  marker in the body. The sink lives in the cache, so `setPlan`/`browserHost` (which flush it) run before any send.
  Quiet hours (21:00–09:00 store time) are made deterministic by giving each throwaway shop a fixed-offset timezone
  where it is ~13:00 (or ~02:00) locally (`campaignShop(label, plan, localHour)` in `support/campaigns.ts`). Unsubscribe
  pages are opened on `{slug}.localhost:3010/u/{code}` (`browserHost`). The dev DB needs the `2026_12_02_*` migrations.
  Locally every browser request reaches the API as one shopper IP (127.0.0.1), so the `storefront-unsubscribe` limiter
  (20/min) can trip when several `/u` specs run back to back (the page then shows `?e=1`): run `phase8-5.` files one at a
  time if that happens. On sqlite a `SendCampaignBatch` can die on "database is locked" (tries = 1 by design);
  `waitCampaign()` then runs `campaigns:dispatch-due` with `resume_after_minutes = 0` (`kickDispatchDue()`) instead of
  waiting the 2-minute idle window.
  Run the API with `php artisan serve --port=8010` (it forwards the fake/sink flags, which `.env` doesn't set);
  the dashboard origins (:5183, :5184) are already in `SANCTUM_STATEFUL_DOMAINS`. Process env overrides of keys that `.env` also sets do not reach Laravel under `php -S`
  (the cli-server SAPI keeps them out of `$_SERVER`/`$_ENV`, so `.env` wins and logins answer 400 `stateful_required`).
  ```bash
  APP_ENV=local PAYMENTS_FAKE=true COURIERS_FAKE=true DOMAINS_FAKE=true BILLING_FAKE=true \
    SMS_DRIVER=log CAMPAIGN_MAILER=log CAMPAIGNS_DEV_SINK=true php artisan serve --port=8010
  SMS_DRIVER=log CAMPAIGN_MAILER=log CAMPAIGNS_DEV_SINK=true php artisan queue:work --queue=campaigns --timeout=250   # second terminal
  cd tests/e2e && pnpm exec playwright test phase8-5.
  ```
- **Automations (Phase 8.6)** use the same flags as campaigns (**`SMS_DRIVER=log CAMPAIGN_MAILER=log CAMPAIGNS_DEV_SINK=true`**,
  plus the earlier fake flags; nothing new) and need a worker on **`automations`** as well as `campaigns` and
  `notifications` (`--tries=1 --timeout=250`; compose runs `queue-automations`, the e2e workflow starts one only if compose
  lacks it). Automation messages land in the same dev sink with `automation_id` (`autoSink()` in `support/automations.ts`).
  The scheduler is not needed: specs run `automations:detect-abandoned` / `automations:resume-due` through tinker after a
  test-only clock move (`ageContactCarts()` sets the captured carts' `last_activity_at` 20 min back; `elapseWait()` moves
  one waiting run's `resume_at` into the past). Quiet hours use the 8.5 store-timezone trick (`automationShop(label, plan,
  localHour)`). `order.delivered` fires on the manual ship → deliver transitions (the manual ship creates a shipment), so no
  courier is needed; the low-stock team mail is read from `laravel.log` (MAIL_MAILER=log; not Mailpit). The dev DB needs the
  `2026_12_03_*` migrations.
  ```bash
  SMS_DRIVER=log CAMPAIGN_MAILER=log CAMPAIGNS_DEV_SINK=true \
    php artisan queue:work --queue=automations,campaigns --tries=1 --timeout=250   # apps/api; `composer dev` workers keep default/notifications
  cd tests/e2e && pnpm exec playwright test phase8-6.
  ```
- **Expenses (Phase 8.7)** need no new flag or provider. Receipts are stored on the private disk
  (`storeplix.private_disk`, default `local`); image receipts are re-encoded by `ProcessMedia` on the **`media`** queue and
  recurring expenses are generated by `GenerateRecurringExpenses` on **`default`**, so a worker must consume both (compose:
  `queue`; the 8.6 local worker line above does **not** include `media`). The scheduler is not needed: `phase8-7.repeat`
  runs `expenses:repeat` through tinker after a test-only clock move (`moveNextOn()` sets the series' `next_on` to today).
  The EXIF check builds a GPS EXIF segment by hand (`withGpsExif()` in `support/expenses.ts`, JPEG from the browser canvas)
  and reads the stored object through tinker (`storedReceipt()`). The dev DB needs the `2026_12_04_*` migration.
  ```bash
  php artisan queue:work --queue=media,default --tries=3 --timeout=90   # apps/api, if no worker consumes `media`
  cd tests/e2e && pnpm exec playwright test phase8-7. phase7.reports
  ```
- **Fake-order guard (Phase 8.8a)** needs no new flag or provider. **Fixture rule:** new shops trial Starter, which has
  `fake_order_guard`, and the guard is on by default (OTP for new numbers, 3 COD orders per phone per day, duplicate
  holds, `checking` until the check job ran). `setupShop()` therefore switches it **off** (`PATCH …/fraud-guard/settings
  {enabled: false}`, ignored on a pre-8.8a API) so every older spec keeps the 8.7 checkout; only `phase8-8.*` opt in
  with `setupShop(label, {guard: true})` / `guardShop()` (`support/fraud-guard.ts`). Delivery records are built from real
  manual orders taken to delivered/returned (`buildRecord()`; manual orders are never held). `CheckOrderRisk` runs on
  **`default`** after commit, so a worker must consume it (specs poll `guard.checked_at` with `waitGuard()`). The checkout
  OTP is read from the dev message sink (`CAMPAIGNS_DEV_SINK=true`) or, failing that, from the `sms.log_driver` line of
  `laravel.log` (`SMS_DRIVER=log`; read through tinker under `E2E_ARTISAN=docker`) with `readOtp()`. Advance links pay
  on the fake gateway (`PAYMENTS_FAKE`), bookings on FakeCourier (`COURIERS_FAKE`). Do cache-flushing setup
  (`browserHost`, `mapStoreHost`, `setPlan`) before placing orders: the sink and fake parcels live in the tenant cache. The
  dev DB needs the `2026_12_05_*` migrations.
  ```bash
  SMS_DRIVER=log CAMPAIGNS_DEV_SINK=true php artisan queue:work --queue=default,notifications --tries=3 --timeout=90   # apps/api
  cd tests/e2e && pnpm exec playwright test phase8-8.
  ```
- **Suppliers + purchase orders (Phase 8.8b)** need no new flag, provider or queue (receipts, quick purchase and payments
  are synchronous; the supplier import runs on **`bulk`** like products, the PO PDF uses the existing `DOCUMENTS_DRIVER`,
  so under `html` the PDF route may answer `PO-n.html` — the specs accept both). **Fixture rules:** every `phase8-8b.*`
  shop is a throwaway `setupShop()` tenant (`purchasingShop(label, plan, stock)` in `support/purchasing.ts`, guard off)
  whose simple wrap (cost ৳ 200) and kurta M/L (৳ 700 / ৳ 800) give known starting costs and on-hand counts, so the
  weighted-average maths (`weightedCost()`, `landedUnitCosts()` recomputing P88B-5/6) are exact; never touch the demo
  store's stock or costs. Plans switch with `setPlan()` (Free fixtures are created on Growth first, then downgraded).
  Receipts and quick purchases always send a fresh `Idempotency-Key` unless the test replays one on purpose. Reorder
  suggestions need real `order_shipped` movements: `manualOrderQty()` + `shipOrder()` (confirm → ready → manual ship).
  The adjust-only receiver is a custom role with just `inventory.adjust` (`createRole` + `createMember`). The dev DB
  needs the `2026_12_06_*` migrations.
  ```bash
  cd tests/e2e && pnpm exec playwright test phase8-8b.
  ```
- **Locations (Phase 8.8c part A)** need no new flag, provider or queue (locations, adjust, make-default and receipts
  are synchronous). **Fixture rules:** every `phase8-8c-a.*` shop is a throwaway `purchasingShop(label, plan, stock)`
  (guard off) — store creation makes the "Main warehouse" default, so a shop starts with one location; second locations
  come from `createLocation()` (`support/locations.ts`, Growth only) and per-location stock from `adjust()` with
  `location_id`. Per-location numbers are read with `stockAt(s, variant, location)` (`filter[location_id]`; a missing row
  reads 0); storefront stock with `sfAvailability()` — the wrap's low-stock threshold is 5, so `low_stock` is the exact
  online count while it is ≤ 5 (keep fixture stock ≤ 5 at the online location) — and `sfCanAdd()` (cart 422
  `out_of_stock`). The PDP check needs `browserHost(shop)` and the storefront on :3010. Downgrades use `setPlan()` after
  the fixtures exist. The 8.8b omission list (`OMITTED` in `support/purchasing.ts`) no longer contains "Warehouses":
  the tab shows on every store since part A. The dev DB needs the `2026_12_07_*` migrations (`php artisan migrate`,
  never `migrate:fresh`).
  Gate runs used a **copy** of the dev DB (`sqlite3 database/database.sqlite ".backup <scratch>/e2e.sqlite"`, then
  `DB_DATABASE=<scratch>/e2e.sqlite php artisan migrate`) for both `artisan serve` and the Playwright process: the specs'
  `tinker()` helpers (`setPlan`, `browserHost`, cleanup) run `php artisan` with the Playwright process env, so export the
  same `DB_DATABASE` there or they write to a different database. The storefront's `.env.local` may still point
  `STOREFRONT_API_URL` at :8000 (another project's port): start it with `STOREFRONT_API_URL=http://localhost:8010` or
  every throwaway shop's PDP is "Store not found".
  ```bash
  cd tests/e2e && pnpm exec playwright test phase8-8c-a. phase8-8b.   # part A + the 8.8b regression smoke
  ```
- **Throwaway tenants / members** (Phase 4): `createTenant()` registers an `@e2e.storeplix.test` owner with a store
  (`activateStorefront()` makes it public on `{slug}.localhost` with a tinker DB write); `cleanup()` deletes the
  tenant (FK cascade) and the user. `createMember(owner, 'staff')` invites + accepts; `cleanup()` removes both.
- **Phase 4 records** carry a per-run tag (`E2E {run} …`, SKUs `E2E-{RUN}-…`). `Tracker.cleanup()` deletes them
  through the API (images detached first: `product_images` keep media RESTRICT after a soft delete) and
  `purgeRun()` hard-deletes this run's soft-deleted rows (products + variants/inventory/ledger, categories,
  customers, imports) so the demo DB ends as it started. Audit-log rows stay.
- **Env switches:** `E2E_VISUAL=1`, `E2E_ARTISAN=docker`, `STOREFRONT_API_KEY` (else read from `apps/api/.env`; with
  docker compose it must be the compose-level key, the e2e workflow sets it), `E2E_PROD_STOREFRONT_PORT` (optional: a
  `next build && next start` storefront on that port; `phase5.storefront-buy` then asserts the exact production
  `Cache-Control: private, no-store` on cart, checkout, thank-you and track — `next dev` rewrites it to `no-store`).
- **Phase 5 commerce flows never touch the demo store's orders.** `setupShop()` (`support/commerce.ts`) registers a
  throwaway tenant with a category, a variable and a simple product (cost set), three zones (thana, whole district,
  fallback), a contact phone and publishes it; `browserHost()` adds `{slug}.localhost` for Chromium. API-level
  storefront calls go server-to-server (`sf()`, key + host + client IP). Orders, refunds, plan limits, publish
  blockers and throttles all run there; `cleanup()` deletes the tenant (cascade).
- **Notifications (Phase 5a)** are queued on `notifications`. Docker compose runs `queue-notifications`. Locally,
  `composer dev` only listens on `default,media` and `bulk` (QA F-M1), so order SMS/email jobs pile up in `jobs`
  until a worker runs `php artisan queue:work --queue=notifications`. With `SMS_DRIVER=log` the SMS text is written
  to `laravel.log` (`sms.log_driver`).
- **merchant-bulk throttle:** the suite makes ~15 bulk calls per run on the demo tenant; set
  `THROTTLE_MERCHANT_BULK_PER_HOUR=1000` in local/CI env (the e2e workflow does).
- **Mail:** with `MAIL_MAILER=log` (local `apps/api/.env`) the specs read the link from
  `apps/api/storage/logs/laravel.log` (only the bytes appended after the action; override with `LARAVEL_LOG`).
  With docker compose (Mailpit) set `MAILPIT_URL=http://localhost:8025`.
- **Throwaway users** (`*@e2e.storeplix.test` only) are deleted with `php artisan tinker` in `apps/api`
  (`API_DIR` to override) or `docker compose exec api` when `E2E_ARTISAN=docker`. Users have no delete endpoint.
- Typecheck: `cd tests/e2e && pnpm exec tsc -p .`.

## 2d. Postgres row-level security (Phase 5b-1, PHASE-5B-CONTRACT §2, ADR 0012)

sqlite proves nothing about RLS, locks or races. Use the Docker Postgres (`docker compose up -d postgres redis`), never
the Homebrew Postgres on the dev machine (another project's).

**Roles.** `infrastructure/docker/postgres/initdb/01-roles.sql` (psql script, run as a superuser) creates:

| Role | Attributes | Used by (Laravel connection) |
|---|---|---|
| `storeplix_owner` | `NOSUPERUSER BYPASSRLS`, owns the database and every table | migrations, seeders (`pgsql_owner`, `DB_OWNER_USERNAME`) |
| `storeplix_app` | `NOSUPERUSER NOBYPASSRLS`, owns nothing, DML only | web + queue workers (`pgsql`, default, `DB_USERNAME`) |
| `storeplix_admin` | `NOSUPERUSER BYPASSRLS`, DML only | `withoutTenancy()`, console, scheduler, platform jobs (`pgsql_admin`, `DB_ADMIN_USERNAME`) |

`storeplix` (the compose `POSTGRES_USER`) stays the container **superuser** for psql only. A superuser bypasses RLS, so
the app must never connect as it with `TENANCY_RLS=true` (boot check). Passwords come from `psql -v owner_pw=… app_pw=…
admin_pw=…`, else the env vars `STOREPLIX_OWNER_PASSWORD` / `STOREPLIX_APP_PASSWORD` / `STOREPLIX_ADMIN_PASSWORD`
(compose passes them to the postgres container), else dev-only defaults equal to the role names. The script is
idempotent and applies to the database it is connected to (ownership and default privileges are per database), so run
it once per database.

**Fresh volume.** `docker compose up -d postgres redis` runs the script automatically (mounted into
`/docker-entrypoint-initdb.d`). The compose API containers already use `storeplix_app` and `TENANCY_RLS=true`;
migrate with `docker compose exec api php artisan migrate --seed --database=pgsql_owner`.

**Existing volume** (created before 5b-1: the script never ran and the tables belong to `storeplix`):
```bash
docker compose exec postgres psql -U storeplix -d storeplix -f /docker-entrypoint-initdb.d/01-roles.sql
# Tables created earlier are owned by the superuser; the owner role can't drop or alter them. Simplest (loses local data):
docker compose down -v && docker compose up -d postgres redis     # fresh volume, the script runs on its own
```

**Test database** (the race tests TRUNCATE, so the name must end in `_test`; `RefreshDatabase` wipes it):
```bash
docker compose exec postgres createdb -U storeplix storeplix_test
docker compose exec postgres psql -U storeplix -d storeplix_test -f /docker-entrypoint-initdb.d/01-roles.sql
```

**Run the RLS suites locally** (same env and order as the CI `api-rls` job):
```bash
cd apps/api
export APP_ENV=testing DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_PORT=5432 DB_DATABASE=storeplix_test \
  DB_USERNAME=storeplix_app DB_PASSWORD=storeplix_app \
  DB_OWNER_USERNAME=storeplix_owner DB_OWNER_PASSWORD=storeplix_owner \
  DB_ADMIN_USERNAME=storeplix_admin DB_ADMIN_PASSWORD=storeplix_admin \
  TENANCY_RLS=true CACHE_STORE=array QUEUE_CONNECTION=sync SESSION_DRIVER=array STOREFRONT_REVALIDATE_URL=
php artisan migrate:fresh --seed --force --database=pgsql_owner
php artisan test --group=rls                       # must run, never skip
php artisan test --group=tenancy
php artisan test --group=security --exclude-group perf --exclude-group race
php artisan test --filter='::test_concurrent_checkouts_never_oversell$'   # each race test in its own process
php artisan test --group=checkout-perf             # p95 < 300 ms with RLS on (§2.8)
```
Day-to-day `apps/api/.env` for `php artisan serve` against Docker Postgres (§2.9): `DB_CONNECTION=pgsql
DB_USERNAME=storeplix_app DB_PASSWORD=storeplix_app DB_OWNER_USERNAME=storeplix_owner DB_OWNER_PASSWORD=storeplix_owner
DB_ADMIN_USERNAME=storeplix_admin DB_ADMIN_PASSWORD=storeplix_admin TENANCY_RLS=true`, and migrate with
`php artisan migrate --database=pgsql_owner`. `composer dev` on sqlite keeps `TENANCY_RLS=false`.

**CI job `api-rls`** (`.github/workflows/ci.yml`, part of `ci-ok`):
1. Postgres 16 service, database `storeplix_rls_test`, superuser `storeplix`.
2. `01-roles.sql` piped into the service container's `psql` as the superuser (service containers can't mount files).
   The script aborts if `storeplix_app` is a superuser, can bypass RLS or is a member of the owner/admin roles.
3. `migrate:fresh --seed --database=pgsql_owner`, then rollback + re-migrate as the owner (policy migration reversible).
4. Catalogue checks with psql: every table is owned by `storeplix_owner`; every table with a `tenant_id` column has RLS
   enabled **and** forced with at least one policy.
5. With `DB_USERNAME=storeplix_app TENANCY_RLS=true CACHE_STORE=array`: `--group=rls` (fails if empty or any test
   skips), `--group=tenancy`, `--group=security --exclude-group perf --exclude-group race` (fail if empty), the eight race
   tests one process each (fail on skip), `--group=checkout-perf` (fail on skip). JUnit files are uploaded as `rls-junit`.

`api-postgres` and `api-perf` also run `01-roles.sql` (the policy migration grants to the roles) but keep connecting
as the superuser: `api-postgres` proves app-level isolation with RLS bypassed.

## 3. The `tenancy` test group (required)

Every test that proves tenant isolation **must** be tagged with the PHPUnit group `tenancy`:

```php
use PHPUnit\Framework\Attributes\Group;

#[Group('tenancy')]
class CrossTenantProductAccessTest extends TestCase { ... }
```

(Pest: `->group('tenancy')`.) CI step **`tenant-isolation`** runs `php artisan test --group=tenancy`
and **fails if the group contains zero tests**. The group also runs against Postgres 16 in the
`api-postgres` job. Removing a test from this group requires QA review.

Standard fixture: two tenants (A, B), each with a user, store, domain and at least one record of every
tenant-owned model. Each test acts as A and attempts to touch B.

## 4. Required cross-tenant / security test catalogue

IDs are referenced from PRs and review reports. "Expect" = the assertion the test must make.
Phase column = when the test becomes mandatory (the feature must exist first).

| ID | Scenario | Expect | Phase |
|---|---|---|---|
| T-01 | Cross-tenant **read**: A's token + A's `X-Tenant-Id` requests B's resource by ID (show/list/search/export) | 404 (not 403 — no existence oracle); B's rows never in list payloads | 1+ |
| T-02 | Cross-tenant **write**: A updates/deletes B's resource by ID | 404; B's row unchanged in DB | 1+ |
| T-03 | Mass-assignment of `tenant_id`: A creates/updates with `tenant_id`=B in body | `tenant_id` ignored; row belongs to A | 1+ |
| T-04 | **`X-Tenant-Id` spoofing**: A's token with `X-Tenant-Id`=B (not a member) | 403 `tenant_forbidden`; no data | 1 |
| T-05 | Missing / malformed `X-Tenant-Id` (non-ULID, unknown) on tenant routes | 400/403/404 envelope; never falls back to "first tenant" | 1 |
| T-06 | Global scope: a model query with no tenant context bound | throws / returns nothing — never all tenants | 1 |
| T-07 | Relationship leakage: A attaches B's category/variant/customer ID to A's product/order | 422 validation (`exists` rule scoped to tenant) | 3+ |
| T-08 | **Host header spoofing** on storefront: `X-Storefront-Host` / `Host` / `X-Forwarded-Host` of unregistered, suspended or `pending_verification` domain | 404 `store_not_found` | 1 |
| T-09 | Host normalization: `DEMO.localhost`, trailing dot, port suffix, IDN/punycode, `demo.localhost.evil.com` | resolves only exact normalized registered host | 1 |
| T-10 | **Storefront key**: `/storefront/*` with missing / wrong / empty `X-Storefront-Key`; timing-safe compare (`hash_equals`) | 401/403, no tenant data; key absent from logs | 1 |
| T-11 | Storefront payload minimality: `/storefront/config` contains only `StorefrontConfig` fields (no tenant_id, emails, domain verification tokens, settings secrets) | exact key whitelist | 1 |
| T-12 | Merchant token on storefront endpoints and storefront key on merchant endpoints | rejected | 1 |
| T-13 | **Queue tenant leakage**: job dispatched under tenant A runs with A's context; a job whose payload references B's model while carrying A's context fails; tenant context is reset between jobs on the same worker | no B access; context cleared | 2+ |
| T-14 | **Cache key collisions**: two tenants with same slug/product handle/config key → distinct cache entries; flushing A's cache leaves B intact | keys prefixed `tenant:{id}:` | 1+ |
| T-15 | Domain cache poisoning: domain moved/removed → host→tenant cache invalidated | old tenant not served | 6 |
| T-16 | **Payment manipulation**: client-supplied amount/currency/status ignored; redirect "success" without gateway verification does not mark paid; replayed transaction id rejected; order of tenant B cannot be paid via A's checkout | server-side amount; status only via verify/webhook | 5 |
| T-17 | **Webhook manipulation**: missing/invalid signature, stale timestamp, replayed event id, webhook for B's order to A's endpoint | 401/409/ignored; idempotent | 5 |
| T-18 | **Domain-ownership bypass**: activate domain without DNS TXT match; claim a domain already verified by another tenant; re-use another tenant's verification token; claim `*.storeplix.com` platform subdomain as custom domain | rejected; uniqueness enforced at DB level | 6 |
| T-19 | Slug squatting / reserved slugs (`www`, `api`, `admin`, `app`, `mail`) | 422 | 2 |
| T-20 | RBAC: staff role without permission performs owner-only action within own tenant | 403 | 2+ |
| T-21 | Super-admin endpoints with merchant token | 403 | 8 |
| T-22 | Auth: login rate limit, token revoked on logout, password not in any response, `/auth/me` without token → 401 envelope | as stated | 1 |
| T-23 | File uploads: path traversal, SVG/HTML upload, another tenant's storage path | rejected / served from tenant-scoped prefix | 4+ |
| T-24 | Audit log entries are written with the correct tenant and are not readable cross-tenant | — | 2+ |
| T-25 | Theme/page/menu of tenant B read or written by A (`/stores/{B}/themes`, `/pages`, `/navigation`) | 404; B unchanged | 3 |
| T-26 | Tenant B's media id in A's theme config (`*MediaId`, any depth), page body/`og_image`, store SEO share image; B's `page_id` in A's menu | 422 | 3 |
| T-27 | Storefront host A + slug of B's page; B's preview token with host A | 404 / public (published) data only | 3 |
| T-28 | Href injection in rich text, page buttons, theme hrefs, nav urls (`javascript:`, encoded/whitespace/control-char variants, `data:`, `//`, `/\`, credentials) | 422; storefront `sanitizeHref` drops it again | 3 |
| T-29 | Preview/draft leakage: draft theme/page never served to a cookie-less request after a preview render; preview responses `private, no-store` | public HTML unchanged | 3 |
| T-30 | Framing: live pages `frame-ancestors 'none'` + `X-Frame-Options: DENY`; with `sp_preview` only the `STOREFRONT_EDITOR_ORIGINS` | headers as stated | 3 |
| T-31 | Staff (role `staff`) on every theme/page/nav/SEO write | 403; GETs 200 | 3 |
| T-32 | Tenant/store B's category, media, variant, customer, note, import, export ids in A's **routes** | 404 (never 403) | 4 |
| T-33 | B's ids inside A's **payloads** (`category_ids`, `parent_id`, `images.*.media_id`, `variants.*.id`, `image_media_id`, adjustment `variant_id`, bulk `ids`) | 422 with the field path; DB triple FKs as backstop | 4 |
| T-34 | Same SKU / slug in A and B | allowed, never revealed | 4 |
| T-35 | Stock races: parallel adjustments on one variant | never negative; ledger rows = successful changes | 4 |
| T-36 | CSV formula injection in export, error report and template (`= + - @` TAB CR, full-width, leading space) | cell prefixed with `'` | 4 |
| T-37 | Malicious CSV upload: archive/binary magic, NUL, non-UTF-8, > 10 MB, > 5 000 rows, > 50 cols, > 10 000-char cell, > 64 KB line, bad headers | 413 / 422 with the §5.1 code; nothing decompressed | 4 |
| T-38 | Staff: cost/profit/stock value at cost, delete, import, export | null / 403 | 4 |
| T-39 | Storefront feed minimality and draft exposure | exact card keys; draft store 404; preview `private, no-store` | 4 |
| T-40 | Cookie auth (4.7): CSRF, HttpOnly, host-only, storefront origin not stateful, logout/expiry | 419 / 401 | 4 |
| T-41 | Checkout tampering (S1): client prices/discounts/totals/status in the body; tampered `expected_total_amount` | DB prices; 409 `checkout_changed`, nothing written | 5a |
| T-42 | Oversell and coupon over-redemption under parallel checkouts (S2, S3), mixed-cart deadlock | exactly N orders / redemptions; no deadlock (Postgres) | 5a |
| T-43 | Idempotent checkout and refunds (S4): replay, other body, concurrent same key, missing/malformed key | same order + `Idempotent-Replayed`; 409; 400 | 5a |
| T-44 | Cart token of store A on host B; token at rest; token/phone/address in logs (S5, S15) | 404 `cart_not_found`; sha256 only; absent | 5a |
| T-45 | Storefront key sets (S7): catalog, availability, cart, confirmation, tracking | never cost/SKU/barcode/on_hand/committed/tenant ids | 5a |
| T-46 | Order enumeration (S8): wrong phone vs unknown number, throttle | identical 404 body; 429 after 10/min | 5a |
| T-47 | State machine and staff (S10): every invalid (from, to); staff cancel paid / refund / coupons / shipping / publish | 409 `invalid_state_transition`; 403 | 5a |
| T-48 | Unsafe tracking links and redirects (S14): `javascript:`/`http:` `tracking_url`; `/discount/{CODE}?next=` | 422; always `/` | 5a |
| T-49 | Plan limit for manual orders (S17), sequential and parallel; storefront orders never refused | 402 `plan_limit_reached`; storefront 201 | 5a |
| T-50 | Server Actions CSRF (S12): cross-origin POST with `Next-Action`; non-GET on route handlers | rejected (no cookie set); 405 | 5a |

Non-PHP checks (CI or review):

- **S-01** `STOREFRONT_API_KEY` value and name never appear in `.next/static` or Vite `dist/` (CI step).
- **S-02** No `NEXT_PUBLIC_*`/`VITE_*` variable holds a secret.
- **S-03** CORS: API allows only configured dashboard origins; `/storefront/*` is not callable from browsers with credentials.
- **S-04** Storefront never forwards a browser-supplied `X-Storefront-*` header (nginx strips them).

## 5. Definition of Done (testing checks)

A feature PR is done only when:

1. Happy path, validation (422 envelope) and authorization (401/403) feature tests exist for every new endpoint.
2. Every new tenant-owned model uses the tenant global scope/trait **and** has T-01/T-02/T-03 tests in group `tenancy`.
3. Any new cache key, job, event listener or scheduled command touching tenant data has T-13/T-14 coverage.
4. Response shape matches `packages/types` (resource test asserts exact JSON keys); types updated in the same PR.
5. `php artisan test`, `pint --test`, `pnpm -r typecheck/lint/test/build` pass locally and in CI; `tenant-isolation` passes.
6. Migrations apply on Postgres from scratch and roll back.
7. No secrets in client bundles (S-01) and no new public env var holds a secret.
8. UI changes: component tests for forms (Zod validation, error envelope rendering); responsive check at 375 / 768 / 1280 px.
9. Docs updated (API conventions / architecture) and a reviewer has signed off.

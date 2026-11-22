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
#   docker compose up -d postgres redis
#   DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_DATABASE=storeplix DB_USERNAME=storeplix DB_PASSWORD=storeplix CACHE_STORE=array \
#     php artisan test --filter='::test_concurrent_checkouts_never_oversell$'   # one process per race test (see ci.yml)
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
  cd tests/e2e && pnpm exec playwright screenshot --full-page http://demo.localhost:3000 /tmp/home.png
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

How they run:
- **Against the running stack** (API :8000 with a queue worker, storefront `http://demo.localhost:3000`, merchant :5173,
  seeded demo store). Override with `API_URL`, `MERCHANT_URL`, `STOREFRONT_URL`. The queue worker is required:
  mail and storefront revalidation are queued.
- **Idempotent and self-cleaning.** Each spec snapshots what it changes and restores it in `finally`/`afterAll`
  (theme draft + published config, menus, SEO flag, logo, created pages, invited user). Unique names per run.
- **Serial** (`workers: 1`): the specs share the demo store.
- **Sign-in (cookie sessions only, PHASE-4-CONTRACT §7.4; Bearer was removed in 4.7c):** one login per run at most.
  `GET /sanctum/csrf-cookie` → `POST /api/v1/auth/login` through the **merchant origin** (Vite proxy); the Playwright
  storage state is cached in `tests/e2e/.auth/demo.json` (+ `demo.meta.json` for tenant/store ids) and reused while
  `/auth/me` says the session has > 1 h left. Every helper call (`api()` / `apiCall()`) goes through
  `http://localhost:5173/api/...` with that cookie jar and sends `X-XSRF-TOKEN` on writes. Playwright's request
  client never sends `Sec-Fetch-Site`, so Laravel's same-origin CSRF shortcut never applies to helper calls; 419
  tests therefore work from the request client. Browser specs get the cookies via `signInDashboard()`.
  `throttle:auth` limits auth calls per IP; `phase2.auth-flows` uses 5 and `phase4.staff`, `phase4.storefront`,
  `phase4.onboarding05`, `phase4.security` 1 each, so **wait ~60 s between back-to-back full runs**. If another
  process changes the demo password or logs sessions out, the cached state is detected as dead and replaced.
- **Phase 4 needs a worker on the `bulk` queue** (imports/exports). Locally, `composer dev` in `apps/api` starts
  a 4-worker server, a `default,media` worker, a separate `bulk` worker and the scheduler (QA F-L3). On SQLite also
  set `DB_JOURNAL_MODE=wal` and `DB_BUSY_TIMEOUT=5000`. Docker compose runs `queue-bulk`. Without it `phase4.import-export` / `phase4.security` time out with
  "is a queue worker consuming the `bulk` queue?".
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

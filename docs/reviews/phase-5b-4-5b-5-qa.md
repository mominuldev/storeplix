# QA gate: Phase 5b-4 (documents) and 5b-5 (order changes)

Date: 2026-11-22 · Branch `phase-5b-online-money` @ 0fe247d + this gate's changes · Contract PHASE-5B-CONTRACT §7, §8,
§13, §17. Reviewer: QA.

**Verdict: pass, with the fixes below.** The two increments work on Postgres with RLS on, as the app role, through
the real dashboard and a real Gotenberg. Four bugs were found and fixed. Three low-severity items stay open (§4).

## 1. What ran

| Check | Environment | Result |
|---|---|---|
| Full API suite (`--exclude-group perf,race,checkout-perf`) | Docker Postgres 16, superuser, RLS off | 440 tests, 4 failures → **fixed** (§2 F-1, F-2) |
| `DocumentsTest`, `OrderChangesTest`, `ReturnsTest` | Postgres, `storeplix_app`, `TENANCY_RLS=true` | 24/24 after F-3 |
| CI `api-rls` recipe: `rls`, `tenancy`, `security` groups, `checkout-perf` | same | 25 / 99 / 172 / 1 passed |
| S36 race (`test_concurrent_edit_and_checkout_on_the_last_unit_do_not_oversell`) + S2 oversell | same, one process each | passed |
| New group `documents` (real Gotenberg 9.1.0, basic auth) | Postgres + RLS, and sqlite | 4/4 after F-4, F-5. **100 labels: 1.3 s** (budget 20 s) |
| Playwright `phase5b.documents`, `phase5b.edit-and-return`, `phase5b.mobile` | API :8100 (`artisan serve`, Postgres, RLS on, `DOCUMENTS_DRIVER=html`), database-queue worker on all queues, dashboard :5183 | 3/3 |
| Regression: `phase5.merchant-orders`, `phase5.manual-order`, `phase5.security`, `phase5.coupons-shipping` | same stack, RLS on | all pass after F-6, except S14 (needs the Next storefront, not started) |
| Visual check of the PDFs (pdftoppm) | Gotenberg 9.1.0 | Bangla shaped correctly (conjuncts in রহিম উদ্দিন, মিরপুর ১০); label, A5, receipt layouts read correctly |

Ports 8000/5173 were in use by another project on the dev machine, so the stack ran on 8100/5183 and Postgres on
55432 (the Homebrew Postgres holds 5432).

## 2. Findings fixed in this gate

| # | Sev | Finding | Fix |
|---|---|---|---|
| F-1 | Medium | **Postgres jsonb reorders keys** in two more API responses (same class as 0fe247d): `notifications.customer_sms` (5b-5 added `order_updated`) and the import `summary` (Phase 4). Clients diffing or rendering in key order get a different order on Postgres than on sqlite. | `StoreCommerce::present` and `DataTransferPresenter::import` serialize in the contract key order. The rich-text description assertion in `ImportExportTest` now compares the tree without regard to key order (`assertEquals`). |
| F-2 | Low (pre-existing, Phase 3) | `DELETE /media/{id}` relies on catching an FK error; on Postgres inside an outer transaction the error aborts it ("current transaction is aborted"). | The delete runs in its own `DB::transaction` (a savepoint when nested). |
| F-3 | Test | `DocumentsTest` snapshot renamed the store outside tenant context: under RLS the UPDATE matched 0 rows. | Wrapped in `inTenant`. |
| F-4 | **Medium** | **A5 two-up printed a blank second sheet** for every pair: two 138 mm halves + 5 mm gap = 281 mm > A4's 277 mm printable height. Only visible with a real renderer (the html snapshot can't measure). | Halves are 135 mm (275 mm total). Covered by the `documents` group (2 orders → 1 page). Snapshot refreshed. |
| F-5 | **Medium** | **80 mm receipts were always 297 mm long** (blank paper fed on the roll): with `preferCssPageSize=true` the CSS `@page` 80 × 297 mm wins and `singlePage` can't shrink the page. | `GotenbergClient` sends `preferCssPageSize=false` for `receipt_80mm` only; the page now fits the content (2 receipts ≈ 237 mm). Test asserts width 80 mm and height < 297 mm. |
| F-6 | Medium (WEB) | **The "items changed" timeline entry showed no detail.** The API writes `meta.changes`; the dashboard read `meta.lines`, so "Kurta 1 → 2" never appeared. Unit tests used a mock with the dashboard's key. | `orders/timeline.tsx` reads `meta.changes`; new `phase5b.unit.test.ts` pins the API shape; the e2e spec asserts the text. |
| F-7 | Test harness | The e2e `tinker()` helper ran as the RLS app role with no tenant context: fixture reads returned 0 rows and cleanup deletes failed (`phase5.security` S5, `phase5.manual-order` plan limit). | `tinker()` switches to `pgsql_admin` (BYPASSRLS) on Postgres. No-op on sqlite. |

## 3. QA deliverables added (§13, §17)

- `docker-compose.yml`: `gotenberg` (9.1.0 pinned by tag + digest, released 2026-11-06, ≥ 14 days; basic auth;
  no published port; `mem_limit: 1g`; healthcheck `/health`) and `queue-documents`
  (`--queue=documents --tries=2 --timeout=150`). `DOCUMENTS_DRIVER` defaults to `gotenberg` in compose. Verified:
  healthy, and a convert without credentials → 401.
- CI: new job **`api-documents`** (starts the compose-pinned image with basic auth, asserts 401 without it, installs
  poppler-utils, runs `--group=documents`, fails when the group is empty or anything skips), wired into `ci-ok`.
  The S36 race test was added to both race loops (`api-perf` and RLS-on `api-rls`); before, it ran only inside the
  superuser `perf` group, never with RLS on.
- Tests: `DocumentsGotenbergTest` (group `documents`), `phase5b.unit.test.ts`, Playwright `phase5b.documents`,
  `phase5b.edit-and-return`, `phase5b.mobile`. TESTING.md updated.

## 4. Open items (not fixed)

- **L-1 (WEB, low):** at 390 px, Edit items truncates the product name to "Q…" (price, stepper and delete take the
  row). Readable names matter most on the phone. Screenshot: `test-results/phase5b.mobile-*/order-edit-items-390.png`.
- **L-2 (5b-2):** exchange "send payment link for the difference" shows "coming soon", as agreed; §13
  "exchange order with link" can only be finished with payment links.
- **L-3 (ARCH/QA, low):** Gotenberg could additionally run with a Chromium deny-list for every non-`file:` URL. S34
  already proves the HTML carries no URLs, so this is defence in depth; not added without a tested regex.
- `pdftotext` splits shaped Bangla words at some vowel signs ("মিরপু র"). The glyphs are correct (checked visually),
  so the round-trip check ignores whitespace. Documented in the test.

## 5. Not verified

- The `api-documents` job and the edited race loops have not run on GitHub yet (next push).
- Compose end to end: the `api` image was not built here, so `queue-documents` → `gotenberg` inside the compose
  network wasn't run. The same client and image ran against a local container.
- The full API suite **as the app role** fails in older (Phase 2–4) tests that set up data without tenant context.
  CI never runs it that way (only `rls`/`tenancy`/`security`), and none of those failures are in 5b-4/5b-5 code.
  Worth a cleanup before RLS becomes the only mode.
- S14 (`/discount/{CODE}`) and other storefront-browser specs: the Next storefront wasn't started.

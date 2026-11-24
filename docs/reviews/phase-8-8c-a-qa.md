# QA gate: Phase 8.8c part A (locations + per-location stock)

Date: 2026-11-24 · Branch `feat/phase-8-8c-locations` @ 5fe8883 (types 120d547, docs 2f58583, API 02cf8a1, WEB
5fe8883 on top of the contract commit 0a84500) plus the uncommitted QA files · Contract PHASE-8-8C §12 part A
(S179–S186), §13, §16 items 1–3 and 6–8. Reviewer: QA.

**Verdict: PASS.** Re-gate 2026-11-24 after the coordinator's fix. **P88CA-QA-1 is fixed.** The "Latest stock changes"
panel now sits beside the table only from 1400 px (`InventoryPage.tsx`, `min-[1400px]:grid-cols-[minmax(0,1fr)_340px]`);
below 1400 px it stacks under the table. **P88CA-QA-2 is fixed**: contract §4 now says 422 `location_archived`. On the
re-run, `phase8-8c-a.*` passed **24/24**, including `visual` at 1280, 390 and 375 px. `single` and `online` now run at the
default viewport, because the 1440 px workaround was removed. The API, storefront behaviour, Postgres/RLS races and every
other check were green at the first run and are unchanged.

Follow-ups (do not block the gate):
- P88CA-QA-3: the stale `phase8-8b.*` specs need a refresh.
- The storefront `.env.local` still points at the :8000 / :5173 ports of the other project.

## 1. What ran

The local stack ran on api **:8010** (`artisan serve`, `PAYMENTS/COURIERS/DOMAINS_FAKE=true`), merchant **:5183** (vite),
storefront **:3010** (`next dev` with `STOREFRONT_API_URL=http://localhost:8010`) and one
`queue:work default,notifications,bulk`. All of them used a **scratch copy** of the dev DB (`.backup` → `migrate`). The
dev DB itself was not migrated and not touched. A scratch Postgres 18 cluster ran in UTC on :55432 with the CI roles
(`01-roles.sql`). :8000, :5173 and :3000 were not touched.

| Check | Result |
|---|---|
| Pest `--group=locations` (sqlite) | 25: 24 passed, 1 skipped (pgsql-only RLS test). With races included: 27, of which 3 skipped |
| Pest `--group=locations` (Postgres, superuser) | 25: 24 passed, 1 skipped |
| Pest `--group=locations` (Postgres, **RLS on**, app role, `migrate:fresh` as `storeplix_owner`) | 25: 23 passed, 2 skipped (the two backfill-migration tests, which skip under RLS by design) |
| Race `test_parallel_checkouts_sell_only_the_online_locations_stock` | passed on Postgres and with RLS on (1 test, 18 assertions, no skip) |
| Race `test_parallel_location_writes_keep_the_cap_and_one_default` | passed on Postgres and with RLS on (no skip) |
| Pest `--group=rls` (RLS on) | 46/46 passed, including `LocationRlsTest` |
| Full API suite (sqlite, excluding perf and race) | **1366: 1317 passed, 49 skipped, 0 failed**. Pre-existing tests were not edited except for additive `locations` rows in `PermissionParityTest` and `RoutePermissionsTest` (§2.1) |
| Playwright `phase8-8c-a.*` (24 tests, 5 files) | First run: 23 passed, 1 failed (`visual` at 1280: P88CA-QA-1). **Re-gate after the fix: 24/24 passed** |
| Playwright 8.8b + regression smoke (`phase8-8b.*`, `phase4.inventory`, `phase5.storefront-buy`) | `phase5.storefront-buy` 2/2 and `phase4.inventory` passed. In `phase8-8b.*`, 22 passed and 6 failed; all 6 failures are **pre-existing spec drift, not 8.8c regressions** (§4) |
| `pnpm -r typecheck` | clean (tests/e2e `tsc --noEmit` also clean) |
| Merchant-dashboard Vitest | 605 passed (coordinator; not re-run here) |
| `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` | valid, with 29 warnings (same count as before) |
| `ci.yml` | parses as YAML; the race-list guard script was run locally against the real file and found both races listed twice |

## 2. Acceptance criteria (part A)

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | A one-location store behaves exactly as before; pre-existing tests unchanged (S182) | Full Pest suite green with no pre-existing test edited (only route-map rows added). `phase8-8c-a.single`: a Starter shop has exactly one "Main warehouse" (default) holding all 12 units; adjust, PO and receive without `location_id` land there; the All-locations row equals that location; storefront `low_stock` is unchanged; Inventory has no selector, no "All locations" and no Receive at; the adjust dialog has no Location field. Pest `LocationBackfillMigrationTest` covers this on a seeded pre-8.8c fixture (Σ on_hand kept; a negative row aborts the migration) | **Met** |
| 2 | Storefront and checkout use only the online location; release, ship and restock use the committed location after a switch (S183, S184) | `phase8-8c-a.online`: Dhanmondi gets +3 through the UI → storefront still shows 4 (API `low_stock`, PDP "Only 4 left") and a cart of 5 is refused with `out_of_stock`. Two orders commit at Main → UI "Make default" on Dhanmondi → storefront shows 3 (PDP "Only 3 left"). After the switch, A ships and B cancels against Main (Main 3/0, Dhanmondi untouched), the `order_shipped` movement is at Main, and a new order commits at Dhanmondi. Pest `OnlineLocationTest` (matrix incl. return and edit) passes, and the Postgres oversell race passes with RLS on | **Met** |
| 3 | Every reader is online, total or location; no 1:1 inventory join remains (S185) | Pest `InventoryReaderParityTest`: the two-location parity matrix, the static `join('inventories'` allow-list test, and reorder suggestions on total available. E2E: the product `inventory` block shows `location_id` = online, `total_on_hand` 7, `other_locations_on_hand` 4; the All-locations row shows totals plus `locations[]` | **Met** |
| 6 | `multi_warehouse` gates second locations (S181) | Starter → 402 `feature_not_in_plan` on a 2nd location (`single`, `access`). After a Growth → Starter downgrade: list, adjust at Dhanmondi, and archive-once-empty all work; new location and unarchive → 402; the UI shows the upgrade note and no enabled "+ Add location" (`access`). Pest `test_plan_gate_on_second_location_and_unarchive` | **Met** |
| 7 | Figma `11:589` / `35:6210` / `36:6607` with documented omissions; composed Warehouses tab; states; 375 px usable | At 390 and 375 px, Warehouses (cards), the add dialog and Inventory (selector) show no overflow and no console errors. At 1280, Warehouses is fine. New PO shows "Receive at"; the PO page shows "receive at Dhanmondi shop" and the footer "Adding 2 units to Dhanmondi shop". No Transfer stock or Stock count (part B). After the fix, the 1280 Inventory table shows full product names and the Adjust buttons; the side panel stacks below the table (P88CA-QA-1 fixed) | **Met** |
| 8 | Suites green | Pest sqlite, Postgres and RLS green; races green; typecheck and openapi lint green; `phase8-8c-a.*` 24/24 | **Met** |

## 3. Security checklist coverage (S179–S186)

| Item | Pest (API) | Playwright (QA) |
|---|---|---|
| S179 isolation | `LocationsApiTest::test_isolation` (path 404, body/filter 422), `LocationRlsTest` (forced RLS, `rls` group) | `access`: B's location in A's adjust / PO / `filter[location_id]` → 404/422 with nothing written; B's location via A's routes → 404; A's location via B → 404; cross-tenant list 404 |
| S180 permissions | `PermissionParityTest` rows, `PerLocationStockTest` (staff adjust) | `access`: Staff GET 200; create / PATCH / make-default / archive → 403 `forbidden`; adjust at a location 200 |
| S181 plan | `test_plan_gate_on_second_location_and_unarchive`, `test_at_most_ten_active_locations` | `single` (Starter 402), `access` (downgrade matrix + UI note) |
| S182 backfill | `LocationBackfillMigrationTest` (2 tests; skipped under RLS by design, run on sqlite + Postgres) | `single` (store creation makes the default, all stock on it) |
| S183 online isolation | `OnlineLocationTest::test_storefront_and_checkout_use_only_the_online_location`, race `test_parallel_checkouts_sell_only_the_online_locations_stock` (Postgres + RLS) | `online` (API availability, cart refusal, PDP text, before and after the switch) |
| S184 stored location | `OnlineLocationTest::test_stored_location_matrix_after_switching` | `online` (ship A / cancel B after the switch; new order at the new default) |
| S185 reader parity | `InventoryReaderParityTest` (3 tests incl. the static join guard) | `online` (product block + All-locations totals) |
| S186 cost | `PurchasingLocationTest::test_weighted_average_uses_total_on_hand_…` | `receive-at`: 4 @ ৳ 800 at Main + receive 2 @ ৳ 600 at Dhanmondi → ৳ 733.33 (not ৳ 600), then 3 more → ৳ 688.89 |

## 4. Defects and findings

**P88CA-QA-1 (Medium, WEB), FIXED in the re-gate: the Inventory Stock levels product column has zero width at 1280 px, and with more than one
location the Adjust button is clipped.** `InventoryPage.tsx` puts the table beside the 340 px "Latest stock changes"
panel from `xl` (1280) upward (`xl:grid-cols-[minmax(0,1fr)_340px]`). The fixed columns (On hand 80, Held 64, Incoming
84, Available 84, Status 110, Adjust 76) leave the flexible Product column about 0 px wide, so product names are
invisible and the "PRODUCT" header sits under "ON HAND".

- This layout already existed on the base commit (Phase 4 side panel), so even a one-location store shows no names at 1280.
- Part A adds the 32 px "Show stock per location" column, which pushes the Adjust button past the card edge (only "Adju"
  is visible).
- Page-overflow checks miss this because the card clips the content.
- Evidence: `phase8-8c-a.visual` at 1280 fails on `getByText('QA Muslin Wrap')`.
- Fix suggestion: give Product a minimum width, move the side panel below the table until `2xl`, or let the table
  scroll inside the card.
- The `single` and `online` specs ran their Inventory steps at 1440 px so they tested behaviour rather than this layout.
- **Fix:** the coordinator moved the side-panel breakpoint to 1400 px (`min-[1400px]:grid-cols-[minmax(0,1fr)_340px]`).
  The re-gate `visual` at 1280 passes and its screenshot shows the names and Adjust buttons. The 1440 px workaround was
  removed from `single` and `online`, and both pass at the default 1280 viewport.

**P88CA-QA-2 (Low, ARCH contract wording), FIXED: §4 now says 422 `location_archived`.** Original finding: §4 says "making an archived location default → 409", but openapi 1.18.0
and the API return **422 `location_archived`**. openapi is the machine-readable contract and the API follows it, so the
`access` spec asserts 422.

**P88CA-QA-3 (Info, open follow-up, pre-existing `phase8-8b.*` spec drift, QA-owned, not caused by 8.8c).** Each item below was checked
against base 0a84500: the relevant source is unchanged, or it changed only in 8.8c lines unrelated to the failure.

1. `flow`: sending a PO twice expects 409, but `PurchaseOrderService::send` has allowed DRAFT and ORDERED (a re-send)
   since 8.8b.
2. `suppliers` CSV import: the summary counts differ (create 2 / errors 1 vs 1 / 2), and `SupplierImportValidator` is
   unchanged.
3. `ui-flow`: there is no "Partly paid" pill on the PO page. The PO page diff in 8.8c is 6 lines about "receive at".
4. `visual` at 390 and 375: the `Incoming` locator `.first()` resolves to the hidden desktop column header. The
   Incoming column is unchanged.

These 8.8b specs need a separate QA refresh. They were left as they are in this gate, because they are not a part-A
regression.

**QA changes to 8.8b helpers (required by part A):** "Warehouses" left the 8.8b `OMITTED` list, because the tab now
shows on every store (§10). `receiveInputs()` now also matches the `inputMode="numeric"` text boxes "Receiving now of
{name}" and "Damaged of {name}", which are not spinbuttons.

**Local-run notes (recorded in TESTING.md):**

- The specs' `tinker()` helpers use the Playwright process env, so `DB_DATABASE` must be exported there when the API
  runs on a scratch DB.
- The storefront `.env.local` still points `STOREFRONT_API_URL` / `STOREFRONT_MEDIA_ORIGINS` /
  `STOREFRONT_EDITOR_ORIGINS` at :8000 / :5173, the other project's ports. Every throwaway shop then showed "Store not
  found" until it was overridden. This belongs in the pending `chore/dev-ports` work. **This is an open follow-up.**

## 5. CI (QA infra part A)

- `api` (sqlite): new step "phase 8.8c-A group (locations)", JUnit-counted; it fails when the group is empty.
- `api-postgres`: new step "phase 8.8c-A locations (postgres)"; it fails when the group is empty.
- `api-perf` and `api-rls` race lists gain `test_parallel_checkouts_sell_only_the_online_locations_stock` and
  `test_parallel_location_writes_keep_the_cap_and_one_default`. They run one per process, strict, and must not skip.
- `api-perf`: new guard "phase 8.8c-A race list complete (discovered)". It finds every `#[Group('race')]` method or
  class in files tagged `#[Group('locations')]` and fails when there are none, or when a discovered test is missing
  from either race list.
- `api-rls`: new step "phase 8.8c-A locations (RLS on)" (`run-group.sh locations lenient`; the two backfill tests skip
  by design).

## 6. Playwright specs (part A)

| Spec | Tests | Result |
|---|---|---|
| `phase8-8c-a.single` (§13 a, AC 1) | 4 | 4/4 |
| `phase8-8c-a.online` (§13 b + c, AC 2) | 7 | 7/7 |
| `phase8-8c-a.receive-at` (§13 d, §6, S186) | 5 | 5/5 |
| `phase8-8c-a.access` (S179–S181, P88C-17) | 4 | 4/4 |
| `phase8-8c-a.visual` (§13 e) | 4 | 4/4 in the re-gate (1280 failed in the first run: P88CA-QA-1, now fixed) |

Screenshots are in `tests/e2e/test-results/phase8-8c-a-visual/{1280,390,375}/` (git-ignored): `warehouses`,
`warehouses-add`, `inventory-all-locations` and `warehouses-starter`. Helpers are in `tests/e2e/support/locations.ts`.

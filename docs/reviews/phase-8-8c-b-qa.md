# QA gate: Phase 8.8c part B (stock transfers + stock count)

Date: 2026-11-25 · Branch `feat/phase-8-8c-transfers-counts` @ fca69a9, plus the uncommitted API fix for D1 and the
uncommitted QA files · Contract PHASE-8-8C §12 part B (S187–S194), §13, §16 items 4–8. Reviewer: QA.

**Verdict: PASS.** One defect was found and fixed during the gate:

- **P88CB-QA-1 (D1, API, S191 / P88C-12):** `StockCountPresenter::summary()` multiplied an unbracketed difference by
  the cost. SQL therefore computed `counted − expected × cost`, which made `extra_value_amount` and
  `net_value_amount` wrong whenever `expected ≠ 0` or a line had extra units. For example, a ৳ 200 wrap counted 1
  against an expected 0 gave an extra value of 1 instead of 20000. The API agent bracketed the difference and added
  Pest coverage for short, extra and net. The re-run is green.

There are no open defects.

## 1. What ran

The stack ran locally:

- api on **:8010** (`artisan serve` with `PAYMENTS/COURIERS/DOMAINS_FAKE=true`)
- merchant dashboard on **:5183** (vite)
- storefront on **:3010** (`next dev` with `STOREFRONT_API_URL=http://localhost:8010`; `.env.local` was not edited)
- one `queue:work default,notifications,bulk`

All of them used a **scratch copy** of the dev DB: `.backup`, then `migrate` with the `2026_12_08_*` migrations. The same
`DB_DATABASE` was exported to Playwright. The dev DB was not touched.

A scratch Postgres 18 cluster ran on :55433 in **UTC**, with the CI roles loaded from `01-roles.sql` into each DB. Ports
:8000, :5173 and :3000 were not touched.

| Check | Result |
|---|---|
| Pest `--group=stocktransfer` (sqlite) | 24 tests: 23 passed, 1 skipped (a pgsql-only test) |
| Pest `--group=stocktransfer` (Postgres, superuser) | 24 tests: 23 passed, 1 skipped |
| Pest `--group=stocktransfer` (Postgres, **RLS on**, app role) | 24/24 passed |
| Pest `--group=rls` (RLS on) | 47/47 passed |
| Pest `--group=locations` (RLS on, regression) | 25 tests: 23 passed, 2 skipped (backfill tests skip under RLS by design) |
| 4 `StockTransferRaceTest` races, one process each | each passed on Postgres and again with RLS on; no skips |
| Full API suite (sqlite, excluding perf and race) | **1390 tests: 1340 passed, 50 skipped, 0 failed** |
| Playwright `phase8-8c-b.*` (4 files) | **19/19 passed** (after the D1 fix) |
| Playwright regression: `phase8-8c-a.*`, `phase4.inventory`, `phase5.storefront-buy` | **30/30 passed** |
| Playwright `phase8-8b.visual` | 4/4 passed, after the QA spec refresh in §5 |
| `pnpm -r typecheck` and `tests/e2e` `tsc --noEmit` | clean |
| `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` | valid, 29 warnings (unchanged) |
| `ci.yml` | parses as YAML. The new discovery guard was run locally against the real file and found the 4 races, each listed twice |

On sqlite, "database is locked" hit `setupShop` once; the re-run passed. This is the known local flake, not an 8.8c
problem.

## 2. Acceptance criteria (part B)

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 4 | Send takes stock out, receive puts received units in, short is written off, and nothing is sent beyond available (S188, S189) | **`transfer` spec, the Growth flow with Dhanmondi:** Inventory "Transfer stock" opens the panel. Lines are added through "+ Add product". The panel shows "Main warehouse stock 6 → 2 / 6 → 3" and the low-stock warning "— online orders may sell out". "Save draft" returns 201 with TR-nnn, status Draft, and stock is unchanged. "Send" carries an Idempotency-Key; afterwards Main reads M 2 and wrap 3, Dhanmondi 0, status In transit. "Receive all" then wrap → 1 shows "5 received · 2 short" live. The confirm reads "Receive with 2 short?". The pill becomes "Received · 2 short". Dhanmondi reads M 4 / wrap 1, Main is unchanged, and the line shows `quantity_received`. A second receive or cancel returns 409. **Ledger:** `transfer_out` −4/−3 at Main, `transfer_in` +4/+1 at Dhanmondi, reference `stock_transfer`, and the Movements tab shows "Transfer → Dhanmondi shop". **Cancel in transit** from the menu ("The 2 units sent go back to Main warehouse") returns Main to its pre-send value exactly once, with one `transfer_in` row "Cancelled"; a repeat cancel returns 409. **Over-available send** returns 422 `insufficient_stock` and the transfer stays a draft. **Pest:** state machine, idempotent send/receive/create, and the races "sends + checkouts never below committed", "one transfer sent once" and "receive vs cancel once" | **Met** |
| 5 | A finished count changes each counted line by counted − expected-at-count, and sales during the count are kept (S190) | **`count` spec, on Starter, stock 3:** "Start count" (Location Main) opens the count screen and the breadcrumb. A second open count returns 409 `count_in_progress`. Three SKUs are typed (one in lower case); each adds 1, expected is 3, and focus stays in the box. An unknown code shows the alert "No product in this count has the SKU or barcode …". Click-editing COUNTED for M to 2 shows a difference of −1, and the chips show "Differences · 3" and "Matched · 0". **Mid-count:** a storefront order for M is placed **and shipped**, so on hand drops to 2. **Finish & adjust stock** (confirm: "keep stock") gives **M = 1 = counted 2 − order 1**, L 1, wrap 1, and three `count` movements (−1, −2, −2). The completed count is read-only (pill Completed, "Result", no editors). **Second count:** wrap typed twice (expected 1, counted 2) with "Set uncounted items to 0" switched on gives M 0, L 0, wrap 2. **Pest:** delta vectors (sale after counting, receipt after counting, keep vs zero), idempotent finish, and the one-open-count race | **Met** |
| 6 | `multi_warehouse` gates transfers; counts work on every plan (S192) | **`access` spec:** on Starter, POST returns 402, there is no "Transfer stock", the Transfers tab is hidden (one location), the Stock count tab is visible, and a count starts (201). After a Growth → Starter downgrade, one in-transit transfer can be received (200) and another cancelled (200), with stock back on Main. A new transfer or the send of a draft returns 402, and a count still starts. **Pest:** `test_plan_gate_blocks_create_update_send_but_not_receive_or_cancel` | **Met** |
| 7 | Figma `153:34425` / `153:35246` with the documented omissions; loading/empty/error states; 375 px usable | **`visual` spec at 1280, 390 and 375 px:** no page overflow and no console errors on Transfers (KPI tiles Drafts "Not sent yet", In transit, Received this month, Locations; Draft, In transit and "Received · 2 short" rows), transfer detail, the new-transfer panel (a drawer below 1400 px), the counts list and the count screen (SKU box, "If you finish now", "Set uncounted items to 0"). Omissions are absent: Waiting for approval, Approve & send, Reject, needs approval, Pause, Scanner ready, Record shortage as expense, Lock online sales. Below `md` the SKU box stays in view after scrolling. Empty states at 390 px: "No transfers yet" and "No counts yet". Screenshots are in `tests/e2e/test-results/phase8-8c-b-visual/{1280,390,375}/` | **Met** |
| 8 | Suites green | Pest on sqlite, Postgres and RLS (`stocktransfer`, `rls`, `locations`, races); typecheck; openapi lint; `phase8-8c-*` Playwright | **Met** |

## 3. Security checklist coverage (S187–S194)

| Item | Pest (API) | Playwright (QA) |
|---|---|---|
| S187 isolation | `test_cross_tenant_and_cross_store_isolation`, `test_transfers_and_counts_are_isolated`, RLS on the 4 tables (`rls` group) | `access`: A's transfer, count and count line through B's path or session return 404 for GET, send, cancel, scan, PUT line and finish. B's location or variant in A's transfer or count returns 404/422 and nothing is written |
| S188 transfer integrity | `test_draft_send_and_receive_with_two_short`, `test_send_takes_only_available_stock…`, `test_cancel_draft_and_in_transit_and_delete`, races (sends + checkouts, one transfer once, receive vs cancel) | `transfer` (a)–(d) |
| S189 idempotency | `test_idempotent_send_receive_and_create`, `test_finish_is_idempotent` | the send request carries an Idempotency-Key (asserted) |
| S190 count maths | `test_delta_at_count_vectors`, `test_one_open_count_per_location…`, race `test_parallel_count_starts_open_one_count_per_location` | `count` (a)–(d) |
| S191 values without `costs.view` | `test_values_only_with_costs_view`, `test_summary_values_with_short_and_extra` (short/extra/net added with the D1 fix) | `access`: a custom role with `inventory.adjust` but not `costs.view` scans; summary and line `*_amount` values are null; no ৳ and no Value column. The owner sees extra 1 × ৳ 200 (this test found D1) |
| S192 plan | `test_plan_gate_blocks_create_update_send_but_not_receive_or_cancel` | `access` (Starter + downgrade matrix) |
| S193 scan input | `test_scan_input_is_literal_and_scoped_to_the_count` | `count`: `%`, `_`, `QA-M%` and `QA-_-%` return 404 `count_line_not_found`; a 65-character code returns 422; counts are unchanged |
| S194 audit | `test_audit_with_actor_and_impersonation_is_read_only`, `test_isolation_permissions_plan_and_audit` | (API only) |
| P88C-14 permissions | `test_permissions` | `access`: a custom role with only `orders.view` gets 200 on GET and 403 `forbidden` on every write. The UI shows no "+ New transfer", Send/Receive, "Start count", SKU box or Finish |

## 4. CI (owned by QA)

- `api` (sqlite): new step "phase 8.8c-B group (stocktransfer)". It writes JUnit and fails when the group is empty.
- `api-postgres`: new step "phase 8.8c-B stocktransfer (postgres)", which also fails when empty.
- `api-perf`:
  - The 4 races were added to the race loop: `test_parallel_sends_and_checkouts_never_take_the_source_below_committed`, `test_parallel_sends_of_one_transfer_move_stock_once`, `test_parallel_receive_and_cancel_settle_an_in_transit_transfer_once` and `test_parallel_count_starts_open_one_count_per_location`.
  - New step "phase 8.8c-B race list complete (discovered)". It finds the `stocktransfer` ∩ `race` tests in the test files, and fails when there are none or when one is missing from either race list.
- `api-rls`: the same 4 races were added to the RLS race loop, and a new step "phase 8.8c-B stocktransfer (RLS on)" runs through `run-group.sh` (fails when empty).

## 5. QA changes to earlier specs (required by part B)

- `support/purchasing.ts` `OMITTED`: "Stock count" was removed from the list, because the tab now shows on every store. "Transfer stock" stays on the list, because the button is hidden on one-location shops.
- `phase8-8c-a.visual`: the two-location Growth Inventory now **expects** "Transfer stock".
- `phase8-8c-a.single`: docblock wording only.
- `phase8-8b.visual` at 390 and 375 px: the "Incoming" check now matches the visible label (`visible=true`) instead of the hidden desktop column header. This fixes 8.8c-A follow-up P88CA-QA-3 item 4, which was pre-existing spec drift. The other three items of QA-3 (`flow`, `suppliers`, `ui-flow`) were out of this gate's scope and are still open.

## 6. Notes (not blocking)

- One-location Growth shops show "No other locations yet" on Transfers, as §10.6 specifies. The "No transfers yet" check runs on a two-location shop.
- Below 1400 px the transfer panel is a drawer. The confirm dialogs render inside it, so the specs find dialogs by their accessible name.
- The storefront `.env.local` still points at :8000 / :5173. Override `STOREFRONT_API_URL` for local runs.

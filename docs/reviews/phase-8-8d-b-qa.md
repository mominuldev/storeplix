# QA gate: Phase 8.8d part B (POS — held sales, sales history, returns at the till)

## Re-gate, 2026-11-25 · `feat/phase-8-8d-pos-b` @ 4b8f027 — **Verdict: PASS**

P88DB-QA-1 is fixed in `79e730b`: `variantCaption()` hides "Default" in the history receipt lines and in the Return
items dialog. `4b8f027` narrows `PosReturnInput.reason` to `PosReturnReason | null`, and ReturnDialog now builds its
select from `POS_RETURN_REASONS`. `0462b04` (ARCH) reconciled the docs and types, and openapi is now 1.22.0. There are
no API changes since the first gate (`git diff 742407e..4b8f027 -- apps/api` is empty), so the API full suite and
Postgres were not re-run, as agreed. The first gate's findings are kept below, unchanged.

| Check | Result |
|---|---|
| Playwright `phase8-8d-b.*`, each file alone | held 4/4 · history 2/2 · returns 5/5 · access 3/3 · visual **4/4** (incl. the QA-1 regression) |
| Playwright `phase8-8d-b.*` together | **18/18** |
| Playwright `phase8-8d-a.*` together (regression) | **27/27** |
| merchant-dashboard typecheck · lint · test · build | clean · 0 errors (46 warnings, unchanged) · **681/681** (43 files) · ok |
| super-admin typecheck · lint · test · build | clean · clean · **69/69** · ok |
| `packages/api-client` typecheck · lint · test · build | clean · clean · **204/204** (25 files) · ok |
| storefront typecheck · `tests/e2e` `tsc --noEmit` | clean · clean |
| `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` (1.22.0) | valid, 29 warnings |

**Spec change:** the QA-1 test in `phase8-8d-b.visual` is now an ordinary regression test ("a simple product shows no
\"Default\" variant caption in the receipt detail or the return dialog").

**New defects: none.** The environment was the same as the first gate: API on :8011 and vite on :5185 against a fresh
`.backup` of the dev DB. The user's servers and the dev DB were left alone, and everything was stopped and deleted at
the end.

---

## First gate (2026-11-25 · @ f15f948) — FAIL

Date: 2026-11-25 · Branch `feat/phase-8-8d-pos-b` @ f15f948 (API `0bb1b83`, `fee5570`; WEB `738aee0`, `d1f2c71`,
`3daae39`, `f15f948`; part A merged as #20 `f2f2043`) plus the QA files of this gate · Contract PHASE-8-8D §9,
§10 (part B rows), §11.6, §11.7, §11.9, §13 (S206, S207 and the part-A items as they apply to B), §14, §16 AC 7–9.
Reviewer: QA.

**Verdict: FAIL** on one cosmetic defect, with no money, stock or security impact. Everything else is green:
- held sales: park, resume, sell, the 20 limit, `held_sale_id` rules, no stock reserved, deleted on close;
- sales history: KPIs, filters, detail, reprint, SMS;
- returns at the till: cash, bKash, card, partial, over-return, `drawer_short`, `register_closed`, restock at the line's location, the drawer and close variance;
- permissions, plan and isolation;
- Pest on sqlite, Postgres and RLS, including the two new races;
- the part A regression.

The real UI↔API integration held on every path this time.

| ID | Severity | Owner | Summary |
|---|---|---|---|
| P88DB-QA-1 | Low | WEB | The receipt detail and the Return items dialog print the placeholder variant title "Default" for simple products ("Default · Qty 2", "Default · 1 of 2 returnable"); every other screen hides it |

The documented build-vs-docs gaps (return `reason` enum, 409 `return_not_allowed`, no returns list on `PosSale`,
returns lock the session FOR UPDATE, history defaults, `orders.refund` before the plan) are **not** flagged. The specs
assert the built behaviour.

## 0. Defects

### P88DB-QA-1 (Low, WEB): "Default" variant caption on simple products

**Where:**
- `apps/merchant-dashboard/src/pos/HistoryPage.tsx` l. 365: `[i.variant_title, `Qty …`, …].filter(Boolean)`.
- `ReturnDialog.tsx`, the line caption: `[i.variant_title, `${max} of ${qty} returnable`]`.

`OrderItem.variant_title` is `"Default"` for a product without options. Orders (`OrderDetailPage` l. 254,
`OrderEditPage`, `CreateOrderPage`) and the POS cart all hide it.

**Reproduction:** sell a QA Muslin Wrap ×2 at the till, open Sales history and click the receipt. The line reads "QA
Muslin Wrap / **Default** · Qty 2", and **Return items** shows "Default · 2 of 2 returnable". The screenshot is
`tests/e2e/test-results/phase8-8d-b-visual/390/06-receipt-detail.png`. Playwright: `phase8-8d-b.visual` › "P88DB-QA-1 …",
which is last in its serial file.

**Proposed fix:** use `i.variant_title !== 'Default' ? i.variant_title : null` in both captions, as Orders does, or a
shared `variantCaption()` helper. Add a Vitest case for a simple-product line.

## 1. What ran

The stack ran locally against a **scratch copy** of the dev DB: `.backup`, then `migrate` (`2026_12_10_000300` held
sales, `000400`). The same `DB_DATABASE` was exported to Playwright, and the dev DB was not touched.
- API: `artisan serve` on **:8011** with `PAYMENTS/COURIERS/DOMAINS_FAKE=true SMS_DRIVER=fake CACHE_STORE=file`, plus one `queue:work`.
- Merchant dashboard: vite on **:5185**, proxied to :8011.
- The pre-existing dev servers on :8010, :5183, :5184 and :3010 were left alone. :8000, :5173 and :3000 were not touched.

A scratch Postgres 18 cluster ran on :55433 in **UTC**, with the CI roles from `01-roles.sql`.

| Check | Result |
|---|---|
| Full API suite, sqlite (`--exclude-group perf --exclude-group race`) | **1458 tests: 1407 passed, 51 skipped, 0 failed** |
| Pest `--group=pos`, Postgres **RLS on**, app role | **56/56** |
| Pest `--group=rls`, RLS on | **48/48** |
| Pest `--group=pos`, Postgres (superuser) | 56: 55 passed, 1 skipped (`PosRlsTest`, which needs RLS on) |
| 6 POS races, one process each, Postgres and again with RLS on (the 4 from part A, plus `test_two_resumes_of_one_held_sale_complete_it_once` and `test_a_cash_return_racing_the_close_is_counted_in_it_or_refused_and_two_never_empty_the_drawer_twice`) | **6/6 + 6/6, none skipped** |
| merchant-dashboard typecheck · lint · test · build | clean · 0 errors (46 warnings, `react-refresh/only-export-components`) · **680/680** (43 files) · ok |
| super-admin typecheck · lint · test · build | clean · clean · **69/69** · ok |
| `packages/api-client` typecheck · lint · test · build | clean · clean · **204/204** (25 files) · ok |
| storefront typecheck · `tests/e2e` `tsc --noEmit` | clean · clean |
| Playwright `phase8-8d-b.*` (5 files, 18 tests), each alone | held 4/4 · returns 5/5 · history 2/2 · access 3/3 · visual 3/4 (QA-1) |
| Playwright `phase8-8d-b.*` together | **17 passed, 1 failed (P88DB-QA-1)** |
| Playwright `phase8-8d-a.*` (regression, 7 files, 27 tests) together | 24 passed. `visual` failed because it still listed "Hold sale" as a part-A omission; QA updated it (§5), and it re-ran **3/3**, giving **27/27** |
| `ci.yml` | parses as YAML. The discovery guard was run locally against the real file: it found the 6 POS races, each listed twice |

## 2. Acceptance criteria (§16, part B and the screens)

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 7a | Held sales park and resume without reserving stock (S207) | **`held` spec:** a cart (Wrap ×2, new phone + name) → **Hold sale** dialog with "Held sales don’t hold stock. Items are checked again when you resume." and note "Trying another size" → 201. The cart empties, "Held · 1" shows, and Mirpur stock is unchanged at 5. Drawer card: "QA Held Buyer", "2 items", "৳ 1,000", "“Trying another size”"; client search filters and shows "No held sales match.". **Resume** brings the lines, quantity, phone and name back → Charge (card) sends `held_sale_id` → 201, the held sale is gone (GET 404), and "Held · 0" / "No held sales". **No reservation:** hold 3, another register sells the 3, resume → the line alert shows and Charge is disabled; the API sale → 422 `out_of_stock` and the held sale is kept. A `held_sale_id` from another register, unknown, or already completed → 422 on `held_sale_id`. 20 held → the 21st gets 409 `held_sales_limit`, and the UI shows "This register already has 20 held sales. Resume or delete one first."; Delete from the drawer leaves 19. **Close:** "19 held sales will be deleted" warning; after the close the list is empty; another register's held sales are untouched; holding on a closed session → 409 `register_closed` | **Met** |
| 7b | Sales history KPIs match the orders | **`history` spec, API:** 4 sales (R1 cash ৳ 1,000, bKash ৳ 1,200 with phone, split ৳ 500; R2 card ৳ 1,400) and a ৳ 500 cash refund → `summary = {sales 360000, receipts 4, average 90000, returns 1 / 50000}`, page size 50. Register filter → R2 only (৳ 1,400); `method=split`; `q` = exact number or local phone (all days); a partial number → none; yesterday → empty with zero KPIs; a custom range > 366 days → 422. **UI:** defaults to the session's register ("Register 1 · Mirpur shop · Today": ৳ 2,200, 3 receipts, ৳ 733.33 average, returns "1 · ৳ 500"). "All registers" → `register=all`, 4 rows, ৳ 3,600 / ৳ 900. Register 2, Split, search and Yesterday drive the URL and the table; the filtered empty state "No sales match these filters" + Clear filters. The row "Return" tag; the detail "Partly refunded", Cash received ৳ 1,500, Change given, − ৳ 500 | **Met** |
| 7c | Returns restock at the shop and refund from the drawer with `orders.refund` (S206) | **`returns` spec, UI:** History → receipt → **Return items** → "Return one more QA Muslin Wrap", reason Damaged, Cash (the default for a cash sale) → 201 with an Idempotency-Key, `return_request.status refunded`, and refund `{50000, cash, pos_session_id}`. Pill "Partly refunded", the row "Return" tag, KPI returns "1 · ৳ 500". Mirpur 2 → 3 and online unchanged, with one +1 ledger row at Mirpur. Session `cash_refunds 50000`, drawer 270000. The stepper then stops at 1 (sold − returned). **API:** a bKash full return (`refunded_amount 140000`) and a card return don't touch the drawer; over-return → 409 `return_not_allowed` (also on a fully returned sale); a free-text reason → 422; no key → 400. **`drawer_short`:** a cash refund on a ৳ 0 drawer → 422 via the API, and the UI shows "There isn’t enough cash in the drawer for this refund…"; switching to Card → 201, stock back at Mirpur. A closed session → 409 `register_closed`. **Close:** "− Cash refunds ৳ 500", Expected ৳ 2,700; counting ৳ 2,700 → "Drawer matches"; Returns "3 · ৳ 2,400". **Staff** (no `orders.refund`): API 403 `forbidden`, the receipt is readable, Reprint shows, and there is no Return items button | **Met** |
| 8 | Figma `22:2409`, `27:754` with the omissions; loading/empty/error; 390 px | **`visual` at 1280 and 390 px**, with no page overflow and no console errors: the hold dialog (the Q242 copy, no "reserved for 30 minutes"), the held drawer (full width at 390), history with the KPI tiles, the receipt detail, and the return dialog (Refund method radiogroup). "Void receipt (manager PIN)" and "Return or exchange items" are absent. Empty "No sales yet today" and "No held sales". **Except P88DB-QA-1** | **Not met** (QA-1) |
| 9 | Suites green | Pest on sqlite, Postgres and RLS, races, Vitest and typecheck: green. Playwright: 1 red (QA-1) | **Not met** until the fix |

## 3. Security checklist (part B)

| Item | Pest (API) | Playwright (QA) |
|---|---|---|
| S195 isolation (held sales, returns) | `PosHeldSalesApiTest`, `PosReturnsHistoryApiTest` tenancy cases; `PosRlsTest` (4 tables) | `access`: A's held sale (GET/DELETE), return and sale through B's path or session → **404**, nothing deleted. B's register in the held list and the history filter, B's session in hold and return, B's variant in hold, and another sale's order item → **422** on that field |
| S196 permissions | route map, `test_returns_need_orders_refund_and_the_plan_and_stay_in_the_tenant` | `access`: an orders.view role → 403 on the held list, hold, get, delete, history and return. A `pos.sell`-only cashier reads the held list and history, but a return → 403. Staff UI: no Return items |
| S197 plan | plan tests | `access`: after a downgrade, hold and return → 402, and a role without `orders.refund` still gets 403 first; history, sale detail and the held list stay readable; held delete works |
| S206 returns | quantity bounds, restock location, refund ≤ paid − refunded, cash refund needs an open session and ≤ drawer; race "cash return vs close / two returns never empty the drawer twice" (Postgres + RLS) | `returns` (above) |
| S207 held sales + audit | held CRUD, limit, `held_sale_id` must match the register, deleted on close, audit `pos_held_sale.deleted`; race "two resumes complete it once" | `held` (above) |
| S200 idempotency (returns) | `idempotent:pos.return` | the UI return carries a key; no key → 400 |

## 4. CI (owned by QA)

- The `pos` group steps (sqlite, Postgres, RLS) and the "race list complete (discovered)" guard from part A cover part B: the new tests are in `#[Group('pos')]`.
- `api-perf` and `api-rls` race loops: added `test_two_resumes_of_one_held_sale_complete_it_once` and `test_a_cash_return_racing_the_close_is_counted_in_it_or_refused_and_two_never_empty_the_drawer_twice`. Without them the discovery guard would fail.
- CI still has no Playwright job; `phase8-8d-b.*` runs locally (as part A).

## 5. QA files

- `tests/e2e/support/pos.ts`: part B helpers (held sales, history, returns, `returnByVariant`, `historyUrl`).
- `tests/e2e/specs/phase8-8d-b.{held,history,returns,access,visual}.spec.ts`.
- `phase8-8d-a.visual`: "Hold sale" is no longer an omission, because it shipped in part B.

## 6. Notes (not blocking)

- A held sale for a phone that wasn't a customer yet resumes as a new customer: the phone and name go back into the boxes. The customer is created by the sale, not by the hold.
- The held-sales drawer keeps its search text when it is reopened, so after a search the next opening can show "No held sales match.".
- History opens on the session's register. "All registers" sets `register=all`.
- Average sale is rounded to the paisa ("৳ 733.33").
- Screenshots: `tests/e2e/test-results/phase8-8d-b-visual/{1280,390}/`.

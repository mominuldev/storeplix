# QA gate: Phase 8.8d part A (POS — sell, open/close)

## Re-gate, 2026-11-25 · `feat/phase-8-8d-pos` @ dd041de — **Verdict: PASS**

The three defects of the first gate are fixed and verified on the real stack. The `ApiError.details` widening
(`f0f2217`, `dd041de`) does not break field errors on forms. The first gate's findings are kept below, unchanged.

| ID | Fix | Verification |
|---|---|---|
| P88DA-QA-1 | `6659714` (API): `counts: {}` means ৳ 0 on open and close | `access` › "an empty drawer (৳ 0) opens and closes from the count table": open sends `{counts: {}}` → 201, close at ৳ 0 → 200, session `opening 0 / counted 0 / variance 0` |
| P88DA-QA-2 | `6252d70` (WEB): a scanned variant keeps its options | `stock`: the scan in the UI flow, plus the dedicated test, show "L · ৳ 1,400" |
| P88DA-QA-3 | `6cb0a78` (WEB): `PaymentDialog` ignores close requests for 400 ms after it opens | `double`: a double-click on Charge keeps one "Take payment" dialog, both in-flow and in the dedicated test |

The three defect tests are now ordinary regression tests: no defect IDs in their titles and no "expected fail". The
QA-2 and QA-3 checks are also asserted inside the main flows again.

**What ran (re-gate):**

| Check | Result |
|---|---|
| Full API suite, sqlite (`php artisan test --exclude-group perf --exclude-group race`) | **1448 tests: 1397 passed, 51 skipped, 0 failed** |
| merchant-dashboard typecheck · lint · test · build | clean · 0 errors (46 warnings, all `react-refresh/only-export-components`) · **662/662** (42 files) · ok |
| super-admin typecheck · lint · test · build | clean · clean · **69/69** (6 files) · ok |
| `packages/api-client` typecheck · lint · test · build | clean · clean · **199/199** (24 files) · ok |
| storefront typecheck · `tests/e2e` `tsc --noEmit` | clean · clean |
| Playwright `phase8-8d-a.*` (7 files, 27 tests), each file alone | access 7/7 · stock 4/4 · orders 2/2; sell 4/4, double 4/4, visual 3/3 and form-errors 3/3 after one re-run (below) |
| Playwright `phase8-8d-a.*` together | **27/27 passed** (second run; the first lost `access` to a "database is locked" 500 in the shop setup's `POST /categories`, with 6 tests not run) |
| Form-error regression (new `phase8-8d-a.form-errors`) | **3/3**: a 422 `validation_failed` from the API shows its exact field message under **Phone** on Customers › Add customer (duplicate phone), under **Name** on Warehouses › Add location (taken name), and under **Name** on POS › Add register (`register_name_taken`) |
| Playwright regression: `phase8-3.roles`, `phase8-3.editor`, `phase5.merchant-orders`, `phase5.manual-order`, `phase8-8c-b.transfer`, `phase4.inventory`, `phase6.domains` | 23 passed, 3 failed, 11 not run, **none caused by this branch**. `phase5.merchant-orders` l.157 is the pre-existing hidden-`.first()` drift from §6. `phase4.inventory` "20 parallel −1 adjustments" is the documented sqlite flake: the log shows `database is locked` on `update "inventories"`, and the invariant part passed. `phase6.domains` fails at l.103 because `ask` → 401: the ask key in the spec doesn't match the gate API's env, so it is environmental. That serial file then skips its later tests, including the inline-error test. The new `form-errors` spec covers the field-error regression instead |

No Postgres was run, as agreed: nothing in the fixes touches RLS.

**Spec changes in the re-gate:**
- `support/pos.ts` `serverErrorsSince()` also ignores `testing.ERROR` lines. A concurrent `php artisan test` run writes to the same `laravel.log`; that caused the first `sell` failure in the re-gate.
- `phase8-8d-a.form-errors.spec.ts` is new.
- The defect tests were renamed into regression tests (see above).
- The `visual` and `double` specs were slow in the first pass (about 15 min) only because the full Pest suite ran at the same time; they took 1.7 min together afterwards.

**New defects: none.**

**Environment:** the same as the first gate. API on :8011 and vite on :5185 ran against a fresh `.backup` of the dev DB, with `migrate` applied, `CACHE_STORE=file` and the fake drivers. The pre-existing servers on :8010, :5183, :5184 and :3010 were left alone.

---

## First gate (2026-11-25 · @ b21021e) — FAIL

Date: 2026-11-25 · Branch `feat/phase-8-8d-pos` @ b21021e (API `dbe2639..b21021e`, WEB `114bbff..46c1238`) plus the QA
files of this gate · Contract PHASE-8-8D §13 (S195–S205), §14, §16 part A (AC 1–6, 8, 9 for part A), §11.9.
Reviewer: QA.

**Verdict: FAIL.** The API, the Pest suites (sqlite, Postgres, RLS, races) and the till flow itself are green, and the
real UI↔API integration held up on every main path (open with counts, cash with change, bKash, card, split, SMS
receipt, close under and over tolerance, stock at the register location, double-tap safety, the orders tag and chip).
Three defects block a PASS; all three are small and have a failing Playwright test that turns green with the fix.

| ID | Severity | Owner | Summary |
|---|---|---|---|
| P88DA-QA-1 | **Medium** | API (or WEB) | An empty drawer can't be opened or closed from the count table: the SPA sends `counts: {}` and the API answers 422 "The given data was invalid." |
| P88DA-QA-2 | Low | WEB | A scanned variant of a multi-variant product loses its options in the cart line ("৳ 1,400" instead of "L · ৳ 1,400") |
| P88DA-QA-3 | Low | WEB | A double-tap on **Charge** opens the payment dialog and the second tap, landing on its backdrop, closes it again |

No sale is ever duplicated or lost by any of them; money, stock and the ledger stay correct.

## 0. Defects

### P88DA-QA-1 (Medium, API or WEB): ৳ 0 drawer → 422 on open and close

**Where:** `apps/merchant-dashboard/src/pos/pos.ts` `textsToCounts()` drops zero counts, so a table with every count
blank or 0 becomes `counts: {}`; `PosPage` sends `{counts: {}}` to open and `ClosePage` sends `{counts: {}, …}` to close.
`OpenPosSessionRequest` / `ClosePosSessionRequest` use `required_without:counts` on `opening_cash_amount` /
`counted_cash_amount`, and Laravel treats an empty array as absent.

**Reproduction:**
- UI: Growth shop, Register 1 closed, last session left ৳ 0 (or clear the prefilled counts). On `/pos` the opening total
  reads "৳ 0" and **Open register and start selling** is enabled. Click it: toast "The given data was invalid.", and the
  register stays closed.
- UI: on an open session with expected ৳ 0 (for example a ৳ 0 float and card-only sales), go to **Close register**. Type
  0 in any count; "Drawer matches" shows and Close is enabled. Confirm: red "The given data was invalid.", and the
  session stays open.
- API: `POST …/pos/registers/{id}/open {"counts":{}}` → 422 `opening_cash_amount` "required when counts is not
  present". `POST …/pos/sessions/{id}/close {"counts":{},"left_in_drawer_amount":0,"revision":n}` → 422
  `counted_cash_amount` …. With `{"counts":{"100000":0}}` the API closes fine (200).
- Playwright: `phase8-8d-a.access` › "P88DA-QA-1: an empty drawer (৳ 0) opens and closes from the count table".

**Why it matters:** opening without a float, and closing a drawer after everything was banked or after card-only
trading, are normal shop situations (P88D-15 allows `opening_cash_amount ≥ 0`). After a downgrade this is the only
write left (P88D-19).

**Proposed fix (either side; API preferred, so every client gets it):**
- API: treat a present `counts` key as the count, even when it is empty. For example `'counts' => ['present_without:…'` or
  `Rule::requiredIf(! $this->has('counts'))` on `opening_cash_amount` / `counted_cash_amount` instead of
  `required_without:counts`, with `Σ {} = 0`. Add Pest cases: open `{counts: {}}` → 201 with 0, and close
  `{counts: {}}` → 200 with counted 0.
- Or WEB: when the counts sum to 0, send `opening_cash_amount: 0` / `counted_cash_amount: 0` instead of `counts: {}`. Add
  a Vitest case for each.

### P88DA-QA-2 (Low, WEB): scanned variant shows no options in the cart

**Where:** `pos.ts` `addToCart()` sets `variantTitle: item.variants.length > 1 ? variant.title : ''`. `GET …/pos/lookup`
returns the product with **only the matched variant** (as specified in §5.3), so a scanned "QA Cotton Kurta · L" gets an
empty title.

**Reproduction:** on the sale screen, type Kurta L's SKU in "Search products or scan a barcode" and press Enter. The cart
line reads "QA Cotton Kurta / ৳ 1,400". The same variant picked through the picker reads "L · ৳ 1,400". Scanning M and L
gives two lines with the same name and no size. The receipt is right, because it uses the server's `variant_title`.
Playwright: `phase8-8d-a.stock` › "P88DA-QA-2 …".

**Proposed fix:** `variantTitle: variant.options.length > 0 ? variant.title : ''`. A simple product's only variant has
`options: []`. Add a Vitest case: `addToCart` with a lookup-shaped item (one variant that has options) keeps the title.

### P88DA-QA-3 (Low, WEB): double-tap on Charge closes the payment dialog

**Where:** `SalePage` opens `PaymentDialog` (a `Modal` built on the native `<dialog>`) on the first click. The second click
of a double-tap lands on the new dialog's backdrop, and `Modal` closes on any click whose target is the dialog element
(`packages/ui/src/components/Modal.tsx` l. 78).

**Reproduction:** add a product and double-click **Charge ৳ x**. The "Take payment" dialog flashes and is gone. A
double-click on **Complete sale** is safe: one POST, one order. Playwright: `phase8-8d-a.double` › "P88DA-QA-3 …".

**Proposed fix:** in `SalePage`, ignore `onClose` from the payment dialog for about 400 ms after it opens (for example
`openedAt` in the `paying` state). Or give `Modal` an opt-out of backdrop dismissal (`dismissOnBackdrop={false}`, a
`packages/ui` change that needs ARCH's agreement) and use it on the payment dialog, which holds money input anyway.
Add a Vitest case that a click on the backdrop within 400 ms of opening keeps the dialog.

## 1. What ran

The stack ran locally on the branch's code against a **scratch copy** of the dev DB: `.backup` into the scratchpad, then
`migrate` (`2026_12_10_000100/000200/000400`). The same `DB_DATABASE` was exported to Playwright. The dev DB was not
touched.

- API: `artisan serve` with `PAYMENTS/COURIERS/DOMAINS_FAKE=true SMS_DRIVER=fake CACHE_STORE=file`, plus one
  `queue:work default,notifications,bulk`.
- Merchant dashboard: vite.

**Ports note.** :8010, :5183, :5184 and :3010 were already held by dev servers that an earlier session had started on the
dev DB, without the fake flags. Stopping them was not permitted, so this gate ran its own API on **:8011** and its own
merchant vite on **:5185** (`VITE_API_PROXY_TARGET=http://localhost:8011`, `SANCTUM_STATEFUL_DOMAINS=localhost:5185`).
Playwright got `API_URL` and `MERCHANT_URL`. :8000, :5173 and :3000 were not touched. The storefront UI was not needed:
storefront tracking was checked through the API.

A scratch Postgres 18 cluster ran on :55433 in **UTC**, with the CI roles loaded from `01-roles.sql`.

| Check | Result |
|---|---|
| Full API suite, sqlite (`php artisan test --exclude-group perf --exclude-group race`) | **1447 tests: 1396 passed, 51 skipped, 0 failed** |
| Pest `--group=pos`, Postgres (superuser) | 45 tests: 44 passed, 1 skipped (`PosRlsTest`, which needs RLS on) |
| Pest `--group=pos`, Postgres **RLS on**, app role | **45/45 passed** |
| 4 `PosRaceTest` races, one process each, Postgres (superuser) and again with RLS on | **4/4 + 4/4 passed, none skipped** |
| RLS on: `rls` | 48/48 |
| RLS on: `roles` | 73: 72 passed, 1 skipped |
| RLS on: `reports` | 16/16 |
| RLS on: `locations` | 25: 23 passed, 2 skipped (backfill, by design) |
| RLS on: `security` | **564/564** |
| RLS on: `stocktransfer` | 24/24 |
| RLS on: `fraud` | 59/59 |
| RLS on: `automations` | 32/32 |
| RLS on: `tenancy` | 114/114 |
| merchant-dashboard typecheck · lint · test · build | clean · 0 errors (warnings only) · **659/659** (42 files) · ok |
| super-admin typecheck · lint · test · build | clean · clean · **67/67** · ok |
| `packages/api-client` typecheck · lint · test · build | clean · clean · **197/197** · ok |
| storefront typecheck | clean |
| `tests/e2e` `tsc --noEmit` | clean |
| `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` | valid, 29 warnings (unchanged) |
| Playwright `phase8-8d-a.*` (6 files, 24 tests), each file alone | sell 4/4 · orders 2/2 · visual 3/3 · access 6/7 · stock 3/4 · double 3/4 |
| Playwright `phase8-8d-a.*` together | **21 passed, 3 failed**. The 3 failures are exactly P88DA-QA-1/2/3; nothing else failed |
| Playwright regression: `phase8-3.roles`, `phase8-3.editor`, `phase5.merchant-orders`, `phase5.manual-order`, `phase8-8c-b.transfer`, `phase4.inventory` | 26 tests: 25 passed, 1 failed. The failure is pre-existing spec drift, not caused by 8.8d (§6) |
| `ci.yml` | parses as YAML. The new discovery guard was run locally against the real file and found the 4 POS races, each listed twice |

On sqlite the known "database is locked" flake hit twice during spec development (once in a cache write during shop
setup, once in storefront tracking), and the re-run passed. The specs retry locked writes (`retryLocked`). They also
check `laravel.log` for server errors other than the lock flake (`serverErrorsSince`), and a GET 500 from the lock is
tolerated in the network watch because TanStack Query retries reads.

### The two `security` failures from the API agent's run

`Tests\Feature\Expenses\ExpenseImpersonationAndLimitsTest::test_limiters` and
`Tests\Feature\Expenses\ExpenseReceiptsTest::test_upload_sniffing_matrix` **pass on this branch**:

- in the full sqlite suite;
- in `--group=security` on Postgres with RLS on (564/564).

Both write expense receipt files to local storage (the size limiter and the MIME sniffing matrix). The API agent's run
failed them while the disk was full. They are therefore **environmental (disk full)**: they are neither pre-existing on
`main` nor caused by this branch. No A/B against `main` was needed, because they don't fail here.

## 2. Acceptance criteria (§16, part A)

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | A store without `pos` behaves as before; all pre-existing tests pass unchanged | Full Pest suite 1447/0 failed. RLS groups `roles`, `reports`, `locations`, `security`, `stocktransfer`, `fraud`, `automations` and `tenancy` are green. Vitest is green in all three SPAs and packages. The Playwright regression subset is in §6. The `access` spec checks that Starter sees only the plan note | **Met** |
| 2 | A register opens with a counted float, sells, and closes with counted cash; expected, variance, banked and left are computed on the server and match the payment ledger (S201) | **`sell` spec:** counts 1 × ৳ 1,000 + 2 × ৳ 500 → "৳ 2,000". The open POST body is `{counts: {"100000":1,"50000":2}}` with an Idempotency-Key. Cash in drawer goes ৳ 2,000 → ৳ 3,000 after a cash sale of ৳ 1,000 (tendered ৳ 1,500, change ৳ 500) → ৳ 3,200 after a split with ৳ 200 cash. `totals` = cash ৳ 1,200 / bKash ৳ 1,500 / card ৳ 500, 4 receipts. The close shows Expected ৳ 3,200. Counted ৳ 3,180 gives "Short by ৳ 20 · Within your ৳ 50 tolerance"; leave ৳ 2,000 (prefilled = opening) gives Banked ৳ 1,180. The response is `expected 320000, counted 318000, variance −2000, left 200000, banked 118000` with the note. The Last session card reads "৳ 3,200 · 4 receipts", "৳ 3,180", "−৳ 20", "৳ 1,180", "৳ 2,000". Re-open is prefilled ৳ 2,000 with "Matches last closing". ৳ 100 over shows the danger copy; Close stays disabled until a note is typed; the API without a note gives 422 `close_note_required` (`variance_amount 10000`, `tolerance_amount 5000`); left > counted gives 422. **Except P88DA-QA-1 (a ৳ 0 drawer)** | **Not met** (QA-1) |
| 3 | Every till sale is one delivered, paid `pos` order; it shows in Orders, Dashboard, Sales report and P&L, and never in delivery, courier, tracking, fraud-guard or automation flows (S205) | **`sell`:** 4 sales → orders `created_via pos`, `channel walk_in`, `delivered`, `paid`, `payment_method pos`, `pos.register_name` "Register 1"; walk-in customer "Walk-in customer" / phone "" / no shipment; the new phone customer (8801…) has orders 1 and ৳ 1,200 spent. **`orders`:** `filter[created_via]=pos` returns only till sales and `=dashboard` only the manual order. Sales report channel `walk_in` 2 orders / ৳ 1,700, and the district breakdown has no '' and no till sale. P&L revenue ৳ 1,700 from 2 delivered orders, delivery cost 0, product cost ৳ 900 (the `unit_cost` snapshot). Delivery report has no couriers and no returning. Storefront `orders/track` for a till sale → 404. `label_4x6` → 422; `invoice_a4` is allowed; courier booking is refused and `shipment` stays null. Dashboard KPIs, fraud-guard and automations are covered by Pest `PosReadersTest` (S205) | **Met** |
| 4 | Stock leaves only the register's location, never beyond its available, through `InventoryService` with `pos_sale` (S199); a retried or double-tapped sale makes one order (S200) | **`stock`:** Mirpur 2 → sale of 3 gives 422 `out_of_stock` with `details["lines.0.quantity"] = ["Only 2 left at Mirpur shop."]` and nothing written. Sale of 2 → Mirpur 0, Main (online) still 10, one `pos_sale` row of −2 at Mirpur with `reference {type: order, id}`. At 0 → "None left at Mirpur shop.". UI: the tile is disabled with "Out of stock"; the picker stops at 2. Stock taken by another till while the payment dialog is open → 422 → the dialog closes, the cart notice and the line alert "Only 1 left at Mirpur shop." show with "Refresh cart", no order is written; − to 1 → 201. **`double`:** a double-click on Complete sends one key → 1 order and 1 ledger row. A lost response (the server sold, the browser got a network failure) → "We couldn’t reach the server…", the pill shows "Offline — reconnect to charge", the 5 s probe brings it back Online, and Complete again **reuses the same key** → 201 replay, still one order. API: no key → 400; same key in parallel → one order; replay → the same `order_id`; other body → 409 `idempotency_key_mismatch`. Pest races (Postgres and RLS): till + checkout oversell, double-tap. **Note:** P88DA-QA-3 (double-tap on Charge dismisses the dialog) loses no sale | **Met** (QA-3 is UX only) |
| 5 | Cash with change, bKash, card and split are manual payment rows bound to the session; Σ = total (S201) | **`sell`:** payment rows `[cash 100000]`, `[bkash_personal 120000 ref TRX8D0001]`, `[card 50000 ref APPR-77]`, `[cash 20000, bkash_personal 30000 ref TRX8D0002]`, each `provider manual`, `status succeeded`, `pos_session_id` = the session. Tendered 150000 and change 50000 are on the sale. Order detail shows "Till · Register 1". Split UI: "Remaining ৳ 300" → **Rest** → "Fully paid" | **Met** |
| 6 | Receipts print at 80 mm from the browser; SMS receipts respect the tick, the allowance and sanitising (S204) | `window.print` stubbed: called **once** on complete with Print receipt ticked, not called when unticked, and called by Print Z-report. The receipt preview shows the number (= order number), lines, ৳ 1,000, tendered ৳ 1,500, change ৳ 500, and the coupon code. SMS: walk-in → tick disabled and status `no_phone`; phone sale → tick on by default and status `queued`/`sent`; the fake driver wrote exactly **one** `sms_messages` row, purpose `pos_receipt`, to `8801…`; there is no order-status SMS for till sales. Allowance and sanitising are covered by Pest | **Met** |
| 8 | Figma screens with documented omissions; loading/empty/error; 390 px usable (part A screens) | **`visual` at 1280 and 390 px**, with no page overflow and no console errors on Open register, Sale, Variant picker, Payment, Sale complete, Close register, and with the omissions absent (Hold sale, Scanner ready, Open drawer, Void receipt / manager PIN; Cashier read-only). All 10 denominations show (P88D-15). At 390 px: 2-column catalog, sticky "Cart is empty" / "Charge ৳ 1,700 · 2 items" bar, cart bottom sheet, payment full width with numpad and "Give 1 × 200, 1 × 100". States: "Set up your first register" + "Create Register 1 at Main warehouse" (390 and 1280 px), "No products match — try another name or scan the barcode", catalog loading, catalog error "We couldn’t load products" + retry. Screenshots are in `tests/e2e/test-results/phase8-8d-a-visual/{1280,390}/` | **Met** |
| 9 | Suites green | Pest on sqlite, Postgres and RLS; races; typecheck; Vitest; openapi lint: green. Playwright `phase8-8d-a.*`: 3 red (QA-1/2/3) | **Not met** until the fixes land |

## 3. Security checklist (S195–S205)

| Item | Pest (API) | Playwright (QA) |
|---|---|---|
| S195 isolation | `PosRegistersSessionsApiTest`, `PosSalesApiTest`, `PosCatalogApiTest` isolation cases; `PosRlsTest` (RLS on 3 tables) | `access`: A's session, sale, SMS, close, open, patch and archive through B's path or session → **404**. B's `register_id` in catalog/lookup, `session_id` in quote/sale, `variant_id` in quote, and `location_id` in register create → **422 on that field**. Nothing is written |
| S196 permissions | route-map and O/A/S/C matrix, impersonation 403 | `access`: an orders.view-only role → **403 `forbidden` on all 12 POS routes**, no POS in the sidebar, `/pos` and `/pos/:id` show the no-access page. A cashier-only role (`pos.sell`) sells (`cashier_name` = the actor) and gets 403 on register create/patch/archive. System Staff has POS and no "Add register" |
| S197 plan | plan/downgrade tests | `access`: Starter → plan note "POS is on the Growth plan" + See plans, no Open form; register create / open / unarchive → 402. Downgrade with an open session → quote and sale 402, "Registers still open" → Close register works (200), re-open 402 |
| S198 price integrity | quote/sale pricing and coupon tests | `stock`: coupon `QA8D100` priced by the server (৳ 1,400 − ৳ 100 = ৳ 1,300). An unknown coupon → 422 `coupon_invalid` with an inline error. A stale `expected_total_amount` → 409 `checkout_changed` with `details.quote` (total 130000) and a ৳ message; the UI shows "Prices or the coupon changed…" and re-charges at ৳ 1,300 (201). The receipt carries the coupon |
| S199 stock integrity | `InventoryService::sell` tests; race `test_parallel_till_sales_and_checkouts_on_one_location_never_oversell` (Postgres + RLS) | `stock` (above); `sell`: −2 at Mirpur, online unchanged, one ledger row |
| S200 idempotency | replay tests; race `test_a_double_tapped_sale_makes_one_order` | `sell` (open: same key replays the session; other body → 409; no key → 400), `double` (sale) |
| S201 cash integrity | open/close maths, tolerance, banked/left; races `test_parallel_opens_of_one_register_open_one_session`, `test_a_sale_racing_the_close_is_counted_in_it_or_refused` | `sell` (a), (c); `access` "register_already_open" with `details.session_id`; **P88DA-QA-1** |
| S202 session binding | session tests | `access`: a session of another store → 422; the cashier is the actor; `held_sale_id` → 422 in part A |
| S203 customer lookup | exact phone, limiter | `sell`: an unknown phone → 404 (new-customer name box); after the sale the same local phone → 200 summary (name, 1 order, ৳ 1,200) |
| S204 SMS receipt | job, allowance, sanitising, no phone | `sell` (above) |
| S205 reader safety | `PosReadersTest` + static allow-list | `orders` (above) |

## 4. CI (owned by QA)

- `api` (sqlite): new step "phase 8.8d-A group (pos)" (JUnit; fails when empty).
- `api-postgres`: new step "phase 8.8d-A pos (postgres)" (fails when empty).
- `api-perf`: the 4 POS races were added to the race loop: `test_parallel_till_sales_and_checkouts_on_one_location_never_oversell`, `test_parallel_opens_of_one_register_open_one_session`, `test_a_sale_racing_the_close_is_counted_in_it_or_refused` and `test_a_double_tapped_sale_makes_one_order`. A new step "phase 8.8d-A race list complete (discovered)" fails when the `pos` ∩ `race` set is empty or when a discovered test is missing from either race list.
- `api-rls`: the same 4 races were added to the RLS race loop, and a new step "phase 8.8d-A pos (RLS on)" runs through `run-group.sh`.
- As before, CI has no Playwright job; the `phase8-8d-a.*` specs run locally (see TESTING.md).

## 5. QA files

- `tests/e2e/support/pos.ts`: fixture `posShop` (Growth, "Mirpur shop" of type `shop` with stock through `/inventory/adjustments`, "Register 1"), POS API helpers, UI helpers, a `window.print` stub, the fake-SMS row reader and the log check.
- `tests/e2e/specs/phase8-8d-a.{access,sell,stock,double,orders,visual}.spec.ts`.
- `tests/e2e/support/roles.ts`: `pos.sell` was added to the e2e permission catalogue (`PermissionKey`, `LABEL` "Sell at the till (POS)").
- The defect tests sit **last** in their serial files, so a red defect test never skips the rest of the file.

## 6. Regression (Playwright)

`phase8-3.roles`, `phase8-3.editor` (permission catalogue +1 key), `phase5.merchant-orders`, `phase5.manual-order`
(orders list gained the POS chip), `phase8-8c-b.transfer`, `phase4.inventory`: **25/26 passed** together. The orders
list with the POS chip, the permission catalogue with `pos.sell`, transfers and inventory are all green.

The one failure is `phase5.merchant-orders` › "orders list: bulk confirm skips invalid states; dashboard and customer
counters follow". It failed again when run alone, at l. 157: `getByText('Rahim Uddin').first()` resolves 18 times, and
`.first()` is a **hidden** element on `/customers`. The visible table row "Rahim Uddin · Since Nov 2026 · Website" is
there. This branch changes nothing under `apps/merchant-dashboard/src/customers` or `apps/api/app/Domain/Customers`
(`git diff main...HEAD` is empty), so this is pre-existing spec drift of the kind in P88CA-QA-3 and is not an 8.8d
regression.

**QA follow-up (not blocking):** match the visible element (`.filter({ visible: true }).first()`) in that spec.

## 7. Notes (not blocking)

- "Receipt {number} · paid in cash / card / split" uses lower-case method names on purpose; bKash keeps its brand case.
- A walk-in sale reports `sms_receipt_status: "no_phone"` (not `not_requested`).
- At zero stock, the out-of-stock message reads "None left at {location}." instead of "Only 0 left …". This is better copy, and the SPA shows it verbatim.
- Reports are cached for 120 s per range (P7-18). A till sale shows in the Sales report and P&L within 2 minutes.
- Cleanup order matters for throwaway users: a cashier who sold can only be deleted once the tenant is gone (`pos_sales.cashier_id`). The `access` spec deletes tenants first.

# Phase 5a QA Review (Commerce: COD orders, cart, checkout, coupons, shipping, go-live)

- Date: 2026-11-22 (+06)
- Branch: `phase-5-commerce`. The 5a work of API, WEB and SF is uncommitted in the tree.
- Spec: `docs/development/PHASE-5-CONTRACT.md` (§0, §1, §3, §5, §7, §8, §10, §12, §13, §15); `docs/api/openapi.yaml` 1.5.0;
  `packages/types/src/index.ts`.
- Live target: the running dev stack.
  - API :8000 (`php artisan serve`, sqlite, WAL), one worker on `default,media,bulk` (**not** `notifications`, F-M1).
  - Merchant :5173 (Vite proxy). Storefront `next dev` on :3000 (`demo.localhost`, `{slug}.localhost`).
  - A **production build** of the storefront (`next build && next start`, separate `distDir`, port 3100) for the
    cache-header, mock-mode, local-IP and Server Action checks. Stopped and deleted afterwards.
- **Docker was not running** (`docker info` failed), so the compose Postgres was unavailable. As instructed, the
  Homebrew Postgres on this machine was not used. **The Postgres race tests were not run** (§15.2 = pending); the CI
  workflow now runs them and fails if any of them skips (§0).
- Throwaway tenants: every destructive flow (orders, deliver, refund, cancel, return, plan limit, publish blockers,
  throttles) ran on throwaway "QA …" tenants created through the SPA registration flow (`setupShop()`), each made
  reachable on `{slug}.localhost` with a test-only domain row. All of them were deleted after use.
- The demo store was only read (catalog, PDP, search, robots, sitemap, one `/discount` link without a cart).
- **Data restored.** The demo sqlite was backed up before the run, outside the repo. The final row counts equal the
  pre-run snapshot for every business table (§6). **Not restored:** `audit_logs` (803 → 1 324, including other
  agents' activity). The 7 test orders made by the SF and WEB agents before this review are still there; §6.2
  proposes their cleanup (not run).

**Verdict: NO-SHIP, until the Postgres race job has run green.** That is a gate, not a defect: no Critical or High
findings, 3 Medium, 7 Low.

- Every §10 control I attacked held on the live stack: tampering, idempotency, cross-store carts, foreign ids, key
  sets, tracking enumeration, draft stores, throttles, the state machine, staff limits, refunds, plan limit, Server
  Action CSRF and open redirects.
- The full shopper flow and the merchant flow work end to end in the browser, including the parts WEB never ran
  live: deliver, refund and the `launch_blocked` list.
- **§15.2 (no oversell, coupon limits under load) has never run anywhere.** The contract makes the race jobs the merge
  gate for step 3 (§14.4). Two harness problems (F-M2) could make them fail or flake in CI, not because of the app.
  Ship once `api-perf` → "race tests (postgres, must not skip)" is green and F-M2/F-M3 are addressed.

## 0. QA deliverables (§13)

| Area | Change |
|---|---|
| `tests/e2e/support/commerce.ts` (new) | • `sf()`: server-to-server storefront calls (key, host, client IP, cart token, idempotency key, preview), with timing.<br>• `setupShop()`: throwaway tenant + category + variable (M/L, cost) and simple product (cost, low threshold) + 3 zones (thana, whole district, fallback) + contact phone + **real publish**. `browserHost()` adds `{slug}.localhost`.<br>• `cartAdd`, `checkoutBody`, `expectedTotal`, `checkout`, `placeOrder`, `transition`, `inventoryOf`, `movements`, `forbiddenKeys()` (S7 deep key scan). |
| `tests/e2e/specs/phase5.*` (new) | 7 files, **23 tests**: `storefront-buy` 2, `merchant-orders` 3, `manual-order` 2, `coupons-shipping` 3, `onboarding-golive` 1, `security` 9, `mobile` 3. Details in TESTING.md §2c. |
| `tests/e2e/specs/phase4.{dashboard,onboarding05,storefront,inventory}` | Updated for intended 5a behaviour: the `orders` block is no longer always `null` (API + UI tiles); onboarding 05 now continues to `/onboarding/delivery`; product cards link to `/products/{slug}`; `committed_units` is real. |
| `.github/workflows/ci.yml` | • `api-perf`: `pcntl`+`posix`, `CACHE_STORE=array` (forked children must not share a Redis socket). The perf group now **fails when anything in it is skipped**.<br>• New step "race tests (postgres, must not skip)": the 7 fork-based tests (S2 ×2, S3, S4, S17, Phase 4 A8/A16), one process each, failing on `tests < 1` or `skipped > 0`.<br>• New step "checkout p95 budget": runs group `checkout-perf` and warns while it is empty (F-M3).<br>• `api-postgres`: `pcntl`+`posix`. `security (postgres)` runs `--exclude-group perf --exclude-group race`, because the race tests commit their rows (F-M2). Note: PHPUnit 12 ignores `--exclude-group=a,b`; the flag must repeat. |
| `.github/workflows/e2e.yml` | `STOREFRONT_API_KEY` = the compose-level key (in compose, `apps/api/.env` doesn't hold the key the API uses, so every `sf()` call would 401). `timeout-minutes` 30 → 45. |
| `docker-compose.yml` | New `queue-notifications` worker (`--queue=notifications --tries=3 --backoff=10,60 --timeout=60`). `docker compose config -q` passes. |
| `docs/development/TESTING.md` | Race-test row and local Postgres recipe, Phase 5 specs, throwaway shops, `E2E_PROD_STOREFRONT_PORT`, the notifications worker, T-41…T-50. |

### 0.1 Declared deviations (build agents) — verdicts

| # | Deviation | Verdict |
|---|---|---|
| D1 | A zone area clash returns 422, not 409 `zone_area_taken` | **Accept.** §3.5 itself says 422 (the area is "taken" within the same full-replace payload). ARCH: drop `zone_area_taken` from §3.0 / openapi. Live: 422 "Mirpur is already in A." ✓ |
| D2 | An unavailable item returns 422 `out_of_stock` at checkout | **Accept.** It matches §3.4 step 2 ("any issue line → 422 with its details"). Add-to-cart of a foreign or disabled variant gives 422 "This item isn't available." ✓ |
| D3 | SMS dedupe uses `order_events`, not an `sms_messages` lookup | **Accept.** `sms_messages` has no `order_id`. The check runs under the order row lock (`SendOrderSms.php:51-53`), and Pest proves one SMS on retry. See F-L3 for the failure path. |
| D4 | A malformed `Idempotency-Key` returns 400 | **Accept.** Live: 400. ARCH: name the code in openapi. |
| D5 | Manual orders are accepted while COD is off | **Accept** (the merchant collects however they like). Document it in §3.7. |
| D6 | With no zones, delivery is ৳ 0 (such stores can't publish) | **Accept.** Only manual orders on a draft store can hit it, and the UI offers "Change". |
| D7 | Inside Dhaka = 50 thanas | **Accept.** That is the dataset's city-thana count for Dhaka district. P5-8/Q37 still say "41 thanas": ARCH should update the copy. Live: onboarding 06 saved 50 areas ✓ |
| D8 | Dashboard counts are grouped by the month of `*_at` | **Accept.** E.g. delivered this month = `delivered_at` this month, which is what a merchant expects. Document it in §3.9. |

## 1. Command results

| Command | Result |
|---|---|
| `php artisan test` | **PASS**: 380 tests (373 passed, **7 skipped** = the Postgres-only race tests), 24 334 assertions, 30 s |
| `php artisan test --group=tenancy` | **PASS**: 63 tests, 818 assertions |
| `php artisan test --group=security` | **PASS**: 150 tests (143 passed, 7 skipped), 1 098 assertions |
| `php artisan test --group=perf` (sqlite) | **PASS**: 6 tests (1 passed, 5 skipped). 5 000-row import 3.4 s. Every race test skips on sqlite |
| `vendor/bin/pint --test` | **PASS** |
| `pnpm -r typecheck` | **PASS** |
| `pnpm -r lint` | **PASS**: 0 errors, **73 warnings** (ui 20, super-admin 1, merchant-dashboard 52; Phase 4: 41) |
| `pnpm -r test` | **PASS**: **799 tests**. merchant-dashboard 222, storefront 332, themes 125, api-client 74, ui 39, super-admin 6, config 1 |
| `cd tests/e2e && pnpm exec tsc -p .` | **PASS** |
| e2e Phase 5 (`phase5.*`, 23 tests) | All 7 files ran together once: 21 passed, plus the order-detail check that was then a `test.fail()` and passed by chance (F-L4 is content-dependent, so it's now an annotation). After the edits, mobile + security reran **12/12**; the other 5 files were unchanged and green (11/11). `E2E_PROD_STOREFRONT_PORT=3100` was set |
| e2e Phase 1–4 after the 5a changes | 4 specs failed on intended 5a behaviour (`orders` block, 05 → 06, card links, real `committed`); updated, all green. See §1.1 |
| Postgres race tests (S2, S3, S4, S17) | **NOT RUN** (no Docker; the Homebrew Postgres was off-limits). CI `api-perf` runs them and fails on skip |

### 1.1 Phase 2–4 regression run

`phase2`, `phase3`, `phase4.{auth-cookie,catalog,categories,customers,import-export,inventory,mobile,security,staff}`
(51 tests, one run, 2.2 min): **48 passed, 1 failed, 2 not run**. The failure was `phase4.inventory`
"summary counts", which expected `committed_units` 0: open orders now hold stock (P5-5). The assertion was updated,
and the file then passed **4/4**. With the 12 tests above, all 63 Phase 1–4 tests that ran pass. `phase4.visual`
(opt-in) was not run.

## 2. Live security checks (§10, checklist A1–A22)

All of them ran on throwaway tenants: `shop` (published) and `eve` (draft, own catalog), plus a staff member of `shop`.

| # | Check | Result |
|---|---|---|
| A1 | Eve on 11 shop routes (order show/patch/confirm/cancel/notes/refunds, coupon show/patch/delete, pickup patch/delete), under both her store id and the shop's | **404 on all 22** ✓. Spoofed `X-Tenant-Id` → 403 `tenant_forbidden` ✓ |
| A2 | Shop ids in Eve's payloads | Manual order `items.0.variant_id` → 422 ✓. Coupon `product_ids.0` / `category_ids.0` → 422 ✓. Shop zone id in Eve's `PUT /shipping` → refused, shop zones unchanged ✓. Bulk `ids` → 422 and nothing applied ✓. **Quote** → 200 with an empty `unavailable` line (no name, price or stock: no leak; F-L1) |
| A3 | Cross-store storefront (S5, S6) | Eve's variant added on the shop host → 422 "This item isn't available." ✓. The shop's cart token on Eve's host (with preview) → 404 `cart_not_found`; an add there creates a **new** Eve cart ✓. Tracking a shop order through Eve's host → 404 ✓ |
| A4 | Price tampering and mass assignment (S1, S11) | `unit_price_amount`, `discount_amount`, `total_amount`, `shipping_amount`, `status`, `payment_status`, `number`, `channel`, `store_id`, `tenant_id`, `customer_id`, `paid_amount`, `lines[]` are all ignored. The order is 1 200 + 60 = 1 260, `pending`, `website`/`storefront`, `unpaid` ✓. `expected_total_amount: 1` → 409 `checkout_changed` "The total changed to ৳ …", order count unchanged ✓ |
| A5 | Idempotency (S4) | Replay → same number + `Idempotent-Replayed: true` ✓. Other body, same key → 409 `idempotency_key_mismatch` ✓. Missing → 400 `idempotency_key_required` ✓. Malformed → 400 ✓. A single order in the list ✓. Refund: replay → same payment id + header ✓; no key → 400 ✓. *The concurrent same-key race is Postgres-only (not run)* |
| A6 | Cart token (S5, S15) | 43-char base64url. The DB holds `sha256` only (raw lookup 0, hashed 1) ✓. `sp_cart` is HttpOnly, SameSite=Lax, Path=/, absent from `document.cookie`, and cleared after checkout ✓. `laravel.log` after cart + checkout contains no token, phone or street ✓ |
| A7 | Key sets (S7) | Product list, PDP, availability, categories, category, config, cart, confirmation and tracking: **no** `cost_amount`, `unit_cost_amount`, `sku`, `barcode`, `on_hand`, `committed`, `tenant_id`, `store_id`, `revision` or `created_by` at any depth ✓. Availability keys are exactly `id, available, low_stock` ✓. The PDP HTML holds no SKU or stock ✓. Staff `unit_cost_amount` null, owner 80 000 ✓. Demo store payloads clean ✓ |
| A8 | Tracking (S8) | Lower-case number, local phone and the number without prefix all match ✓. Wrong phone vs unknown number → **byte-identical** 404 bodies ✓. 429 within 10/min/IP ✓. The view has district and thana only: no street, no email ✓. UI wrong-phone text ✓ |
| A9 | Draft store and spam (S9, S16) | Eve's draft store: products, PDP and categories → 404 ✓. Preview PDP → 200 `private, no-store` ✓. Preview checkout → 409 `store_not_live` "Your shop isn't live yet. Orders open after you go live." ✓. The 11th checkout per IP per minute → 429 ✓. The 6th per phone (different IPs) → 429; the first 5 were 409 and wrote nothing ✓ |
| A10 | State machine and staff (S10, S14) | Pending → ready/ship/deliver/return → 409 `invalid_state_transition` ✓. `tracking_url` `javascript:` and `http:` → 422 ✓. Staff: deliver 200 ✓; refund, coupon create, `PUT /shipping`, publish and pickup create → 403 ✓; cancel unpaid 200 ✓; cancel paid → 403 "Only owners and managers can cancel paid orders." ✓ |
| A11 | Refunds (P5-18) | > paid → 422 `refund_exceeds_paid` ✓. Partial ৳ 10 → `partially_refunded` ✓. The rest → `refunded` ✓. ৳ 0.01 more → 422 ✓. 2 refund events ✓. **UI** "Record refund" dialog → `refunded_amount` 50 000, customer spent − refund ✓ |
| A12 | Stock (P5-5) | Placement → `committed` +2, `on_hand` unchanged ✓. Ship → `on_hand` 10 → 8, `committed` 0, one ledger row `order_shipped` −2 ✓. Cancel (UI) → `committed` released, `orders_count` −1, `cancel_reason` stored, later confirm 409 ✓. Return (UI stepper, 1 of 2) → `on_hand` +1, ledger `order_returned`, `restocked_quantity` 1, `returned_orders_count` 1, COD charge `cancelled` ✓ |
| A13 | Coupons (P5-11…13) | UI-created 15 % capped at ৳ 150 → discount exactly 15 000 ✓. Usage limit 1 → second checkout 422 "This code has been fully used." ✓. List "1 / 1" and revenue ৳ 1,310; `display_status: used_up` ✓. Delete → 409 `coupon_in_use` ✓. Code frozen → 422 ✓. Cancel releases → `used_count` 0, reusable ✓. Per phone "You've already used this code." ✓, first order "This code is for first orders only." ✓, minimum "Spend ৳ 3,000 or more to use this code." ✓, unknown "This code doesn't exist." ✓. Duplicate code in another case → "This code is already used." ✓. Product-only 50 % discounts only that line ✓. Removing the line drops the code with the notice on that response ✓ |
| A14 | Shipping (P5-7, P5-9) | Thana (Dhanmondi) → Inside Dhaka 60 ✓. Whole district (Savar) → "Dhaka outskirts" 90 ✓. Whole district in zone 1 (Gazipur) ✓. Fallback (Chattogram) 120 ✓. Thana not in district → 422 ✓. Free over ৳ 5 000: 5 600 → free ✓; a ৳ 700 coupon brings it below → charged again (after discount) ✓. Free-shipping coupon → `shipping_amount` 0 and `shipping_discount_amount` 12 000 ✓. No fallback → "Keep one fallback zone for everywhere else." ✓ |
| A15 | Plan limit (S17, P5-27) | Free plan, 50 orders this month → manual order **402** `plan_limit_reached`; UI upgrade dialog "Your plan allows 50 orders per month." ✓ (two copies stack, F-L2). A storefront order is still 201 → `plan {used: 51, limit: 50}` ✓. *Parallel race: Postgres-only (not run)* |
| A16 | Go-live (P5-25) | Checklist: `products` and `shipping` required and not done, `payments` done ✓. Publish → 409 `launch_blocked` with the exact detail texts ✓. **UI** "Finish setup" → "Before you go live" alert listing each blocker with a link ✓. Fix → 05 → 06 (defaults ৳ 70 / ৳ 130, 50 Dhaka city thanas) → 07 → publish → 08 "You're live" ✓. **Coming soon gone in < 5 s** ✓. Re-publish → 200 ✓ |
| A17 | Server Actions CSRF (S12), production build | A `Next-Action` POST (addToCart id from the server manifest) with `Origin: http://evil.example` → 500, **no `sp_cart` set** ✓. Same origin → handled (the demo item is sold out, nothing written) ✓. `/api/cart-summary`, `/api/availability/{slug}` and `/api/shipping-quote` → **405** for POST/PUT/DELETE ✓ |
| A18 | Storefront production build (SF's concern) | `next start`: `/cart`, `/checkout`, `/checkout/thank-you` (307 without a token and **200 with a real `sp_order`**), `/track` and `/discount/*` all send **`private, no-store`**, with and without cookies ✓. `next dev` rewrites them to `no-store`: a dev-only artifact, not a defect. `STOREFRONT_COMMERCE_MOCK=1` at build and run time: the gate compiled to `(process.env.STOREFRONT_COMMERCE_MOCK, await fetch(…))`, so production always calls the API ✓. `dangerouslyAllowLocalIP: false` in `required-server-files.json` ✓. No key or secret in `.next/static` ✓. The mock catalogue is still bundled server-side as dead code (harmless). The sitemap has products + categories; robots disallows `/cart`, `/checkout`, `/track`, `/search`, `/discount` ✓ |
| A19 | Open redirect (S14) | `/discount/WELCOME10?next=https://evil.example/` → lands on `/` of the same host ✓. `/discount/%2F%2Fevil.example` stays on the host ✓ |
| A20 | Notifications (§8, S13, S18), on a **copy** of the demo DB with storage redirected to the scratchpad | The 14 stuck jobs ran: `order_placed` SMS in **Bangla** from the fixed template ("প্রিয় Playwright, Demo Store এ আপনার অর্ডার DE-1001 পেয়েছি। মোট 2,450 টাকা… ট্র্যাক: https://demo.storeplix.test/track") ✓. `sms_messages` holds the template name, never the body ✓. Timeline "SMS sent: Order received" ✓. Merchant "New order DE-1001 · Tk 2,450" mail to the store contact ✓. 120 jobs for already-deleted throwaway tenants finished as no-ops (S18-like) ✓ |
| A21 | Mobile 390 px (§15.9) | PDP, PLP, cart, checkout, track, dashboard Orders and Create order: no horizontal overflow ✓. Order detail: **3–9 px** overflow, content-dependent (F-L4) |
| A22 | Postgres races: oversell, deadlock, coupon limit, same key, plan limit | **NOT RUN** (no Docker). Statically reviewed: lock order inventories → coupon → counter (`InventoryService.php:100`, `CouponService.php:53`), advisory lock for manual orders (`OrderPlacementService.php:117`). See F-M2 for the harness |

## 3. Acceptance criteria (§15)

| # | Criterion | Status |
|---|---|---|
| 1 | Shopper: `/c/{slug}`, price filter, PDP variant, cart, coupon, COD order, thank-you number, track by number + phone; no cost, SKU or exact stock in storefront responses | **PASS** (browser, throwaway shop; demo browsed read-only) |
| 2 | No oversell (Postgres, stock 5 × 20); replay = same order; coupon limits under parallel load | **Pending, not run** for the races. Replay **PASS** live. CI gate added |
| 3 | Shipping: thana/district/fallback, free delivery at the threshold; unit-tested | **PASS** (live + Pest `ShippingGeoTest`, `CartPricerTest`) |
| 4 | Coupons: 3 types, eligibility, limits, dates; list shows usage and revenue | **PASS** (live; dates via Pest) |
| 5 | Orders: confirm, pack, ship (tracking), deliver, return, cancel; 409s; stock and ledger; staff limits; refunds; timeline; manual orders same pricing + plan limit | **PASS** (UI + API live) |
| 6 | Notifications: shopper SMS (Bangla) + merchant email queued; toggles, allowance; no duplicate on retry | **PASS** with caveats: live on a DB copy; toggles, allowance and retry via Pest. Locally nothing consumes the queue (F-M1). Failure path: F-L3 |
| 7 | Onboarding 06 → 07 → publish → 08; clear blockers; Coming soon gone < 5 s | **PASS** |
| 8 | Dashboard KPIs, waiting, best sellers; customers delivered/returned + orders table | **PASS** (API numbers + UI tasks; customer list) |
| 9 | Mobile 390 px: PDP, cart, checkout, Orders tab | **PASS** (order detail F-L4, not in the criterion) |
| 10 | Suites green, Postgres perf/race jobs, Playwright, openapi 1.5.0 | **Partly.** Pest, vitest, typecheck, lint and Playwright (Phase 1–5) are green locally; the Postgres perf/race jobs have not run (CI); openapi was not re-validated by QA in this pass |

## 4. Findings

**Critical:** none. **High:** none.

| # | Sev | Where | Finding | Repro / fix |
|---|---|---|---|---|
| F-M1 | Medium · **fixed** | `apps/api/app/Providers/AppServiceProvider.php:84-85` | `composer dev` (`php artisan dev`) starts workers for `default,media` and `bulk` only. Nothing consumes `notifications`, so locally **no order SMS or email is ever sent**: 14 demo jobs were stuck at the start of this review. Compose had no worker either (QA added `queue-notifications`). | Place any order with `composer dev` running → `select count(*) from jobs where queue='notifications'` grows. Fix: add `queue:listen --queue=notifications --tries=3 --timeout=60` (or add `notifications` to the first worker). |
| F-M2 | Medium (predicted; never run) · **fixed** | `apps/api/tests/Feature/Commerce/CommerceSecurityTest.php:336-357`; `tests/Feature/Commerce/NotificationsTest.php:122` | The race harness `parallel()` calls `DB::commit()` and forks. (a) The children's rows **stay committed**: race checkouts write `sms_messages` (sync queue, fake driver), and later in the same `security (postgres)` run `test_job_retry_sends_at_most_one_sms_per_event` asserts a **global** `SmsMessage::query()->count() === 1` → expected red. (b) The children inherit the parent's **Redis socket** (CI `CACHE_STORE=redis`; storefront host resolution is cached), so interleaved replies → 500s/flakes. (c) `test_manual_order_plan_limit_race` has no `perf`/`race` group. | QA mitigation in CI: races isolated, one process each, `CACHE_STORE=array`, excluded from `security (postgres)`. API fix: truncate the touched tables after each race test (or `DatabaseTruncation` for a dedicated race class); in the child, `Redis::purge()` / `Cache::forgetDriver()`; scope `NotificationsTest:122` to the tenant; tag all race tests `#[Group('race')]`. |
| F-M3 | Medium · **fixed** | §12 perf group; no test | **No checkout p95 test** ("< 300 ms with a 10-line cart on CI Postgres, 50 sequential runs"). `grep p95` finds nothing. | API: add it in group `checkout-perf` (the CI step exists and warns while the group is empty; switch it to fail once added). |
| F-L1 | Low · **fixed** | `apps/api/app/Domain/Orders/OrderPlacementService.php:135-139` (quote) vs `:394` (create) | `POST /orders/quote` with another store's `variant_id` → 200 with an empty `unavailable` line instead of 422 `items.N.variant_id` (contract "Foreign ids"). Nothing leaks. | Eve: `POST /stores/{eve}/orders/quote {items:[{variant_id: <shop variant>}]}` → 200. Apply the create path's "Unknown variant." rule to the quote. |
| F-L2 | Low · **fixed** | `apps/merchant-dashboard/src/orders/CreateOrderPage.tsx:259` + `layout/AppShell.tsx:51` (also `onboarding/AddProductsPage.tsx:338`) | `<PlanLimitDialog/>` is mounted twice, so the 402 opens **two stacked identical dialogs** (the top one intercepts clicks). | Free plan at 50 → Create order → 2 `dialog[open]`. Remove the page-level mount. |
| F-L3 | Low · **fixed** | `apps/api/app/Domain/Orders/Notifications/SendOrderSms.php:72-74, 85-88, 42-48` | (a) The timeline row "SMS sent: …" is written **before** sending. A gateway failure sets `sms_messages.status = failed`, but the timeline still says sent, and the dedupe means it is **never retried** (`$tries = 3` is moot). (b) No status check, so a delayed `order_placed` SMS still goes out after the order was cancelled (seen for DE-1011/1012 on the DB copy). | (a) Write the event after a successful send, or mark it failed and let the job retry. (b) Skip `order_placed`/`order_confirmed` when the order is already `cancelled`. |
| F-L4 | Low · **fixed** | `apps/merchant-dashboard/src/orders/OrderDetailPage.tsx:163` | At 390 px the order detail overflows horizontally by **3–9 px** (customer card, timeline). The `grid` has no mobile column template, so the implicit auto track grows to its min-content. Content-dependent. | `phase5.mobile` annotation. Add `grid-cols-1` (or `grid-cols-[minmax(0,1fr)]`) below `lg`. |
| F-L5 | Low · **fixed** | `apps/api/tests/Feature/Commerce/{OrdersTest,CheckoutTest,StorefrontCatalogTest}.php` | §12 lists S10 (state matrix), S14 (`tracking_url`) and S16 (draft store) in the **security group**. The tests exist, but without `#[Group('security')]`, so `security (postgres)` doesn't run them. | Tag them. |
| F-L6 | Low (docs) · **fixed** | `PHASE-5-CONTRACT.md` §3.0, P5-8/Q37, §7, §3.7, §3.9; openapi | Contract drift from D1–D8: `zone_area_taken` 409 is unused; "41 thanas" (it's 50); dedupe via `order_events`; the 400 code for a malformed key; manual orders with COD off; no zones → ৳ 0; the `*_at` month rule. | ARCH: align the contract and openapi. |
| F-L7 | Low · **fixed** | WEB lint | Lint warnings 41 → 73 (merchant-dashboard 52, ui 20). No errors. | Clean up during 5b. |

Notes (not findings):
- `next dev` reports `Cache-Control: no-store` on commerce pages. The production build keeps `private, no-store`
  (A18), and `phase5.storefront-buy` checks the exact header when `E2E_PROD_STOREFRONT_PORT` is set.
- The storefront `/api/shipping-quote` route answers 404 for unknown codes, while the API answers 422. Read-only and
  harmless.
- Under load the local sqlite stack once returned `database is locked` while creating a fixture (it passed on
  re-run). This is the known single-process dev stack (Phase 4 F-L3), not 5a code.

### Follow-up fixes (2026-11-22)

All 10 findings are fixed. The ship gate is still open: the 7 race tests and the checkout p95 test have never run
(Postgres only). The branch is pushed so CI's Postgres jobs run them, and 5a ships only when those are green.

| # | Fix |
|---|---|
| F-M1 | `composer dev` gains `queue-notifications` (`queue:listen --queue=notifications --tries=3 --backoff=10,60`). Compose has `queue-notifications`. |
| F-M2 | New `tests/Support/ForksRaces.php`. Each forked child reconnects its DB, Redis and cache. `raceCleanup()` truncates in a `finally` and refuses unless the database name ends in `_test`/`_testing`. The 7 race tests are tagged `race`. `NotificationsTest` counts per tenant. |
| F-M3 | `CheckoutPerfTest` (groups `perf`, `checkout-perf`, Postgres only): 10-line cart with a coupon, 50 runs, p95 < 300 ms. |
| F-L1 | `POST /orders/quote` returns 422 `items.N.variant_id` for another store's or a deleted variant (2 tests). |
| F-L2 | `CreateOrderPage` no longer renders its own `PlanLimitDialog`; only the `AppShell` one opens (test added). |
| F-L3 | `SendOrderSms`: the timeline is written after the provider accepts. A failure retries (3 tries, backoff 10 s/60 s) without duplicates. A late non-cancel SMS for a cancelled order is skipped. Failed sends don't count toward the allowance (3 tests). |
| F-L4 | `grid-cols-1` on the mobile grids in OrderDetail, CreateOrder and CouponEditor. All 13 orders show 0 px overflow at 390 px. |
| F-L5 | `#[Group('security')]` added to S7, S10, S14 and S16. |
| F-L6 | Contract amended and openapi bumped to 1.5.1 (8 deviations, the unpack route, throttle values); redocly finds the spec valid. |
| F-L7 | Lint warnings 73 → 37: helpers moved out of component files, plus real dependency lists in the two editors. No rules disabled. |

Re-run: typecheck 0 errors; lint 0 errors / 37 warnings; vitest 800 (dashboard 223, storefront 332, themes 125,
api-client 74, ui 39, super-admin 6, config 1); Pest 384 (376 passed, 8 skipped: Postgres only); pint clean.
New gap to log for 5b: the `storefront` throttle is 1 200/min per store host. The planned per-shopper-IP limit was never
built, so one client can use up a store's budget.

## 5. Not verified live, and why

- **Postgres race tests** (S2 oversell + deadlock, S3, S4 concurrent same key, S17 parallel plan limit): Docker was
  down and the Homebrew Postgres belongs to another project. They now run in CI `api-perf`, which fails on skip.
- **Checkout p95 budget:** no test exists (F-M3).
- **Real SMS (REVE) / SMTP:** the local drivers are log-based. The templates and the mail were checked on a DB copy (A20).
- **Notification toggles, language switch and monthly allowance in the UI:** covered by Pest
  (`NotificationsTest`), not driven through Settings → Notifications in a browser.
- **Coupon dates in Asia/Dhaka and the derived `scheduled`/`expired`:** Pest only.
- **Nginx / app.localhost:** no Docker, as in Phase 4 (A20).
- **`phase4.visual`** (opt-in screenshots) was not re-run.

## 6. Data

### 6.1 State after the run (vs the pre-run snapshot)

| Table | Before | After |
|---|---|---|
| tenants / users / stores / store_domains | 1 / 1 / 1 / 2 | same |
| products / variants / inventories (Σ on_hand 94, Σ committed 8) | 8 / 13 / 13 | same (same sums) |
| inventory_movements / categories / customers / media | 15 / 3 / 6 / 8 | same |
| orders / order_items / order_events / payments / shipments | 13 / 13 / 45 / 13 / 3 | same |
| coupons (WELCOME10 used 1, FREEDELIVERY used 1) / coupon_redemptions | 2 / 4 | same |
| carts / cart_items / idempotency_keys | 5 / 5 / 7 | same |
| shipping_zones / zone_areas / pickup_locations / store_counters (orders 1013) | 2 / 50 / 1 / 1 | same |
| sms_messages / jobs (all `notifications`) / failed_jobs | 2 / 14 / 0 | same (the 194 orphaned jobs of deleted throwaway tenants were removed) |
| audit_logs | 803 | 1 324 (not restored; includes other agents and the Phase 2–4 regression run) |

Every throwaway tenant, user (`@e2e.storeplix.test`) and `qa-*` domain is gone (0 left). The production build dir
`.next-qa` was deleted and port 3100 is free.

### 6.2 Pre-existing test orders on the demo store — proposed cleanup (NOT run)

- **DE-1001…1004:** storefront, `pending`, customer "Rakib Hasan" (seeded; `orders_count` 5 instead of 1).
  Together they hold **all 4 units** of variant `01m7zqhj92scavx2b4qdpdy801` (Gentle Bath Set: `on_hand` 4,
  `committed` 4), so **that product shows "Sold out" on the demo store.** Side effects: 4 converted carts and 4
  `storefront.checkout` idempotency keys.
- **DE-1011, DE-1012** (`cancelled`, WELCOME10 redemptions `released`) and **DE-1013** (`returned`; ledger
  `order_shipped` −1 / `order_returned` +1, net 0): manual orders, customer "E2E Phase5 Web" (no other orders),
  3 `orders.create` idempotency keys, 1 shipment.
- Shared: 7 COD payments, 29 order events, the 14 queued notification jobs, 1 active SF test cart
  `01m80th9z75ygpnkrt99e5kx5f`.

The API has no order delete. The cleanest **API-only** step is to cancel DE-1001…1004 from the dashboard (reason
"Other", SMS off). That releases the 4 committed units (the product is buyable again) and sets Rakib's
`orders_count` to 1, but the 7 order rows stay in the lists. Full removal is a one-off SQL in one transaction (sqlite,
demo store only), to run after a fresh backup:

```sql
PRAGMA foreign_keys = ON;   -- the sqlite3 CLI has it off: without it the cascades below don't fire
BEGIN;
CREATE TEMP TABLE qa_o AS SELECT o.id FROM orders o JOIN stores s ON s.id = o.store_id
  WHERE s.slug = 'demo' AND o.number IN ('DE-1001','DE-1002','DE-1003','DE-1004','DE-1011','DE-1012','DE-1013');
UPDATE inventories SET committed = committed - 4, updated_at = CURRENT_TIMESTAMP
  WHERE variant_id = '01m7zqhj92scavx2b4qdpdy801';                                  -- DE-1001..1004 (pending, 1 each)
DELETE FROM inventory_movements WHERE reference_type = 'order' AND reference_id IN (SELECT id FROM qa_o); -- DE-1013 −1/+1
DELETE FROM payments WHERE order_id IN (SELECT id FROM qa_o);                          -- FK NO ACTION
DELETE FROM coupon_redemptions WHERE order_id IN (SELECT id FROM qa_o);                -- 2 × released; used_count unchanged
DELETE FROM carts WHERE converted_order_id IN (SELECT id FROM qa_o) OR id = '01m80th9z75ygpnkrt99e5kx5f';
DELETE FROM idempotency_keys WHERE scope IN ('storefront.checkout','orders.create')
  AND store_id = (SELECT id FROM stores WHERE slug = 'demo');                          -- 4 + 3 (they also expire in 24 h)
DELETE FROM jobs WHERE queue = 'notifications'
  AND EXISTS (SELECT 1 FROM qa_o WHERE jobs.payload LIKE '%' || qa_o.id || '%');      -- the 14 stuck jobs
DELETE FROM orders WHERE id IN (SELECT id FROM qa_o);                                  -- cascades items, events, shipments
DELETE FROM customer_notes WHERE customer_id = '01m80tyqz4p4td3ge8bb53zzzd';
DELETE FROM customers WHERE id = '01m80tyqz4p4td3ge8bb53zzzd';                         -- "E2E Phase5 Web"
UPDATE customers SET orders_count = orders_count - 4 WHERE id = '01m7zqhjhjxz961r79dp0dw7pd'; -- Rakib Hasan 5 → 1
UPDATE store_counters SET value = 1010 WHERE key = 'orders'
  AND store_id = (SELECT id FROM stores WHERE slug = 'demo');                          -- next number DE-1011
COMMIT;
```

Dry-run on a copy of the pre-run backup: 0 foreign-key violations; orders 6 (DE-1005…1010, all `demo-seed`),
order_items 6, order_events 16, payments 6, shipments 2, coupon_redemptions 2, customers 5, carts/cart_items 0,
idempotency_keys 0, jobs 0, inventory_movements 13, Σ committed 8 → 4 (Gentle Bath Set 0), counter 1010. The alternative is
`php artisan migrate:fresh --seed`, which also resets `audit_logs` and everything else.

## 7. Files

- QA-owned changes: `tests/e2e/support/commerce.ts`, `tests/e2e/specs/phase5.*.spec.ts` (7),
  `tests/e2e/specs/phase4.{dashboard,onboarding05,storefront,inventory}.spec.ts`, `.github/workflows/{ci,e2e}.yml`,
  `docker-compose.yml`, `docs/development/TESTING.md`, this file.
- Outside the repo (scratchpad): the demo sqlite backup, the row-count snapshots, the notifications DB copy and
  its log, and screenshots under `tests/e2e/test-results/` (git-ignored).

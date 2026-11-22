# QA gate: Phase 5b-2 (online payments)

Date: 2026-11-22 · Branch `phase-5b-online-money` (uncommitted tree, 5b-2 in progress by API-1/API-2/WEB/SF) ·
Contract PHASE-5B-CONTRACT §1.B, §4.1–4.5, §5.3, §11, §12 (S22–S31, S38), §13 QA, §15, §17. Reviewer: QA.

**Verdict: pass for the fake-gateway flows, with one open finding (F-2) and the items in §5 not verified.** Every
§13 QA payment flow runs end to end against the real API (Postgres, RLS on, app role), the real dashboard and the real
Next storefront, with `PAYMENTS_FAKE=true`. No real gateway was called.

## 1. What ran

Stack: API `php artisan serve` :8100 (Docker Postgres :55432 `storeplix`, `storeplix_app`, `TENANCY_RLS=true`,
`PAYMENTS_FAKE=true`, `CACHE_STORE=file`, `QUEUE_CONNECTION=database`, `DOCUMENTS_DRIVER=html`, `APP_URL`/`PUBLIC_API_URL`
= `http://localhost:8100`), one database-queue worker on `default,media,bulk,notifications,documents,webhooks`, dashboard
(Vite) :5183, storefront (`next dev`) :3000 → API :8100. Ports 8000/5173 belong to another project.

| Check | Result |
|---|---|
| `phase5b.online-checkout` (5): COD + bKash offered; fake **Pay** → "Paid ৳ 560", order `confirmed`/`paid` by `system`; **Fail** → Try again → Pay; **Cancel** → Pay on delivery instead → `pending` COD; hold expiry (time travel) → `cancelled` `payment_timeout`, stock released, retry 409; advance delivery charge (422 `advance_required`, ৳ 60 → `confirmed` `partially_paid`, no COD switch) | 5/5 |
| `phase5b.payment-link` (2): dashboard Ask for an advance → `/pay/{token}` → fake Pay → `confirmed`, due −৳ 60, link `paid`, used link page; one active link 409, 25 % amount, link expiry cancels (`payment_link_expired`) + releases stock, identical 404 | 2/2 |
| `phase5b.refund` (1): Payments card → Refund to bKash ৳ 200 → refund `gateway` `succeeded`, charge/order `refunded_amount`, `partially_refunded`; over-refund 422; Idempotency-Key replay | 1/1 |
| `phase5b.payments-security` (6): S22, S23 (17-paisa mismatch, 13-paisa fail), S24 (return replay ×3 → paid once; unknown IPN key 404), S26/S38 (no secret in any response, the DB column, or the log; staff read-only 403s; `invalid…` 422 `credentials_invalid`, `unavailable…` 502), S27, S28 (identical 404s, no raw token in DB, 429), S29, S30 + foreign ids | 6/6 |
| `phase5b.mobile` (2): + payment result (paid, failed), `/pay/{token}` valid + invalid at 390 px, no overflow | 2/2 |
| `phase5b.edit-and-return` (now with the exchange payment link, closes 5b-4/5 QA L-2), `phase5b.documents` | 2/2 |
| Full `phase5b` run in one go | **18/18** (1.7 min) |
| Regression: `phase5.merchant-orders`, `phase5.security`, `phase5.storefront-buy` | 14/14 |
| `docker compose config --quiet`; e2e typecheck (`tsc -p tests/e2e`) | ok |

## 2. Findings

| # | Sev | Owner | Finding | Repro / fix |
|---|---|---|---|---|
| F-1 | Medium | API | **Resolved during the gate.** `PATCH /settings` rejected `checkout.cod_advance` (422 "The checkout field must be an array.", `UpdateStoreSettingsRequest.php:142` allowed only `cod_enabled`), so the advance flow (P5B-13) couldn't be switched on. | Fixed by API before the final run; `phase5b.online-checkout` "advance delivery charge" passes. |
| F-2 | **Medium** | WEB + API (PO call) | **Exchange payment link amount ≠ the label.** Create exchange order shows "Send a payment link for ৳ 200" (the price difference, `returns/ReturnPanel.tsx:524`), but the API creates the link with `amount_kind: 'full'` = the new order's whole due, ৳ 260 incl. delivery (`Returns/ReturnService.php:410–421`). The merchant (and the shopper by SMS) is asked for a different amount than the dialog said. P5B-67 says only "positive difference → optional payment link". | `phase5b.edit-and-return`: M→L exchange (৳ 200 difference + ৳ 60 delivery) → link amount 26000. Either label the checkbox with the order's due ("…for ৳ 260 (difference + delivery)") or create a `custom` link for the difference. The spec currently pins the API's `full` behaviour. |
| O-1 | Low | API (pre-existing, 5a) | One Postgres deadlock (40P01) in `SendOrderSms` inserting `sms_messages` (FK `KEY SHARE` on `tenants` vs another transaction holding that tenant row) during the parallel regression run; the job retried. | `laravel.log` 12:37:36; `Orders/Notifications/SendOrderSms.php:80,111`. Worth a look if the SMS quota path locks `tenants` `FOR UPDATE`. |

Harness notes (fixed in `tests/e2e`): local returns and link URLs use `http://{primary_host}:3000`
(`Payments/PaymentUrls.php:89`) and Playwright doesn't route redirect targets, so browser specs make `{slug}.localhost`
the primary domain (`mapStoreHost`); the online checkout submit reads "Pay ৳ N with bKash", not "Place order".

## 3. QA deliverables added

- `docker-compose.yml`: `PAYMENTS_FAKE` (default true, dev only), `INTEGRATION_CREDENTIALS_KEY` (dev-only default) +
  `_PREVIOUS_KEYS`, `PUBLIC_API_URL`; new `queue-webhooks` (`--queue=webhooks --tries=5 --backoff=10,60,300`) and
  `scheduler` (`schedule:work`: `payments:expire`, `payment-links:expire`, `payments:reconcile`,
  `payments:refund-status`; compose had no scheduler before). `infrastructure/docker/.env.example` gains the keys.
- `.github/workflows/e2e.yml`: fake-driver env (`PAYMENTS_FAKE`, a generated `INTEGRATION_CREDENTIALS_KEY`,
  `PUBLIC_API_URL`, `DOCUMENTS_DRIVER=html`); migrations as `pgsql_owner` (RLS roles).
- `tests/e2e/support/commerce.ts`: payment helpers (`connectFakeGateway`, `placeOnlineOrder`, `placeAndPay`,
  `fakeGatewayOutcome`, `fakeGatewayReturnUrl`, `expireHolds` via `POST /dev/payments/{payment}/expire-now`,
  `createPaymentLink`, `mapStoreHost`, `choosePayment`, `placeOrderButton`, `leaks`, …).
- Specs `phase5b.online-checkout`, `phase5b.payment-link`, `phase5b.refund`, `phase5b.payments-security`; extended
  `phase5b.mobile`, `phase5b.edit-and-return`. TESTING.md §2c table + how to run with the fake gateway.

## 4. Open items

- F-2 (above).
- §13 "rls" re-run of the 5a security spec with RLS on: done implicitly (the whole stack ran as `storeplix_app`).

## 5. Not verified

- **Sandbox certification** (`phase5b.sandbox.spec.ts`, real bKash/SSLCommerz sandbox + tunnel): no credentials.
- Compose end to end: the `api` image wasn't built here, so `queue-webhooks` and `scheduler` were validated with
  `docker compose config` only. `e2e.yml` hasn't run on GitHub.
- Scheduler-driven expiry: the specs use the testing-only time travel (holds) and `payment-links:expire` after a
  DB write (links nobody tried to pay have no payment row for the endpoint).
- IPN replay with a **valid** SSLCommerz route key (only the unknown-key 404 is live; replay/race S24 is Pest's
  `race` group). The fake 19-paisa (execute timeout → query) rule and S31 late-payment auto-refund are not asserted
  in e2e (Pest covers them).
- Gateway connect dialog / Integrations / Settings → Payments / onboarding 07 UI (WEB) weren't driven in the browser;
  connect runs through the API in every spec.

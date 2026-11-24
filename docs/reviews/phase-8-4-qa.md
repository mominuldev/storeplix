# QA gate: Phase 8.4 (developer API keys + outbound webhooks)

Date: 2026-11-24 · Branch `feat/phase-8-4-developer-api` @ c274d95 + the uncommitted Phase 8.4 working tree (API-KEYS,
API-HOOKS, ARCH and WEB all done) · Contract PHASE-8-4 §9 (S100–S112), §10, §13. Reviewer: QA.

**Verdict: PASS with findings.** All 13 security controls (S100–S112) hold, both in Pest and end to end against the real
API and dashboard. The HMAC signature was verified receiver-side in the Playwright spec with the documented algorithm.
All 18 `phase8-4.*` Playwright tests pass, the Pest `developer-api` group passes on sqlite, Postgres and with RLS on,
and nothing regressed. One **Medium** finding is open: P84-QA-1 is a deployment gap. No `webhooks-out` worker exists in
`docker-compose.yml` or the RUNBOOK, so outside `composer dev` and CI no webhook would ever be sent. Fix it before the
first deploy that enables Growth webhooks. It doesn't block the merge, because CI's e2e job works around it. The other
findings are Low or Info.

## 1. What ran (all by QA)

| Check | Environment | Result |
|---|---|---|
| `php artisan test --exclude-group perf --exclude-group race` | sqlite in-memory | **1116 tests: 1073 passed, 43 skipped, 0 failed** |
| `--group=developer-api` | sqlite | **85: 82 passed, 3 skipped** (RLS/pgsql-only) |
| `--group=developer-api` | Postgres 18, plain superuser (`api-postgres` env), scratch cluster | **85: 82 passed, 3 skipped** |
| `--group=rls` / `developer-api` / `roles` / `tenancy` / `security` (RLS on) | scratch Postgres 18 cluster (**UTC**), port 55433, `01-roles.sql` per DB, `migrate:fresh --seed` as `storeplix_owner`, app as `storeplix_app`, api-rls env | **rls 40/40 (0 skipped)**, **developer-api 85/85**, roles 68/69 (1 sqlite-only skip, as in 8.3), **tenancy 114/114**, **security 403/403** |
| 8.4 migrations: `migrate:rollback --step=3` then `migrate` on Postgres; RLS flags | same cluster | down + up clean; `api_keys`, `webhook_endpoints`, `webhook_secrets`, `webhook_deliveries` all `relrowsecurity` **and** `relforcerowsecurity` |
| 8.4 migrations on the local dev DB (`php artisan migrate`, additive; never `migrate:fresh`) | sqlite dev DB (backup taken first) | 000100 / 000200 / 000300 applied |
| `vendor/bin/pint --test` | — | passed |
| `pnpm -r typecheck` / `pnpm -r lint` | — | clean / 0 errors (warnings only) |
| Vitest `pnpm -r test` | — | merchant-dashboard **426**, api-client **143**, storefront 415, themes 125, super-admin 55, ui 57: all green |
| `pnpm --filter @storeplix/merchant-dashboard build` | — | built |
| `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` (1.12.0) | — | valid (29 warnings, same as 8.1–8.3) |
| `cd tests/e2e && pnpm exec tsc -p .` | — | clean |
| **Playwright `phase8-4.*`** (18 tests, 5 files) | API `artisan serve :8010` (`:8000` is taken by another local project) with `PAYMENTS/COURIERS/DOMAINS/BILLING_FAKE=true` + **`WEBHOOKS_OUT_FAKE=true`**, `queue:work --queue=webhooks-out,default,notifications`, merchant :5173 proxied to :8010 (`VITE_API_PROXY_TARGET`), sqlite dev DB, `API_URL=http://localhost:8010` | **18/18 passed** in a full run, then again per file. One earlier run timed out once in `phase8-4.retries` test 1 while waiting for a delivery (sqlite + a shared worker). It did not recur in 4 later runs |
| Playwright regression `phase8-3.*` (25 tests) | same stack | 24/25 in the combined run: `phase8-3.visual` beforeAll hit sqlite "database is locked" (memory note `local-e2e-setup`). **6/6 when run alone**, so 25/25 |
| Log scan (S100) | `storage/logs/laravel.log`, API and worker logs after all runs | 0 matches for `sp_live_[A-Za-z0-9]{40}` and `whsec_[A-Za-z0-9]{32}` |

Not run: the CI workflows themselves (no push), E2E on Postgres or the compose stack, and the `perf`/`race` groups (no
8.4 tests in them). The local `:8000`/`:3000` processes belong to another project and were not touched.

## 2. Findings

| # | Sev | Area | Finding | Status |
|---|---|---|---|---|
| P84-QA-1 | **Medium** | API-HOOKS / infra, §4.3 | **No `webhooks-out` worker outside `composer dev`.** `DeliverWebhook` runs on `webhooks-out` (`apps/api/config/webhooks_out.php:16`), and `webhooks:dispatch-due` only re-dispatches to that queue (`WebhookDeliveries.php:56`). Only the `composer dev` worker list has it (`AppServiceProvider.php:128`, whose comment says it "mirrors compose `queue-webhooks-out`"). There is no such service in `docker-compose.yml` (compare `queue-billing` at :397), and none in the `docs/deployment/RUNBOOK.md` worker table (§1, line ~26). The contract's "new Horizon supervisor" has no counterpart either, since the repo has no Horizon config. Effect: on compose and on a deploy that follows the RUNBOOK, deliveries stay `pending` forever. Also missing: compose doesn't forward `WEBHOOKS_OUT_FAKE` (nor `infrastructure/docker/.env.example`), and the RUNBOOK env table lacks `WEBHOOKS_OUT_FAKE` / `WEBHOOKS_OUT_ALLOW_HTTP` (production: `false`). CI e2e works around it (`e2e.yml` starts a worker and writes the flag into `apps/api/.env`). Fix: add `queue-webhooks-out` (`queue:work redis --queue=webhooks-out --timeout=40 --sleep=1`) and `WEBHOOKS_OUT_FAKE: ${WEBHOOKS_OUT_FAKE:-true}` to compose, plus the RUNBOOK rows | Open |
| P84-QA-2 | Low | WEB, AC 5 | **At 1024–1440 px the keys and webhooks tables overflow their card.** In the two-column layout (`DeveloperPage.tsx:75`, `lg:flex-row` with a 360 px right column), the left card's table area is about 525 px at 1280, but `DevTable` has `minWidth` 680 (`ApiKeysCard.tsx:61`) and 640 (`WebhooksCard.tsx:66`). So LAST USED, the SUCCESS · 7 DAYS pill ("0% · fai…") and the **row menus** (Rename / Revoke / Send test event) are only reachable by scrolling inside the card, and scope tags are clipped ("Stock · writ"). Screenshot `tests/e2e/test-results/phase8-4-visual/1280/developer.png`. No page overflow; the Playwright clicks still work. Suggested fix: switch to two columns at `xl`/`2xl`, or drop the min widths to about 520 | Open |
| P84-QA-3 | Low | WEB ↔ API, §4.4 | **The "Resend failed (n)" count can disagree with what the API resends.** The API resends only failed deliveries **not superseded by a later delivery of the same event to the same endpoint** (`WebhookDeliveries::failedQuery`, `WebhookDeliveries.php:240–251`). The UI counts every `failed` row of the last 24 h (`merchant-dashboard/src/developer/queries.ts:89–101`). Repro (seen in `phase8-4.retries`): a failed delivery that was already resent by hand shows "Resend failed (1)", and the click answers `{count: 0}`, so nothing happens. The dedupe rule is also missing from contract §4.4 and openapi. Fix: expose the API's count (e.g. `meta.failed_resendable` on the list, or a count endpoint) or apply the same rule in the UI; document the rule. The spec now fails the newest delivery of the event, so it passes on the intended path | Open |
| P84-QA-4 | Info | ARCH, §3 | §3 says the external API sends "`X-Request-Id` as elsewhere", but no API route sends that header (no `X-Request-Id` anywhere in `apps/api/app` or `bootstrap`). Either drop the sentence or add the middleware platform-wide. The spec doesn't assert it | Open (doc) |
| P84-QA-5 | Info | ARCH, §6.3 | `api_key_scope_missing` sends `details.required_scope` as an **array** (`["products:read"]`, `RequireApiScope.php:39`). The contract and openapi describe it as if singular. That matches the "details values are arrays" style, but openapi should show the shape. The spec accepts both | Open (doc) |
| P84-QA-6 | Info → **fixed** | e2e | The QA prep specs used `?endpoint_id=` / `?status=` on the deliveries list; the API and openapi use `filter[endpoint_id]` / `filter[status]` (repo convention), and unknown params are ignored, so the filter silently didn't apply. Specs and `support/developer.ts` now use `filter[...]`. Two more spec-side adjustments: the plain key is read from the read-only CopyField input (orchestrator), and `required_scope` (P84-QA-5) | Fixed in `tests/e2e/**` |
| P84-QA-7 | Info | e2e harness (pre-existing) | Playwright clears `test-results/` at the start of every run, so screenshots written there by `phase8-3.visual` / `phase8-4.visual` survive only until the next run. Regenerate them with `pnpm exec playwright test phase8-4.visual` right before a Figma review, or point them at a directory outside `outputDir` | Open (optional) |

## 3. Security checklist (§9)

| S | Control | Pest evidence | E2E evidence | Result |
|---|---|---|---|---|
| S100 | Plain key never persisted/logged/returned after create; DB holds sha256 only | `ApiKeysApiTest::test_create_returns_the_plain_key_once_and_stores_only_its_sha256` | `phase8-4.api-keys`: plain key only in the success step; masked row; list API has no `plain_key`; log scan 0 hits (§1) | **Pass** |
| S101 | Unknown, malformed, revoked key → identical 401 | `ExternalAuthTest::test_malformed_unknown_and_revoked_keys_get_the_identical_401` | revoked vs never-issued error bodies equal; malformed 401 | **Pass** |
| S102 | Tenant A key on B's store / ids → 404 | `test_other_tenants_store_and_ids_are_404`, `test_scope_denial_and_cross_tenant_404`, `test_keys_of_another_tenant_answer_404` | other tenant's store 404, unknown order 404, `X-Tenant-Id` spoof ignored | **Pass** |
| S103 | Exactly one `scope:` per external route; missing → 403 `api_key_scope_missing` | `test_every_external_route_declares_exactly_one_known_scope_and_no_session_auth`, `test_scope_is_enforced_with_api_key_scope_missing` | products list + status change → 403 | **Pass** |
| S104 | External refuses cookies; merchant refuses keys | `test_a_session_never_authenticates_the_external_api_and_a_key_never_the_merchant_api` | `/external/me` with session → 401; `/stores` with Bearer → 401 | **Pass** |
| S105 | Non-delegation; staff 403; custom role grants only backed scopes | `test_non_delegation_for_custom_roles`, `test_staff_and_roles_without_developers_manage_are_refused`, `test_staff_cannot_reach_any_webhook_route_admin_and_custom_role_with_the_permission_can` | `phase8-4.access`: staff 403 on all 12 routes, no `developers.manage`, no-access page, no banner | **Pass** |
| S106 | No `api_webhooks` → external 402, writes 402, no deliveries, nothing deleted | `test_suspended_tenant_403_and_plan_without_api_webhooks_402`, `test_without_api_webhooks_reads_work_and_writes_answer_402_nothing_deleted`, `test_plan_downgrade_fails_pending_retries_with_plan`, `test_nothing_is_recorded_without_a_subscription_the_plan_or_a_commit` | `phase8-4.access`: Free reads 200 / writes 402 `upgrade_plan: [growth]`; downgrade → external 402, key + endpoint kept, order → no delivery | **Pass** |
| S107 | SSRF refused on save and at send (private ranges, metadata, `[::1]`, ULA, DNS → private, http in prod, redirects) | `WebhookSsrfTest` (`test_refused_on_save`, `test_rechecked_at_send_time_dns_rebinding_is_refused`, `test_redirects_are_not_followed`, `test_http_only_with_the_flag_and_never_in_production`, `test_public_ip_classification`) | — | **Pass** |
| S108 | Verifiable signature; previous secret ≤ 24 h | `test_signature_known_vector_and_receiver_verification`, `test_rotation_signs_with_both_secrets_for_24_hours_only` | `phase8-4.webhooks`: receiver-side HMAC on the sink's raw body; tampered body / wrong secret / altered `t` fail; after rotation two `v1=`, both valid; `previous_expires_at` ≈ +24 h | **Pass** |
| S109 | Secret encrypted at rest; reveal/rotate audited; staff 403 | `test_signing_secret_is_lazy_encrypted_at_rest_revealable_and_rotatable`, `test_reveal_is_throttled_to_ten_per_minute` | staff reveal/rotate 403; delivery detail redacts the signature | **Pass** |
| S110 | Deliveries isolated (RLS + scope); job runs in the delivery's tenant | `WebhookRlsTest::test_webhook_tables_are_isolated_by_row_level_security`, `test_store_isolation_of_the_webhook_tables`, `test_the_delivery_job_runs_only_inside_the_deliverys_tenant` (green with RLS on) | — | **Pass** |
| S111 | 121st request/min per key → 429; separate buckets | `test_rate_limit_is_120_per_minute_per_key` | — | **Pass** |
| S112 | Fake / allow-http refuse to boot in production | `test_fake_and_allow_http_refuse_to_boot_in_production` | — | **Pass** (deploy docs gap: P84-QA-1) |

## 4. Acceptance criteria (§13)

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | **HMAC signatures** verifiable; rotation overlap | S108 row | **Met** |
| 2 | **Retries** P84-9 then `failed`; resend, resend-failed; auto-disable 72 h | `test_retry_schedule_then_failed_after_the_seventh_attempt` (frozen clock), `test_endpoints_failing_for_72_hours_are_auto_disabled`, `test_resend_and_resend_failed`; E2E attempt 1 → `retrying` +60 s, row "Failing since", resend = new delivery with same event id, "Resend failed" → `{count: 1}` | **Met** (UI count caveat P84-QA-3) |
| 3 | Keys shown once, sha256, scoped, revocable, non-delegable, rate limited, audited, Growth-gated | S100–S106, S111; `test_rename_and_idempotent_revoke_are_audited_and_keep_the_row` | **Met** |
| 4 | External API §3 routes, identical shapes, isolation, scope per route | `ExternalResourcesTest` (orders/products/categories/inventory/customers), E2E orders item keys = merchant list item keys | **Met** |
| 5 | Developer page matches `144:40726` (documented omissions), states, 375 px usable | `phase8-4.visual` 1280/390/375: four cards, no page overflow, no console errors; plan note variant (Free); Vitest states. Desktop table clipping P84-QA-2 | **Met with finding** |
| 6 | `pnpm -r test` / `typecheck`, Pest sqlite + Postgres + `api-rls` (`developer-api`, `rls`, `security`), Playwright `phase8-4.*`, redocly | §1 (CI not executed locally; workflows wired) | **Met** |

## 5. Test-requirement coverage (§10)

| Requirement | Where | Result |
|---|---|---|
| CRUD + validation + authz + isolation for every §6.1 route | `ApiKeysApiTest`, `WebhookEndpointsApiTest`, `WebhookDeliveryTest` | Covered |
| Every §3 route: happy path + scope deny + cross-tenant 404 | `ExternalResourcesTest`, `ExternalAuthTest` | Covered |
| Event emission per §4.1 (10 events) | `WebhookEventsTest` (order.created/confirmed/cancelled/paid, shipment.updated/delivered, return.received, product.updated, stock.low ×2, customer.created) | Covered |
| Retry schedule (frozen clock), auto-disable, prune, resend | `WebhookDeliveryTest` | Covered |
| Signature vector test | `test_signature_known_vector_and_receiver_verification` | Covered |
| RoutePermissionsTest rows + external route scope test | `roles` group green (sqlite, RLS); `test_every_external_route_declares_exactly_one_known_scope_and_no_session_auth` | Covered |
| Vitest: page, plain key once, scope implication / non-grantable, plan note, failing pill, gating | merchant-dashboard 426 green (incl. phase 8.4 tests) | Covered |
| Playwright §10 QA flows | `phase8-4.api-keys`, `.webhooks`, `.retries`, `.access`, `.visual`: 18/18 | Covered |

## 6. CI wiring (QA)

- `ci.yml`: the `developer-api` group runs in `api` (sqlite, fails when empty), in `api-postgres` and in `api-rls`
  (`run-group.sh developer-api lenient`; lenient because 3 tests are pgsql/sqlite-specific).
- `e2e.yml`: `WEBHOOKS_OUT_FAKE=true` goes into the compose `.env`, `apps/api/.env` and the Playwright env. A
  `webhooks-out` worker is started in the `api` container unless compose defines `queue-webhooks-out` (P84-QA-1).

## 7. How to reproduce the E2E run locally

```bash
cd apps/api && php artisan migrate      # additive; never migrate:fresh the dev DB
APP_ENV=local PAYMENTS_FAKE=true COURIERS_FAKE=true DOMAINS_FAKE=true BILLING_FAKE=true WEBHOOKS_OUT_FAKE=true \
  APP_URL=http://localhost:8010 PUBLIC_API_URL=http://localhost:8010 php artisan serve --port=8010
php artisan queue:work --queue=webhooks-out,default,notifications     # second terminal
cd apps/merchant-dashboard && VITE_API_PROXY_TARGET=http://localhost:8010 pnpm dev
cd tests/e2e && API_URL=http://localhost:8010 pnpm exec playwright test phase8-4.
```
(Port 8010 only because 8000 was in use here; with a free 8000 the defaults apply.)

## Follow-up (orchestrator, 2026-11-24, after the gate)
- **Finding 1 (Medium) — resolved.** `docker-compose.yml` already had the `queue-webhooks-out` worker and the
  `WEBHOOKS_OUT_FAKE` / `WEBHOOKS_OUT_ALLOW_HTTP` passthrough by the time the gate ended (API-HOOKS added them while QA was running);
  `docs/deployment/RUNBOOK.md` now lists the `queue-webhooks-out` worker row and the production rule for both flags.
- **Finding 2 (Low) — resolved.** The two-column layout starts at 1440 px (Figma width); below that the cards stack and the
  side cards sit two-up from `lg`. Access column widened to 226 px so "+n" and "Stock · write" are not clipped.
  `phase8-4.visual` re-run: 3/3.
- **Finding 3 (Low) — accepted, documented.** The API rule (skip failed deliveries already superseded by a later delivery of
  the same event to the same endpoint) is now in PHASE-8-4 §4.4. The UI count can still exceed what is resent; the toast
  reports the API's `{count}`.
- **Finding 4 (Info) — resolved.** Contract §3 no longer mentions `X-Request-Id`; `details.required_scope` documented as an
  array in the contract, API-CONVENTIONS and openapi.

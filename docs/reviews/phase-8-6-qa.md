# QA gate: Phase 8.6 (automations + checkout recovery)

Date: 2026-11-24 · Branch `feat/phase-8-6-automations` @ 2e35ff5 plus the uncommitted Phase 8.6 working tree (ARCH, API
and WEB all reported done) · Contract PHASE-8-6 §12 (S127–S140), §13, §16. Reviewer: QA.

**Verdict: PASS with one open Medium item (P86-QA-1).** AC 1 to AC 4 are met. AC 5 is met except `phase8-5.visual`,
which fails because the spec is stale: Phase 8.6 is supposed to unhide the items it checks are hidden. That spec is
outside QA's 8.6 ownership, so it was not edited.

## 1. What ran

The local stack used API `artisan serve :8010`, which was already running with `PAYMENTS/COURIERS/DOMAINS/BILLING/WEBHOOKS_OUT_FAKE=true`,
`SMS_DRIVER=log`, `CAMPAIGN_MAILER=log` and `CAMPAIGNS_DEV_SINK=true` on sqlite. The dev DB was brought up to date with
`php artisan migrate`, which ran the two `2026_12_03_*` migrations; no `migrate:fresh`. The merchant dashboard ran with
vite on **:5183**, started with `VITE_API_PROXY_TARGET=http://localhost:8010` (see P86-QA-5). The storefront ran with
`next dev` on **:3010**. A new worker ran `queue:work --queue=automations,campaigns,notifications,default,webhooks-out --tries=1 --timeout=250`;
it replaced the stale 8.5 gate worker so the new code was loaded. :8000, :5173 and :3000 were not touched.

| Check | Result |
|---|---|
| Playwright `phase8-6.*` (26 tests, 5 files) | **26/26 passed** in the final full run. Two earlier full runs each had one sqlite "database is locked" 500. `deliveredOrder()` now retries a locked transition, as the 8.5 helpers already do |
| Playwright `phase8-5.*` (24 tests, regression) | 14 passed, 5 failed, 5 did not run. **`phase8-5.email` and `phase8-5.schedule` failed only on sqlite "database is locked"; 9/9 passed when re-run alone.** `phase8-5.visual` failed at 1280, 390 and 375 px (P86-QA-1) |
| Pest `--group=automations` (sqlite) | 32: 31 passed, 1 skipped (pgsql-only RLS test). API reports 32/32 on Postgres with RLS on; not re-run here |
| Pest `--group=campaigns` (sqlite) | 63: 62 passed, 1 skipped |
| `pnpm -r typecheck` | clean |
| `pnpm -r test` | green: merchant-dashboard 501, storefront 445, api-client 152, themes 125, ui 59, super-admin 55, config 1 |
| `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` | valid (29 warnings, same count as 8.5) |
| `docker compose config` | valid; `queue-automations` is listed |

## 2. Acceptance criteria

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | Trigger → action runs logged | Each trigger produces one run with logged steps and an outcome: `checkout.abandoned` (cart and unfinished online order), `order.delivered` (thank_you, vip_tag), `return.received`, `stock.low`. Outcomes seen: `completed`, `waiting`, `skipped/conditions_not_met`, `stopped/converted`, `stopped/opted_out`, `stopped/plan`. Step outcomes seen: `done`; `skipped` with reason `frequency_cap` or `opted_out`. A second `detect-abandoned` creates no second run. The run log page and Recent runs show the runs with their outcome pills (`phase8-6.recipes`, `.recovery`, `.rules`, `.access`). `failed` and `unknown` steps are covered by Pest only (the fake drivers never fail) | **Met** |
| 2 | 5 recipes end to end; recovery detects, sends ≤ 2, restores, stops on order, attributes | Recovery flow: phone captured on blur (invalid phone not captured, never echoed) → detect → SMS with `{cart_link}` and opt-out footer → `/r/{code}` in a fresh context clones the cart to `/checkout` with a new httpOnly `sp_cart` (original cart unchanged; an unknown code goes to `/`, API 404 `recovery_link_invalid`) → order from the same phone → run `stopped/converted`, conversion order on the run, `/stats` step 1 sent 1 / recovered 1, recovery page shows "Recovered · SMS". An unfinished online order (`payment_timeout`) starts a run with subject order. Thank-you, VIP (min 2), returns and low stock all pass; the owner gets the low-stock mail, with no shopper phone in it | **Met** |
| 3 | Opt-out, eligibility, quiet hours, frequency cap, allowance; dry run has no side effects | Opt-out through the automation's `/u/{code}` (resolved by the 8.5 API) → `stopped/opted_out`, no second SMS. Three thank-yous to one phone → `done`, `done`, `skipped/frequency_cap`; the sink holds 2. Night shop: run `waiting` until 09:00 store time; a forced resume inside quiet hours waits again. Dry run: run count and sink unchanged. Free → 402; downgrade → no new run, waiting run `stopped/plan`. Allowance and eligibility (S128, S135 allowance) are covered by Pest | **Met** |
| 4 | Figma pages with omissions; checkout notice; states; 375 px | `phase8-6.visual` at 1280, 390 and 375 px covers Automations, Thank-you editor, recovery page, run log and checkout notice: no page overflow, no console errors, quiet-hours note present, WhatsApp / Time saved / Risky orders held / Clicked / Cost / Add a step absent. Screenshots are in `tests/e2e/test-results/phase8-6-visual/{width}/` for the Figma review. Staff see the no-access state on all 4 pages | **Met** (visual Figma diff still to be reviewed by design) |
| 5 | Suites green | All green except stale `phase8-5.visual` (P86-QA-1) | **Met except P86-QA-1** |

Audit check (coordinator question): the API writes no `audit_logs` row when an automation tags a customer. This
**matches** the contract: P86-20 and S139 say per-action changes are recorded only in the run log, and `audit_logs`
gets the config-level actions (`automation.created|updated|enabled|disabled|deleted|test_sent`). Not a finding.

"Unsubscribes" KPI tile removed from the Marketing overview by WEB: no `phase8-5.*` spec asserts that tile, so nothing
fails. Whether to keep it out is the product owner's call.

## 3. Findings

| # | Severity | Owner | Finding | Status |
|---|---|---|---|---|
| P86-QA-1 | Medium | QA (coordinator approval: file outside the 8.6 ownership) | `tests/e2e/specs/phase8-5.visual.spec.ts:74` asserts that `/Automations/` and `/Carts recovered/` are absent from the Marketing overview. Contract §10.5 unhides both in 8.6, so the spec fails at all three widths. Fix: remove those two patterns from the hidden list (keep WhatsApp, Return on spend, Top up, Best week yet) | Open |
| P86-QA-2 | Low | ARCH + API | The per-condition results are stored in `automation_runs.outcome_detail` (§4.3; C2 says `outcome_detail` lists the derived conditions), but `AutomationRun` (§9.2, openapi, `RunPresenter.php:66-84`) does not expose them. The run log therefore shows "Skipped · Conditions not met" without saying which condition failed. The specs read the stored value through tinker. Fix: add `outcome_detail` (masked, no PII) to the shape, or state in §9.2 that it stays internal | Open |
| P86-QA-3 | Low | ARCH | `vip_tag` dedupe differs from §3. `VipTag.php:152` uses `customer:{id}` only when the conditions pass, else `order:{id}`. This is the right behaviour: with the literal §3 key, the first `conditions_not_met` run would block the customer forever. §3 should be amended to describe it | Open (doc) |
| P86-QA-4 | Info | WEB/API | Customer tags are stored lower-case (P4), so Recent runs and the run log read "Tagged vip" / "Tagged returned" (`automations.ts:95`), while Figma shows "Tagged VIP". Consider showing the recipe's configured tag text from the step `detail.tag` before normalisation | Open (optional) |
| P86-QA-5 | Info | local env | `apps/merchant-dashboard/.env.local` (git-ignored) sets `VITE_API_PROXY_TARGET=http://localhost:8000`, which is another project's API. A dashboard started on :5183 without an override signs up against the wrong backend (404 problem+json). Start vite with `VITE_API_PROXY_TARGET=http://localhost:8010` or fix the local file | Note |
| P86-QA-6 | Info | QA | Local sqlite "database is locked" flakes under the full suite, as in 8.5. They hit one 8.6 test in each of two runs and two 8.5 specs; all passed alone. CI runs Postgres | Note |

## 4. Repro

- P86-QA-1: `cd tests/e2e && pnpm exec playwright test phase8-5.visual`. The failure is "hidden in 8.5: /Automations/".
- P86-QA-2: on a Starter shop, enable Thank-you with condition `order.total_amount gt 10000000` and deliver an order.
  `GET /stores/{s}/automation-runs` then returns the run `skipped/conditions_not_met` with no `outcome_detail` key, but
  `automation_runs.outcome_detail` holds the per-condition results.
- P86-QA-3: `phase8-6.recipes` "Tag VIP buyers": the 1st delivery gives `skipped`, and the 2nd delivery for the same
  customer gives a new run that tags the customer (only possible because of the `order:{id}` fallback).

## 5. QA deliverables

- Specs: `tests/e2e/specs/phase8-6.{recovery,recipes,rules,access,visual}.spec.ts`, support `tests/e2e/support/automations.ts`.
- CI (`.github/workflows/ci.yml`): `automations` group steps on sqlite (must be non-empty), Postgres and RLS (`run-group.sh`).
  `e2e.yml`: `queue-automations` fallback worker (`--tries=1 --timeout=250`) and `SMS_DRIVER` / `CAMPAIGN_MAILER` in the test env.
- `docker-compose.yml`: `queue-automations` service (`--queue=automations --tries=1 --timeout=250`) and a header note. No new env keys.
- `docs/development/TESTING.md`: Phase 8.6 group row, Pest command, 5 spec rows and the local run recipe.

## Orchestrator fixes after the gate (2026-11-24)
| Finding | Resolution |
|---|---|
| P86-QA-1 | Fixed: `phase8-5.visual.spec.ts` no longer expects "Automations" / "Carts recovered" hidden (shown since 8.6 §10.5). |
| P86-QA-2 | Fixed: runs expose `outcome_detail` (`{conditions: [{field, label, passed, detail}]}` or null) in `RunPresenter`, `packages/types`, openapi 1.14.0; the run log lists the failed conditions. Pest `RecipesTest::test_conditions_matrix_and_eligibility` asserts the API shape. |
| P86-QA-3 | Fixed (docs): contract §3 `vip_tag` dedupe row amended to match the code. |
| P86-QA-4 | Open (Info): tags are stored lower-case. |
| P86-QA-5 | Local env only: `apps/merchant-dashboard/.env.local` proxy target updated to :8010 (git-ignored). |

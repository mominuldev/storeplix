# QA gate: Phase 8.5 (marketing campaigns, SMS + email)

Date: 2026-11-24 · Branch `feat/phase-8-5-campaigns` @ 3fe3f5c + the uncommitted Phase 8.5 working tree (ARCH, API and
WEB all reported done) · Contract PHASE-8-5 §10 (S113–S126), §11, §14. Reviewer: QA.

**Verdict (re-gate, §0): PASS.** All four acceptance criteria are met. The findings from the first gate (§1–§5,
verdict FAIL) are fixed and verified, except two Info items left open.

## 0. Re-gate (after the WEB/API/compose fixes)

| Check | Result |
|---|---|
| Playwright `phase8-5.*` (24 tests, incl. `phase8-5.regressions`) | **24/24 passed, in two consecutive full runs** (same local stack as §1: API `artisan serve :8010`, `campaigns` worker restarted with `--timeout=250`, merchant :5174, storefront :3010) |
| Pest `--group=campaigns` (sqlite) | **63: 62 passed, 1 skipped** (pgsql-only RLS test) |
| `pnpm -r typecheck` / `pnpm -r test` | clean / green: merchant-dashboard 479, storefront **426** (incl. new `tests/unsubscribe.test.ts`), api-client 147, themes 125, ui 59, super-admin 55, config 1 |
| redocly lint `openapi.yaml` 1.13.0 | valid (29 warnings, unchanged) |

Finding status after the re-gate:

| # | Status | Verified by |
|---|---|---|
| P85-QA-1 confirm dialog stale count | **Fixed** | `phase8-5.regressions` P85-QA-1 passes |
| P85-QA-2 unsubscribe ends on 404 | **Fixed**: buttons POST to `apps/storefront/app/u/[code]/change/route.ts` (303 → `/u/{code}`, or `?e=1`) | `phase8-5.regressions` P85-QA-2 (Unsubscribe and Subscribe again in place), `phase8-5.campaigns`, `phase8-5.email` |
| P85-QA-3 composer stays on `/edit` after send | **Fixed** | `phase8-5.campaigns` now *requires* the detail URL (tolerance removed); 2/2 runs |
| P85-QA-4 cross-channel opt-out side effect | **Fixed by PO decision**: opt-out is per channel only and never touches `accepts_marketing` (contract P85-4, §4.2 and ADR 0019 amended) | `phase8-5.email`: after the email one-click the customer is email `unsubscribed` / SMS `subscribed`, `accepts_marketing` still true, **and an SMS campaign still reaches them**; after Subscribe again email reads `subscribed` |
| P85-QA-5 no compose `campaigns` worker | **Fixed** (coordinator): `queue-campaigns` (`--timeout=250`) + campaign env in `docker-compose.yml`; the `e2e.yml` fallback is now a no-op and stays as a guard | config review |
| P85-QA-6 no storefront Vitest for the unsubscribe page | **Fixed**: `apps/storefront/tests/unsubscribe.test.ts` | storefront Vitest 426 green |
| P85-QA-7 unsubscribe page English-only | Open (Info; no store-language setting yet) | — |
| P85-QA-8 generic message on preview 429 | **Fixed** (WEB) | Vitest (not reproduced in e2e) |
| P85-QA-9 spec assumptions | Fixed (QA) | — |
| New: campaign job timeouts | API raised both campaign job timeouts to 240 s with a 150 s send budget per batch; `campaigns:dispatch-due` resumes the remainder. Workers need `--timeout` > 240 (compose uses 250; local runs need the flag too) | noted in TESTING.md via the worker line |

Acceptance criteria (re-gate):

| # | Criterion | Result |
|---|---|---|
| 1 | Opt-out respected (now per channel) | **Met** |
| 2 | Create, preview, test, schedule/send, cancel, at-most-once, quiet hours, allowances, attribution/overview | **Met** (attribution/overview numbers by Pest) |
| 3 | Overview, list, composer, detail, storefront unsubscribe page, states, 375 px | **Met** (P85-QA-7 Info open) |
| 4 | Suites green | **Met** locally. Postgres/`api-rls` per the API agent's report (59/59 before the fixes); QA did not re-run Postgres |

Still not covered: Postgres/RLS by QA, and a production `next build` of the unsubscribe route. CI was not executed
(no push).

---

*First gate (kept for the record):*

## 1. What ran (all by QA unless marked)

| Check | Environment | Result |
|---|---|---|
| `php artisan test --group=campaigns --exclude-group perf --exclude-group race` | sqlite in-memory | **59: 58 passed, 1 skipped** (`CampaignRlsTest`, pgsql-only) |
| `--group=security --group=rls` | sqlite | 475: 435 passed, 40 skipped (pgsql-only), 0 failed |
| `--group=campaigns` on Postgres with RLS on | — | **Not re-run by QA.** API reported 59/59 |
| `pnpm -r typecheck` | — | clean |
| `pnpm -r test` (final tree) | — | merchant-dashboard 477, storefront 415, api-client 147, themes 125, ui 59, super-admin 55, config 1: all green |
| `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` (1.13.0) | — | valid (29 warnings, same as 8.4) |
| `cd tests/e2e && tsc --noEmit -p .` | — | clean |
| 8.5 migrations on the local dev DB (`php artisan migrate`, additive; never `migrate:fresh`) | sqlite dev DB | 000100 / 000200 / 000300 applied |
| **Playwright `phase8-5.*`** (24 tests, 6 files) | API `php artisan serve --port=8010` with `PAYMENTS/COURIERS/DOMAINS/BILLING/WEBHOOKS_OUT_FAKE=true`, `CAMPAIGN_MAILER=log`, `CAMPAIGNS_DEV_SINK=true` (`SMS_DRIVER=log` from `.env`); worker `queue:work --queue=campaigns,default,notifications,webhooks-out`; merchant **:5174** (Vite, proxy → :8010); storefront `next dev` **:3010** (`STOREFRONT_API_URL` → :8010); sqlite dev DB | **Final full run: 22 passed, 2 failed.** The 2 failures are the `phase8-5.regressions` checks for P85-QA-1 and P85-QA-2. Every file also passed on its own in earlier runs |

Notes on the local run. `:8000`, `:5173` and `:3000` belong to another project and were not touched. Earlier runs hit
local-only problems, none of them product defects:

- sqlite "database is locked" (memory note `local-e2e-setup`). `SendCampaignBatch` is `tries = 1` by design, so a
  locked batch waits for `campaigns:dispatch-due`. The specs now trigger that command instead of waiting 2 minutes.
- The `storefront-unsubscribe` limiter. Locally every browser request is one shopper IP.
- `php -S` not passing env overrides for keys that `.env` sets.

TESTING.md documents all three.

## 2. Findings

| # | Sev | Area | Finding | Status |
|---|---|---|---|---|
| P85-QA-1 | **Medium** | WEB, §8.3 | **Confirm dialog shows a stale recipient count and allowance.** The dialog's "Recipients / Total SMS / Left this month after" come from `useCampaignEstimate` (`CampaignComposerPage.tsx:139`, `:253`). That estimate is fired once with the initial debounced input and is never refreshed after the audience or body changes. `useDebounced` (`catalog/ui.tsx:25`) is keyed on object identity, and `queries.ts:82` passes a new object every render. Repro (`phase8-5.regressions` P85-QA-1): 1 consenting customer + 1 who ordered today; composer → SMS, untick "Skip anyone who ordered in the last 7 days", type a body. The summary reads "2 customers will get this message", but Send campaign → dialog "Recipients **1**". A network trace shows one estimate request with `body: ""` and `ordered_within_days: 7`, and none after the edits. The server re-checks the allowance at send time, so no over-send, but the merchant confirms against wrong numbers. The Allowance card uses the same data | Open |
| P85-QA-2 | **High** | WEB (storefront), §8.6, AC 3 | **Unsubscribe / Subscribe again end on a 404 page.** `changeSubscription` (`apps/storefront/app/u/[code]/actions.ts`) POSTs and then `redirect('/u/{code}')`. The re-render inside the server-action response shows the store's 404 "This page wandered off", probably via `notFound()` when `findCurrentStore()` returns null in the action context (`page.tsx:26–27`). The state change succeeds (API status `unsubscribed`), and a reload shows "You’re unsubscribed". But the shopper sees an error right after opting out and has no "Subscribe again" button. Reproduced in 4 of 4 runs on `next dev`, not checked on a production build. One-click (`/u/{code}/one-click`) is unaffected | Open |
| P85-QA-3 | Low | WEB, §8.3 | After "Send campaign" the composer sometimes stays on `/marketing/campaigns/:id/edit` with "This campaign can’t be edited" instead of opening the detail page (1 of about 5 UI sends). The send itself succeeds. Likely a race: `useLaunchCampaign` `onSuccess` sets the detail cache to `sending` (`queries.ts:143`, `useInvalidateCampaigns`), so the mounted composer re-renders into its non-editable branch before the per-call `navigate` runs (`CampaignComposerPage.tsx:236`). The spec accepts both URLs and annotates it | Open |
| P85-QA-4 | Medium (product question → ARCH/PO) | Contract P85-3/P85-4 | **A link opt-out on one channel removes the other channel too, and "Subscribe again" doesn't restore delivery for consent-only customers.** P85-4 sets `accepts_marketing = false` on every link opt-out. For a customer with no orders that makes the *other* channel `not_eligible`: email one-click → SMS `not_eligible`. "Subscribe again" lifts the suppression but leaves `accepts_marketing = false`, so the customer reads `not_eligible` and still gets nothing, though they asked to resubscribe (seen in `phase8-5.email`, annotation `resubscribe`). Conformant to the contract as written, but it contradicts "per channel" (P85-4) and the page copy. Suggest resubscribe re-sets `accepts_marketing = true`, or eligibility ignores that flag when a `link` row was removed by the shopper | Open (decision) |
| P85-QA-5 | Medium | infra (compose owner), §5.1 | **No `campaigns` queue worker or campaign env in `docker-compose.yml`.** Sends stay queued on the compose stack. The same gap as P84-QA-1. Needed: a `queue-campaigns` service (`queue:work redis --queue=campaigns --tries=1 --timeout=120 --sleep=1`), `CAMPAIGN_MAILER` / `CAMPAIGNS_DEV_SINK` in the compose `x-api` env and `infrastructure/docker/.env.example`, plus RUNBOOK rows. Not edited by QA (outside the QA file list). CI's `e2e.yml` works around it: it writes the flags and starts a worker unless compose defines `queue-campaigns` | Open |
| P85-QA-6 | Low (gap) | WEB / test ownership | No storefront Vitest covers the unsubscribe page (`copy.ts` screens, actions, one-click route): `apps/storefront/tests/**` had no owner this phase. Contract §11 lists "storefront unsubscribe page states". Covered only by Playwright (`phase8-5.campaigns`, `.email`, `.regressions`, `.visual`) | Open |
| P85-QA-7 | Info | WEB, §8.6 | The unsubscribe page is English-only. The storefront has no store-language setting yet (`copy.ts` header), so "bn/en follows the store language" isn't met. Reported by WEB | Open (doc) |
| P85-QA-8 | Info | WEB | The composer fires an audience preview on every edit. A merchant editing quickly can hit the 30/min `campaigns-preview` limiter, and the box then says "We couldn’t count this audience. Check the segment and try again." This was seen once in `phase8-5.visual`, which fills the composer 6 times. A 429 deserves its own message ("Too many changes, try again in a minute") | Open (optional) |
| P85-QA-9 | Info → **fixed** | e2e | QA prep assumptions corrected against the built code: `unsubscribed_source` is `{sms, email}` (not a string); `send_mode` isn't an input field; list filter is `filter[status]`; a staff member **can** use the customer opt-out toggle (`customers.edit`, §2.1); `/marketing` without `marketing.manage` redirects to Coupons (`App.tsx:93–96`) rather than a no-access state | Fixed in `tests/e2e/**` |

## 3. Security checklist (§10)

| S | Control | Pest evidence (API) | E2E evidence | Result |
|---|---|---|---|---|
| S113 | Opt-out wins at send time | `campaigns` group (pipeline / suppression tests) | Campaign 2 after A's opt-out: sink has no SMS to A; A's row (when kept) `skipped/opted_out` | **Pass** (the between-snapshot-and-batch race is covered by Pest only) |
| S114 | Suppression by address survives delete/re-create | group | A deleted and re-created with the same phone → `marketing.sms = unsubscribed`, not messaged | **Pass** |
| S115 | Every message has a working link; email `List-Unsubscribe` headers | group (renderer, headers) | Every SMS ends `STOP: {host}/u/{code}`, unique per recipient; every email sink copy has `https://{host}/u/{code}`. Headers are not visible in the sink, so Pest only | **Pass** |
| S116 | GET read-only, POST idempotent, identical 404s, sha256, 429 | group | Page load leaves status `subscribed`; two POSTs → equal 200 bodies; unknown/malformed/foreign → identical 404 `unsubscribe_link_invalid`; 21st request/min → 429 | **Pass** |
| S117 | Code of store A on B's host → 404 | group | `phase8-5.email`: API and page | **Pass** |
| S118 | Merchant can't clear customer-owned opt-out | group | DELETE → 409 `suppression_customer_owned`; PATCH `accepts_marketing=true` → still unsubscribed; merchant-owned suppression removable | **Pass** |
| S119 | Cross-tenant/store isolation, RLS | group (+ RLS on Postgres per API) | Foreign-store code 404 | **Pass** (RLS run not repeated by QA) |
| S120 | Staff 403 on every §6.1 route; masked addresses | `RoutePermissionsTest` rows | Staff 403 on all 16 routes + dev sink; no `marketing.manage` in `/auth/me`; recipient `masked_address` never has 6+ digits | **Pass** |
| S121 | At-most-once | group | Each address exactly once per campaign in the sink | **Pass** |
| S122 | Allowances; Free 402 | group | Free: send/schedule/test → 402 `plan_limit_reached`, `upgrade_plan` starter, `details.*.limit 0`; Starter estimate limits 1 000 / 5 000 | **Pass** |
| S123 | Content escaping, header injection | group (renderer) | Email `text` sink copy only (no HTML in the sink); the subject is sent as typed | **Pass** (Pest) |
| S124 | Quiet hours + schedule bounds in store tz | group (frozen clock) | Store tz moved so local time is 13:00 / 02:00: 22:30, 21:00, tomorrow 08:30 → 422 `campaign_quiet_hours` with `allowed_from`; < 5 min and > 90 d → 422; night "Send now" → 422; the composer shows it inline | **Pass** |
| S125 | Dev sink / log mailer refused in production | group | — | **Pass** (Pest) |
| S126 | Audit rows; impersonation can't send | group | — | **Pass** (Pest) |

## 4. Acceptance criteria (§14)

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | **Opt-out respected** (link, one-click, merchant toggle; scheduled-before and re-created customers; working link in every message) | S113–S115, S118; `phase8-5.campaigns` (5/5 in the final run), `phase8-5.email` | **Met** (cross-channel side effect: P85-QA-4) |
| 2 | Create, preview, test, schedule/send now, cancel; at-most-once; quiet hours; allowances; attribution + overview match orders | `phase8-5.campaigns`, `.schedule`, `.access`, `.email`; attribution and overview numbers by Pest only | **Met** |
| 3 | Overview, list, composer, detail match Figma with omissions; storefront unsubscribe page; states; 375 px | `phase8-5.visual` 1280/390/375: no page overflow, no console errors, hidden items absent; screenshots `tests/e2e/test-results/phase8-5-visual/{width}/` (regenerate before the Figma review) | **Not met**: P85-QA-2 (High), P85-QA-1 (Medium), P85-QA-3 (Low) |
| 4 | `pnpm -r test` / `typecheck`, Pest (sqlite + Postgres + `api-rls`), Playwright `phase8-5.*`, redocly | §1 | **Not met** only through the two Playwright regressions; everything else green (Postgres/RLS per API) |

## 5. QA deliverables

- Specs: `tests/e2e/specs/phase8-5.{campaigns,email,schedule,access,visual,regressions}.spec.ts`, helpers
  `tests/e2e/support/campaigns.ts` (store-tz control for quiet hours, dev-sink reader, `kickDispatchDue()`); the
  `marketing.manage` label in `support/roles.ts` is now "Coupons & campaigns" (§2.1).
- CI: `ci.yml` gains a `campaigns` group step on sqlite (must be non-empty), on Postgres and with RLS on. `e2e.yml`
  writes `SMS_DRIVER=log`, `CAMPAIGN_MAILER=log` and `CAMPAIGNS_DEV_SINK=true` (root `.env` and `apps/api/.env`), and
  starts a `campaigns` worker unless compose defines `queue-campaigns`.
- `docs/development/TESTING.md`: the Phase 8.5 group row, the `phase8-5.*` spec table, and a local-run recipe with the
  alternate-port, limiter and sqlite notes.

Re-gate: after P85-QA-1 and P85-QA-2 are fixed, run `cd tests/e2e && pnpm exec playwright test phase8-5.` (all 24
must pass) and decide P85-QA-4.

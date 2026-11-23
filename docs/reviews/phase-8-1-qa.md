# QA gate: Phase 8.1 (super admin, impersonation, suspension)

Date: 2026-11-23 · Branch `phase-8-super-admin` @ fd1837f + the uncommitted Phase 8.1 working tree (API, WEB, SF done) ·
Contract PHASE-8-1-CONTRACT §9 (S67–S81), §10 (QA), §11, §14. Reviewer: QA.

**Verdict: pass on fake drivers, with one Medium product gap for the PO (P8-QA-1).** Two blockers found at this gate
are fixed in the same working tree (P8-QA-3: `migrate:fresh` broke on Postgres, so `api-rls` would have been red;
P8-QA-4: twelve admin tests failed with RLS on). After the fixes every `admin`, `impersonation`, `rls`, `security`,
`domains`, `billing` and `reports` test passes on Postgres as the app + admin roles with RLS on, and the five new
`phase8.*` Playwright specs pass end to end in a real browser: TOTP sign-in and lockout, search → extend / comp plan
change / void / mark paid with audit rows, read-only impersonation with toast, exit and revoke, suspension → 503
storefront + suspended dashboard → reactivation, and invite → enrol → Billing role without Suspend.

## 1. What ran

| Check | Environment | Result |
|---|---|---|
| `php artisan test` (whole API suite) | sqlite in-memory | 954 tests: 896 passed, 58 skipped (pgsql-only), 0 failed (before and after the fixes) |
| `--group=rls` | scratch Postgres 18 cluster (UTC, like CI), fresh `storeplix_rls_test`, roles from `01-roles.sql`, migrations as `storeplix_owner`, app as `storeplix_app`, `TENANCY_RLS=true`, `CACHE_STORE=array` | **35 / 35** (after P8-QA-3) |
| `--group=admin` (RLS on) | same | **71 / 71** (after P8-QA-4; 59 / 71 before) |
| `--group=impersonation` (RLS on) | same | **20 / 20** |
| `--group=security --exclude-group perf --exclude-group race` (RLS on) | same | **310 / 310** (after P8-QA-4) |
| `--group=domains` / `billing` / `reports` (RLS on) | same | **133 / 133**, **85 / 85**, **13 / 13** (Phase 6/7 command tests unchanged and green, AC 6) |
| `--group=tenancy` / `plans` (RLS on) | same, first run (server TZ +06, see note) | 112 / 112, 11 / 11 |
| `pnpm -r typecheck` / `pnpm -r test` | local | green: super-admin 39, merchant-dashboard 376, storefront 415, api-client 130, ui 52, themes 125, config 1 |
| `pnpm -r lint` | local | 0 errors (warnings only) |
| `npx @redocly/cli@1.25.11 lint docs/api/openapi.yaml` | — | valid (29 warnings) |
| Playwright `phase8.*` (new, 25 tests) | API `composer dev` (sqlite dev DB migrated forward, `PAYMENTS_FAKE`/`COURIERS_FAKE`/`DOMAINS_FAKE`/`BILLING_FAKE`), merchant :5173, admin :5174, storefront :3000 | **25 / 25** in 3 of 4 full runs; one run had 1 failure (P8-QA-5) |
| Playwright `phase8.*` on **Postgres + RLS** (after the gate) | scratch Postgres 18 (UTC) `storeplix_e2e_pg` (01-roles.sql run per DB), API `artisan serve` :8200 as `storeplix_app` with `TENANCY_RLS=true`, database cache/queue/session, fakes on, merchant :5283, admin :5284, storefront :3200 | run 1: 25 / 26 (impersonation revoke timing, spec fixed); runs 2–3: **26 / 26**; impersonation alone 3 × 4 / 4. No product bug in apps/api |
| `api-postgres` reproduced (after the gate) | scratch Postgres 18 (UTC), superuser as CI, RLS off, `storeplix_test` | migrate:fresh + seed, rollback to the first migration + migrate OK; tenancy 112 (81 + 31 skipped), security 310 (308 + 2), domains 133 (130 + 3), billing+plans+reports 98 (97 + 1), admin+impersonation 72 (70 + 2): **0 failed**. Whole suite excl. perf/race: 934 tests, 896 passed, 38 skipped, 0 failed |
| `api-perf` reproduced | `storeplix_perf`, `CACHE_STORE=array` | perf 20 / 20 on a quiet run (import 57 s / 120 s; checkout p95 33 ms, online 32 ms / 300 ms; shipments list p95 26 ms). A loaded run (other agents' stacks, disk nearly full) had `ReportsPerfTest` p95 1036 ms > 800 ms (cold first sales request; budget margin is thin, as noted at the Phase 7 gate) and the import at 115 s. Race loop 16 / 16; checkout-perf 2 / 2 |
| `api-rls` race loop + checkout-perf | `storeplix_rls_test`, RLS on | race 16 / 16; checkout-perf 2 / 2 (p95 32 ms / 48 ms) |
| Full Playwright suite (regression) | same stack | see §5 |

Note on the first Postgres run: the scratch cluster took the machine's +06 time zone; many Phase 6/7 time assertions
failed by exactly 21 600 s. CI's Postgres runs in UTC; re-running with `timezone = 'UTC'` made them all green. Not a
product issue, but anyone repeating §2d locally on a non-UTC machine must set the server time zone.

Not run: the CI workflows themselves (no push); the e2e suite on Postgres with
RLS on at gate time (done afterwards, see the Postgres row); a deliberate 1024 px pass over every admin screen (AC 8;
the specs run at 1280 px).

**Final combined check after all fixes (sqlite, local):** `pnpm -r typecheck` clean; `pnpm -r test` green (merchant-dashboard
384, super-admin 39, storefront 415, api-client 130, ui 52, themes 125, config 1); `php artisan test` 955 tests, 897
passed, 58 skipped, 0 failed; `vendor/bin/pint --test` passes (it failed on `BillingInvoiceController.php` before; import
order only, fixed); redocly valid.

## 2. Findings

| # | Sev | Area | Finding | Repro / evidence | Suggested fix |
|---|---|---|---|---|---|
| P8-QA-1 | Medium → **fixed** (2 PO questions open) | WEB merchant (§7.2, §10 `phase8.merchants`, AC 2) | **Staff actions are not visible anywhere in the merchant UI.** The contract wants them in the merchant's "Activity log" as "Store Plix support". The only activity list in the dashboard is Staff → "Recent staff activity", which queries `action: staff.*`, so billing actions (extend, comp change, void, mark paid), suspension and impersonation start/end never show. The API side is right: `GET /audit-logs` returns them with `actor.type: platform_user` and no staff name/email/id (S81, asserted in the spec). | `apps/merchant-dashboard/src/pages/StaffPage.tsx:67`; spec `phase8.merchants` "merchant audit API …" | **Fixed** (no Figma frame for a merchant activity log exists, so no new screen): `GET /audit-logs` gains `filter[actor_type]` (`user`/`system`/`platform_user`, 422 otherwise; openapi, types, api-client, `AuditLogTest` incl. tenant scoping); the Staff card merges its `staff.*` query with `actor_type=platform_user` rows (newest 5) and reads them as "Store Plix support …"; `staff-activity.test.tsx`; `phase8.merchants` checks `/staff`. **PO:** (a) rename the card "Recent staff activity" → "Recent activity"? (b) an impersonation that ends by expiry is audited with the system actor, so it doesn't appear there — acceptable? |
| P8-QA-2 | Low → **fixed** | WEB merchant (§7.2) | During impersonation the Account page reads "E2E Super Admin · Owner of QA p8i": `/auth/me` is the staff user with owner-level access, and the page labels them as the owner. Its Save calls the API outside a TanStack mutation, so the global read-only toast doesn't fire there (the inline "This is a read-only impersonation session…" alert does). | Open `/account` in an impersonation | **Fixed**: during impersonation `AccountPage` shows a read-only "Account settings aren’t available in a support session." notice (EmptyState) instead of the staff member's profile, password, shops, transfer and Sign out; normal sessions unchanged. `__tests__/account.test.tsx` (2 tests), `phase8.impersonation` checks `/account` |
| P8-QA-3 | **High → fixed** | API migrations (AC 7, 9) | `migrate:fresh` on an already-migrated Postgres database failed: `2026_09_01_000200` changes `sp_resolve_host`'s return type, functions survive `migrate:fresh`, and the merged `2026_06_01_000100` then runs `CREATE OR REPLACE` with the old type (`42P13 cannot change return type`). `api-rls` migrates + seeds, then `TestCase` runs `migrate:fresh` again, so every RLS test would have errored in CI; any local Postgres re-migrate too. | 35/35 `rls` errors with `42P13` on the scratch cluster | **Fixed**: `TenancyServiceProvider` listens to `MigrationsStarted` and drops `sp_resolve_host(text)` only when `2026_06_01_000100` hasn't run yet (fresh/new DB); merged migrations untouched (forward-only rule); production never affected |
| P8-QA-4 | **Medium → fixed** | API tests (AC 7) | 12 admin tests failed with RLS on: they read platform-level `audit_logs` rows (`tenant_id` null) and one fixture moved a `tenant_users` row through the app connection, which RLS hides (0 rows, then 403). | `AdminLoginTest`, `TeamTest` | **Fixed**: use the existing `platformQuery(AuditLog::class)` / `platformTable()` helpers (pgsql_admin in RLS mode). No product code changed |
| P8-QA-6 | **High → fixed** | WEB admin | The whole admin app went blank (`Cannot read properties of null (reading 'primary_host')`) on the dashboard and merchants list when a tenant has no store yet (owner registered, shop not named). The API returns `store: null`, but openapi 1.9.0 and `packages/types` marked it required | Two such tenants in the dev DB | **Fixed**: SPA handles `store: null` (dashboard, merchants, detail, dialogs, search, shop picker) + a page-level error boundary showing the 148:35336 error state; `AdminTenantSummary.store` is `object \| null` in openapi and types |
| P8-QA-7 | Medium → fixed | e2e fixture | `PlatformStaffE2eSeeder` set `password_changed_at = now()` on every run, which ends every live session of the shared super admin: a spec re-seeding (lock reset) signed out specs running next to it — a likely cause of P8-QA-5 | `phase8.*` runs alongside another spec | **Fixed**: password and `password_changed_at` are only reset when the user is new or the password no longer matches |
| P8-QA-8 | Low → **fixed** | WEB merchant / API (§7.2) | The API answers `401 impersonation_ended` once and invalidates the session; later requests get `unauthenticated`. If that one response is lost (tab navigates mid-request, network drop), the merchant app shows the login page ("session expired") instead of "Impersonation ended", because `impersonation.info` lives only in memory | Found on Postgres: revoke while the dashboard's first reads are in flight, then navigate | **Fixed** in the merchant app: `impersonation/store.ts` keeps an `impersonation_active` flag in `sessionStorage`, so any later 401 in that tab ends the impersonation (ended screen) instead of the login page; cleared on sign-out and on a normal `/auth/me`. `impersonation-store.test.ts` (3). The spec also waits for `networkidle` before revoking |
| P8-QA-5 | Low | e2e | One full `phase8.*` run: `phase8.team` landed on "This invitation can't be used" right after the mailed link opened. Not reproduced in 5 further runs (2 alone, 3 full); the trace was lost to the next run's cleanup. | `tests/e2e/specs/phase8.team.spec.ts` | Watch it in the next runs (local stack is sqlite, known for lock flakes); keep the trace if it recurs |

## 3. Changes made at this gate

- `apps/api/app/Domain/Tenancy/TenancyServiceProvider.php`: P8-QA-3.
- `apps/api/tests/Feature/Admin/Auth/AdminLoginTest.php`, `.../Team/TeamTest.php`: P8-QA-4.
- `.github/workflows/ci.yml`: `admin` and `impersonation` groups in `api` (sqlite, must be non-empty),
  `api-postgres` and `api-rls` (RLS on).
- `docs/deployment/RUNBOOK.md` §11 (environment, schedule, first super admin, break glass, suspension, impersonation);
  `apps/api/.env.example` gains the §11 `ADMIN_*` / `IMPERSONATION_*` keys.
- `tests/e2e/support/admin.ts` (TOTP without a dependency, admin sign-in/session, `reseedSuperAdmin()` also resets the
  `admin-login` throttle); `support/api.ts` `createTenant()` returns the owner phone; specs
  `phase8.admin-auth|merchants|impersonation|suspension|team`; `docs/development/TESTING.md` rows.

### AC 8 visual pass (after the gate)
New `tests/e2e/specs/phase8.admin-visual.spec.ts` (own throwaway super admin, 11 views × 1280×800 and 1024×768,
`scrollWidth <= innerWidth`, render errors fail, screenshots to `test-results/admin-visual/`): **2 / 2**. Compared
with Figma 15:123, 32:5527, 33:4851, 34:859, 36:1598, 45:8156, 39:12019, 39:16118, 32:5666. Fixed: P8-QA-6; pill tabs
with counts (32:5667) on Merchants / Billing / Team with Sort and filters in the tabs row as designed; collapsed
Invoice / Member / Reason columns (min widths, scroll inside the card); dashboard KPI icon; "1 invoice" plural.
Left as is: at 1024 px wide tables scroll inside their card (row menu behind the scroll, allowed by §7.1); shared
`Select` is 44 px vs Figma 40 px and shows "Plan: All" (shared with the merchant app, not changed here); login,
enrolment and dialogs not in the screenshot pass (covered functionally by `phase8.admin-auth` / `phase8.team`).

## 4. Acceptance criteria (§14)

| # | Status |
|---|---|
| 1 | Pass: password + TOTP required (API + UI), surfaces separated both ways (`phase8.admin-auth`, `AdminPermissionTest`) |
| 2 | Pass for the API (reason on every write, one audit row with the platform actor). Merchant-side visibility: P8-QA-1 |
| 3 | Pass: search by name, slug, owner email and phone (spec); domain and invoice number in `AdminReadsTest` |
| 4 | Pass (`phase8.impersonation`, `ImpersonationTest`, `ImpersonationRlsTest`) |
| 5 | Pass (`phase8.suspension`, `SuspensionTest`) |
| 6 | Pass: Phase 6/7 command tests unchanged (`git status` shows no edited Billing/Domains test) and green on sqlite and RLS |
| 7 | Pass after P8-QA-3/4 |
| 8 | Pass with the noted leftovers: every §7.1 route at 1280 and 1024 px, no overflow, Figma deviations fixed (see AC 8 visual pass) |
| 9 | Pass locally (CI not run): `pnpm -r test`, `typecheck`, Pest sqlite + RLS groups, `phase8.*`, redocly |

## 5. Full Playwright regression

1. First attempt (183 tests): **not valid** — it overlapped with the agents' Playwright runs (13 `ENOENT` on
   `test-results/.playwright-artifacts-*` deleted by a concurrent cleanup) and their load on the shared sqlite DB.
2. Quiet re-run (186 tests, sqlite dev stack up for hours): 122 passed, 18 failed, 3 skipped, 43 did not run (serial
   followers). The API log had 1 081 `database is locked` errors (composer dev restarts six `queue:work --once`
   workers every few seconds against one sqlite file).
3. Each failing file alone, then **A/B against the branch's last commit fd1837f** (Phase 7 in, Phase 8.1 out; git
   worktree, same machine, a `.backup` copy of the same dev DB, same fake drivers):

| Spec file | Phase 8.1 tree | Baseline fd1837f | Verdict |
|---|---|---|---|
| phase4.catalog, phase4.import-export, phase4.inventory, phase4.storefront, phase5.security, phase5b.couriers, phase5b.documents, phase5b.online-checkout, phase6.domains | fail alone | **fail alone too** | Pre-existing (local sqlite stack; matches the known list: import re-run, parallel stock, courier connect, labels, domains) |
| phase5.manual-order, phase7.billing-security | pass alone | pass | Load flake in the full run |
| phase5.mobile, phase5b.mobile, phase5b.payment-link | fail on the hours-old stack, **pass 2 / 2 on a fresh stack** | pass | Stale stack (storefront dev server and API under hours of load) |
| phase7.reports | 2 / 5 pass, every failure `database is locked` on the staff-invite accept insert | **2 / 5 pass, same error** | Pre-existing flake |
| phase5.storefront-buy | 5 / 8 pass (failures on the first visits after a cold start: missing PDP heading, coupon message, each within 10 s) | 4 / 4 pass | **Inconclusive**, see P8-QA-9 |
| phase8.team | fail on the old stack; **3 / 3 pass** fresh (after the P8-QA-7 seeder fix) | n/a | Stale stack / P8-QA-7 |

**P8-QA-9 (Low, SF, observation):** the storefront proxy's suspension check (`apps/storefront/lib/suspension.ts`)
adds at most one blocking `GET /storefront/config` per host every 15 s (3 s timeout), but failed lookups (e.g. API 500
under sqlite locks) are not cached, so every page view retries while the API struggles, and a cold page can wait up
to 3 s longer. Plausible cause of the cold-start `storefront-buy` flakes on this branch; not proven with this sample.
Suggested: cache failures as "not suspended" for a few seconds, and re-measure on the Postgres e2e stack (where the
26 / 26 `phase8.*` runs passed).

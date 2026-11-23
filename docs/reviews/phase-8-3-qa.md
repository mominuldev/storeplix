# QA gate: Phase 8.3 (custom roles & granular permissions)

Date: 2026-11-24 · Branch `feat/phase-8-3-roles` @ 4b69482 + the uncommitted Phase 8.3 working tree (API, WEB done) ·
Contract PHASE-8-3 §9 (S91–S99), §10, §13. Reviewer: QA.

**Verdict: pass with findings.** Authorization is sound. Every §9 control holds, both in the API tests and in an
end-to-end run against the real API and dashboard. I re-recorded the parity fixture on `main` myself and it matches the
committed one exactly (156 routes × owner/admin/staff, 0 differences). The Postgres RLS groups are green. One
**Medium** finding (P83-QA-1) is open: on a phone the Staff page's permission matrix can't be ticked. This partly misses
AC 5 ("usable at 375 px") and keeps 2 of the 25 `phase8-3.*` Playwright tests red. Fix it before merge. The role
detail page is a working fallback on mobile. The other findings are Low or Info.

## 1. What ran (all by QA)

| Check | Environment | Result |
|---|---|---|
| `php artisan test --exclude-group perf --exclude-group race` | sqlite in-memory | **1023 tests: 983 passed, 40 skipped, 0 failed** |
| `--group=roles` | sqlite | 61: 60 passed, 1 skipped (`RolesRlsTest`, pgsql only) |
| `--group=rls` / `roles` / `tenancy` / `security` (RLS on) | scratch Postgres 18 cluster (**UTC**), fresh `storeplix_rls_test`, `01-roles.sql`, `migrate:fresh --seed` as `storeplix_owner`, app as `storeplix_app`, api-rls env | **rls 37/37 (0 skipped)**, **roles 60/61** (1 skipped: `RolesMigrationTest`, sqlite only, see P83-QA-5), **tenancy 114/114**, **security 355/355** |
| Full suite, RLS on | same cluster | 1023 tests: 1016 passed, 6 skipped (4 Gotenberg, 2 sqlite-only migration tests), **1 failed: `RlsLifecycleTest`**. The same failure on **`main`** (962 tests, same single failure, see P83-QA-2) |
| Parity fixture re-recorded on `main` | `git archive main apps/api` into the scratchpad with its own `vendor` + autoload; this branch's `PermissionParityTest` copied in with its two route-coverage asserts removed (the 6 role routes don't exist on `main`), `PARITY_RECORD=1`, sqlite | 156 routes recorded. **Identical** to `tests/Fixtures/permission-parity.json` (0 differing codes, same keys). On the branch the parity test passes on sqlite and with RLS on |
| Backfill on Postgres (not covered by Pest, P83-QA-5) | separate scratch DB: `migrate:fresh --seed`, `migrate:rollback --step=4`, insert 2 legacy tenants (O/A/S members; open, accepted and revoked invitations), `migrate` | every row has the matching system `role_id` (7 members, 6 invitations); both columns NOT NULL; `roles` and `role_permissions` RLS enabled and forced. Also on the **dev sqlite DB** (`php artisan migrate`, additive): 1 tenant → 3 system roles, owner mapped |
| `vendor/bin/pint --test` | — | passed |
| `pnpm -r typecheck` / `pnpm -r lint` | — | clean / 0 errors (warnings only) |
| Vitest | — | merchant-dashboard **405**, api-client **140**, super-admin 55, ui 57: all green |
| `pnpm --filter …merchant-dashboard / super-admin build` | — | built |
| `npx @redocly/cli@1.25.11 lint docs/api/openapi.yaml` (1.11.0) | — | valid (29 warnings, as in 8.1/8.2) |
| **Playwright `phase8-3.*`** (25 tests, 5 files, new) | API `artisan serve` with `PAYMENTS/COURIERS/DOMAINS/BILLING_FAKE=true`, queue worker, sqlite dev DB, merchant :5173 | **23 passed, 2 failed (P83-QA-1)** in two consecutive full runs. No console errors on any screen. The member never receives a 403 from the SPA's own calls |
| Playwright legacy O/A/S (§10 `phase8-3.legacy`): `phase4.staff`, `phase4.security`, `phase5.security`, `phase5.merchant-orders`, `phase5b.payments-security`, `phase6.domains`, `phase7.billing-security`, `phase7.limits`, `phase7.reports`, `phase8.team` | same stack + super-admin :5174 + storefront :3000 + `DOMAINS_ASK_KEY` | all green once the environment was complete and the flaky files ran on their own. The first run's failures: :5174/:3000 not started, ask key unset, sqlite "database is locked" (memory note `local-e2e-setup`), and one real spec change (P83-QA-4) |

Not run: the `perf` / `race` groups (no 8.3 tests in them), the CI workflows themselves (no push), E2E on Postgres.

## 2. Findings

| # | Sev | Area | Finding | Status |
|---|---|---|---|---|
| P83-QA-1 | **Medium** | WEB, AC 5 / Q125 | **The Staff matrix can't be used at 390 or 375 px.** The table's sticky "Permission" column (`sticky left-0`, table `minWidth: 320 + n × 96`) is 320 px wide. That is wider than the card's scroll area (306 px at 390). So at **every** horizontal scroll position the sticky `<th>` covers the role columns, and no checkbox can be clicked (Playwright: "`<th scope=row class="sticky left-0 …">` intercepts pointer events"). The sticky group sub-header rows (`scope=rowgroup colSpan`) also lose their label on scroll and show as blank bands. `apps/merchant-dashboard/src/staff/PermissionMatrix.tsx:121` (min width), `:124`, `:137`, `:143` (sticky cells). Repro: `pnpm exec playwright test phase8-3.visual -g "Staff matrix at 390px"`; screenshot `tests/e2e/test-results/phase8-3-visual/390/matrix-scrolled.png`. Suggested fix: below `sm`, cap the sticky column (e.g. `w-[140px]`/`max-w-[45vw]`, description hidden or clamped) or drop `sticky` there; give the group header a non-sticky inner span. The role detail editor works at 390 px | **Open** (spec stays red until fixed) |
| P83-QA-2 | Low | API tests (pre-existing) | `RlsLifecycleTest::test_worker_running_job_a_then_job_b_never_sees_a_in_b` fails **only in a single-process full-suite run** with `queue:work` exit **12** = `Worker::EXIT_MEMORY_LIMIT`. By then the PHPUnit process has passed `queue:work`'s default `--memory=128` MB, so the worker stops before the jobs. It is **identical on `main`** (full RLS run of `main` code: 962 tests, same single failure), so it is not caused by 8.3. CI is unaffected: `api-rls` runs it inside the 37-test `rls` group, where it passes (and in `tenancy`). `apps/api/tests/Feature/Tenancy/Rls/RlsLifecycleTest.php:46`. Suggested fix (API): pass `'--memory' => 1024` to the `artisan('queue:work', …)` call | Open (not blocking) |
| P83-QA-3 | Low | Contract consistency | §10 QA says the "Order staff" member sees "no Customers/Reports/**Settings** nav". §7.1 doesn't gate Settings: the settings reads are base (§3.1) and the pages are read-only without `settings.manage`. The build follows §7.1, so Settings (and Integrations) stay visible. ARCH/PO to decide; the spec asserts Customers/Reports/Staff/Import hidden only. `apps/merchant-dashboard/src/layout/nav.ts:90`, `docs/development/PHASE-8-3-CONTRACT.md:482` | Open (doc) |
| P83-QA-4 | Low → **fixed** | e2e (legacy spec) | `phase5.security` "S10 … staff limits" pinned the old message "Only owners and managers can cancel paid orders." The API now says "You do not have permission to cancel paid orders." (`apps/api/app/Domain/Orders/OrderService.php:240`): status 403 and code `forbidden` are unchanged, and the old copy is wrong once custom roles can hold `orders.refund`. The spec now asserts the code | Fixed in `tests/e2e/specs/phase5.security.spec.ts` |
| P83-QA-5 | Info | API tests | `RolesMigrationTest` (the §10 migration test) is sqlite only. On Postgres, 000400's NOT NULL + FK make a pre-8.3 row unrepresentable, and CI `api-postgres` only runs the backfill on an empty schema. QA checked the Postgres backfill by hand (§1). Optional: a pgsql variant that runs 000300 between a rollback of 000400 and re-applying it | Open (optional) |
| P83-QA-6 | Info → **fixed** | CI | `.github/workflows/ci.yml` did not run the new `roles` group anywhere | **Fixed**: `roles` step added to `api` (sqlite, fails if empty), `api-postgres`, and `api-rls` (`run-group.sh roles lenient`; lenient because the sqlite-only migration test skips there) |

## 3. Security checklist (§9)

| S | Control | Evidence |
|---|---|---|
| S91 | `perm:` on every tenant route = §3 | `RoutePermissionsTest` (3 tests, also `security`), green on sqlite and RLS. Parity cases ↔ route list asserted both ways in `PermissionParityTest` |
| S92 | Escalation by granting (N1, N2) | `RolesApiTest::test_nobody_grants_or_edits_more_than_they_hold`. E2E `phase8-3.delegation`: `staff.manage`-only member → `costs.view` role 403 `permission_not_held` (`details.permissions: [costs.view]`); bigger custom role PATCH/DELETE 403, `editable: false`; ⊆ role allowed |
| S93 | Escalation by assignment (N5, N6, owner) | `RolesApiTest::test_nobody_assigns_or_removes_roles_beyond_their_own`. E2E: invite Manager/Staff (also legacy `role: admin`), promote, demote/remove a Manager, revoke/resend a Manager invitation, **delete with `reassign_to` Manager/Staff** → 403; `role_id` = owner → 422. UI: Manager/Staff radios disabled with "Has permissions you don’t have", no actions on Manager rows |
| S94 | Self-escalation (N3, N7) | `test_system_roles_are_locked_and_nobody_edits_their_own_role`, `test_own_membership_and_the_owner_are_protected`. E2E: PATCH/DELETE own role → `cannot_edit_own_role`; own membership → `cannot_change_own_role`; own role page read-only, own row "Leave shop" only |
| S95 | System roles locked (N4) | Same tests + `test_injected_permission_rows_are_ignored`. E2E: PATCH/DELETE owner/admin/staff as the owner → 409 `system_role_locked` |
| S96 | Cross-tenant roles | `RolesApiTest::test_roles_are_isolated_by_tenant` (`tenancy`), `RolesRlsTest` (rls). E2E `phase8-3.editor`: foreign role 404 on GET/PATCH/DELETE; foreign `role_id` / `reassign_to` → 422 |
| S97 | Stale permissions | `MeTest::test_changes_apply_on_the_next_request`, `test_removing_a_key_applies_on_the_next_request`. E2E: adding `customers.view` → member API 200 at once; the open tab shows Customers after the focus (`visibilitychange`) refetch, with no sign-out |
| S98 | Downgrade escalation | `test_custom_roles_need_growth_and_stay_enforced_after_a_downgrade`. E2E `phase8-3.plan`: after Growth → Free the member keeps exactly `[orders.view, orders.process]` (customers still 403); create/edit/assign/invite 402; delete with reassign to Staff works |
| S99 | Unknown keys | `PermissionCatalogueTest::test_permission_set_ignores_unknown_keys…`, `test_injected_permission_rows_are_ignored`, DB CHECK. E2E: unknown key and `billing.manage` in payload → 422 |

Code read: role writes take `Tenant … lockForUpdate()` and lock the role row inside one transaction
(`RoleService.php:177–256`). The matrix only makes a column live when `!is_system && editable && custom_roles_enabled`,
and a cell only when the key is grantable and held. The API remains the gate either way.

## 4. Acceptance criteria (§13)

| AC | Status |
|---|---|
| 1 Every route needs its §3 key; allow/deny per key; conditional checks | ✓ (`RoutePermissionsTest`, `PermissionEnforcementTest` dataset + 6 conditional tests) |
| 2 O/A/S parity on every route, sqlite and Postgres | ✓, and the fixture was independently re-recorded on `main` (§1) |
| 3 Custom roles: create/edit/duplicate/delete-with-reassign, assign to members and invitations, Growth-gated, ≤ 20, audited, next request | ✓ (Pest + E2E `roles`, `editor`, `plan`; audit `role.created/updated/deleted`, `staff.invited`, `staff.role_changed`, `role.deleted` meta `members_moved: 1, invitations_moved: 1`) |
| 4 N1–N9; owner unique and all-powerful; system roles locked | ✓ |
| 5 SPA hides nav/pages/actions; Staff, role detail, invite modal; states; usable at 375 px | ✓ except **P83-QA-1** (matrix at 375/390). Nav/deep links/actions verified for a custom-role member; screenshots at 1280/390/375 in `tests/e2e/test-results/phase8-3-visual/` |
| 6 `pnpm -r test`/typecheck, Pest sqlite + Postgres + `api-rls` (`roles`, `rls`, `security`), Playwright `phase8-3.*`, redocly | ✓ except 2 Playwright tests red until P83-QA-1 is fixed. The CI `roles` wiring was added at this gate |

## 5. Builder claims checked

| Claim | Result |
|---|---|
| sqlite 984 passed / 62 skipped / 0 failed | Confirmed in substance: 0 failed. Without `perf`/`race`: 983 passed / 40 skipped of 1023 |
| `rls`, `tenancy`, `security`, `roles` green on Postgres RLS | Confirmed (counts in §1) |
| `RlsLifecycleTest` fails only after earlier tests | Confirmed; the cause is the worker's 128 MB memory stop, and it is pre-existing on `main` (P83-QA-2) |
| Parity fixture: identical codes on all 156 routes | Confirmed: identical **before vs after** for each role (the codes differ between roles as expected, e.g. staff 403 on `/staff`), re-recorded on `main` |
| WEB green only against mocks | Now also exercised end to end against the real API: 23/25 green, the 2 red are P83-QA-1 |

## 6. Files changed at this gate

- `tests/e2e/specs/phase8-3.{roles,delegation,plan,editor,visual}.spec.ts` (new, 25 tests)
- `tests/e2e/support/roles.ts` (new): `shopOn(plan)`, role/staff API helpers, §2.1 labels, nav/console/overflow watchers
- `tests/e2e/support/api.ts`: `createMember(owner, { role_id })`; `acceptInvitation()` split out for UI-sent invites
- `tests/e2e/specs/phase5.security.spec.ts`: P83-QA-4
- `.github/workflows/ci.yml`: `roles` group in `api`, `api-postgres`, `api-rls` (P83-QA-6)
- `docs/development/TESTING.md`: Phase 8.3 group row, `phase8-3.*` spec rows, run notes
- `docs/reviews/phase-8-3-qa.md`: this report

## 7. Fixes (fixer pass, 2026-11-24)

Every finding from this gate and from the Phase 8.3 security review is fixed. Each one has a test that fails without
the fix and passes with it. Failure without the fix was checked by temporarily reverting the change.

| # | Status | Fix | Evidence |
|---|---|---|---|
| SEC-M1 (product export leaks `cost_price`) | **Fixed** | New forward-only migration `2026_11_01_000500_add_include_costs_to_data_exports` (`include_costs` boolean, default false). `ExportController::store` records whether the requester holds `costs.view`, and `RunExport` leaves the cost column empty when that flag is false | `PermissionEnforcementTest::test_product_export_carries_cost_only_for_costs_view` |
| SEC-M2 (`data.import` gets around other keys) | **Fixed** | `ImportController::authorizeType`: on upload, validate and run, `products` needs `products.edit` + `inventory.adjust` and `customers` needs `customers.edit`. On run, a product file in which any row sets cost also needs `costs.view`. A missing key gives 403 `forbidden`. Contract §2.1, §3.2 and openapi updated | `PermissionEnforcementTest::test_imports_need_the_keys_of_what_they_write` |
| SEC-L3 (no `revision` on delete; N2/N6 read unlocked) | **Fixed** | `DELETE /roles/{role}?revision=` is **required**: missing → 422, stale → 409 `revision_conflict`. `RoleService::delete` and `update` lock the tenant row, then the role and the target, and re-check N2/N5 on the locked rows. Staff role change and removal lock tenant → membership → roles and re-check N8/N6/N5. The api-client `roles.remove` and the WEB delete dialog send `revision`, and the dialog handles `revision_conflict` | `RolesApiTest::test_delete_needs_the_current_revision`, `::test_delete_rechecks_n2_on_the_locked_role`; api-client `roles.remove sends the revision…`; Vitest delete-with-reassign asserts `revision` |
| SEC-L4 (accept skips N9) | **Fixed** | `InvitationAcceptanceController::accept` re-checks `custom_roles` for a custom-role invitation inside the locked transaction → 402 `feature_not_in_plan` (`upgrade_plan: ["growth"]`), and nothing is created. Documented in contract §4 N9 and §6.2 and in openapi | `StaffRolesTest::test_accepting_a_custom_role_invitation_needs_the_feature` |
| SEC-L5 (N6 skipped when the role row is missing) | **Fixed** | `RoleService::assertHoldsRole`: a missing role counts as every permission, so only the owner passes. Used by staff update/remove and invitation resend/revoke | `RolesApiTest::test_n6_fails_closed_when_the_role_row_is_missing` |
| P83-QA-1 (matrix unusable at 375/390) | **Fixed** | `PermissionMatrix.tsx`: below `sm` the label column is 136 px, labels wrap and the description is hidden. Role columns are 80 px and the table min-width follows these widths. Group headers are non-sticky cells with a sticky inner label. Tokens only | `phase8-3.visual` "Staff matrix at 390px/375px" green, now also asserting that group labels stay in view at both scroll ends |
| P83-QA-2 (`RlsLifecycleTest` memory) | **Fixed** | `queue:work --memory=1024` | Full RLS run green (below) |
| P83-QA-3 (Settings nav) | **Fixed (doc)** | §7.1 kept as written. The contract §10 `phase8-3.roles` line now says Settings stays visible and that settings pages enforce `settings.manage` on each action. No spec expected otherwise | contract §10 |
| W-1 (only `beforeunload`) | **Fixed** | The app uses `BrowserRouter` (no data router, so no `useBlocker`). New `src/lib/useLeaveGuard.tsx` intercepts in-app links in the capture phase and asks with the `@storeplix/ui` `Dialog` ("Leave without saving?"). Programmatic leaves go through `guard()` ("+ Custom role", "Duplicate role"). It also keeps `beforeunload`. Used by the role editor (only once something has been edited) and the matrix | Vitest `W-1: an in-app link asks…`, `W-1: without staged changes…`, `W-1: the role editor asks…` |
| W-2 (wrong upgrade title) | **Fixed** | `PlanLimitDialog` gains a `feature` variant. "+ Custom role" shows "Custom roles are on Growth", other `feature_not_in_plan` errors show "Available on the {Plan} plan", and count limits keep "You’ve reached your plan’s limit" | Vitest assertions in the custom-roles upgrade and 402-on-save tests |
| ARCH docs | **Done** | API-CONVENTIONS §3 lists `permission_not_held`, `cannot_edit_own_role`, `system_role_locked`, `role_in_use` and `role_limit_reached`. SECURITY.md adds **T33**. `role` is added to the audit `filter[subject_type]` (API and openapi). openapi **1.11.1** with a changelog entry; redocly reports it valid (29 warnings, unchanged) | `RolesApiTest::test_audit_log_filters_by_role_subject` |

e2e specs updated for the required `revision` (`phase8-3.{plan,delegation,editor}`).

### Re-run after the fixes

| Check | Result |
|---|---|
| Pint `--test` | passed |
| sqlite full (`--exclude-group perf --exclude-group race`) | 1030 tests: 990 passed, 40 skipped, 0 failed |
| Postgres 18 scratch cluster (UTC, `01-roles.sql`, api-rls env): `rls` / `tenancy` / `security` / `roles` | 37/37 · 114/114 · 359/359 · 67/68 (1 skipped, sqlite-only) |
| Postgres RLS **full** | 1030 tests: 1024 passed, 6 skipped, **0 failed** (`RlsLifecycleTest` green) |
| merchant-dashboard / ui / api-client | typecheck 0 errors · lint 0 errors · Vitest 408 / 57 / 140 green · builds OK |
| Playwright `phase8-3.*` (25) | all green: full run 19 passed, then the visual file alone 6/6 (the 1 failure and 5 not-run in the full run came from a sqlite "database is locked" in `phase8-3.visual` setup; another run's lock in `phase8-3.plan` was green alone at 4/4) |

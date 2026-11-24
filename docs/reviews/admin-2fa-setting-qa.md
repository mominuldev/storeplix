# QA gate: amendment A1 (switchable staff two-step sign-in)

Date: 2026-11-25 · Branch `feat/admin-2fa-setting` @ daad33a, plus the uncommitted API, WEB and QA work in the tree ·
Contract `docs/development/PHASE-8-1-AMENDMENT-ADMIN-2FA.md` (A1-1 to A1-7, §2 QA), Q231. Reviewer: QA.

**Verdict: PASS.** There are no open defects.

## 1. What ran

The user's dev servers (:8010, :5183, :5184, :3010) and the dev DB were not touched. This gate used its own stack:

- API on **:8110**. `artisan serve` ran with `ADMIN_TWO_FACTOR_REQUIRED=true`, `APP_URL=http://localhost:8110`,
  `ADMIN_APP_URL=http://localhost:5284`, `SANCTUM_STATEFUL_DOMAINS=localhost:5284` and `PAYMENTS/COURIERS/DOMAINS_FAKE=true`.
  `APP_ENV` was `local`, the same as the E2E API.
- Super-admin SPA on **:5284**. It was started with `vite --port 5284` and `VITE_API_PROXY_TARGET=http://localhost:8110`.
- Both used a **scratch copy** of the dev DB, made with `sqlite3 .backup` and then `migrate`, which added
  `2026_12_09_000100_create_platform_settings_table`. The same `DB_DATABASE` and `ADMIN_TWO_FACTOR_REQUIRED=true`
  were exported to Playwright, so the `tinker()` and seeder calls wrote to the same database.
- A scratch Postgres 18 cluster ran in **UTC** on :55532, with `01-roles.sql` loaded into each DB. A cluster on
  :55432 that belongs to another agent was found in the shared scratchpad. It was not used, migrated or stopped.
- Every server and cluster listed above was stopped at the end of the gate.

## 2. Results

| Check | Result |
|---|---|
| Pest `admin-settings`, sqlite (`:memory:`, `APP_ENV=testing`) | 11/11 pass (172 assertions) |
| Pest `admin` group, sqlite | 99 pass, 1 skipped (Postgres-only, as before) |
| Admin Auth + Permissions + Team suites, sqlite | 34/34 pass |
| Pest `security` group, sqlite | 539 pass, 14 skipped (Postgres-only / provider skips, as before) |
| api-postgres job, local: `migrate:fresh --seed`, full rollback + migrate | OK (the `platform_settings` migration is reversible) |
| `admin-settings` on Postgres (superuser) | 11/11 pass |
| `admin` on Postgres | 99 pass, 1 skipped |
| api-rls job, local: `migrate:fresh --seed` as `storeplix_owner`, app role, `TENANCY_RLS=true` | OK |
| `admin-settings` with RLS on | 11/11 pass, 0 skipped |
| `admin` with RLS on | 100/100 pass, 0 skipped |
| `rls` group | 47/47 pass, 0 skipped |
| `platform_settings` grants (A1-2) | owner `storeplix_owner`; `storeplix_app` **SELECT only**; `storeplix_admin` SELECT/INSERT/UPDATE/DELETE. No RLS policy, because the table is platform-level, like the other `RlsTables::PLATFORM` tables |
| Playwright `phase8.admin-2fa-setting` (new) + `phase8.admin-auth`, run twice in a row | 9/9 pass on both runs |
| After the runs | No `platform_settings` row was left behind. The spec restores the value it found |
| e2e `tsc --noEmit`; YAML parse of `ci.yml` / `e2e.yml` | OK |

The Pest group covers every §2 item:

- the default for each environment: local is off, testing is on, and the env override works
- a stored value wins over the default
- with the setting off, sign-in returns `signed_in` and is audited with `method: password`
- with the setting on, the existing flow is unchanged
- `me` returns `environment` and `security`
- the GET/PATCH happy path
- the audit row, and the `risk: high` flag when the setting is turned off outside local
- a wrong password gets 422 `invalid_password` and nothing changes
- validation
- billing, support and read_only get 403 `forbidden`; a guest gets 401; a merchant-surface session gets 403
- the cache is busted when the setting changes

## 3. Playwright `phase8.admin-2fa-setting`

The spec is `tests/e2e/specs/phase8.admin-2fa-setting.spec.ts`. It runs serially and re-seeds the super admin around
each sign-in so the `admin-login` throttle does not trip.

1. **API shape:** `environment_default` is `true` on the E2E API. A wrong password gets 422 `invalid_password` and
   the value does not change. A missing `current_password` gets 422.
2. **Off through the API, then a password-only sign-in:**
   - PATCH returns `source: "setting"` and `updated_by` set to the super admin.
   - The audit log has an `admin.settings_updated` row.
   - `POST /admin/auth/login` returns `step: "signed_in"` with no `login_token`, and `/admin/auth/me` returns 200 with
     `security.staff_two_factor_required: false`.
   - In the UI, email and password go straight to **Platform overview** with no TOTP step, and the page survives a
     reload.
3. **On through the UI, then the next sign-in asks for the code:**
   - **Platform settings** in the sidebar opens `/settings` with the Security section.
   - The switch "Require two-step sign-in for platform staff" is off. The text "Default for this environment … On"
     and the badge "Set by a super admin" are shown.
   - Clicking the switch opens the "Turn on two-step sign-in?" dialog. A wrong password shows the field error, the
     dialog stays open and nothing is stored.
   - With the right password, the switch turns on, the toast appears and "Last changed by" is shown. The API returns
     `true` with `source: "setting"`.
   - A fresh browser context shows "Two-factor verification", and the TOTP code completes the sign-in. The API
     returns `step: "totp"` and gives no session before the code.
4. **Support role:**
   - The support user does not have the `manage_settings` permission.
   - GET and PATCH `/admin/settings/security` return 403 `forbidden`.
   - There is no **Platform settings** nav item, and opening `/settings` shows "You can’t open platform settings" with
     no switch.

## 4. E2E environment (A1-7)

- `.github/workflows/e2e.yml` appends `ADMIN_TWO_FACTOR_REQUIRED=true` to `apps/api/.env`. Compose loads that file as
  `env_file`, and `x-api-env` does not set the key. The Playwright step env also sets the flag, so `tinker()` and the
  seeder calls see the same value.
- The flag is needed. Under compose and `artisan serve` the API runs with `APP_ENV=local`, which now defaults to off,
  and `phase8.admin-auth` expects the TOTP step.
- `support/admin.ts`:
  - `adminLogin()` now accepts both the `totp` and the `signed_in` path. An optional `expectStep` asserts one of them.
    Every other admin spec keeps working whatever the setting is.
  - New helpers: `getSecuritySetting`, `patchSecuritySetting`, and `clearStoredSecuritySetting`, which is test-only.
    It deletes the stored row and runs `Cache::flush()`.
- `docs/development/TESTING.md` has a new group row, the spec row, a note on the `phase8.admin-auth` row, and a local
  recipe for the spare ports and the scratch DB.

## 5. CI

`.github/workflows/ci.yml` runs the `admin-settings` group in three jobs. Each step fails when the group is empty:

- **api** (sqlite): JUnit count check, same pattern as the other phase groups.
- **api-postgres**: JUnit count check.
- **api-rls**: `run-group.sh admin-settings lenient`.

E2E is still a manual job (`e2e.yml`, `workflow_dispatch`). The new spec does not run automatically on PRs.

## 6. Notes, not defects

- **N1:** A super admin can leave a stored `false` in a developer's local DB. The stored value beats
  `ADMIN_TWO_FACTOR_REQUIRED`, so `phase8.admin-auth` would then fail locally. Fix: remove the row, either with
  `clearStoredSecuritySetting()` or by turning the setting on in the UI. TESTING.md documents this.
- **N2:** The Settings page has one section in a "Settings sections" `nav`, not a tablist. The spec checks the nav item
  "Security" and does not look for a tab. This matches A1-6, which says to compose a Security tab where none is drawn.
- **N3:** The CI steps were added but have not run in Actions yet. The local equivalents above are green.

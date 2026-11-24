# PHASE-8-1 amendment A1: platform staff two-step sign-in setting (binding for ARCH, API, WEB, QA)

Status: **Accepted, 2026-11-25 — PO (product owner) asked for staff two-step sign-in to be switchable by a super admin,
off by default locally only** (OPEN-QUESTIONS **Q231**). Branch `feat/admin-2fa-setting` (from `main` @ 6703ee4).
**Amends** PHASE-8-1 §3.1 (TOTP no longer unconditionally mandatory), §6.1 (login response), S67–S70 (apply only while
the setting is on), SECURITY (staff 2FA threat row). Everything else in PHASE-8-1 still applies.

## 1. Decisions
| # | Decision |
|---|---|
| A1-1 | One platform setting `staff_two_factor_required` (bool). Effective value = stored value, else the **environment default**: `config('admin.two_factor_required_default')` from env `ADMIN_TWO_FACTOR_REQUIRED`; when the env var is unset the default is **false only when `APP_ENV=local`**, true otherwise (production, staging, **testing** — existing tests keep TOTP). |
| A1-2 | Storage: new platform table `platform_settings` (key varchar(64) PK · value jsonb · updated_by FK users null SET NULL · updated_at timestamptz). Not tenant-owned; follows the existing `RlsTables::PLATFORM` handling (app role cannot write it outside the admin surface — mirror how other platform tables are treated). Read through a small cached `PlatformSettings` service (cache key not tenant-prefixed; busted on write). |
| A1-3 | Sign-in when **not required**: `POST /admin/auth/login` with a correct password signs in at once and answers `{data: {step: "signed_in", user: <same payload as the TOTP success>}}`; audit `admin.login` with `method: "password"`. Lock-out, IP allow-list, email-domain and eligibility rules unchanged. When **required**: today's flow unchanged (`step: "totp"` / `"enroll"`). Staff who already enrolled are not asked while it's off. |
| A1-4 | Control: `GET /admin/settings/security` → `{staff_two_factor_required, environment_default, source: "setting"|"default", updated_at, updated_by: {id, name}|null}`; `PATCH /admin/settings/security` `{staff_two_factor_required: bool, current_password}` → same shape. New platform permission `manage_settings`, granted to **super_admin only**. Wrong password → 422 `invalid_password`. Audit `admin.settings_updated` `{key, from, to}`. `throttle:admin-write`. |
| A1-5 | Safety: turning it **off** outside `local` shows a warning in the UI and the audit row is flagged `meta.risk: "high"`. The `me` payload gains `security: {staff_two_factor_required}` so the SPA can show a persistent banner "Two-step sign-in is off for platform staff" to super admins when off and `APP_ENV` is not local (`environment` field in `me`). |
| A1-6 | Super-admin SPA: login handles `step: "signed_in"`; new **Platform settings** sidebar item (super_admin only) → `/settings` with a **Security** tab: switch "Require two-step sign-in for platform staff", helper text with the environment default, confirm dialog asking for the current password, last changed by/at. Follow the Platform settings Figma (find the settings section in the admin file `5:189`, e.g. near `45:8156` Domains & SSL); compose a Security tab if none is drawn. |
| A1-7 | E2E: Playwright runs the API with `APP_ENV=local`, so the e2e env must set `ADMIN_TWO_FACTOR_REQUIRED=true` (keeps `phase8.admin-auth` valid); a new spec covers the off path by toggling the setting through the API. |

## 2. Tests
API (Pest group `admin-settings`, + `security`): default per env (local off / testing on / env override), stored value wins, login `signed_in` path with session + audit, required path unchanged, GET/PATCH authz (support, read_only, merchant token → 403/401), wrong password 422, audit + risk flag, cache bust. Web (Vitest): login signed_in step, settings tab toggle + password confirm, banner, nav gating. QA (Playwright `phase8.admin-2fa-setting`): sign in password-only when off; turn on → next sign-in asks TOTP; support role can't see the page.

# Phase 2 QA Review (SaaS foundation + Addendum A phone OTP)

- Date: 2026-11-21, 21:05–21:45 (+06)
- Branch: `phase-2-saas-foundation`, uncommitted changes vs `b79e8d6`, including untracked files.
- Spec: `docs/development/PHASE-2-CONTRACT.md`, including Addendum A and the PO confirmations.
- Live target: the running dev stack (API :8000 sqlite, a queue worker on `default,media`, storefront :3000, merchant :5173), with `SMS_DRIVER=log`.
- Data restored: the QA users, Eve's tenant and store, media rows and files, invitations, OTP/SMS rows, audit rows created since the start of the run, and reset tokens were deleted. The demo `stores` / `store_settings` rows were restored byte-for-byte from a backup taken before the run, and revalidation was re-triggered. The OTP per-IP limiter for 127.0.0.1 was cleared. The storefront shows the original contact data again.

**Verdict:** the implementation is solid and matches the contract closely. Every role, cross-tenant, media, reset, OTP and revalidation check passed.

- **Critical:** none.
- **High:** none.
- **Medium:** 3. Login timing enumeration amplified by argon2id; OTP endpoints missing from openapi; the shared per-IP auth throttle is tight for Bangladeshi carrier-grade NAT (CGNAT, many users behind one IP).
- **Low:** 7.

## 1. Command results

| Command | Result |
|---|---|
| `php artisan test` | **PASS**: 125 tests, 125 passed, 1018 assertions (9.1 s) |
| `php artisan test --group=tenancy` | **PASS**: 47 tests, 341 assertions |
| `php artisan test --group=security` | **PASS**: 24 tests, 162 assertions |
| `vendor/bin/pint --test` | **PASS** |
| `pnpm install --frozen-lockfile` | **PASS** (already up to date) |
| `pnpm -r typecheck` | **PASS**: 7/7 |
| `pnpm -r lint` | **PASS**: 0 errors, 5 warnings (ui 3, merchant-dashboard 2; `react-refresh/only-export-components`) |
| `pnpm -r test` | **PASS**: 262 tests. storefront 172, merchant-dashboard 45, api-client 30, ui 9, super-admin 5, config 1 |
| `pnpm -r build` (isolated copy; sentinel `STOREFRONT_API_KEY`, `REVALIDATE_SECRET`, `REVESMS_API_KEY`, `REVESMS_SECRET_KEY`) | **PASS**: all apps and packages |
| Secret scan of `.next/static` and `apps/*/dist` (sentinel values and the names `STOREFRONT_API_KEY` / `REVALIDATE_SECRET` / `REVESMS`) | **PASS**: none found. `sp_preview` is not found either. |
| `dev_otp` hint in the production merchant bundle | **Runtime-gated, not tree-shaken.** The production `index-*.js` contains `Dev mode — your code is`, `Autofill` and `dev_otp`. `DevOtpHint` takes `isDev = import.meta.env.DEV` as a *default prop*. Vite folds that to `false`, so the component returns `null` in prod, but the JSX stays in the bundle. Safe in practice, because the API never returns `dev_otp` outside local + log (see L-1). |

## 2. Live security checks

### Role matrix (owner = demo user; manager and staff created through the real invite → accept flow)

| Check | Result |
|---|---|
| Staff: PATCH settings / POST invitation / GET staff / GET audit-logs / GET subscription / PATCH another member | 403 `forbidden` ✓ (all six) |
| Staff: GET features, GET settings | 200 ✓ |
| Manager demotes owner | 409 `last_owner` ✓ |
| Manager removes owner | 409 `last_owner` ✓ |
| Manager changes own role | 403 `cannot_change_own_role` ✓ |
| Manager assigns `role=owner` | 422 ✓ |
| Owner leaves (deletes self) | 409 `last_owner` ✓ |
| Owner demotes self | 403 ✓ |
| Manager: GET subscription, PATCH settings | 200 ✓ |
| Invitation token reuse after accept | 404 `invitation_invalid` ✓ |
| Seats | `seats_used 2 / seats_limit 5` (owner excluded) ✓ |

### Cross-tenant (Eve's tenant vs Demo)

| Check | Result |
|---|---|
| GET / DELETE Demo media | 404 ✓ |
| Set Demo media as Eve's logo | 422 ✓ |
| GET Demo settings with Eve's tenant header | 404 ✓ |
| PATCH Demo settings with a faked `X-Tenant-Id` | 403 `tenant_forbidden` ✓ |
| PATCH / DELETE a Demo member | 404 ✓ |
| Eve's audit log | Only her own 3 rows ✓ |
| Unknown audit filter | 422 ✓ |
| Audit meta | No passwords and no contact values (only key names) ✓ |

### Media

| Check | Result |
|---|---|
| PHP file renamed `.png` | 422 "Unsupported file type" ✓ |
| SVG with `<script>`/`onload`, as `.png` and as `.svg` | 422 ✓ |
| GIF renamed `.png` | 422 ✓ |
| 5.9 MB logo (limit 2 MB) | 422 ✓ |
| 30 px logo | 422 ✓ |
| Non-square favicon | 422 ✓ |
| 7000×7000 (49 MP) decompression bomb, 6 KB file | 422 ✓ |
| Filename `../../../../etc/passwd/..%2f..%2fevil.png` | 201; stored at `tenants/{tenant}/media/{ulid}/original.png` (the client filename is ignored) ✓ |
| PNG + appended `<?php …` polyglot | 201, then re-encoded by the queue worker. The original no longer contains `<?php` ✓ |
| Variants produced by the queue (`status` processing → ready within about 1–2 s) | logo 400 px → `w160`, `w320` (w640 skipped, no upscaling); favicon 300 px → `favicon_32`, `apple_180`, `icon_192` (no `icon_512`) ✓ |

### Password reset (email)

| Check | Result |
|---|---|
| Known vs. unknown email | Both 202 with identical bodies ✓ |
| Wrong email, garbage token, unknown email | All 422 `invalid_reset_token` ✓ |
| Valid token | 200; the old Bearer token then gets 401 (all tokens revoked) ✓ |
| Reuse of the token | 422 ✓ (single-use) |
| Second request within 60 s | 202, but only 1 email sent (silently throttled) ✓ |
| Token aged 61 min | 422 ✓ |
| Password `password` | 422 (letters + numbers rule) ✓ |

### OTP

| Check | Result |
|---|---|
| Send, `login` purpose, registered phone | 202 `{expires_in:300, resend_in:60, dev_otp}` |
| Send, unknown phone | 202 `{expires_in:300, resend_in:60}`. Same status and fields except `dev_otp` (local only; L-1) |
| `otp_codes` row | 64-hex HMAC; plaintext not in the row ✓ |
| Resend within 60 s | 429 `otp_rate_limited`, `error.retry_after: 60`, `Retry-After: 60` ✓ |
| 5 wrong codes, then the correct one | 422 `invalid_otp` (locked) ✓ |
| Unknown phone on `login/otp` | 422 `invalid_otp` (same as a wrong code) ✓ |
| Correct code with `+88…` input | 200 `{token, expires_at, user}` ✓ |
| Reuse of a consumed code | 422 ✓ |
| Per-IP limit | 429 after 20 sends in the hour, `retry_after: 3217` + header ✓ |
| Logs after sends | No `apikey`/`secretkey` and no REVE values in `storage/logs` ✓. With `SMS_DRIVER=log` the OTP text is logged by design. `RevesmsGateway` sends credentials only in the POST JSON body and redacts them in every log line. |
| Production path | `OtpController::devOtpEnabled()` = `app()->environment('local') && config('sms.driver') === 'log'`. OtpTest covers the production env and the revesms driver ✓ |

### Revalidation and storefront config

| Check | Result |
|---|---|
| PATCH contact + logo | Visible on the storefront after 10.0 s on the first (cold) run, then **4.1 s** and **2.8 s**. The queue worker polls the `database` queue. ✓ |
| Favicon | `<link rel=icon sizes=32x32>` → `favicon_32.png`, `apple-touch-icon` → `apple_180.png`, manifest → `icon_192` ✓ |
| Contact links | `tel:+880…` and `https://wa.me/880…` ✓ |
| `/storefront/config` keys | `contact, preview, seo, social, store, theme`; store adds `icons, logo_url, favicon_url` |
| Business address | The test address (`SECRET-STREET-42`) does not appear in the config or the HTML ✓. The tenant ULID appears only inside media URLs (see §3). |

## 3. Laravel agent's reported deviations

| Deviation | Verdict |
|---|---|
| **BD-only `8801…` phone storage for users** | **Acceptable.** Addendum A explicitly says "store/send as `8801XXXXXXXXX`", which supersedes §1.2's "E.164". Store contact phones use `+8801…` (per §1.4), so the two formats differ. Low: document it, and make sure UI formatting handles both (L-5). Duplicate detection across formats works: `+88017…` registered against `017…` → 422. |
| **No upscaled favicon variants** | **Acceptable.** It matches the contract table header "Variants (never upscaled)". Note that a 64–179 px favicon therefore gets no `apple_180`/`icon_192`. The storefront already treats `icons.*` as nullable, and the UI copy should recommend ≥ 512 px. |
| **Tenant ID in media URLs** | **Acceptable, low risk.** The path format `tenants/{tenant_id}/media/{media_id}` is mandated by contract §1.5. A tenant ULID is not a credential: every API call needs a membership-validated `X-Tenant-Id`, and the store ID is already public. The minor information exposed: tenant creation time (ULID timestamp) and linking stores that share a tenant (impossible under D1). Optional later: an opaque path prefix on the CDN (Phase 9). |
| **429 code renamed `rate_limited`** | **Acceptable / required.** The contract header and PO confirmation 4 specify `rate_limited` (and `otp_rate_limited`) with `retry_after`. API-CONVENTIONS and openapi already say `rate_limited`, and api-client reads `retry_after`. |
| **"Login/reset/invitation endpoints accept one of six email-or-name aliases"** | **Not present in the code.** I searched `apps/api` for alias handling and alternate input keys (`login`, `username`, `identifier`, …) and read Login/ForgotPassword/ResetPassword/AcceptInvitation requests and the `auth` limiter. `POST /auth/login` validates only `{email, password}`. `forgot-password` only `{email}`. `reset-password` uses the broker with `{email, token, password, password_confirmation}`; the broker drops `token` and any `password*` keys before the lookup. Accept-invitation takes `{name, password, password_confirmation, phone?}`. The only shared mechanism is the `throttle:auth` limiter keyed by `ip` + `input('email')`, which covers all six routes in that group: register, login, forgot, reset, invitation show, invitation accept. That is probably what the agent meant. It does **not** widen the attack surface. For the invitation routes `email` is empty, so the per-email key collapses to per-IP (see M-3). Ask the agent to restate it if something else was meant. |
| **argon2id** | **Acceptable** (contract §1.1). Cost: m=64 MB, t=4 → about 150 ms per login locally. Two side effects: M-1 (timing) and L-4 (memory/DoS, and legacy bcrypt hashes fail verification because `HASH_VERIFY=true`; fine before launch). |
| **`GET /subscription` for owner + admin** | **Acceptable / required.** The contract §1.6 table says "`B` + `T`, O A" and the ADR matrix's "billing view" row is O A. Verified live: staff 403, manager 200. Staff still sees the trial banner via `/features` (O A S), which is fine. |

## 4. Contract conformance

- **Laravel resources vs `packages/types`:** I compared the keys of a live response for each of these against the contract §3 type: `User`, `StaffMember`, `StoreSettings` (identity, branding, `MediaRef`, address), `Media`, `MediaVariant`, `Plan`, `Subscription`, `FeatureAccess`, `AuditLog`, `Store`. **Zero extra or missing keys.** The seeded plans match §1.6:
  - free: 0, 5 seats
  - starter: 49900, 5 seats, 5 features
  - growth: 149900, 15 seats, 10 features

  The trial is `trialing/starter`, ending in 14 days.
- **`packages/types`:** every §3 and Addendum A type is present (`OtpPurpose`, `SendOtpResponse`, `phone_verified_at`, `StorefrontConfig.contact/social/icons`, …).
- **api-client:** methods exist for every endpoint, including `sendOtp`. `ApiError.retryAfter` reads `error.retry_after`.
- **openapi.yaml (v1.2.0-phase2):** has every §1 endpoint except the **four Addendum A OTP endpoints** (M-2).

## 5. Findings

### Critical / High
None.

### Medium

**M-1 Login timing reveals which emails have accounts (argon2id made it worse)**
- Where: `apps/api/app/Domain/Identity/Http/Controllers/AuthController.php` `login()`: `if ($user === null || ! Hash::check(...))`.
- Evidence: a wrong password for an existing account takes **150–180 ms**; an unknown email takes **8 ms**. The contract says "no enumeration on login/reset".
- Fix: when the user is null, still run `Hash::check($password, $dummyArgonHash)`. Add a test that asserts the hasher is called on both paths.
- The OTP send path has a much smaller gap (a DB insert vs none), so it is acceptable.

**M-2 `openapi.yaml` is missing the Addendum A endpoints**
- Missing: `POST /auth/otp/send`, `/auth/phone/verify`, `/auth/login/otp`, `/auth/reset-password/otp`, plus the 429 `otp_rate_limited` body with `retry_after`.
- Check that the `ApiError` schema documents `retry_after`.
- Owner: ARCH.

**M-3 One shared per-IP limiter on all auth routes is tight for Bangladeshi carrier-grade NAT**
- `throttle:auth` = 10/min per IP across register, login, forgot, reset and both invitation routes; the per-email key adds 5/min.
- My test sequence (2 invites + accepts + a few resets) hit 429 within a minute from one IP.
- Bangladeshi mobile carriers put many users behind one public IP (carrier-grade NAT), so a busy office or mobile carrier IP would lock out legitimate merchants.
- Fix:
  - per-IP 30–60/min plus per-email/per-token limits
  - give invitation routes their own limiter keyed by token hash

### Low

**L-1 The dev OTP hint is only gated at runtime, and `dev_otp` presence reveals registration locally**
- Where: `apps/merchant-dashboard/src/otp/DevOtpHint.tsx:8`. The hint component ships in the production bundle (gated at runtime).
- Fix: wrap the call sites with `import.meta.env.DEV && <DevOtpHint …/>`, or `if (!import.meta.env.DEV) return null` at the top. Either lets Rollup drop it.
- Also: in local mode, `dev_otp` is present only for registered phones, so it reveals registration. This is acceptable because it is local only, and a test guarantees it is absent in production.

**L-2 Unprocessed originals are public during processing**
- Where: `MediaController::store` writes the raw upload to the public disk and returns its URL while `status=processing`. `ProcessMedia` re-encodes it afterwards.
- During that window, EXIF/GPS data and any polyglot bytes are publicly fetchable.
- Fix: write the original to a private path (or the `local` disk), and publish only re-encoded output.

**L-3 Reset and invitation tokens are written to `laravel.log` in the dev env**
- The running dev `.env` uses `MAIL_MAILER=log`, while `.env.example` and the contract say Mailpit (smtp :1025). Mailpit is running on :8025.
- Fix: switch the dev `.env` to smtp. Make sure no non-local env ever uses the `log` mailer.

**L-4 argon2id operational notes**
- 64 MB per hash × concurrent logins is a memory-pressure vector; it is bounded by the limiter.
- With `HASH_VERIFY=true`, any bcrypt hash makes `Hash::check` throw (a 500) instead of failing.
- Fix: before any data migration, allow bcrypt verification plus `rehash_on_login`.

**L-5 Two phone formats**
- Users are stored as `8801…`; store contacts as `+8801…`. The UI must format both consistently. The Account page shows `01700-000000`, which is fine.

**L-6 `REVALIDATE_SECRET` placeholders differ between the example files**
- `apps/api/.env.example` has `dev-revalidate-secret`; `apps/storefront/.env.example` has `change-me-too`. Copying both examples as-is gives a silent 401 → the job `fail()`s with no retry.
- Fix: use the same placeholder in both.

**L-7 Lint warnings:** 5 (`react-refresh/only-export-components`).

## 6. QA-owned changes made in this review
- `docker-compose.yml`:
  - api/queue env: `MERCHANT_APP_URL`, `MEDIA_DISK`, `MEDIA_URL`, `STOREFRONT_REVALIDATE_URL` (internal `http://storefront:3000/api/revalidate`), `REVALIDATE_SECRET`, `SMS_DRIVER`, `REVESMS_*`
  - queue worker now runs `--queue=default,media`
  - nginx mounts `storage/app/public` at `/storage`
  - storefront gets `REVALIDATE_SECRET` and `STOREFRONT_MEDIA_ORIGINS`
- `infrastructure/docker/.env.example`: added `REVALIDATE_SECRET`, `SMS_DRIVER`, `REVESMS_*`.
- `infrastructure/nginx/nginx.conf`: `client_max_body_size 6m` (the contract's 413 above 6 MB).
- `infrastructure/nginx/conf.d/api.conf`: `/storage/` is static-only (`try_files $uri =404`, never passed to PHP), with `nosniff` and a sandbox CSP.
- `.github/workflows/ci.yml`:
  - new `security` step (`--group=security`)
  - the bundle scan now also checks the `REVALIDATE_SECRET` and `REVESMS_*` sentinels and names
- Still to do (contract §6): e2e specs for reset via the Mailpit API, invite → accept, and settings → storefront logo.

## 7. Visual check (Playwright 1440×900 vs Figma)

| Screen | Figma | Result |
|---|---|---|
| Staff | `60:15363` | Close match: team table, seats card, roles summary, read-only matrix (Owner/Manager/Staff), recent activity from `staff.*`. "Online now", "Actions today", sign-in security and per-person toggles are omitted, as the contract requires. Order staff/Packer appear as a "later update" note ✓ |
| Staff screen, staff role | — | "Only the owner and managers can manage staff" empty state ✓ |
| Settings → Store details | `60:13854` | All cards are present: identity (logo + favicon upload, EN/BN name, read-only slug, colours, category chips), contact, social, address with returns toggle, language & region (language and number format disabled, "coming soon"). Trade licence hidden ✓. The logo/favicon upload sits inline instead of linking to "Online store → Preferences", which is a reasonable Phase 2 choice. |
| Account | `148:33262` | Profile card, Sign-in & security (Password → Change; SMS two-step, authenticator and backup codes disabled "soon"), Your shops, Transfer ownership disabled. Sessions and My alerts hidden ✓ |
| Verify phone | `46:8705` | Match: 6-box OTP, resend countdown, SMS info note, and the yellow "Dev mode — your code is …" hint with Autofill. "Call me instead" omitted, which is fine. |
| SMS sign-in | `57:1050` | The SMS tab is enabled, with phone + code, a countdown, the dev hint, and "Verify and sign in" ✓ |

The screenshots are in the QA scratchpad and were not committed.

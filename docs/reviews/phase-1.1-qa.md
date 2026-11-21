# Phase 1.1 QA Review (D1–D4)

- Date: 2026-11-21, 20:40–20:50 (+06)
- Branch: `phase-1.1-decisions`. I reviewed the uncommitted working tree against `git diff phase-1-foundation` plus the untracked files.
- Spec: "Phase 1.1 contract additions" in `docs/development/AGENT-CONTRACTS.md`.
- Reviewer: QA agent

**Verdict:** D1–D4 are implemented and behave as specified, with **no critical or high findings**. The open items are:
- medium: contract/doc drift
- medium: a stale-cache window on status changes
- a handful of lows

## 1. Command results

| Command | Result |
|---|---|
| `php artisan test` (apps/api) | **PASS**: 62 tests, 62 passed, 387 assertions |
| `php artisan test --group=tenancy` | **PASS**: 34 tests, 214 assertions. The Phase-1 finding H-1 is fixed. |
| `vendor/bin/pint --test` | **PASS** |
| `pnpm install --frozen-lockfile` | **PASS** (already up to date) |
| `pnpm -r typecheck` | **PASS**: 7/7. The Phase-1 finding M-1 is fixed. |
| `pnpm -r lint` | **PASS**: 0 errors, 4 warnings (`react-refresh/only-export-components`, same as Phase 1) |
| `pnpm -r test` | **PASS**: 199 tests. storefront 152, merchant-dashboard 18, api-client 17, ui 6, super-admin 5, config 1 |
| `pnpm -r build` (isolated copy; sentinel `STOREFRONT_API_KEY` + `REVALIDATE_SECRET`) | **PASS**: storefront, merchant-dashboard, super-admin, plus the packages |
| Secret scan of `.next/static` and `apps/*/dist` | **PASS**. Neither sentinel value nor the names `STOREFRONT_API_KEY` / `REVALIDATE_SECRET` appear. The values are not anywhere in `.next/` either. |
| Scan for `sp_preview` in client bundles | **PASS**: absent. The cookie is httpOnly and read only in `lib/preview.ts` (`server-only`). |
| Header names `X-Storefront-Key` / `X-Storefront-Preview` in client bundles | Present in the merchant and super-admin bundles, coming from api-client `storefront.getConfig`. No values. Carried over as L-1. |

## 2. Live checks (running dev servers: API :8000 sqlite, storefront :3000, merchant :5173)

| Check | Result |
|---|---|
| **D1** Second store for the demo tenant | 409 `store_limit_reached` ✓ (also 409 with an empty body, because the check runs before validation) |
| **D3** Login response | `{token, expires_at, user}`; `expires_at` = now + 7 days ✓ |
| **D3** Expired Sanctum token (created via tinker, expired 1 min ago) on `/auth/me` | 401 `unauthenticated` ✓ |
| **D3** Dashboard with an invalid token in sessionStorage | Redirected to `/login` with "Your session expired, please sign in again" ✓ |
| **D2** Mint for own store | 201 `{token, url, expires_at}`, `Cache-Control: no-store` ✓ |
| **D2** Cross-tenant mint, Eve's tenant → Demo store ID | 404 ✓ |
| **D2** Cross-tenant mint, Eve spoofs Demo's `X-Tenant-Id` | 403 `tenant_forbidden` ✓ |
| **D2** Valid token, own store | `preview: true`, response `Cache-Control: no-store, private`, `Vary: X-Storefront-Preview` ✓ |
| **D2** Cross-store (Demo's token on Eve's store) | `preview: false` ✓ |
| **D2** Tampered signature | `preview: false` ✓ |
| **D2** Tampered payload (expiry extended, old signature) | `preview: false` ✓ |
| **D2** Expired token (issued 61 min ago) | `preview: false`, no error leak ✓ |
| **D2** `?preview=<valid>` on `/collections/all?a=1` | 307 → `/collections/all?a=1`, `Set-Cookie: sp_preview=…; HttpOnly; SameSite=lax; Max-Age=3600` (no Secure in local dev, as specified), `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer` ✓ |
| `?preview=` (empty) | Deletes the cookie ✓ |
| **Demo set to draft** (tinker): `/products/x`, `/collections/all` | 200, title "Demo Store · Coming soon", `<meta robots="noindex, nofollow, nocache">`, HTML `Cache-Control: no-store` ✓ |
| Draft robots.txt / sitemap.xml | `User-agent: * / Disallow: /` and an empty `<urlset>` ✓ |
| Draft with the preview cookie | "Preview · Demo Store" + "not public yet" banner, noindex ✓. robots.txt is still `Disallow: /` ✓ |
| Public request right after a preview visit, and 3 interleaved preview→public pairs | Coming soon every time; no preview content leaked ✓ |
| Poisoning: client `X-Storefront-Preview` header | Ignored → Coming soon ✓ |
| Poisoning: another store's token in the cookie | Coming soon ✓ |
| Poisoning: expired cookie, garbage cookie (`<script>`) | Coming soon ✓ |
| **Stale window:** first public request right after the draft switch, and again 65 s later | Both still served the **live** store. Coming soon appeared only from the following request. The same happened after restoring active: Coming soon kept showing for ≥ 65 s + 1 request. See M-1. |
| Demo store restored to `active` | Verified (`status=active`, live title, robots `Allow: /`) ✓ |
| **Forgot-password** for an existing vs. a non-existent email | Both 202 with an identical body ✓. Bad email format → 422. |

Test data left in the dev DB: QA users `eve*@x.test`, `qa-multi*@x.test`, `qa-new*@x.test`, draft stores `eve-*`, and a staff membership of `qa-multi*` in tenant Demo. These are safe to delete or reseed.

## 3. Findings

### Critical / High
None.

### Medium

**M-1 The storefront config cache is not invalidated on status change, so stale content is served after publish, unpublish or suspend**
- Where:
  - `apps/storefront/lib/config-request.ts:34`: public config is cached under tag `store:{host}` with `revalidate=STOREFRONT_CONFIG_REVALIDATE` (60 s)
  - `apps/api/app/Domain/Stores/Observers/StoreObserver.php:14`: this only flushes the API's own host cache
- Nothing calls `POST /api/revalidate`, and Next serves stale-while-revalidate: the first request after expiry still gets the **old** payload and triggers a background refresh. Observed live in both directions.
- Risk:
  - *Draft → active (publish):* the merchant sees "Coming soon" for ≥ 60 s. This is a UX issue and fails closed.
  - *Active → draft (unpublish):* the live catalogue stays visible ≥ 60 s.
  - *Active → suspended:* the store keeps rendering (not 404) until revalidation. For an idle store, the **first visitor after any amount of time** still gets the stale live page once. This matters for takedowns.
  - Caching the *public* draft response in the shared tag cache is not itself a leak. Its body is identical for every public visitor; preview responses use `cache: 'no-store'`. It does deviate from the D2 wording "(do not cache in shared tag cache keyed only by host)".
- Fix (Laravel):
  - On `Store` status, settings or theme changes (and on `StoreDomain` changes), dispatch a queued `RevalidateStorefront` job that POSTs `{hosts:[…all domains…]}` to `STOREFRONT_REVALIDATE_URL` with `REVALIDATE_SECRET`.
  - Add `REVALIDATE_SECRET` to `docker-compose.yml` and both `.env.example` files.
  - Optionally have the storefront set `revalidate: 0` when `store.status === 'draft'`, or lower the TTL, until that lands.
  - Add a test.

**M-2 `docs/api/openapi.yaml` drifts from the implementation**
- `/auth/forgot-password` 202 is documented as `{data:{status:"sent"}}` (openapi.yaml:113-119). The API returns `{data:{message:"…"}}` (`AuthController.php` `forgotPassword`).
- `/stores/{store}/preview-token` documents a 404 `tenant_not_found` for a non-member tenant (openapi.yaml:178). The API returns **403 `tenant_forbidden`**, and the 403 response is not listed.
- **`/stores` (GET/POST) and `/stores/{store}` are not in openapi.yaml at all**, so the D1 409 `store_limit_reached` is undocumented.
- `packages/types` (`AuthToken.expires_at`, `StorefrontConfig.store.status`, `preview`, `PreviewToken`, `User.tenants`, `primary_domain: string|null`) and api-client are consistent with the Laravel resources. ✓
- Fix: the Architecture agent updates openapi.yaml.

### Low

**L-1 Server-only storefront client is still bundled into the dashboards** (carried over)
- Where: `packages/api-client/src/client.ts` (`storefront.getConfig`, now with `X-Storefront-Preview`). Only the header names leak.
- Fix: move it to an `@storeplix/api-client/server` entry with `server-only`.

**L-2 The local preview URL points at the `.test` primary domain**
- Where: `PreviewTokenService::previewUrl` (`apps/api/app/Domain/Stores/Preview/PreviewTokenService.php:52-62`) returns `http://demo.storeplix.test:3000/?preview=…`. That host does not resolve without a hosts/dnsmasq entry. In the docker stack it should also be port 80, not 3000.
- Fix: prefer a `*.localhost` alias in the local env, or make the origin configurable (`STOREFRONT_PUBLIC_ORIGIN_TEMPLATE`).

**L-3 The D1 unique constraint was added by editing an existing migration**
- Where: `2026_01_01_000200_create_store_tables.php:22`. Existing databases (including the dev DB if it was not refreshed) never get `stores_tenant_id_unique`.
- This is acceptable before the first deploy. After that, use additive migrations only.

**L-4 The dashboard hardcodes `.storeplix.com`**
- Where: `apps/merchant-dashboard/src/pages/NameShopPage.tsx:38,117` and `src/stores/useTenantStore.ts:25`. In local or staging (`PLATFORM_DOMAIN=storeplix.test`) the shop link preview is wrong.
- Fix: use `VITE_PLATFORM_DOMAIN`.

**L-5 Forgot-password looks the account up only to log it**
- Where: `AuthController::forgotPassword`. The DB lookup creates a small timing difference. Measured 22 ms vs 8 ms on a cold vs warm request, so not conclusive.
- Fix: when the real mailer lands, do the lookup inside a queued job so the response time is constant.

**L-6 Preview tokens are stateless and cannot be revoked within their 60 min**
- Any tenant member (including staff) can mint one. This is acceptable per D2.
- Track revocation (for example a per-store `preview_key_version`) if previews ever expose unpublished pricing.

**L-7 Lint warnings** (4, unchanged).

## 4. D4 visual check (Playwright 1440×900 and iPhone 13 vs Figma frames)

I compared screenshots of the built screens against Figma frames 01 `46:8583`, L1 `57:911`, L4 `58:957` and 03 `48:7869`:

- **01 Sign up:** close match on layout, left marketing panel, step indicator "Step 1 of 7", chips and courier strip. The deliberate deviations follow D4 / the Phase-1 API:
  - email + password fields added
  - "Continue with Google" and SMS copy omitted
- **L1 Sign in:** match. The SMS tab is shown disabled with "Coming soon", as D4 asks. Email replaces mobile. "Keep me signed in" was dropped, which is consistent with D3 sessionStorage.
- **L4 Choose a shop:** match: membership cards with role chip, domain and status, and the "Open this shop by default" checkbox. "Create another shop" is correctly omitted under D1. Orders-waiting counts are omitted (no API yet).
- **03 Name your shop:** match: 7-step sidebar with "Verify phone · Coming soon", the live phone preview, and category chips. The Bangla shop name field, the "Where do you sell now?" card and the slug "Available" check are not built (later scope). The `.storeplix.com` suffix is hardcoded (L-4).
- **Routing:**
  - user with 2 memberships → `/choose-shop` ✓
  - new user with no store → `/onboarding/shop` ✓
  - demo user → dashboard ✓
  - wrong password → inline 422 error ✓
  - expired token → `/login` with notice ✓

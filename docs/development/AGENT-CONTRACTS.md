# Phase 1 agent contracts (binding for all agents)

## File ownership — never edit outside your area
| Agent | Owns |
|---|---|
| Architecture | `CLAUDE.md`, `docs/**` (except `docs/design/FIGMA-INDEX.md`, this file) |
| Laravel | `apps/api/**` |
| React | `apps/merchant-dashboard/**`, `apps/super-admin/**`, `packages/ui/**`, `packages/config/**`, `packages/api-client/**` |
| Next.js | `apps/storefront/**` |
| QA | `.github/**`, `docker-compose.yml`, `infrastructure/**`, `tests/e2e/**`, `docs/development/TESTING.md`, review reports in `docs/reviews/**` |
`packages/types` and root `package.json`/`pnpm-workspace.yaml` are orchestrator-owned; propose changes in your final report instead of editing.

## Ports
api `8010` · merchant-dashboard `5183` · super-admin `5184` · storefront `3010` · postgres `5432` · redis `6379`

## Package names
`@storeplix/ui` `@storeplix/types` `@storeplix/api-client` `@storeplix/config` `@storeplix/merchant-dashboard` `@storeplix/super-admin` `@storeplix/storefront`

## API contract (Phase 1)
Envelope: success `{ "data": ..., "meta"?: ... }`; error `{ "error": { "code", "message", "details"? } }` with proper HTTP status. IDs are ULID strings. snake_case JSON.
- `GET  /api/v1/health` → `{data:{status:"ok",version,time}}`
- `POST /api/v1/auth/register` {name,email,password,password_confirmation,phone?} → 201 `{data:{token,user}}`
- `POST /api/v1/auth/login` {email,password} → `{data:{token,user}}`
- `POST /api/v1/auth/logout` (Bearer) → 204
- `GET  /api/v1/auth/me` (Bearer) → `{data:User}`
- `GET  /api/v1/storefront/config` — tenant resolved server-side from header `X-Storefront-Host: <normalized host>` validated against `store_domains`; also requires header `X-Storefront-Key` = shared secret `STOREFRONT_API_KEY` (server-to-server only). Unknown host → 404 `{error:{code:"store_not_found"}}`. Returns `StorefrontConfig`.
Merchant auth: Sanctum personal access tokens (Bearer) for the SPA in Phase 1 (ADR may revisit cookie-based SPA auth).
Tenant context for merchant APIs: header `X-Tenant-Id` (ULID) validated against the user's `tenant_users` membership.

## Dev seed
`php artisan db:seed` creates user `demo@storeplix.test` / `password`, tenant "Demo", store slug `demo`, domains `demo.storeplix.test` and `demo.localhost`.
Base platform domain env: `PLATFORM_DOMAIN=storeplix.test` (prod `storeplix.com`).

---
# Phase 1.1 contract additions (product-owner decisions, 2026-11-21)

## D1 — ONE store per merchant (tenant)  [revised by product owner, supersedes "many stores"]
- Exactly one store per tenant: DB `UNIQUE(stores.tenant_id)`. Store slug stays globally unique.
- `POST /api/v1/stores` when the tenant already has a store → 409 `{error:{code:"store_limit_reached"}}`.
- Keep `/api/v1/stores/{store}/...` paths and `store_id` columns (cheap, keeps a future multi-store option open), but no multi-store UI or plan limits.
- A *user* may still belong to several tenants (e.g. staff of two shops). Dashboard after login: user has 0 tenants-with-store → "Name your shop"; exactly 1 → open it; >1 memberships → "Choose a shop" (Figma L4 `58:957`), which picks the TENANT (= its single store). No store switcher in the sidebar; the existing tenant switcher stays.

## D2 — Draft stores show "Coming soon"
- `StorefrontConfig.store.status`: `'active' | 'draft'` (suspended stays 404).
- Draft store, public visitor: storefront renders a branded Coming Soon page (store name/logo/theme colours), `noindex`, `Cache-Control: private, no-store` semantics (do not cache in shared tag cache keyed only by host), robots.txt `Disallow: /`, empty sitemap. Status code 200.
- Merchant preview: `POST /api/v1/stores/{store}/preview-token` (Bearer + X-Tenant-Id) → 201 `{data:{token, url, expires_at}}`; token = signed, expires in 60 min, bound to store id; `url` = `https://{primary_domain}/?preview={token}` (http + :3010 in local env).
- Storefront: `?preview=` → proxy sets httpOnly, Secure (prod), SameSite=Lax cookie `sp_preview` (max-age 3600) and redirects to the same URL without the param. Server forwards it as header `X-Storefront-Preview` to `/storefront/config`. API returns `preview: true` in the payload when valid for that store; storefront then renders the real store with a "Preview — not public yet" banner. Invalid/expired token → treated as public visitor (no error leak).
- Preview responses must never be cached in the shared cache.

## D3 — Token expiry
- Sanctum tokens expire: `SANCTUM_EXPIRATION` minutes, default 10080 (7 days). Token responses add `expires_at` (ISO-8601). Scheduled `sanctum:prune-expired --hours=24` daily.
- Expired/invalid token → 401 `{error:{code:"unauthenticated"}}`. Dashboards: on 401 clear session and redirect to /login with "Your session expired, please sign in again"; also log out proactively when `expires_at` passes. Store the token in sessionStorage (not localStorage) until cookie auth (Phase 4).

## D4 — Onboarding UI follows Figma page 43:13544
Desktop: 01 Sign up `46:8583` · 02 Verify phone (OTP) `46:8705` · 03 Name your shop `48:7869` · 04 Pick a theme `48:8119` · 05 Add first products `50:312` · 06 Delivery `50:604` · 07 Get paid `52:564` · 08 You're live `52:765`.
Mobile: M1 `53:758` · M2 `53:831` · M3 `53:885` · M4 `54:810` · M5 `54:941`.
Sign in: L1 Password `57:911` · L2 SMS code `57:1050` · L3 Forgot password `57:1198` · L4 Choose a shop `58:957` · L5 Mobile `58:1132`.
Components: Onboarding/Logo `45:8009` · Step `45:8034` · Chip `45:8043` · Option card `45:8065` · Connect card `45:8086` · Checklist item `45:8102`.
Phase 1.1 builds: 01/M1 sign up, L1/L5 sign in, L3 forgot password (UI + API stub returning 202 always), L4 choose a shop, 03/M3 name your shop (→ POST /stores). Phone OTP / SMS sign-in (02, L2) and steps 04–08 are later phases — do not fake them; omit or show disabled.

## Browser testing — Playwright only
All agents: verify UI in a browser with Playwright (`tests/e2e`, see TESTING.md §2b). Never use the Claude in Chrome
extension or the user's Google Chrome.

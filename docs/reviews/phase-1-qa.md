# Phase 1 QA Review

- Date: 2026-11-21, ~19:46 (+06). The other agents were still committing changes during the review, so results describe the tree at that time.
- Scope: apps/api, apps/storefront, apps/merchant-dashboard, apps/super-admin, packages/*
- Reviewer: QA agent

## 1. Command results

| Command | Where | Result |
|---|---|---|
| `php artisan test` | apps/api | **PASS**: 48 tests, 48 passed, 288 assertions (3.6 s, sqlite in-memory) |
| `php artisan test --group=tenancy` | apps/api | **FAIL**: 0 tests found (no test is tagged `tenancy`; see H-1) |
| `vendor/bin/pint --test` | apps/api | **PASS** |
| `migrate:fresh --seed` → `migrate:rollback` → `migrate` → `db:seed` (re-run) | apps/api (sqlite copy) | **PASS**. The seeder is idempotent. Postgres was not exercised locally because the Docker daemon was not running. CI job `api-postgres` covers it. |
| `pnpm install --frozen-lockfile` | root | **PASS** (lockfile up to date) |
| `pnpm -r typecheck` | root | **FAIL**: 6 passed, 1 failed (`@storeplix/types`: `tsc: command not found`; see M-1) |
| `pnpm -r lint` | root | **PASS**: 0 errors, 4 warnings (`react-refresh/only-export-components` in ui Badge/Button and both AuthProviders) |
| `pnpm -r test` | root | **PASS**: 156 tests. storefront 128/128, api-client 10/10, merchant-dashboard 10/10, ui 4/4, super-admin 3/3, config 1/1 |
| `pnpm -r build` (isolated copy, sentinel key) | root | **PASS**: storefront (Next 16.4.6), merchant-dashboard, super-admin |
| Secret scan: sentinel `STOREFRONT_API_KEY` value **and** name in `apps/storefront/.next/static`, `apps/*/dist` | build output | **PASS**: not found. The value also does not appear anywhere in `.next/` (it is read at runtime). |
| Playwright smoke (`tests/e2e`, 5 specs) against local api + `next start` + `vite preview` | scratch | **PASS**: 5/5 |
| `docker compose config -q` | root | **PASS**. I could not test `docker compose up` because the Docker/OrbStack daemon was not running. |

### Live smoke (api via `artisan serve`, storefront via `next start`)

| Check | Result |
|---|---|
| `GET /health` | 200, `{data:{status:"ok",version,time}}` ✓ |
| `/storefront/config` with no key | 401 `invalid_storefront_key` ✓ |
| `/storefront/config` with valid key and `demo.localhost` | 200, exact `StorefrontConfig` keys only ✓ |
| Unknown host | 404 `store_not_found` ✓ |
| `Host`/`X-Forwarded-Host` set but no `X-Storefront-Host` | 400 (forwarded headers ignored) ✓ |
| Login/register/me/logout | ✓. After logout, the token gets a 401. |
| `X-Tenant-Id` spoofing (Eve → Demo tenant) | 403 `tenant_forbidden` ✓ |
| Missing `X-Tenant-Id` | 400 `tenant_required` ✓ |
| Eve reads Demo's store ID through her own tenant | 404 ✓ |
| Eve creates a store with `tenant_id`=Demo and `status`=active in the body | Store is created in Eve's tenant with status `draft` ✓ |
| Reserved slug or taken slug | 422 ✓ |
| Storefront `Host: DEMO.localhost:3100` | 200 "Demo Store" ✓ |
| Storefront `Host: nosuch.localhost` with `X-Forwarded-Host: demo.localhost` (no TRUSTED_PROXY) | 404 ✓ |
| Client-supplied `x-storeplix-host` | Overwritten by the proxy → 404 ✓ |
| Storefront `Host: 127.0.0.1` | 400 ✓ |
| CORS preflight from `https://evil.com` | No ACAO header ✓ |
| CORS preflight from `localhost:5173` | Allowed, `supports_credentials=false` ✓ |

**Overall:** tenant isolation is well designed:
- a global scope that throws when no tenant context is set
- `tenant_id` filled on create and immutable afterwards
- composite `(tenant_id, store_id)` foreign keys
- constant-time key comparison that fails closed
- host-only resolution against **active** domains
- the job tenant is captured in the payload and restored by middleware
- tenant-prefixed cache helper

No critical vulnerability found.

## 2. Findings

### Critical
None.

### High

**H-1 No test is tagged `tenancy`, so the required CI gate `tenant-isolation` fails**
- Where:
  - `apps/api/tests/Feature/Tenancy/CrossTenantIsolationTest.php:1`
  - `apps/api/tests/Feature/Tenancy/TenantAwareJobTest.php:1`
  - `apps/api/tests/Feature/Storefront/StorefrontConfigTest.php:1`
- Evidence: `php artisan test --group=tenancy` → "No tests found." CI step `tenant-isolation` (`.github/workflows/ci.yml`) fails on an empty group by design.
- Fix (Laravel agent): add `#[\PHPUnit\Framework\Attributes\Group('tenancy')]` to these three classes, and to any future cross-tenant test (see `docs/development/TESTING.md` §3).

**H-2 `apps/api/Dockerfile` builds the dev server by default, not php-fpm**
- Where: `apps/api/Dockerfile:41-48`. The header comment (lines 3-6) says the default target is `app`, but the **last** stage is `dev`, so `docker build .` produces `php artisan serve` on :8000.
- Impact: a production build without `--target app` ships a debug dev server (`APP_DEBUG=true`).
- Fix: move the `dev` stage above `app`, or always pass `--target app` in deploy pipelines.
- Mitigation: `docker-compose.yml` now pins `target: app`.

### Medium

**M-1 `@storeplix/types` typecheck cannot run**
- Where: `packages/types/package.json:9`. The script calls `tsc`, but the package has no `typescript` devDependency.
- Impact: `pnpm -r typecheck` and the CI `web` job fail.
- Fix (orchestrator-owned): add `"devDependencies": {"typescript": "~6.0.3"}` to packages/types, or add `typescript` to the root devDependencies.

**M-2 Draft stores are publicly served on their platform subdomain**
- Where: `apps/api/app/Domain/Stores/Services/StorefrontResolver.php:84` (`status != suspended`) together with `StoreProvisioner.php:52`, which creates platform domains as `active` immediately.
- Evidence: a store created through the API with status `draft` (`eve-shop-*.storeplix.test`) returned 200 config, and the storefront rendered "Eve shop".
- Blueprint: stores go live at "publish".
- Fix: resolve only `Store::STATUS_ACTIVE`, or serve drafts only with an owner preview token. Add a test.

**M-3 Sanctum tokens never expire**
- Where: `apps/api/config/sanctum.php:53` (`'expiration' => null`).
- Impact: the token is stored in `localStorage` (`apps/merchant-dashboard/src/lib/session.ts:4`), so any XSS gives an attacker permanent access.
- Fix: set an expiration (for example 7 days) plus `sanctum:prune-expired`. Add a CSP to the dashboards. Track the cookie-SPA-auth ADR.

**M-4 Contract drift between Laravel resources and `packages/types`**
- `UserResource.php:25` returns `tenants: [{id,name,role}]`, but the `User` type (`packages/types/src/index.ts:10`) does not have it. The dashboards depend on it through `MeResponse` in `packages/api-client/src/models.ts:27`, typed as optional.
  - Fix: add `TenantMembership` and `User.tenants?` (or `MeResponse`) to `packages/types`.
- `StoreResource.php:27` can return `primary_domain: null`, but the type is `string` (`index.ts:18`).
  - Fix: change the type to `string | null`, or guarantee the value server-side.
- `RegisterInput`, `LoginInput` and `CreateStoreInput` live in api-client. Promote them to `packages/types`.

### Low

**L-1 Storefront server-to-server code is bundled into the dashboards**
- Where: `packages/api-client/src/client.ts:153-164` (`storefront.getConfig`).
- Evidence: the string `X-Storefront-Key` is present in `merchant-dashboard/dist/assets/index-*.js` and `super-admin/dist/assets/index-*.js`. No secret is included, only the header name.
- Fix: move it to a separate entry (`@storeplix/api-client/server`) with `import 'server-only'`. The storefront already uses its own `lib/storefront-api.ts`.

**L-2 Invalid storefront-key attempts are not rate-limited**
- Where: `apps/api/routes/api.php:33`. The `storefront` middleware runs before `throttle:storefront`, so a 401 is returned before throttling.
- The risk is low with a 32-byte random key.
- Fix: put `throttle` first (keyed by IP for unauthenticated requests).

**L-3 Login timing allows user enumeration**
- Where: `AuthController.php:59-62`. `Hash::check` is skipped when the user does not exist.
- Fix: run a dummy hash check, or use `Auth::attempt`-style constant work.

**L-4 Tenant-aware job edge cases**
- `TenantAware.php:30`: a job that defines its own `middleware()` silently drops `RestoreTenantContext`.
- `RestoreTenantContext.php:27`: `forTenant()` / `$tenantId` overrides the dispatching context with no check.
- Fix: merge middleware in the trait (`array_merge(parent…)`) or assert in a base job. Log or deny a cross-tenant pin when a tenant context exists at dispatch.

**L-5 `BelongsToTenant` updating hook only blocks `tenant_id` changes**
- Where: `BelongsToTenant.php:52`. A model loaded via `withoutTenancy()` for tenant B can still be saved while the current context is tenant A.
- Fix: in `updating`/`deleting`, throw when a context exists and `tenant_id !== context id`.

**L-6 Storefront `/api/revalidate` is reachable on every tenant host and custom domain**
- Where: `apps/storefront/app/api/revalidate/route.ts:12`. It is protected by a bearer secret with a constant-time compare (via `secretMatches`) but has no rate limit.
- Fix: restrict it to the internal network or platform host at nginx, or add a rate limit.

**L-7 Domain hostname normalization differs between layers**
- `StoreDomain::setHostnameAttribute` (`StoreDomain.php:61`) does not strip ports or validate labels the way `HostNormalizer` does.
- Fix: use `HostNormalizer::normalize()` in the mutator and reject null.

**L-8 Lint warnings**
- 4 × `react-refresh/only-export-components` in packages/ui and both AuthProviders. Cosmetic.

## 3. Infra delivered by QA (this phase)
- `docker-compose.yml`:
  - postgres16, redis7, mailpit, api (fpm, `target: app`), queue, nginx, one-shot js-deps, storefront, merchant-dashboard, super-admin
  - healthchecks on every service
- nginx config:
  - `:8000` serves the API
  - `:80` proxies `*.storeplix.test` / `*.localhost` to the storefront
  - strips client `X-Storefront-*` headers and overwrites `X-Forwarded-Host`
- `infrastructure/docker/.env.example`
- `.github/workflows/ci.yml`:
  - `changes` path filter
  - `api` job: pint, test, required `tenant-isolation` step
  - `api-postgres` job: migrate, rollback, tenancy group on PG16
  - `web` job: typecheck, lint, test, build, bundle secret scan
  - aggregate `ci-ok` job
- `.github/workflows/e2e.yml`: manual only.
- `tests/e2e`: Playwright smoke (5 specs, verified passing).
- `docs/development/TESTING.md`: cross-tenant catalogue T-01…T-24 and S-01…S-04.

Storefront env names used in compose and CI (from `apps/storefront/lib/env.ts`): `STOREFRONT_API_URL`, `STOREFRONT_API_KEY`, `TRUSTED_PROXY`, `STOREFRONT_LOCAL_PORT`, `REVALIDATE_SECRET`.

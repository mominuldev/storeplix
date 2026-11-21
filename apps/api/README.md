# Store Plix API (`apps/api`)

Laravel 13 · PHP 8.4 · Sanctum (personal access tokens) · PostgreSQL · Redis. REST under `/api/v1`.
Contract: `docs/development/AGENT-CONTRACTS.md`; JSON shapes mirror `packages/types/src/index.ts`.

## Run locally

```bash
cd apps/api
composer install
cp .env.example .env && php artisan key:generate   # Postgres + Redis by default
createdb storeplix                                   # or point DB_* at your server
php artisan migrate --seed                           # demo@storeplix.test / password
php artisan serve --port=8000
php artisan queue:work                               # QUEUE_CONNECTION=redis
```

Tests need no external services (SQLite in-memory, array cache, sync queue — see `phpunit.xml`):

```bash
php artisan test        # or: vendor/bin/phpunit
vendor/bin/pint         # code style
```

Docker: `Dockerfile` — default target `app` = php-fpm on :9000 (put Nginx in front);
`--target dev` = `php artisan serve` on :8000.

## Structure — domain modules

Code is grouped by bounded context under `app/Domain/<Module>` (not by technical layer), each owning
its models, HTTP layer (controllers, FormRequests, API Resources, middleware), services, policies:

| Module | Contents |
|---|---|
| `Tenancy` | `TenantContext`, `BelongsToTenant` + `TenantScope`, `tenant` middleware, queue tenancy, `TenantCache`, `AuditLogger`, `Tenant`/`TenantUser`/`AuditLog` |
| `Identity` | `User`, auth controller/requests, `UserResource` |
| `Stores` | `Store`/`StoreDomain`/`StoreSetting`, `StoreProvisioner`, `StorefrontResolver` + `HostNormalizer`, `storefront` middleware, `StorePolicy`, cache-invalidation observers |
| `Shared` | error envelope renderer, `ApiException`, pagination envelope, health |

Each module may register its own service provider (`bootstrap/providers.php`). Future modules
(Products, Orders, Customers, Domains, Billing…) follow the same layout.

## Multi-tenancy rules (enforced in code, not by convention)

- **Shared schema, `tenant_id` on every tenant-owned row.** ULID primary keys everywhere.
- **`TenantContext`** (scoped singleton, reset per request/job) holds the current tenant + role.
- **`BelongsToTenant`** trait on tenant-owned models: global scope filters by current tenant;
  `tenant_id` auto-filled on create; creating a row for another tenant or changing `tenant_id`
  throws `TenantMismatchException`; **querying with no tenant context throws
  `MissingTenantContextException`**. Platform/system code opts out explicitly with
  `Model::withoutTenancy()`.
- **`tenant` middleware** (after `auth:sanctum`): `X-Tenant-Id` must be a tenant the user is a member
  of (`tenant_users`). Missing → 400 `tenant_required`; unknown/foreign/malformed → identical 403
  `tenant_forbidden` (no enumeration). It runs before route-model binding, so `{store}` bindings are
  tenant-scoped (foreign ids → 404).
- **Policies** re-check `tenant_id` against the context (defence in depth) and roles (owner/admin/staff).
- **Storefront** (`storefront` middleware): `X-Storefront-Key` compared with `hash_equals` against
  `STOREFRONT_API_KEY` (fails closed if unset); tenant resolved **only** from `X-Storefront-Host`,
  normalized (lowercase, strip port and trailing dot, DNS-label validation) and matched to an
  **active** `store_domains` row of a non-suspended store. `Host`/`X-Forwarded-Host` are ignored.
  Lookups cached under the tenant-neutral key `domain:{host}` (1h positive / 60s negative);
  observers on `StoreDomain`/`Store` invalidate on change.
- **Queues**: every queued payload gets `tenant_id` of the dispatching context
  (`Queue::createPayloadUsing`). Jobs using the `TenantAware` trait restore it via the
  `RestoreTenantContext` job middleware; a tenant-aware job without a tenant fails. Use
  `->forTenant($id)` to pin explicitly. Note: `Job::dispatch()` returns a `PendingDispatch` that is
  queued on destruct — dispatch as a statement inside `TenantContext::run()`, don't return it.
- **Cache**: `TenantCache` prefixes keys `tenant:{id}:…` and throws without context.
- **Audit**: `AuditLogger` writes `audit_logs` (store.created, auth.registered, auth.login).

## Endpoints (Phase 1)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/health` | – | `{data:{status,version,time}}` |
| POST | `/api/v1/auth/register` | – (throttled) | creates user + tenant (owner) → 201 `{data:{token,user}}` |
| POST | `/api/v1/auth/login` | – (throttled) | bad credentials → 422 `validation_failed` (details.email) |
| POST | `/api/v1/auth/logout` | Bearer | 204, revokes current token |
| GET | `/api/v1/auth/me` | Bearer | `User` + additive `tenants:[{id,name,role}]` |
| GET | `/api/v1/stores` | Bearer + `X-Tenant-Id` | paginated `{data:Store[],meta}` (`per_page` ≤ 100) |
| POST | `/api/v1/stores` | Bearer + `X-Tenant-Id` (owner/admin) | `{name, slug, business_category?, country?=BD, currency?=BDT}` → 201 `Store`; creates `{slug}.{PLATFORM_DOMAIN}` (active, primary) + default theme |
| GET | `/api/v1/stores/{id}` | Bearer + `X-Tenant-Id` | 404 for other tenants' stores |
| GET | `/api/v1/storefront/config` | `X-Storefront-Key` + `X-Storefront-Host` | `StorefrontConfig`; 401 `invalid_storefront_key`, 400 `storefront_host_required`, 404 `store_not_found` |

Errors always: `{ "error": { "code", "message", "details"? } }` (`validation_failed`, `unauthenticated`,
`forbidden`, `not_found`, `too_many_requests`, `tenant_required`, `tenant_forbidden`, …).
Timestamps are ISO-8601 UTC (`2026-01-01T12:00:00Z`). New stores start as `draft`; draft and active
stores both render on the storefront, suspended ones do not.

## Environment

`PLATFORM_DOMAIN` (storeplix.test), `STOREFRONT_API_KEY`, `CORS_ALLOWED_ORIGINS`
(default `http://localhost:5173,http://localhost:5174`), `APP_VERSION`, `DOMAIN_CACHE_TTL`,
`DOMAIN_NEGATIVE_CACHE_TTL`, plus standard `DB_*`, `REDIS_*`, `QUEUE_CONNECTION=redis`, `CACHE_STORE=redis`.

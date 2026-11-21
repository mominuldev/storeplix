# Multi-Tenancy

Status: Accepted (Phase 0). ADR 0001 (shared DB, shared schema). Implementation lives in
`apps/api/app/Support/Tenancy/`. Read this file before touching any tenant-owned model, job, cache or upload.

## 1. Model
- **Tenant** = a merchant business account (billing entity, owns data). **Store** = its storefront.
  **Exactly one store per tenant** (PO decision D1, revised 2026-11-21): DB `UNIQUE(stores.tenant_id)`; store slug
  globally unique; `POST /api/v1/stores` when the tenant already has a store → 409 `store_limit_reached`.
- Multi-store stays a cheap future option: store-scoped tables still carry `store_id` and merchant routes still use
  `/api/v1/stores/{store}/...`. Enabling it later = drop the unique constraint + add UI/plan limits. No multi-store
  UI or plan limits now.
- Two scoping levels: **tenant-scoped** tables (`tenant_id` only — e.g. `tenant_users`, `media`, `subscriptions`,
  `invoices`, `audit_logs`) and **store-scoped** tables (`tenant_id` + `store_id` — catalog, customers, carts,
  orders, payments, shipping, store config). Full list in DATABASE-DESIGN.md §2.
- **User** is global (one login, may belong to several tenants via `tenant_users` with a role).
- Shared PostgreSQL database, shared schema, `tenant_id char(26)` on every tenant-owned row.
- Platform tables (no `tenant_id`): `users`, `tenants`, `plans`, `themes`, `personal_access_tokens`,
  `platform_admins`, `failed_jobs`, `jobs`. Everything else is tenant-owned.

## 2. Tenant resolution service

`App\Support\Tenancy\TenantResolver` is the only code that maps a request to a tenant.

| Channel | Input | Validation | Failure |
|---|---|---|---|
| Merchant API (`/api/v1/stores…`, other tenant routes) | `X-Tenant-Id` header (ULID) + authenticated user | `tenant_users` row exists for (tenant_id, user_id) with `status='active'`; tenant `status` not `suspended`/`closed` | missing → 400 `tenant_required`; not member → **403** `tenant_forbidden` (as implemented; tenant ULIDs are unguessable, so existence isn't meaningfully revealed); suspended → 403 `tenant_suspended` |
| Storefront API `/api/v1/storefront/*` | `X-Storefront-Host` + `X-Storefront-Key` | key compared with `hash_equals` against `STOREFRONT_API_KEY`; host normalized then looked up in `store_domains` where status in (`active`, or platform subdomain) and store `status IN ('active','draft')` (draft → Coming soon, STOREFRONT-ENGINE §4.1; `suspended` → 404) | bad key → 401 `invalid_storefront_key`; unknown host → 404 `store_not_found` |
| Admin API `/api/v1/admin/*` | none by default; explicit `tenant` route param for impersonation/inspection | user has `platform_role` | 403 |
| Queue jobs | `tenant_id` serialized in the job | tenant exists and is not closed | job fails permanently, logged |
| Console / scheduler | explicit `--tenant=` or iterates `Tenant::query()->cursor()` and calls `TenantContext::run($tenant, fn)` | — | — |

Host normalization (`HostNormalizer`, shared logic mirrored in storefront `lib/host.ts`): lowercase,
strip port, strip trailing `.`, IDN → punycode (`idn_to_ascii`), reject if not a valid hostname or
length > 253. Lookup key: `store_domains.hostname` (unique, stored normalized). Resolution cached in Redis
`sp:host:{hostname}` → `{tenant_id, store_id}` TTL 60 s, deleted on any `store_domains` change.

Never use `$request->getHost()` for tenant resolution in the API — the API host is always `api.*`.

## 3. TenantContext

```php
final class TenantContext            // bound as singleton (scoped per request/job via Octane-safe scoped())
{
    public function set(Tenant $tenant, ?Store $store = null): void;   // throws if already set to a different tenant
    public function tenant(): Tenant;          // throws TenantNotResolved if unset
    public function id(): string;
    public function check(): bool;
    public function run(Tenant $tenant, Closure $fn): mixed;  // set, run, restore previous (for jobs/console)
    public function forget(): void;
}
```
Bind with `$this->app->scoped(TenantContext::class)` so it resets between requests under Octane and
between jobs in a worker. Logging context gets `tenant_id` when set.

## 4. BelongsToTenant trait + global scope

```php
trait BelongsToTenant
{
    public static function bootBelongsToTenant(): void
    {
        static::addGlobalScope(new TenantScope);
        static::creating(function (Model $model) {
            $ctx = app(TenantContext::class);
            if ($model->tenant_id === null) {
                $model->tenant_id = $ctx->id();               // throws if no tenant → fail closed
            } elseif ($ctx->check() && $model->tenant_id !== $ctx->id()) {
                throw new CrossTenantWriteException;
            }
        });
        static::updating(fn (Model $m) => $m->isDirty('tenant_id') ? throw new CrossTenantWriteException : null);
    }
    public function tenant(): BelongsTo { return $this->belongsTo(Tenant::class); }
}

final class TenantScope implements Scope
{
    public function apply(Builder $builder, Model $model): void
    {
        $ctx = app(TenantContext::class);
        if (! $ctx->check()) { throw new TenantNotResolved; }   // fail closed, never "return all"
        $builder->where($model->qualifyColumn('tenant_id'), $ctx->id());
    }
}
```
Rules:
- `tenant_id` is **not** in `$fillable`; it is set only by the trait.
- Bypass only through `Tenancy::withoutTenantScope(fn () => ...)` which logs the call site; allowed in
  `Support/Tenancy`, admin controllers, and migrations/seeders. A Pest arch test enforces this:
  `arch()->expect('App')->not->toUse('withoutGlobalScope')->ignoring([...allowlist])`.
- Route model binding resolves through the scope → a foreign tenant's ULID yields **404**, never 403.
- Validation rules for references use tenant-scoped exists: `Rule::exists('categories','id')->where('tenant_id', tenant()->id)`
  (wrapped as `TenantRule::exists('categories')`).
- Raw `DB::table()` queries on tenant tables are forbidden outside repositories that add `tenant_id`
  explicitly (arch test on `DB::table` usage in `Domain/`).

## 4a. Store scoping (inside a tenant)
- Store-scoped merchant routes are `/api/v1/stores/{store}/...`. `{store}` is resolved by route binding **through
  the tenant scope**, so a store of another tenant → 404 `not_found`. Middleware `store` (`ResolveStore`) then
  binds `StoreContext` (scoped singleton, same API as `TenantContext`: `set/store/id/check/run/forget`).
- Trait `BelongsToStore` (used together with `BelongsToTenant` on store-scoped models): global `StoreScope`
  adds `where store_id = ?` **when `StoreContext` is set**, and `creating` auto-fills `store_id` from it (throws if
  unset — fail closed; rejects mismatches; `store_id` immutable on update). Unlike `TenantScope`, `StoreScope` does
  not throw on read when unset, so tenant-wide reports (e.g. dashboard totals across stores) can query
  without a store, still tenant-filtered.
- Storefront requests set both contexts from the resolved host.
- Validation of references in store routes uses `StoreRule::exists('categories')` (tenant **and** store match).
- Jobs touching store data carry `store_id` too (`InteractsWithTenant` captures `StoreContext` if set and restores it).
- Cache prefix for store data: `t:{tenant_id}:s:{store_id}:`; storage paths stay tenant-prefixed
  (`media` is shared across a tenant's stores).
- Client side: one **user** may belong to several tenants (e.g. staff of two shops). After login: 0 tenants with a
  store → "Name your shop"; exactly 1 → open it; > 1 memberships → "Choose a shop" (Figma L4 `58:957`), which picks
  the **tenant** (= its single store). No store switcher; the tenant switcher stays. TanStack Query keys start with
  `[tenantId, storeId, ...]`.

## 5. Middleware

`tenant` (alias of `ResolveMerchantTenant`) on merchant route group, after `auth:sanctum`.
`storefront` (alias of `ResolveStorefrontTenant`) on storefront group, before throttling (throttle key
uses tenant). Both call `TenantResolver` and `TenantContext::set()`. Order:
`auth:sanctum → tenant → [store] → throttle:merchant → can:...` and `storefront → throttle:storefront`.

## 6. Queue jobs

- Interface `TenantAware` + trait `InteractsWithTenant` capture `tenant_id` in the constructor from
  `TenantContext` (throws if unset). Job middleware `RestoreTenantContext` calls
  `TenantContext::run(Tenant::findOrFail($this->tenantId), $next)`, and `forget()` in `finally`.
- Models passed to jobs via `SerializesModels` are re-fetched **inside** the restored context, so a job
  constructed with a model from tenant A cannot load tenant B rows.
- A global `Queue::before` listener asserts `TenantContext` is empty at job start (catches leaks).
- Listeners for domain events are queued with the same trait (event carries `tenant_id`).
- Platform-wide jobs (e.g. DNS sweep) iterate tenants and dispatch one tenant-aware job per tenant.

## 7. Cache keys
Helper `TenantCache` wraps the cache store with prefix `t:{tenant_id}:`; `Cache::` facade direct use
with tenant data is forbidden (arch test in `Domain/`). Platform keys use `sp:` prefix. Cache tags (Redis)
`tenant:{id}` allow full flush on tenant deletion. Rate limiter keys: `rl:{tenant_id}:{user_or_ip}`.

## 8. Storage paths
`TenantStorage::path(string $area, string $filename)` → `tenants/{tenant_id}/{area}/{ulid}.{ext}`
(areas: `products`, `branding`, `pages`, `imports`, `exports`, `invoices`). Original filenames never used
in keys. Exports/imports/invoices are on a private bucket served by short-lived signed URLs (5 min) after a
policy check; product/branding media are public via CDN. `media` table stores `tenant_id` + `path`;
access checks always go through the model, never by path.

## 9. Database-level defense (RLS) — phased
Phase 1–4: app-level scoping only; every tenant table has `tenant_id NOT NULL` + composite FKs (see
DATABASE-DESIGN.md §3) so cross-tenant references are impossible at the schema level.
Phase 5 (before real money flows), enable Postgres RLS:
1. App connects as role `storeplix_app` (NOT owner, NOT `BYPASSRLS`); migrations run as `storeplix_owner`.
2. For each tenant table: `ALTER TABLE x ENABLE ROW LEVEL SECURITY; ALTER TABLE x FORCE ROW LEVEL SECURITY;`
   `CREATE POLICY tenant_isolation ON x USING (tenant_id = current_setting('app.tenant_id', true))
   WITH CHECK (tenant_id = current_setting('app.tenant_id', true));`
3. `TenantContext::set()` runs `SELECT set_config('app.tenant_id', ?, false)` on the connection;
   `forget()` resets it. Since we use pooled persistent connections (PgBouncer in transaction mode is
   NOT used with RLS; use session pooling or none), reset on every request/job start.
4. Admin/cross-tenant code uses a separate connection `pgsql_admin` with role `storeplix_admin` (`BYPASSRLS`),
   only reachable from admin controllers and platform jobs.
5. Roll out table-by-table behind config `TENANCY_RLS=true`, with the cross-tenant test suite run against
   both modes in CI.
6. **RLS is tenant-level only.** Policies check `tenant_id`, never `store_id`. Store isolation inside a tenant
   is enforced by `StoreScope`, route binding, and the composite `(tenant_id, store_id, …)` FKs. With one store per
   tenant, tenant-level RLS already isolates every store; if multi-store is ever enabled, a store-level bug could
   only expose data between stores of the same merchant, which doesn't justify a second session variable.

## 10. Test strategy for cross-tenant access
- `tests/Support/TenantIsolation.php` provides `assertTenantIsolation(string $modelClass, string $routeBase)`:
  seeds tenants A and B, creates a record in B, acts as A user with `X-Tenant-Id: A`, and asserts
  `GET/PUT/PATCH/DELETE {routeBase}/{b_id}` → 404 and index never contains B ids.
- Mandatory per resource: (a) above; (b) `X-Tenant-Id: B` sent by A user → 403 `tenant_forbidden`;
  (c) creating with a foreign reference (e.g. `category_id` of B) → 422; (d) body containing `tenant_id`
  is ignored.
- Unit: `TenantScope` throws when context unset; `creating` rejects mismatched `tenant_id`.
- Job test: dispatch job in A, run worker with context cleared, assert it only sees A data.
- Cache/storage test: keys and paths contain tenant prefix.
- Storefront: host of store A cannot fetch product slug that exists only in store B (404).
- `{store}` path checks: another tenant's store → 404 (also via `{store}` of tenant B with `X-Tenant-Id: A`);
  a second `POST /stores` for the same tenant → 409 `store_limit_reached`; the store's `store_id` is auto-filled and
  can't be overridden from the body. Cross-store tests within one tenant are added only if multi-store is enabled.
- Arch tests: every model in `Domain/*/Models` except allowlisted platform models uses `BelongsToTenant`.
- Phase 5+: same suite with RLS enabled plus a raw-SQL test proving `storeplix_app` cannot read B rows.

# Multi-Tenancy

Status: Accepted (Phase 0); §9 updated to the Phase 5b-1 build. ADR 0001 (shared DB, shared schema), ADR 0012 (RLS).
Implementation lives in `apps/api/app/Domain/Tenancy/` (the Phase 0 draft said `app/Support/Tenancy/`). Read this file
before touching any tenant-owned model, job, cache or upload.

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
| Console / scheduler | explicit `--tenant=` or iterates `Tenant::query()->cursor()` and calls `TenantContext::run($tenant, fn)`; with RLS on, discovery runs on `pgsql_admin` (§9.5) | — | — |

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
(areas: `products`, `branding`, `pages`, `imports`, `exports`, `invoices`; media rows use
`tenants/{tenant_id}/media/{media_id}/…`). Expense receipts (Phase 8.7) are media rows on the **private** disk. Original filenames never used
in keys. Exports/imports/invoices are on a private bucket served by short-lived signed URLs (5 min) after a
policy check; product/branding media are public via CDN; expense receipts are private and served by a 5-minute
signed URL (PHASE-8-7 §5.3). `media` table stores `tenant_id` + `path`;
access checks always go through the model, never by path.

## 9. Database-level defense (RLS) — as built (Phase 5b-1)

Status: built in 5b-1 and extended by every later 5b migration. Decision: ADR 0012. Binding detail:
PHASE-5B-CONTRACT §2 (P5B-1–P5B-8). Operations (role setup, the production switch, rollback): `docs/deployment/RUNBOOK.md`.
Code: `app/Domain/Tenancy/` (`Database/RlsTables`, `Database/RlsPolicies`, `Database/RlsSession`,
`Support/PlatformDb`, `Support/PreTenantLookup`, `Support/IntegrationLookup`, `Support/DevShipmentLookup`,
`Middleware/ResetDatabaseTenant`, `Middleware/SetDatabaseUser`, `TenancyServiceProvider`).

Phase 1–4 relied on app-level scoping plus `tenant_id NOT NULL` and composite FKs (DATABASE-DESIGN.md §3). Since 5b-1
Postgres enforces tenant isolation itself, so a raw query or a forgotten scope can't cross tenants. Everything below is
inert on sqlite and when `TENANCY_RLS=false`.

### 9.1 Roles and connections
Roles are created outside migrations by `infrastructure/docker/postgres/initdb/01-roles.sql` (psql script, run as a
superuser or a role with `CREATEROLE`; idempotent; once per database):

| Role | Attributes | Laravel connection (env) | Used by |
|---|---|---|---|
| `storeplix_owner` | `LOGIN NOSUPERUSER BYPASSRLS`, owns the database, schema `public` and every table/function | `pgsql_owner` (`DB_OWNER_USERNAME`/`PASSWORD`, falls back to `DB_USERNAME`) | `migrate`, `db:seed` (`--database=pgsql_owner`) |
| `storeplix_app` | `LOGIN NOSUPERUSER NOBYPASSRLS`, owns nothing, DML only, not a member of the other two (the script aborts otherwise) | `pgsql`, the default (`DB_USERNAME`/`PASSWORD`) | web requests, queue workers |
| `storeplix_admin` | `LOGIN NOSUPERUSER BYPASSRLS`, DML only | `pgsql_admin` (`DB_ADMIN_USERNAME`/`PASSWORD`, falls back to `DB_USERNAME`) | `withoutTenancy()`, console commands, the scheduler's discovery queries, platform jobs, future `/admin/*` |

Default privileges: tables the owner creates get `SELECT, INSERT, UPDATE, DELETE` for app and admin, sequences
`USAGE, SELECT` (no `TRUNCATE`, `REFERENCES`, `TRIGGER`, `CREATE`). The policy migration re-grants DML on tables that
existed before 5b and revokes `UPDATE, DELETE ON audit_logs` from the app role (append-only, SECURITY.md T18).

`config/tenancy.php`: `rls` (`TENANCY_RLS`, default `false`; `true` in compose, CI `api-rls` and production),
`owner_connection` = `pgsql_owner`, `admin_connection` = `pgsql_admin`.

### 9.2 Forced RLS on every tenant table
- `RlsTables::TENANT` is the single list: **52 tables** (40 from Phases 1–5a + `return_requests`, `return_items`,
  `return_events`, `document_templates`, `documents`, `payment_gateway_accounts`, `payment_links`, `webhook_events`,
  `courier_accounts`, `shipment_events`, `courier_area_mappings`, `shipment_batches`). `RlsTables::PLATFORM` lists the
  tables without `tenant_id` and without RLS (`users`, `password_reset_tokens`, `sessions`, `cache`, `cache_locks`,
  `jobs`, `job_batches`, `failed_jobs`, `personal_access_tokens`, `tenants`, `plans`, `otp_codes`, `migrations`).
- Every listed table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` (so even the owning role is subject to policies
  unless it has `BYPASSRLS`). Migration `2026_06_01_000100_enable_row_level_security` covers the tables that existed;
  each later 5b migration calls `RlsPolicies::enable($db, $table)` for its own table and adds it to the list in the
  same change. A new tenant table without both is caught by `RlsCoverageTest` and the CI catalogue check.
- GUC helpers: `app_current_tenant()` / `app_current_user()` = `NULLIF(current_setting('app.tenant_id'|'app.user_id',
  true), '')`, `STABLE`. Policies compare with `(app_current_tenant())::bpchar` because the id columns are `char(26)`:
  comparing with `text` would cast the column and lose the `(tenant_id, …)` indexes.
- Policies are `TO storeplix_app` (or `TO public` when the role doesn't exist yet: fail closed either way):

| Table | Policies |
|---|---|
| every other table | `tenant_isolation FOR ALL USING (tenant_id = T) WITH CHECK (tenant_id = T)` |
| `tenant_users` | `SELECT USING (tenant_id = T OR user_id = U)` (memberships for `/auth/me` and `ResolveTenant` before a tenant is set); `INSERT`/`UPDATE`/`DELETE` limited to `tenant_id = T` (split after QA 5b-1 F-L2, so a user can't touch their memberships in other tenants) |
| `audit_logs` | `SELECT USING (tenant_id = T)`; `INSERT WITH CHECK (tenant_id IS NULL OR tenant_id = T)`; no UPDATE/DELETE policy or grant. Platform events (null tenant) are readable only through `pgsql_admin` |
| `sms_messages` | `SELECT` and `UPDATE` `USING (tenant_id = T OR (tenant_id IS NULL AND T IS NULL))` (Postgres applies the SELECT policy to an UPDATE's `WHERE`, and `SendSms` updates OTP rows without a tenant); `INSERT WITH CHECK (tenant_id IS NULL OR tenant_id = T)` |

  (T = `app_current_tenant()`, U = `app_current_user()`.) With no GUC set the app role sees no rows and can't insert.
- **RLS is tenant-level only.** Policies never check `store_id`. Store isolation inside a tenant stays with
  `StoreScope`, route binding and the composite `(tenant_id, store_id, …)` FKs; with one store per tenant, tenant-level
  RLS already isolates every store.

### 9.3 GUC lifecycle (requests and jobs)
`RlsSession` (singleton) writes `select set_config('app.tenant_id', ?, false)` and `app.user_id` on the **default
connection only, and only when it is already open**; a connection opened later gets the current state from the
`ConnectionEstablished` listener. It is inert unless `TENANCY_RLS=true`, the default connection is `pgsql`, and the
default connection is not the owner/admin connection (so `migrate --database=pgsql_owner` is unaffected).

`TenantContext` (`app/Domain/Tenancy/TenantContext.php`; as built: `set`, `clear`, `has`, `id`, `requireId`, `tenant`,
`role`, `run`) mirrors every change into `app.tenant_id`; `run()` restores the previous value in `finally`.

| Moment | What happens |
|---|---|
| Request start | Global middleware `ResetDatabaseTenant`, first in the stack (arch test): both GUCs → `''` |
| After `auth:sanctum` | `SetDatabaseUser` (priority list, right after the auth middleware) sets `app.user_id`; `Authenticated`/`Login` events set it, `Logout` clears it; `ResolveTenant` also sets it before the membership lookup |
| `tenant` / `storefront` middleware | `TenantContext::set()` → `app.tenant_id`; `clear()` in `finally` |
| Tenant switch inside a transaction | `set()` to a **different** tenant while `transactionLevel() > 0` throws `TenantSwitchInTransaction` (null → A is allowed: registration and invitation accept open their transaction inside `run()`) |
| Rollback | `TransactionRolledBack` on the app connection re-writes both GUCs from the current context (a rollback, or rollback to a savepoint, restores the values of the transaction start; QA 5b-1 F-L1) |
| New connection / reconnect / forked race child | `ConnectionEstablished` re-applies tenant + user and runs the role check (§9.6) |
| Queue job | The scoped `TenantContext` is fresh per job; `JobProcessing` resets both GUCs; `RestoreTenantContext` → `run(tenant)`; `JobProcessed`, `JobFailed`, `JobExceptionOccurred` reset again. Jobs on the `sync` connection are skipped on purpose: they run nested in the caller and keep its state |
| Console / scheduler | Separate processes. Discovery runs on `pgsql_admin`; per-tenant work is dispatched as one tenant-aware job per tenant, or runs inside `TenantContext::run()` on `pgsql` |

No Octane, no persistent PDO and no transaction-mode pooler: session GUCs need one server session per connection
(PgBouncer off, or in session mode; RUNBOOK §2).

### 9.4 Pre-tenant request paths (definer functions)
Request paths never hold a `BYPASSRLS` connection. When a request must find its tenant first, it calls a `SECURITY
DEFINER` function owned by `storeplix_owner` (`SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC`,
`GRANT EXECUTE … TO storeplix_app`) that returns **ids only** from exact-match lookups, then works inside
`TenantContext::run()`. With RLS off the same PHP methods fall back to the pre-5b `withoutTenancy()` queries.

| Function (signature as built) | Returns | Caller |
|---|---|---|
| `sp_resolve_host(p_host text)` | `(tenant_id, store_id)` for an `active` domain of a non-suspended store | `PreTenantLookup::resolveHost` (storefront host resolution, B1) |
| `sp_invitation_by_token(p_hash text)` | `(invitation_id, tenant_id)` | `PreTenantLookup::invitationByTokenHash` (invitation show/accept, B4) |
| `sp_store_slug_taken(p_slug text)` | `boolean` | `PreTenantLookup::storeSlugTaken` (global slug uniqueness, B5; a `23505` on `stores.slug` maps to 422) |
| `sp_payment_owner(p_payment text)` | `(tenant_id, store_id)` | `IntegrationLookup::paymentOwner` (signed payment-return URL, B13) |
| `sp_route_key_owner(p_provider text, p_key text)` | `(tenant_id, store_id, account_id)` from `payment_gateway_accounts` **or** `courier_accounts`; provider must match the key's account | `IntegrationLookup::routeKeyOwner` (webhooks `/webhooks/{provider}/{route_key}`, B12). Created in `000200` (gateways) and replaced in `000700` (gateways + couriers) |
| `sp_api_key_owner(p_hash text)` | `(tenant_id, key_id)` for a **non-revoked** `api_keys` row whose `key_hash` (sha256 hex of the plain key) matches | `apikey` middleware (Phase 8.4 external API `/external/*`, PHASE-8-4 P84-3; ADR 0018). Created in `2026_12_01_000100`. The middleware checks the key format first (`^sp_live_[A-Za-z0-9]{40}$`), then sets `TenantContext` with role kind `api_key` (permission set = the key's scopes' backing permissions) and the RLS GUCs |

`IntegrationLookup` validates the input shape first (ULID / 32 base62 characters) and returns `null` otherwise.
`DevShipmentLookup::shipmentOwner` is a **testing-only** pre-tenant lookup for `POST /dev/shipments/{id}/advance`: it
returns null in production or without `COURIERS_FAKE`, and the route is not registered in production; it uses
`withoutTenancy()` (allowlisted in `Domain/Tenancy`).

**Storefront unsubscribe (Phase 8.5, PHASE-8-5 §4.2, ADR 0019) needs no definer function.** `GET|POST
/storefront/unsubscribe/{code}` resolves the tenant and store from `X-Storefront-Host` like every storefront route
(`sp_resolve_host`), then looks the code up by `sha256(code)` in `campaign_recipients` **inside** `TenantContext` on the
normal RLS path, filtered by the host's `store_id`. A code issued by another store (or tenant) therefore never matches
and answers the same 404 `unsubscribe_link_invalid` as an unknown or malformed one (S117). The suppression it writes is
`BelongsToStore` for the host's store. The storefront page `/u/{code}` lives on the merchant's own host and bypasses the
Coming-soon rewrite; a suspended store's host does not resolve (404).

**Checkout contact and cart recovery (Phase 8.6, PHASE-8-6 §7, ADR 0020) need no definer function either.**
`PUT /storefront/cart/contact` resolves tenant and store from `X-Storefront-Host` (`sp_resolve_host`) and finds the cart
by `sha256(X-Cart-Token)` inside `TenantContext` on the normal RLS path, filtered by the host's `store_id`, exactly like
the other cart routes; the contact columns are never serialized by any storefront resource. `POST
/storefront/carts/recover` looks `sha256(code)` up in `automation_runs.recovery_code_hash` the same way (host's
`store_id`, RLS path): a code of another store or tenant never matches and answers the same 404
`recovery_link_invalid` as an unknown one (S133). The new cart is created `BelongsToStore` for the host's store and
copies lines from the run's cart; the original cart row and token are never returned or changed. The storefront route
`/r/{code}` lives on the merchant's own host outside `(store)` (like `/u`) and is on the proxy allowlist.

**Automation actor (Phase 8.6, P86-20).** Changes an automation makes on its own (customer tags) run inside the job's
`TenantContext` with actor type `automation` (`actor_id` = automation id). The automation never acts with a member's
permissions: it can only perform the fixed recipe actions, and per-action effects are recorded in the run log, not
`audit_logs`. Team notifications resolve recipients at send time from current `tenant_users` memberships whose resolved
permission set holds the recipe's key (`inventory.adjust` for low stock), plus owners and admins.

**Expense receipts (Phase 8.7, PHASE-8-7 §5, ADR 0021) need no definer function.** The signed
`GET /expense-receipts/{media}/download` carries the tenant id in its signed parameters (like `documents.download` and
`exports.download`); the controller runs `TenantContext::run(tenant)`, loads the `media` row on the normal RLS path,
and serves it only when the purpose is `expense_receipt`, the row is `ready` and attached to an expense, the disk is
the private disk and `TenantStorage::ownsPath($media->path)` holds. A link of tenant A with tenant B's media id finds
nothing (404). Receipts are never served by the tenant-agnostic CDN and never by the generic `/media` routes
(`MediaPurpose::libraryCases()`).

**Store currency lock (Phase 8.7, P87-18).** `StoreSettingsUpdater` checks `EXISTS` on `orders` and `expenses` filtered
by tenant **and** store inside the settings transaction (store row locked `FOR UPDATE`); expense create locks the same
row `FOR SHARE` before reading `stores.currency`.

### 9.5 Cross-tenant platform code (`withoutTenancy()` → `pgsql_admin`)
- `Model::withoutTenancy()` removes the `TenantScope` **and**, with RLS on, moves the query onto `pgsql_admin`
  (`PlatformDb::reroute`). With RLS off it stays on the default connection, exactly as before 5b.
- `PlatformDb::connection()` gives raw access to the same connection (e.g. `integrations:rotate-key`).
- Allowed only in `app/Console`, `app/Domain/*/Console`, `app/Domain/Tenancy` and `database/seeders`
  (`RlsBypassArchTest`, which also bans `pgsql_admin`, `tenancy.admin_connection`, `PlatformDb::` and
  `withoutGlobalScope(TenantScope…)` elsewhere). Mark each call `// cross-tenant: reason`.
- Scheduled commands (`payments:*`, `payment-links:expire`, `couriers:*`, `documents:prune`, `webhooks:prune`, the
  pre-5b prunes) find work on `pgsql_admin`, then dispatch one tenant-aware job per tenant (or per account). Commands
  that write tenant rows (`shipping:provision-defaults`, `stores:ensure-content`) re-load the store on `pgsql` inside
  `TenantContext::run()`, so relation writes don't inherit the admin connection.
- Phase 8.5: `campaigns:dispatch-due` (every minute), `campaigns:reap-stuck` (every 5 min) and
  `campaigns:prune-recipients` (daily) find due campaigns / stuck recipients / old rows on `pgsql_admin`, then move
  state by conditional UPDATE and dispatch `StartCampaign` / `SendCampaignBatch` as `TenantAware` jobs (queue
  `campaigns`) inside `TenantContext::run()`. The attribution listener on order placed is queued and `TenantAware`.
- Phase 8.6: `automations:detect-abandoned` (every 5 min), `automations:resume-due` (every minute),
  `automations:reap-stuck` (every 5 min) and `automations:prune-runs` (daily) find stores with an `on` recovery
  automation / due `waiting` runs / stuck `sending` steps / old runs on `pgsql_admin`, then move state by conditional
  UPDATE (`recovery_detected_at`, `waiting → running`, `sending → unknown`) and dispatch `EvaluateAutomation` (and step
  jobs) as `TenantAware` jobs on the `automations` queue inside `TenantContext::run()`. The trigger fan-out in
  `WebhookEvents::emit` and the `OrderService::systemCancel` hook run in the request's tenant context and only dispatch
  `TenantAware` jobs.
- Phase 8.7: `expenses:repeat` (hourly) finds active `expense_recurrences` with `next_on ≤ UTC date + 1` on
  `pgsql_admin`, then per store inside `TenantContext::run()` filters `next_on ≤ today in the store timezone` and
  dispatches `GenerateRecurringExpenses` (`TenantAware`, queue `default`; idempotent by `UNIQUE(recurrence_id,
  spent_on)`). `expenses:prune-receipts` (daily) finds unattached `expense_receipt` media older than 24 h on
  `pgsql_admin`, then per tenant deletes the row first (`NOT EXISTS` on `expenses.receipt_media_id`, FK RESTRICT as
  backstop) and the private object after commit when `ownsPath()` holds.
- Seeders run with `--database=pgsql_owner` (the owner bypasses RLS) and keep `TenantContext::run()` around tenant writes.
- Super-admin `/admin/*` (not built yet) must use `pgsql_admin` and stay out of merchant request paths.

### 9.6 Boot checks
With `TENANCY_RLS=true` on Postgres, outside `APP_ENV=testing`, the API refuses to start (`RlsMisconfiguredException`)
when:
1. the app user (`DB_USERNAME`) equals the owner user (`pgsql_owner`), checked at boot without a query;
2. the admin user equals the app user (e.g. `DB_ADMIN_USERNAME` unset, so platform jobs would silently see no rows;
   QA 5b-1 F-L3), checked at boot;
3. the app role is a superuser or has `BYPASSRLS`, checked on every new app connection (`ConnectionEstablished`).

In `testing` the same conditions are asserted by `RlsBootCheckTest` and `RlsCoverageTest` instead (a failing test in
CI `api-rls`).

### 9.7 Rollback and the emergency switch-off
- The policy migration's `down()` (and `RlsPolicies::disable`) drops the policies and runs `NO FORCE` + `DISABLE` on
  every listed table and re-grants `UPDATE, DELETE ON audit_logs`. **The definer functions and GUC helpers stay**
  (QA 5b-1 F-L6): a running app with `TENANCY_RLS=true` keeps calling them, and they are harmless without policies.
  Because later 5b migrations sit on top, rolling back "only the policy migration" means rolling back every migration
  from `2026_06_01_000100` on; prefer the emergency script in production.
- `apps/api/database/sql/rls-emergency-off.sql` does the same as plain SQL in one transaction (tables that don't exist
  are skipped). Its table list must equal `RlsTables::TENANT` (`RlsEmergencyScriptTest`). Order in an incident: run the
  script as `storeplix_owner`, then set `TENANCY_RLS=false` and restart web and workers. A quicker switch that keeps
  the policies: `TENANCY_RLS=false` + the app on the owner user. Re-enabling after the script needs the policy SQL
  re-applied without dropping tables: `php artisan tenancy:rls-enable` (owner, idempotent). Steps: RUNBOOK §7.2.

### 9.8 CI
- `api-postgres`: Postgres 16, runs the roles script, but connects as the superuser: proves app-level isolation with RLS
  bypassed.
- `api-rls` (part of `ci-ok`): runs `01-roles.sql` as the service superuser; `migrate:fresh --seed
  --database=pgsql_owner`; rolls back every migration from the policy migration on, asserts no policies, no RLS and no
  data loss, then re-migrates; catalogue checks (app role can't bypass RLS, every table owned by `storeplix_owner`,
  every `tenant_id` table has RLS enabled **and** forced with a policy); then as `storeplix_app` with
  `TENANCY_RLS=true`: `--group=rls` (fails if empty or anything skips), `--group=tenancy`, `--group=security` (without
  perf/race), the race tests one process each (fail on skip, incl. S36 edit-vs-checkout, IPN-vs-return and concurrent
  bookings), and the checkout p95 budget (`checkout-perf`, < 300 ms).
- Local recipe: `docs/development/TESTING.md` §2d.

### 9.9 Known gaps (as built)
- Platform tables (`users`, `tenants`, `personal_access_tokens`, `sessions`) have no RLS; a raw-SQL bug can still read
  them across tenants (QA 5b-1 I-3).
- CI runs only the `rls`, `tenancy` and `security` groups as the app role; older Phase 2–4 tests that create data
  without a tenant context fail as the app role (QA 5b-4/5 §5).
- No `EXPLAIN` test that list queries keep an index scan under RLS (§2.8); only the p95 budget.
- CI uses `QUEUE_CONNECTION=sync`; a real Redis worker with RLS is exercised by the compose stack only.

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
- Phase 5b (built): the `tenancy` and `security` groups also run with RLS on as `storeplix_app` (CI `api-rls`), plus the
  `rls` group (§9.8): raw-SQL probes proving `storeplix_app` cannot read, insert, update or delete B rows, coverage,
  definer functions, GUC lifecycle, boot checks, bypass arch test, emergency-script list. Fixtures create tenant rows
  inside `inTenant($tenant, fn)` (`tests/TestCase.php`).

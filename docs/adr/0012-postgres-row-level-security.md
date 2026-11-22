# ADR 0012 — Postgres row-level security (tenant-level, defence in depth)

Status: Accepted (Phase 5b, task 5.10) · Date: 2026-11-22 · Binding detail: PHASE-5B-CONTRACT §2 (P5B-1–P5B-8)

## Context
Phases 1–5a isolate tenants in the application only: `BelongsToTenant` + `TenantScope` (fail closed), `{store}`
bound through the scope, composite `(tenant_id, store_id, …)` FKs and the isolation suite. One forgotten `where`,
a raw `DB::table()` in a report, or a future bug in a scope would expose another merchant's customers and money.
Phase 5b moves real money (online payments, courier COD). MULTI-TENANCY §9 already planned RLS "before real money
flows". The code base has a small, enumerable set of queries that must run before a tenant is known.

## Decision
- **Three database roles.** `storeplix_owner` (owns the schema, runs migrations, `BYPASSRLS`), `storeplix_app`
  (the web and queue role: `NOSUPERUSER NOBYPASSRLS`, DML only; `audit_logs` INSERT/SELECT only) and
  `storeplix_admin` (`BYPASSRLS`, DML only) for platform jobs, the scheduler and the future super-admin API.
  Laravel connections: `pgsql` (app, default), `pgsql_owner` (migrations), `pgsql_admin` (platform).
  Superusers bypass RLS, so the app must **never** connect as the compose superuser once `TENANCY_RLS=true`.
- **One policy per tenant table**, `ENABLE` + `FORCE ROW LEVEL SECURITY`:
  `USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())` where
  `app_current_tenant()` = `NULLIF(current_setting('app.tenant_id', true), '')`. Unset → no rows, inserts fail
  (fail closed). Tenant level only (MULTI-TENANCY §9.6). Exceptions: `tenant_users` (also `user_id =
  app.user_id` for "my memberships"), `audit_logs` and `sms_messages` (nullable `tenant_id`: platform rows are
  insertable but readable only through `pgsql_admin`).
- **Session GUCs set by the app.** `TenantContext::set/run/clear` call `set_config('app.tenant_id', …, false)` on
  the `pgsql` connection; the authenticated user sets `app.user_id`. Both are reset at the start of every request
  and every queue job, and re-applied when Laravel reconnects. Setting a different tenant inside an open transaction
  is refused (a rollback would silently revert the GUC). No PgBouncer transaction pooling.
- **Pre-tenant lookups are explicit and narrow.** Request paths that must find a tenant from a public input use
  `SECURITY DEFINER` SQL functions owned by `storeplix_owner` that return ids only (host → store, invitation token →
  tenant, webhook route key → account, payment id → store, store slug taken). Console commands, the scheduler,
  platform jobs and the super-admin API use `pgsql_admin`; `Model::withoutTenancy()` is rerouted to that connection
  and its call sites are an arch-test allowlist. No request path holds a `BYPASSRLS` connection.
- **Every table with a `tenant_id` column must have RLS forced.** A Postgres test compares
  `information_schema.columns` with `pg_class.relrowsecurity/relforcerowsecurity`, so a new table can't be missed.
- **Rollout.** App code that sets GUCs ships first (harmless while policies are absent), then the policy migration.
  CI runs the tenancy and security suites twice on Postgres: as the owner (RLS bypassed, app-level isolation only)
  and as `storeplix_app` with `TENANCY_RLS=true`. Rollback = `migrate:rollback` of the policy migration (drops
  policies, disables RLS) plus switching `DB_USERNAME` back; an emergency SQL script does the same.

## Consequences
+ A missing scope or raw query can no longer read or write another tenant's rows; the database refuses.
+ Webhook and payment-return handlers can't touch rows outside the tenant their route key resolves to.
− Test fixtures that create rows "for tenant X" without a context must run inside `TenantContext::run()`; the
  existing suite needs a mechanical update (largest single cost of 5.10).
− Any "unique across all tenants" validation (e.g. `Rule::unique('stores','slug')`) sees only the current tenant
  under RLS and must use a definer function; the DB unique index still holds.
− Local work needs Postgres (Docker); sqlite keeps working but proves nothing about RLS.

## Alternatives
- Schema- or database-per-tenant: strong isolation, heavy migrations and pooling cost (ADR 0001 rejected).
- A bypass GUC (`app.bypass_rls`) checked in policies: any SQL injection could set it. Rejected.
- `SET ROLE` per request from a privileged login role: an injection can `RESET ROLE`. Rejected.
- Store-level policies (`app.store_id`): one store per tenant (D1) makes it redundant (MULTI-TENANCY §9.6).

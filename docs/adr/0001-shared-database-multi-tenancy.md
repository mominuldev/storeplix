# ADR 0001 — Shared database, shared schema multi-tenancy (PostgreSQL)

Status: Accepted · Date: 2026-11-21 · Amended 2026-11-21 (D1: one store per tenant, store_id kept)

## Context
Thousands of small BD merchants, low ARPU, one ops team. Need strong isolation without per-tenant infra cost.

## Decision
One PostgreSQL 16+ database, shared schema, `tenant_id` on every tenant-owned row. Isolation enforced by
(1) `TenantContext` + `BelongsToTenant` global scope (fail-closed), (2) composite `(tenant_id, id)` FKs,
(3) Postgres RLS from Phase 5 with a non-owner, non-BYPASSRLS app role. Details: MULTI-TENANCY.md, DATABASE-DESIGN.md.

**Amendment (D1, revised by PO):** exactly one store per tenant (`UNIQUE(stores.tenant_id)`; second create → 409
`store_limit_reached`). Store-scoped tables still carry `store_id` with composite FK `(tenant_id, store_id) →
stores(tenant_id, id)` and per-store business uniques (e.g. `U(store_id, sku)`), and merchant routes still use
`/api/v1/stores/{store}/...`, so a future multi-store option needs only a constraint drop + UI. RLS stays tenant-level.
A user may belong to several tenants.

## Consequences
+ One migration path, cheap tenants, simple analytics, easy pooling.
+ Defense in depth: app scope, schema constraints, RLS.
− A scoping bug is a cross-tenant leak → mandatory isolation tests per resource, arch tests.
− Noisy neighbours share one DB → per-tenant rate limits, indexes leading with `tenant_id`, read replica (Phase 9).
− RLS requires session-level `app.tenant_id` → no PgBouncer transaction pooling.
− `store_id` is redundant while there is one store per tenant (small storage/index cost, accepted for future flexibility).

## Alternatives
- **Database per tenant:** strongest isolation, but N migrations, connection explosion, high cost. Kept as future enterprise tier (tenant row would carry a `connection` name).
- **Schema per tenant:** same migration fan-out; Postgres catalog bloat at 10k+ schemas.
- **MySQL 8:** no RLS, weaker partial/expression indexes and jsonb. Rejected.

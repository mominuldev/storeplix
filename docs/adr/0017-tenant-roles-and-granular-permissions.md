# ADR 0017 — Tenant roles and granular permissions

Status: Accepted (Phase 8.3) · Date: 2026-11-23 · Binding detail: PHASE-8-3-CONTRACT §1 (P83-1 – P83-13), §2–§5
Supersedes: the fixed owner/admin/staff matrix of ADR 0005 (authentication and membership rules of 0005 stay).

## Context
ADR 0005 gave every membership one of three fixed roles and the code checked 13 coarse permissions
(`operate`, `manage_refunds`, `manage_settings`, …) against `tenant_users.role`. Figma "Staff · team, roles &
permissions" (`89:26676`) designs custom roles ("Order staff", "Packer") with per-permission toggles, and the Growth plan
already advertises `custom_roles`. Constraints:
- `operate` alone guards most of the merchant API (orders, shipments, catalogue, customers); custom roles need it split.
- Existing tenants must keep exactly today's behaviour.
- RLS (ADR 0012) and composite tenant FKs (MULTI-TENANCY) apply to any new table; `/auth/me` lists memberships of
  several tenants without a tenant context.
- No merchant-defined logic may execute; permissions must stay a closed, reviewable set.

## Decision
1. **Permissions are code constants**: a string-backed `Permission` enum of 23 keys (`orders.view`, `orders.refund`,
   `costs.view`, …), 22 grantable plus owner-only `billing.manage`, with groups, prerequisites and a sensitive flag.
2. **Roles are tenant rows** (`roles`, `role_permissions`). Each tenant has three **system roles** (`key` owner /
   admin / staff, `is_system`), whose permission sets are defined in code, not rows, so they can't drift and pick up
   new keys automatically. Custom roles store their keys in `role_permissions`.
3. **Every membership and invitation has `role_id`** (composite FK to the tenant's roles). `tenant_users.role` stays as
   a denormalised kind (`owner`/`admin`/`staff`/`custom`) for owner uniqueness and existing lookups.
4. **Enforcement is declarative per route** (`perm:<key>|…` middleware on every tenant route, proven by a route test)
   plus a short list of value-dependent checks in services. Policies keep their tenant defence-in-depth check.
5. **Resolution per request**: the membership is loaded with its role; the set comes from code (system) or from a
   tenant-prefixed cache keyed by role id and revision (custom). Changes apply from the next request; sessions are not
   revoked.
6. **Non-delegation**: nobody grants, assigns, edits or removes more than they hold; nobody edits their own role or
   membership; the owner role is never assignable and system roles are locked.
7. **Plan gate**: custom roles need `custom_roles` (Growth). On downgrade they stay assigned and enforced but frozen,
   never widened.
8. `roles` and `role_permissions` get a special RLS SELECT policy (current tenant **or** a tenant the current user is a
   member of), writes limited to the current tenant, like `tenant_users`.

## Consequences
- Every guarded route changes its check in one refactor; a parity fixture recorded before the change proves owner,
  admin and staff see identical status codes after it.
- New features must add a key (or use an existing one) and a route mapping, or the route test fails. Adding a key is
  a code change plus a system-role decision; custom roles get it off by default.
- The SPA no longer derives abilities from the role name; it reads `permissions[]` from the membership.
- Per-person overrides, warehouse-scoped roles and ownership transfer are not supported by this model yet; they can be
  added as extra columns/tables without changing the keys.

## Alternatives considered
- **Bitmask or JSON array on `tenant_users`** (per-person permissions): no reusable roles, matches Figma less, harder
  to audit.
- **Spatie laravel-permission**: global permission tables and guard logic that don't fit RLS/composite FKs and ULIDs;
  adds a dependency for little gain.
- **Store system-role permissions as rows**: drift per tenant and a backfill for every new key.

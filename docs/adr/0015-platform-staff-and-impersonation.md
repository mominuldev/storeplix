# ADR 0015 — Platform staff, the admin surface and read-only impersonation

Status: Proposed (Phase 8.1) · Date: 2026-11-23 · Binding detail: PHASE-8-1-CONTRACT §1 (P8-1 – P8-19), §9 (S67–S82)

## Context
Storeplix staff need to find any shop, look at it, fix billing by hand, act on custom domains and take a shop offline.
Until Phase 7 this was done with artisan commands (PHASE-6 `domains:*`, PHASE-7 §4.4 `billing:*`). The super-admin
SPA (`apps/super-admin`) exists as a shell that signs in through the merchant `/auth/login`, and `/api/v1/admin/*`
doesn't exist. Constraints already in place:
- Cookie sessions (Phase 4.7b), host-only `__Host-` cookies in production, but **one cookie jar for both SPAs on
  `localhost`** (cookies ignore ports). A staff member may also own a shop.
- RLS (ADR 0012): request paths use the app role; `pgsql_admin` (`BYPASSRLS`) is reserved for platform code and "the
  future `/admin/*`" (MULTI-TENANCY §9.5).
- `audit_logs` is append-only in the database (SECURITY T18).
- Figma `5:189` designs a staff sign-in with TOTP, a fixed role matrix and an impersonation mode that renders the real
  merchant dashboard with a banner, read-only, time-boxed and reason-bound.

## Decision
1. **Staff are `users` with `platform_role`** (`super_admin`, `billing`, `support`, `read_only`) and a fixed
   permission matrix in code. The first super admin and break-glass actions are artisan commands.
2. **Every session has a surface** (`merchant`, `admin`, `impersonation`) written at login. `/admin/*` needs the
   `admin` surface and an active role; merchant routes refuse the `admin` surface. A cookie that happens to be shared
   (localhost, a staff member who owns a shop) can never cross surfaces.
3. **Admin sign-in is password + mandatory TOTP**, with hashed single-use recovery codes, replay protection and a
   15-minute lockout; 30 min idle / 12 h absolute sessions; optional IP allowlist.
4. **Admin reads are cross-tenant on `pgsql_admin`, only in `app/Domain/Admin/**`** (arch test). **Admin writes run as
   the tenant**: the admin controller resolves the tenant id, then calls the same domain Action the ops command calls
   inside `TenantContext::run()` on the app role, so RLS `WITH CHECK` still applies to every write.
5. **Impersonation acts as the staff user, never as the merchant.** The admin API issues a 60-second single-use ticket
   (hashed at rest, delivered in a URL fragment); the merchant SPA exchanges it for a fresh session on the merchant
   origin with surface `impersonation`, scoped to exactly that tenant with the owner's read permissions. One middleware
   refuses every non-GET request (plus a short, tested list of GETs with side effects). Sessions last at most 15
   minutes, can be revoked, and write start/end rows on the shop's own audit log, where the merchant sees the actor as
   "Store Plix support".
6. **Suspension** is a tenant + store state. The merchant API refuses the tenant, every storefront host shows a 503
   "temporarily unavailable" page through the existing host-resolution definer function, and money already in flight
   (payment and courier webhooks) still settles.

## Consequences
- One identity per person; staff keep their merchant shops without a second account. Staff management is a role
  column, not a user table, so revoking access is one update plus killing admin sessions.
- The merchant dashboard is reused for support without a parallel admin view of orders, catalog or settings, at the cost
  of a read-only mode that must stay correct as merchant routes grow; the route-list-driven test makes every new write
  route refused by default.
- Audit trails stay truthful: no action is ever recorded as the merchant when staff did it.
- Ops commands become thin wrappers over Actions; behaviour must not change (their tests stay untouched).
- `sp_resolve_host` gains a column; storefront config gains a `suspended` status.
- Not chosen: (a) a separate `platform_users` table: duplicates auth, reset and audit actors; (b) "log in as the
  merchant" tokens: breaks repudiation and needs the merchant's identity; (c) an admin-side copy of merchant screens for
  inspection: weeks of duplicate UI that drifts; (d) Sanctum token abilities (`admin:*`, the old T11 plan): the apps use
  cookie sessions since 4.7b, so the ability check would never run.

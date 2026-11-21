# ADR 0005 — Merchant authentication and roles

Status: Accepted · Date: 2026-11-21 · Amended 2026-11-21 (D1 revised, D3)

## Context
A user may own one tenant and be staff in another. SPAs live on `app.`/`admin.` subdomains; API on `api.`.

## Decision
- **Auth:** Laravel Sanctum personal access tokens (Bearer) for Phase 1–3 as fixed by AGENT-CONTRACTS. Tokens expire
  after **7 days** (`SANCTUM_EXPIRATION`, default 10080 min; PO decision D3), not sliding; token responses include
  `expires_at`; `sanctum:prune-expired --hours=24` runs daily. Abilities `merchant` or `admin`; revoked on
  logout/password change. Expired/invalid → 401 `unauthenticated`. SPA stores the token in `sessionStorage` (not
  `localStorage`), logs out when `expires_at` passes or on any 401, and shows "Your session expired, please sign in again".
- **Shop selection (D1, revised):** one store per tenant; a user may belong to several tenants. "Choose a shop"
  (Figma L4 `58:957`) picks the tenant (= its store). Store-scoped routes are `/api/v1/stores/{store}/...` with `{store}`
  required to belong to the `X-Tenant-Id` tenant (else 404). **Phase 4:** migrate SPAs to Sanctum cookie-based SPA auth (httpOnly, `SameSite=Lax`, CSRF cookie)
  on `.storeplix.com` to remove token exposure to XSS — contract change will be proposed then.
- **Tenant selection:** `X-Tenant-Id` header validated per request against `tenant_users` (non-member → 404).
- **Roles (Phase 2):** `owner`, `admin`, `staff` on `tenant_users.role`; Policies check a code-defined permission map:
  | Permission | owner | admin | staff |
  |---|---|---|---|
  | products, inventory, orders, customers (CRUD) | ✓ | ✓ | ✓ |
  | refunds, order delete/cancel paid | ✓ | ✓ | – |
  | store settings, themes, pages, shipping | ✓ | ✓ | – |
  | domains, payment/courier credentials, staff management | ✓ | ✓ (not owner role) | – |
  | billing/subscription, delete tenant, transfer ownership | ✓ | – | – |
  Phase 8: custom roles with granular permissions (Figma Staff & roles 89:26676) via `roles`/`role_permissions`.
- **Platform admins:** `users.platform_role`; separate login issues `admin`-ability tokens; TOTP mandatory.

## Consequences
+ Simple, matches contract, works cross-subdomain without cookie config in Phase 1.
− Bearer tokens in JS-accessible storage are exposed to XSS → strict CSP now, cookie migration in Phase 4.

## Alternatives
- Cookie SPA auth from day one (better XSS posture, more CORS/CSRF setup) — deferred to Phase 4.
- OAuth2 (Passport) — unnecessary until public API (Phase 8 API keys use hashed keys, not OAuth).

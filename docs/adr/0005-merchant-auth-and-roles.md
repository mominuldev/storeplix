# ADR 0005 — Merchant authentication and roles

Status: Accepted · Date: 2026-11-21

## Context
A user may own one tenant and be staff in another. SPAs live on `app.`/`admin.` subdomains; API on `api.`.

## Decision
- **Auth:** Laravel Sanctum personal access tokens (Bearer) for Phase 1–3 as fixed by AGENT-CONTRACTS. Tokens expire
  after 30 days, abilities `merchant` or `admin`, revoked on logout/password change. SPA keeps token in memory +
  `sessionStorage`. **Phase 4:** migrate SPAs to Sanctum cookie-based SPA auth (httpOnly, `SameSite=Lax`, CSRF cookie)
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

# CLAUDE.md — Store Plix

Multi-tenant e-commerce website-builder SaaS: "Create your online store, connect your domain, and start
selling within minutes." Primary market Bangladesh (BDT, bKash, SSLCommerz, Pathao/Steadfast/RedX).
Product brief: `docs/PRODUCT-BLUEPRINT.md`. Binding inter-app contract: `docs/development/AGENT-CONTRACTS.md`.

**Before modifying a module, read the relevant `docs/architecture/*.md` file and any ADR it cites.**

## Stack
| Area | Tech |
|---|---|
| `apps/api` | Laravel (latest stable), PHP 8.4, REST `/api/v1`, Sanctum, Queues (Redis/Horizon), PostgreSQL 16+, Redis |
| `apps/merchant-dashboard` | React + Vite + TS + Tailwind + React Router + TanStack Query + React Hook Form + Zod |
| `apps/super-admin` | Same stack as merchant dashboard; separate permissions/navigation |
| `apps/storefront` | Next.js App Router, TS, Server Components, Tailwind; tenant resolved from hostname |
| `packages/*` | `@storeplix/ui`, `@storeplix/types`, `@storeplix/api-client`, `@storeplix/config` |
| Infra | Docker, Nginx, S3-compatible storage, Cloudflare (DNS/CDN/SSL for SaaS), GitHub Actions |

Ports: api 8000 · merchant 5173 · super-admin 5174 · storefront 3000 · postgres 5432 · redis 6379.

## Repo layout
```
apps/api                 Laravel API (only app that touches the database)
apps/merchant-dashboard  Merchant SPA
apps/super-admin         Platform admin SPA
apps/storefront          Shared Next.js storefront for ALL merchants
packages/types           API contract types (mirror of Laravel API Resources)
packages/api-client      Typed fetch client used by both SPAs
packages/ui              Shared React components built from Figma tokens
packages/config          Shared tsconfig/eslint/tailwind presets
infrastructure/          docker, nginx, deployment, monitoring
docs/                    architecture, adr, api (openapi.yaml), development, design
```

## Architectural rules (non-negotiable)
1. **Tenant isolation is enforced by code, not memory.** Every tenant-owned Eloquent model uses the
   `BelongsToTenant` trait (global scope + auto-fill `tenant_id`). Tenant is set once per request by
   middleware into the `TenantContext` singleton. Never call `withoutGlobalScope(TenantScope::class)`
   outside `app/Support/Tenancy/` or super-admin code paths explicitly marked `// cross-tenant: reason`.
   See `docs/architecture/MULTI-TENANCY.md`.
2. Merchant API: tenant comes from `X-Tenant-Id`, validated against `tenant_users` membership.
   Storefront API: tenant comes from `X-Storefront-Host`, validated against `store_domains`
   (plus `X-Storefront-Key`). Never trust `Host`/`X-Forwarded-Host` without that lookup.
3. Queued jobs that touch tenant data implement `TenantAware` and run through the tenant job middleware.
   Cache keys, storage paths and rate-limit keys are tenant-prefixed via helpers — never hand-built.
4. **No cross-app imports.** Apps import only from `packages/*`. The storefront and SPAs never touch the
   DB; they talk to `apps/api` over HTTP.
5. API envelope everywhere: success `{ "data": ..., "meta"?: ... }`, error
   `{ "error": { "code", "message", "details"? } }`. See `docs/api/API-CONVENTIONS.md`.
6. Changing a response shape = update the Laravel API Resource, `packages/types`, and `docs/api/openapi.yaml`
   in the same PR.
7. No merchant-provided JavaScript ever executes. Theme config is schema-validated JSON only.
8. Payments: never trust redirects; order is paid only after server-side verification/webhook.
9. Money is integer minor units (`*_amount` bigint) + ISO 4217 `currency`. Never floats.

## Conventions
- **IDs:** ULID strings (26 chars) everywhere, generated in the app (`HasUlids`).
- **JSON:** snake_case keys. Exception: the contents of theme config documents (`ThemeConfig.settings`)
  keep camelCase and are passed through untransformed.
- **API:** plural resource nouns, kebab-case path segments, `/api/v1/merchant/...` for merchant,
  `/api/v1/storefront/...` for public render data, `/api/v1/admin/...` for super admin.
  Error `code` is snake_case and stable (e.g. `validation_failed`, `store_not_found`).
- **DB:** snake_case plural tables, `tenant_id` first column after `id` on tenant-owned tables, composite
  indexes lead with `tenant_id`, `timestamptz` for all timestamps, soft deletes only where listed in
  `docs/architecture/DATABASE-DESIGN.md`.
- **PHP:** PSR-12 + Laravel Pint; strict types; Form Requests for validation, Policies for authorization,
  API Resources for output, Actions/Services for business logic (thin controllers).
- **TS:** strict mode, no `any`, Zod at trust boundaries, TanStack Query for server state.
- Full rules: `docs/development/CODING-STANDARDS.md`.

## Security rules
- Every merchant endpoint: `auth:sanctum` + `tenant` middleware + Policy check. No exceptions.
- Super-admin endpoints live under `/api/v1/admin`, require `platform_role`, and are never reachable
  with a merchant token.
- Validate every input with Form Requests; never `$request->all()` into `create()`/`fill()`.
- No raw SQL with interpolated values. Escape all output; no `dangerouslySetInnerHTML` except sanitized
  rich text via the shared sanitizer.
- Uploads: allowlisted MIME (sniffed), size caps, stored under tenant prefix, served from CDN, never executed.
- Webhooks: verify signatures/IPs per provider; idempotent processing.
- Secrets only in env/secret manager; never committed, never logged.
- Write an `audit_logs` row for security-relevant merchant/admin actions.
- Full threat model: `docs/architecture/SECURITY.md`.

## Testing requirements
- API: Pest feature tests for every endpoint (happy path, validation, authz, **cross-tenant access
  returns 404**). Use the `assertTenantIsolation` helper for every new tenant-owned resource.
- Unit tests for services with business logic (pricing, stock, payment state machines).
- Frontend: Vitest + Testing Library for components/hooks; Playwright E2E for critical flows (QA owns).
- PR must pass: lint, typecheck, unit/feature tests, build. Coverage must not drop on touched modules.

## Git workflow
- Branch per feature off `main`: `feat/<area>-<short>`, `fix/...`, `chore/...`, `docs/...`.
- Conventional Commits (`feat(api): add product variants`). Small PRs (< ~500 changed lines when possible).
- PR requires green CI (lint, typecheck, tests, build) and one review. Squash merge.
- Migrations are forward-only once merged to `main`; never edit a merged migration.

## Phase rules
- Work only on the current phase in `docs/development/DEVELOPMENT-ROADMAP.md`. Do not build later-phase
  features "while you're there"; record them in the roadmap or `docs/architecture/OPEN-QUESTIONS.md`.
- A task is done only when it meets the Definition of Done: backend works, validation, authorization,
  tenant isolation tested, frontend integrated, responsive verified, tests pass, errors handled, docs updated.
- Multi-agent work: respect file ownership in `AGENT-CONTRACTS.md`. Propose contract changes; don't diverge.

## UI and Figma
- **UI must follow Figma — see `docs/design/FIGMA-INDEX.md`.** Do not invent visual styles.
- Use the Figma MCP with the `figma:figma-design-to-code` skill (load it before `get_design_context`).
- **Query section/frame ids, never whole pages** — page metadata is multiple MB.
- Tokens (color, type, spacing, radius, elevation) live in `packages/config` Tailwind preset; components
  in `packages/ui`. Use tokens, never raw hex values in app code.
- Every screen ships its empty/loading/error states (Figma section `148:34032`).

## Key docs
`docs/architecture/` SYSTEM-ARCHITECTURE · MULTI-TENANCY · DATABASE-DESIGN · STOREFRONT-ENGINE ·
DOMAIN-INFRASTRUCTURE · SECURITY · OPEN-QUESTIONS — `docs/adr/` decisions 0001–0010 —
`docs/api/` API-CONVENTIONS, openapi.yaml — `docs/development/` CODING-STANDARDS, DEVELOPMENT-ROADMAP.

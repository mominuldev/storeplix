# Phase 1 agent contracts (binding for all agents)

## File ownership — never edit outside your area
| Agent | Owns |
|---|---|
| Architecture | `CLAUDE.md`, `docs/**` (except `docs/design/FIGMA-INDEX.md`, this file) |
| Laravel | `apps/api/**` |
| React | `apps/merchant-dashboard/**`, `apps/super-admin/**`, `packages/ui/**`, `packages/config/**`, `packages/api-client/**` |
| Next.js | `apps/storefront/**` |
| QA | `.github/**`, `docker-compose.yml`, `infrastructure/**`, `tests/e2e/**`, `docs/development/TESTING.md`, review reports in `docs/reviews/**` |
`packages/types` and root `package.json`/`pnpm-workspace.yaml` are orchestrator-owned; propose changes in your final report instead of editing.

## Ports
api `8000` · merchant-dashboard `5173` · super-admin `5174` · storefront `3000` · postgres `5432` · redis `6379`

## Package names
`@storeplix/ui` `@storeplix/types` `@storeplix/api-client` `@storeplix/config` `@storeplix/merchant-dashboard` `@storeplix/super-admin` `@storeplix/storefront`

## API contract (Phase 1)
Envelope: success `{ "data": ..., "meta"?: ... }`; error `{ "error": { "code", "message", "details"? } }` with proper HTTP status. IDs are ULID strings. snake_case JSON.
- `GET  /api/v1/health` → `{data:{status:"ok",version,time}}`
- `POST /api/v1/auth/register` {name,email,password,password_confirmation,phone?} → 201 `{data:{token,user}}`
- `POST /api/v1/auth/login` {email,password} → `{data:{token,user}}`
- `POST /api/v1/auth/logout` (Bearer) → 204
- `GET  /api/v1/auth/me` (Bearer) → `{data:User}`
- `GET  /api/v1/storefront/config` — tenant resolved server-side from header `X-Storefront-Host: <normalized host>` validated against `store_domains`; also requires header `X-Storefront-Key` = shared secret `STOREFRONT_API_KEY` (server-to-server only). Unknown host → 404 `{error:{code:"store_not_found"}}`. Returns `StorefrontConfig`.
Merchant auth: Sanctum personal access tokens (Bearer) for the SPA in Phase 1 (ADR may revisit cookie-based SPA auth).
Tenant context for merchant APIs: header `X-Tenant-Id` (ULID) validated against the user's `tenant_users` membership.

## Dev seed
`php artisan db:seed` creates user `demo@storeplix.test` / `password`, tenant "Demo", store slug `demo`, domains `demo.storeplix.test` and `demo.localhost`.
Base platform domain env: `PLATFORM_DOMAIN=storeplix.test` (prod `storeplix.com`).

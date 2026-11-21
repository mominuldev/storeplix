# Testing Strategy

Owner: QA agent. Applies to every app in the monorepo. Tenant isolation is the #1 risk in a
shared-DB/shared-schema SaaS, so it has its own **required** CI gate.

## 1. Test pyramid

| Layer | Tooling | Location | Runs in CI |
|---|---|---|---|
| Unit (PHP) | PHPUnit / Pest via `php artisan test` | `apps/api/tests/Unit` | yes (sqlite) |
| Feature / HTTP (PHP) | Laravel HTTP tests, `RefreshDatabase` | `apps/api/tests/Feature` | yes (sqlite) |
| **Tenant isolation (PHP)** | Feature tests in group `tenancy` | `apps/api/tests/Feature/**` | yes, **required**, sqlite **and** Postgres |
| Migrations | `migrate:fresh --seed`, rollback, re-migrate | — | yes (Postgres 16 service) |
| Unit / component (TS) | Vitest + Testing Library | `apps/*/src/**/*.test.ts(x)`, `packages/*/src` | yes |
| Type contracts | `tsc --noEmit` against `@storeplix/types` | all TS packages | yes |
| Bundle secret scan | grep build output for `STOREFRONT_API_KEY` | `.next/static`, `dist/` | yes |
| E2E smoke | Playwright | `tests/e2e` | manual (`e2e.yml`) until stable |

Rough ratio target: many unit tests, a solid layer of API feature tests (every endpoint has at least
happy path + validation + authz + cross-tenant case), a handful of E2E smoke flows.

## 2. Commands

```bash
# API
cd apps/api && php artisan test                      # full suite
cd apps/api && php artisan test --group=tenancy      # tenant-isolation gate only
cd apps/api && vendor/bin/pint --test                # code style

# JS workspace (root)
pnpm install
pnpm -r --if-present run typecheck
pnpm -r --if-present run lint
pnpm -r --if-present run test
pnpm -r --if-present run build

# E2E (stack must be running + seeded; see docker-compose.yml header)
cd tests/e2e && pnpm install --ignore-workspace && pnpm exec playwright install chromium && pnpm test
```

## 3. The `tenancy` test group (required)

Every test that proves tenant isolation **must** be tagged with the PHPUnit group `tenancy`:

```php
use PHPUnit\Framework\Attributes\Group;

#[Group('tenancy')]
class CrossTenantProductAccessTest extends TestCase { ... }
```

(Pest: `->group('tenancy')`.) CI step **`tenant-isolation`** runs `php artisan test --group=tenancy`
and **fails if the group contains zero tests**. The group also runs against Postgres 16 in the
`api-postgres` job. Removing a test from this group requires QA review.

Standard fixture: two tenants (A, B), each with a user, store, domain and at least one record of every
tenant-owned model. Each test acts as A and attempts to touch B.

## 4. Required cross-tenant / security test catalogue

IDs are referenced from PRs and review reports. "Expect" = the assertion the test must make.
Phase column = when the test becomes mandatory (the feature must exist first).

| ID | Scenario | Expect | Phase |
|---|---|---|---|
| T-01 | Cross-tenant **read**: A's token + A's `X-Tenant-Id` requests B's resource by ID (show/list/search/export) | 404 (not 403 — no existence oracle); B's rows never in list payloads | 1+ |
| T-02 | Cross-tenant **write**: A updates/deletes B's resource by ID | 404; B's row unchanged in DB | 1+ |
| T-03 | Mass-assignment of `tenant_id`: A creates/updates with `tenant_id`=B in body | `tenant_id` ignored; row belongs to A | 1+ |
| T-04 | **`X-Tenant-Id` spoofing**: A's token with `X-Tenant-Id`=B (not a member) | 403 `tenant_forbidden`; no data | 1 |
| T-05 | Missing / malformed `X-Tenant-Id` (non-ULID, unknown) on tenant routes | 400/403/404 envelope; never falls back to "first tenant" | 1 |
| T-06 | Global scope: a model query with no tenant context bound | throws / returns nothing — never all tenants | 1 |
| T-07 | Relationship leakage: A attaches B's category/variant/customer ID to A's product/order | 422 validation (`exists` rule scoped to tenant) | 3+ |
| T-08 | **Host header spoofing** on storefront: `X-Storefront-Host` / `Host` / `X-Forwarded-Host` of unregistered, suspended or `pending_verification` domain | 404 `store_not_found` | 1 |
| T-09 | Host normalization: `DEMO.localhost`, trailing dot, port suffix, IDN/punycode, `demo.localhost.evil.com` | resolves only exact normalized registered host | 1 |
| T-10 | **Storefront key**: `/storefront/*` with missing / wrong / empty `X-Storefront-Key`; timing-safe compare (`hash_equals`) | 401/403, no tenant data; key absent from logs | 1 |
| T-11 | Storefront payload minimality: `/storefront/config` contains only `StorefrontConfig` fields (no tenant_id, emails, domain verification tokens, settings secrets) | exact key whitelist | 1 |
| T-12 | Merchant token on storefront endpoints and storefront key on merchant endpoints | rejected | 1 |
| T-13 | **Queue tenant leakage**: job dispatched under tenant A runs with A's context; a job whose payload references B's model while carrying A's context fails; tenant context is reset between jobs on the same worker | no B access; context cleared | 2+ |
| T-14 | **Cache key collisions**: two tenants with same slug/product handle/config key → distinct cache entries; flushing A's cache leaves B intact | keys prefixed `tenant:{id}:` | 1+ |
| T-15 | Domain cache poisoning: domain moved/removed → host→tenant cache invalidated | old tenant not served | 6 |
| T-16 | **Payment manipulation**: client-supplied amount/currency/status ignored; redirect "success" without gateway verification does not mark paid; replayed transaction id rejected; order of tenant B cannot be paid via A's checkout | server-side amount; status only via verify/webhook | 5 |
| T-17 | **Webhook manipulation**: missing/invalid signature, stale timestamp, replayed event id, webhook for B's order to A's endpoint | 401/409/ignored; idempotent | 5 |
| T-18 | **Domain-ownership bypass**: activate domain without DNS TXT match; claim a domain already verified by another tenant; re-use another tenant's verification token; claim `*.storeplix.com` platform subdomain as custom domain | rejected; uniqueness enforced at DB level | 6 |
| T-19 | Slug squatting / reserved slugs (`www`, `api`, `admin`, `app`, `mail`) | 422 | 2 |
| T-20 | RBAC: staff role without permission performs owner-only action within own tenant | 403 | 2+ |
| T-21 | Super-admin endpoints with merchant token | 403 | 8 |
| T-22 | Auth: login rate limit, token revoked on logout, password not in any response, `/auth/me` without token → 401 envelope | as stated | 1 |
| T-23 | File uploads: path traversal, SVG/HTML upload, another tenant's storage path | rejected / served from tenant-scoped prefix | 4+ |
| T-24 | Audit log entries are written with the correct tenant and are not readable cross-tenant | — | 2+ |

Non-PHP checks (CI or review):

- **S-01** `STOREFRONT_API_KEY` value and name never appear in `.next/static` or Vite `dist/` (CI step).
- **S-02** No `NEXT_PUBLIC_*`/`VITE_*` variable holds a secret.
- **S-03** CORS: API allows only configured dashboard origins; `/storefront/*` is not callable from browsers with credentials.
- **S-04** Storefront never forwards a browser-supplied `X-Storefront-*` header (nginx strips them).

## 5. Definition of Done (testing checks)

A feature PR is done only when:

1. Happy path, validation (422 envelope) and authorization (401/403) feature tests exist for every new endpoint.
2. Every new tenant-owned model uses the tenant global scope/trait **and** has T-01/T-02/T-03 tests in group `tenancy`.
3. Any new cache key, job, event listener or scheduled command touching tenant data has T-13/T-14 coverage.
4. Response shape matches `packages/types` (resource test asserts exact JSON keys); types updated in the same PR.
5. `php artisan test`, `pint --test`, `pnpm -r typecheck/lint/test/build` pass locally and in CI; `tenant-isolation` passes.
6. Migrations apply on Postgres from scratch and roll back.
7. No secrets in client bundles (S-01) and no new public env var holds a secret.
8. UI changes: component tests for forms (Zod validation, error envelope rendering); responsive check at 375 / 768 / 1280 px.
9. Docs updated (API conventions / architecture) and a reviewer has signed off.

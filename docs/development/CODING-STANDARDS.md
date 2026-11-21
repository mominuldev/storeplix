# Coding Standards

Binding for all apps. CI enforces what can be enforced; reviewers enforce the rest.

## 1. General
- Readable over clever. Functions do one thing; files < ~300 lines; no dead code or commented-out code.
- No secrets, tokens, or PII in code, fixtures, logs, or commit messages.
- Every behaviour change ships with tests and doc updates (architecture doc / ADR / openapi.yaml as relevant).
- English identifiers and comments. Comments explain *why*, not *what*.

## 2. PHP / Laravel (`apps/api`)
- PHP 8.4, `declare(strict_types=1);` in every file, typed properties/params/returns, `final` classes by default,
  readonly DTOs. Pint (Laravel preset) + Larastan level 8 (`phpstan.neon`) in CI.
- **Layering** (module folders under `app/Domain/<Module>` — see SYSTEM-ARCHITECTURE §5):
  - Controller: thin — authorize, call one Action, return Resource. No queries beyond route binding.
  - Form Request: all validation; `authorize()` delegates to Policy; tenant-scoped `exists` via `TenantRule`.
  - Action (`CreateProduct`, `PlaceOrder`): one public `handle()`/`__invoke`, wraps DB transaction, emits events.
  - Policy per model; abilities named `viewAny, view, create, update, delete` + domain verbs (`refund`, `publish`).
  - API Resource for every response; never return models/arrays directly. Resources must match `packages/types`.
  - Events past tense (`OrderPlaced`), listeners queued when doing I/O.
  - Integrations behind interfaces in `app/Integrations/*` with fake drivers for tests.
- Naming: models singular (`ProductVariant`), tables plural snake (`product_variants`), enums `OrderStatus` backed by
  string, jobs verb-noun (`VerifyDomainJob`), routes named `merchant.products.index`.
- Eloquent: `$fillable` explicit (never `$guarded = []`), no `tenant_id` in fillable, eager-load explicitly,
  `Model::preventLazyLoading()` and `preventSilentlyDiscardingAttributes()` in non-prod.
- Money via `App\Support\Money` value object (int minor + currency); arithmetic only through it.
- Dates: `CarbonImmutable`, stored UTC, presented in tenant timezone by clients.
- Config: `env()` only inside `config/*.php`.
- Errors: throw domain exceptions implementing `HasErrorCode`; handler renders the envelope.
- Migrations: one concern per file, composite tenant FKs (DATABASE-DESIGN §7), no model usage inside migrations.

## 3. Testing (API)
- Pest. `tests/Feature/<Module>/<Endpoint>Test.php`, `tests/Unit/...`, `tests/Arch/`.
- Per endpoint: success, validation (422 shape), unauthenticated (401), unauthorized role (403), cross-tenant (404),
  plan gate (402) where relevant.
- Factories for every model, tenant-aware (`Product::factory()->for($tenant)`). No reliance on seed data.
- External HTTP faked (`Http::fake`, recorded fixtures under `tests/Fixtures/<provider>`). No network in CI.
- Database: `RefreshDatabase` on Postgres (never SQLite — RLS/partial indexes/jsonb differ).

## 4. TypeScript (all JS apps & packages)
- TS `strict`, `noUncheckedIndexedAccess`, no `any` (use `unknown` + Zod), no non-null `!` without comment.
- ESLint (shared config in `@storeplix/config`) + Prettier; `import/no-restricted-paths` forbids cross-app imports.
- API types come from `@storeplix/types`; never redeclare response shapes. HTTP only through `@storeplix/api-client`
  (SPAs) or `src/lib/api.ts` (storefront, server-only).
- Zod at every trust boundary: env vars, form input, URL params, theme config.
- Naming: components `PascalCase.tsx`, hooks `useThing.ts`, utilities `camelCase.ts`, constants `SCREAMING_SNAKE`.
  One component per file; co-locate `Component.test.tsx`.

## 5. React SPAs (merchant-dashboard, super-admin)
- Feature folders: `src/features/<module>/{api,components,routes,hooks,schemas}`; shared UI from `@storeplix/ui`.
- Server state: TanStack Query only (query keys `[tenantId, 'products', params]` — tenant id always first so switching
  tenant never shows stale data); no server data in global client stores.
- Forms: React Hook Form + Zod resolver; map API 422 `details` to field errors via shared helper.
- Routing: React Router data routers, lazy-loaded route modules, route-level error boundaries.
- Every data view implements loading, empty, error states (Figma `148:34032`).
- Styling: Tailwind with `@storeplix/config` preset (Figma tokens). No raw hex, no arbitrary values unless the Figma spec
  requires a one-off (comment with Figma node id).
- Accessibility: semantic elements, labelled inputs, focus visible, keyboard reachable dialogs, WCAG AA contrast.
- i18n-ready: user-facing strings through `t()` (English first; Bangla planned — OPEN-QUESTIONS Q8).

## 6. Next.js storefront
- Server Components by default; `'use client'` only for interactivity; mark server-only modules with `import 'server-only'`.
- All fetches through `lib/api.ts` with tags per STOREFRONT-ENGINE §5. No `cache: 'force-cache'` without tags.
- Never read secrets in client components; env validated at build.
- Themes: no network calls from section components except via provided `ctx` loaders.
- `next/image` with CDN loader; no layout shift (explicit sizes).

## 7. Design fidelity
UI follows Figma (`docs/design/FIGMA-INDEX.md`). Before building a screen, query the specific section/frame id with the
Figma MCP (load `figma:figma-design-to-code`), never whole pages. PR description links the Figma node ids implemented.

## 8. Git & PRs
- Branch `feat|fix|chore|docs|refactor/<area>-<short>`; Conventional Commits with scope (`api`, `merchant`, `admin`,
  `storefront`, `ui`, `types`, `docs`, `infra`).
- PR template: what/why, Figma nodes, screenshots (desktop + mobile) for UI, migration notes, test evidence.
- CI gates: lint, typecheck, tests (API + frontend), build, `composer audit`/`pnpm audit`, gitleaks. All green to merge.
- Squash merge; delete branch. No force-push to `main`.

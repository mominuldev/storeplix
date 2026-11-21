# Store Plix API (`apps/api`)

Laravel 13 · PHP 8.4 · Sanctum (personal access tokens) · PostgreSQL · Redis. REST under `/api/v1`.
Contract: `docs/development/AGENT-CONTRACTS.md`; JSON shapes mirror `packages/types/src/index.ts`.

## Run locally

```bash
cd apps/api
composer install
cp .env.example .env && php artisan key:generate   # Postgres + Redis by default
createdb storeplix                                   # or point DB_* at your server
php artisan migrate --seed                           # demo@storeplix.test / password
php artisan serve --port=8000
php artisan storage:link                             # media served at APP_URL/storage
php artisan queue:work --queue=default,media         # mails, media variants, storefront revalidation
php artisan schedule:work                            # daily sanctum:prune-expired --hours=24
```

Tests need no external services (SQLite in-memory, array cache, sync queue — see `phpunit.xml`):

```bash
php artisan test                    # or: vendor/bin/phpunit
php artisan test --group=tenancy    # cross-tenant / storefront / preview isolation suite
vendor/bin/pint         # code style
```

Docker: `Dockerfile` — default target `app` = php-fpm on :9000 (put Nginx in front);
`--target dev` = `php artisan serve` on :8000.

## Structure — domain modules

Code is grouped by bounded context under `app/Domain/<Module>` (not by technical layer), each owning
its models, HTTP layer (controllers, FormRequests, API Resources, middleware), services, policies:

| Module | Contents |
|---|---|
| `Tenancy` | `TenantContext`, `BelongsToTenant` + `TenantScope`, `tenant` middleware, queue tenancy, `TenantCache`, `AuditLogger`, `Tenant`/`TenantUser`/`AuditLog` |
| `Identity` | `User`, auth (register/login/reset), account (profile/password), phone OTP (`Otp/OtpService`), `PasswordRules` |
| `Staff` | invitations (`StaffInvitation`, hashed tokens, `StaffInvitationMail`), members, `StaffPolicy`, `SeatCounter` |
| `Media` | `Media`, `TenantStorage` (only path builder), `ImageInspector` (finfo + getimagesize), `ProcessMedia` job, `MediaPolicy` |
| `Billing` | `Plan`/`Subscription`, `FeatureGate` (only plan check), `Feature`/`Limit` enums, trial listener, `subscriptions:end-trials` |
| `Audit` | `GET /audit-logs` (writer is `Tenancy\Support\AuditLogger`) |
| `Sms` | `SmsGateway` + drivers `revesms` / `log` / `fake`, `SendSms` job, `sms_messages` |
| `Stores` | `Store`/`StoreDomain`/`StoreSetting`, `StoreProvisioner`, settings (`StoreSettingsUpdater`), `StorefrontResolver` + `HostNormalizer`, `storefront` middleware, `StorePolicy`, cache observers, `Revalidation/` (observer + `RevalidateStorefront`) |
| `Shared` | error envelope renderer, `ApiException`, pagination envelope, health, `Phone` / `PhoneRule` |

Each module may register its own service provider (`bootstrap/providers.php`). Future modules
(Products, Orders, Customers, Domains, Billing…) follow the same layout.

## Multi-tenancy rules (enforced in code, not by convention)

- **Shared schema, `tenant_id` on every tenant-owned row.** ULID primary keys everywhere.
- **`TenantContext`** (scoped singleton, reset per request/job) holds the current tenant + role.
- **`BelongsToTenant`** trait on tenant-owned models: global scope filters by current tenant;
  `tenant_id` auto-filled on create; creating a row for another tenant or changing `tenant_id`
  throws `TenantMismatchException`; **querying with no tenant context throws
  `MissingTenantContextException`**. Platform/system code opts out explicitly with
  `Model::withoutTenancy()`.
- **`tenant` middleware** (after `auth:sanctum`): `X-Tenant-Id` must be a tenant the user is a member
  of (`tenant_users`). Missing → 400 `tenant_required`; unknown/foreign/malformed → identical 403
  `tenant_forbidden` (no enumeration). It runs before route-model binding, so `{store}` bindings are
  tenant-scoped (foreign ids → 404).
- **Policies** re-check `tenant_id` against the context (defence in depth) and roles (owner/admin/staff).
- **Storefront** (`storefront` middleware): `X-Storefront-Key` compared with `hash_equals` against
  `STOREFRONT_API_KEY` (fails closed if unset); tenant resolved **only** from `X-Storefront-Host`,
  normalized (lowercase, strip port and trailing dot, DNS-label validation) and matched to an
  **active** `store_domains` row of a non-suspended store. `Host`/`X-Forwarded-Host` are ignored.
  Lookups cached under the tenant-neutral key `domain:{host}` (1h positive / 60s negative);
  observers on `StoreDomain`/`Store` invalidate on change.
- **Queues**: every queued payload gets `tenant_id` of the dispatching context
  (`Queue::createPayloadUsing`). Jobs using the `TenantAware` trait restore it via the
  `RestoreTenantContext` job middleware; a tenant-aware job without a tenant fails. Use
  `->forTenant($id)` to pin explicitly. Note: `Job::dispatch()` returns a `PendingDispatch` that is
  queued on destruct — dispatch as a statement inside `TenantContext::run()`, don't return it.
- **Cache**: `TenantCache` prefixes keys `tenant:{id}:…` and throws without context.
- **Audit**: `AuditLogger` writes `audit_logs` (store.created, auth.registered, auth.login).

## Endpoints (Phase 1 / 1.1)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/health` | – | `{data:{status,version,time}}` |
| POST | `/api/v1/auth/register` | – (throttled) | creates user + tenant (owner) → 201 `{data:{token,expires_at,user}}` |
| POST | `/api/v1/auth/login` | – (throttled) | `{data:{token,expires_at,user}}`; bad credentials → 422 `validation_failed` (details.email) |
| POST | `/api/v1/auth/forgot-password` | – (throttled) | `{email}` → always 202 (no enumeration); queues `ResetPasswordMail` |
| POST | `/api/v1/auth/logout` | Bearer | 204, revokes current token |
| GET | `/api/v1/auth/me` | Bearer | `User` + additive `tenants:[{id,name,role}]` |
| GET | `/api/v1/stores` | Bearer + `X-Tenant-Id` | paginated `{data:Store[],meta}` (`per_page` ≤ 100) |
| POST | `/api/v1/stores` | Bearer + `X-Tenant-Id` (owner/admin) | `{name, slug, business_categories?, name_bn?, timezone?, country?=BD, currency?=BDT}` → 201 `Store`; creates `{slug}.{PLATFORM_DOMAIN}` (active, primary) + default theme; tenant already has a store → 409 `store_limit_reached` |
| GET | `/api/v1/stores/{id}` | Bearer + `X-Tenant-Id` | 404 for other tenants' stores |
| POST | `/api/v1/stores/{id}/preview-token` | Bearer + `X-Tenant-Id` (any member) | 201 `PreviewToken {token,url,expires_at}`; 60 min, bound to the store; `url` = `https://{primary_domain}/?preview=…` (`http://…:3000` when `APP_ENV=local`) |
| GET | `/api/v1/storefront/config` | `X-Storefront-Key` + `X-Storefront-Host` | `StorefrontConfig` incl. `store.status` (`active`/`draft`) and `preview`; optional `X-Storefront-Preview`; 401 `invalid_storefront_key`, 400 `storefront_host_required`, 404 `store_not_found` |

Errors always: `{ "error": { "code", "message", "details"? } }` (`validation_failed`, `unauthenticated`,
`forbidden`, `not_found`, `too_many_requests`, `tenant_required`, `tenant_forbidden`, …).
Timestamps are ISO-8601 UTC (`2026-01-01T12:00:00Z`).

## Phase 2 (docs/development/PHASE-2-CONTRACT.md)

| Method | Path | Auth / roles | Notes |
|---|---|---|---|
| POST | `/auth/reset-password` | public, throttled | broker token: hashed, 60 min, single use, replaces previous; revokes all tokens; 422 `invalid_reset_token` |
| PATCH | `/auth/me` | B | name/email/phone; email change needs `current_password` |
| PUT | `/auth/password` | B | returns a NEW `AuthToken`; all other tokens revoked |
| POST | `/auth/otp/send` | public (B for `verify_phone`) | 202 `{expires_in, resend_in, dev_otp?}`; 429 `otp_rate_limited` |
| POST | `/auth/phone/verify` · `/auth/login/otp` · `/auth/reset-password/otp` | B · public · public | 422 `invalid_otp` |
| GET/POST/DELETE | `/staff`, `/staff/invitations[/{id}[/resend]]`, `/staff/{member}` | B+T, O A (leave = any role on self) | 409 `last_owner` / `already_member` / `invitation_pending` / `invitation_not_pending`; 403 `cannot_change_own_role`; 402 `plan_limit_reached` |
| GET/POST | `/invitations/{token}[/accept]` | public or B | 404 `invitation_invalid`; 409 `login_required`; 403 `invitation_email_mismatch` |
| GET/PATCH | `/stores/{store}/settings` | B+T (PATCH O A) | partial update, exact contract validation; colours → `theme.settings` |
| POST/GET/DELETE | `/media[/{media}]` | B+T, all (delete logo/favicon O A) | MIME sniffed from bytes; 409 `media_in_use` |
| GET | `/plans` · `/subscription` · `/features` | public · O A · all | |
| GET | `/audit-logs` | B+T, O A | `filter[action|actor_id|subject_type|subject_id|created_at][gte|lte]`, unknown filter → 422 |

- **Roles** come from `Tenancy\Authorization\Permission` (ADR 0005 matrix) and are enforced by Policies.
- **Media**: originals re-encoded (EXIF/polyglot stripped) and variants rendered by `ProcessMedia` (queue `media`).
  Variants larger than the source are skipped (never upscaled) — a 200 px favicon gets no `icon_512`.
- **Trial**: `TenantCreated` (sync, same transaction) → 14-day Starter trial; `subscriptions:end-trials` daily → Free.
- **Revalidation**: changes to store status/name/slug/currency/country, settings, or domains dispatch
  `RevalidateStorefront` after commit (unique per store for 2 s; retries 5/30/120/600 s; 401/422 fail, 503 disabled → stop).
- **Auth rate limits** (QA M-3; per identifier + a looser per-IP ceiling for carrier-NAT IPs):

  | Route(s) | Per identifier | Per IP |
  |---|---|---|
  | `POST /auth/login` | 5/min per email+IP | 60/min |
  | `POST /auth/register` | – | 10/min |
  | `POST /auth/forgot-password`, `/auth/reset-password` | 5/min per email (or phone) | 30/min |
  | `GET /invitations/{token}`, `POST …/accept` | 10/min per token | 60/min |
  | OTP endpoints | Addendum A (cooldown 60 s, 5/phone/h, 20/IP/h) | 30/min |
- **Login timing** (QA M-1): unknown emails still run a password check against a dummy hash made with the
  current hasher settings (`CredentialVerifier`), so they take as long as a wrong password.
- **429s** always carry `error.retry_after` (int seconds) and a `Retry-After` header.
- **Phone OTP (Addendum A)**: account phones are BD mobiles stored as `8801XXXXXXXXX` (unique). Codes: 6 digits,
  HMAC-stored, 5 min, 5 attempts, 60 s resend cooldown, 5/phone/h, 20/IP/h. `dev_otp` is returned **only** when
  `APP_ENV=local` and `SMS_DRIVER=log`. REVE credentials only travel in the POST body and are never logged.
- **Hashing**: argon2id (`HASH_DRIVER`). Old bcrypt hashes don't verify (dev DBs: `migrate:fresh --seed`).

## Phase 1.1 decisions

- **D1 one store per tenant** (revised): DB `UNIQUE(stores.tenant_id)`; slug globally unique. A second
  `POST /stores` → 409 `store_limit_reached` (checked before validation, and the unique-constraint
  violation is caught for races). A *user* may belong to several tenants and selects one via
  `X-Tenant-Id`. `/stores/{store}/…` paths and `store_id` columns stay (future multi-store option);
  `{store}` bindings are tenant-scoped, so another tenant's store id → 404.
- **D2 draft stores / preview**: new stores start as `draft`. Storefront config resolves `draft` and
  `active` stores (`store.status`), suspended → 404. Preview tokens are stateless:
  `base64url({s:store_id,e:expiry}).base64url(HMAC-SHA256)` keyed by a purpose-derived APP_KEY
  (`App\Domain\Stores\Preview\PreviewTokenService`; rotating APP_KEY invalidates them). `preview:true`
  only if the token is authentic, unexpired and issued for the resolved store; anything else silently
  degrades to `preview:false`. Preview responses carry `Cache-Control: private, no-store`; the
  `domain:{host}` cache only ever stores `{tenant_id, store_id}`, never preview state.
- **D3 token expiry**: `sanctum.expiration = SANCTUM_EXPIRATION` (minutes, default 10080); each token
  also stores `expires_at`. Expired token → 401 `unauthenticated`. Scheduler prunes daily.

## Environment

`PLATFORM_DOMAIN` (storeplix.test), `STOREFRONT_API_KEY`, `CORS_ALLOWED_ORIGINS`
(default `http://localhost:5173,http://localhost:5174`), `APP_VERSION`, `DOMAIN_CACHE_TTL`,
`DOMAIN_NEGATIVE_CACHE_TTL`, `SANCTUM_EXPIRATION` (10080), `MERCHANT_APP_URL`, `MEDIA_DISK`, `MEDIA_URL`,
`STOREFRONT_REVALIDATE_URL`, `REVALIDATE_SECRET`, `SMS_DRIVER`, `REVESMS_*`, `HASH_DRIVER`, mail (Mailpit on :1025), plus standard `DB_*`, `REDIS_*`, `QUEUE_CONNECTION=redis`, `CACHE_STORE=redis`.

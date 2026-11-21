# Phase 2 contract: SaaS foundation (binding for API, WEB, SF)

Status: **Binding** from 2026-11-21. Scope: roadmap tasks 2.1, 2.3, 2.5, 2.6, 2.7, 2.8 and 2.9, plus the storefront side
of 2.5. **Out of scope:** 2.4 phone OTP / SMS sign-in (blocked, OPEN-QUESTIONS Q16), custom roles, ownership transfer,
billing payments, languages. Show those UI elements disabled. Don't fake them.

Product-owner decisions in force: one store per tenant (AGENT-CONTRACTS D1); domains unchanged (`app.`, `admin.`,
`api.`; stores on `{slug}.storeplix.com` or a custom domain); sign-in is email + password.
Everything in AGENT-CONTRACTS.md and docs/api/API-CONVENTIONS.md still applies: envelope, snake_case, ULIDs, money in
minor units. The machine-readable spec is `docs/api/openapi.yaml` (v1.2.0).

Conventions in this file:
- **Headers.** `B` = `Authorization: Bearer`. `T` = `X-Tenant-Id` (validated membership: missing → 400 `tenant_required`,
  not a member → 403 `tenant_forbidden`). A `{store}`, `{member}`, `{invitation}` or `{media}` id from another
  tenant → 404 `not_found`.
- **Roles** follow ADR 0005: O = owner, A = admin, S = staff. A role that isn't allowed gets 403 `forbidden`.
- **Errors.** Every endpoint can also return 401 `unauthenticated`, 422 `validation_failed` (with `details`) and
  429 `rate_limited`.

---

## 1. Endpoints

### 1.1 Password reset (task 2.1). Public, `throttle:auth`

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /auth/forgot-password` | `ForgotPasswordInput` | **202** `{data:{message}}`. The message is always `"If an account exists for that email, a reset link will be sent."` (same body as today) | 422 |
| `POST /auth/reset-password` | `ResetPasswordInput` | 200 `{data:{message:"Your password has been reset."}}` | 422 `invalid_reset_token` (unknown, expired, used, or email mismatch: one code, no detail); 422 `validation_failed` |

- **Token.** Laravel password broker using the `password_reset_tokens` table. The token is stored hashed, expires after
  **60 min**, and is **single-use**: the row is deleted on success. A new request replaces the previous token.
  `throttle` is 60 s between emails per address, and the endpoint stays silent when throttled.
- **Email.** Queued mailable `ResetPasswordMail` containing the link
  `${MERCHANT_APP_URL}/reset-password?token={token}&email={urlencoded email}`. Locally, mail goes to **Mailpit**
  (`MAIL_MAILER=smtp`, `MAIL_HOST=mailpit` or `127.0.0.1`, `MAIL_PORT=1025`; UI on `:8025`). New env var:
  `MERCHANT_APP_URL` (default `http://localhost:5173`).
- **On success.** Update the password (argon2id), set `users.password_changed_at`, revoke **all** of the user's Sanctum
  tokens, and write audit `auth.password_reset` (tenant_id null).
- **Password rule** (used everywhere): `required|string|min:8|max:128|confirmed`, plus
  `Password::min(8)->letters()->numbers()`. The rule must not run `uncompromised()` checks in tests.

### 1.2 Account (task 2.5, Figma Account `148:33261`). `B`, no `T`

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /auth/me` | — | 200 `User` (now includes `password_changed_at` and `tenants`) | — |
| `PATCH /auth/me` | `UpdateProfileInput` | 200 `User` | 422 (`email` already taken; `current_password` required and must match when `email` changes) |
| `PUT /auth/password` | `ChangePasswordInput` | 200 `AuthToken`: a **new** token. Every other token, including the current one, is revoked | 422 (`details.current_password: ["The current password is incorrect."]`) |

Validation:
- `name`: `sometimes|string|min:2|max:120`.
- `email`: `sometimes|email:rfc|max:254|unique:users,email` (excluding self), lowercased. Changing it needs `current_password`.
- `phone`: `sometimes|nullable`, BD mobile or E.164 (see `phone` rule, §1.4), stored as E.164.

Audit: `account.profile_updated` and `auth.password_changed`, both with tenant_id null.

### 1.3 Staff (task 2.3, Figma Staff & roles `89:26676`). `B` + `T`

`{member}` = `tenant_users.id`. `{invitation}` = `staff_invitations.id`.

| Method & path | Roles | Body | Success | Errors |
|---|---|---|---|---|
| `GET /staff` | O A | — | 200 `{data: StaffMember[], meta: StaffSeatsMeta}`. Active members first (owner first), then pending invitations, newest first. Not paginated (bounded by seats) | — |
| `POST /staff/invitations` | O A | `InviteStaffInput` | 201 `StaffMember` (`kind:'invitation'`) | 409 `already_member`; 409 `invitation_pending` (an open invite already exists for this email); 402 `plan_limit_reached` (`details.staff_seats`) |
| `POST /staff/invitations/{invitation}/resend` | O A | — | 200 `StaffMember`. Issues a new token, resets the 7-day expiry, and invalidates the old token | 429 (1 per minute per invitation); 409 `invitation_not_pending` |
| `DELETE /staff/invitations/{invitation}` | O A | — | 204. Sets `revoked_at` | 409 `invitation_not_pending` |
| `PATCH /staff/{member}` | O A | `UpdateStaffRoleInput` | 200 `StaffMember` | 409 `last_owner` (target is the owner); 403 `cannot_change_own_role` |
| `DELETE /staff/{member}` | O A; **any role on itself** (= leave the shop) | — | 204 | 409 `last_owner` (target is the owner; the owner can never be removed or demoted, since there is exactly one per tenant) |

Invitation acceptance (the invitee isn't a member yet, so there is no `T`):

| Method & path | Auth | Body | Success | Errors |
|---|---|---|---|---|
| `GET /invitations/{token}` | public, `throttle:auth` | — | 200 `InvitationPreview` | 404 `invitation_invalid` (unknown, expired, revoked or accepted) |
| `POST /invitations/{token}/accept` | public (new user) **or** `B` (existing user) | No `B` → `AcceptInvitationInput`; with `B` → empty | No `B`: **201** `AuthToken` (user + membership created; `email_verified_at` = now). With `B`: **200** `TenantMembership` | 404 `invitation_invalid`; 409 `login_required` (an account exists for the email and no `B` was sent); 403 `invitation_email_mismatch`; 409 `already_member`; 402 `plan_limit_reached` (seats re-checked) |

Rules:
- **Roles.** Assignable roles are `admin` and `staff`; `owner` is never assignable. An admin may invite, re-role or
  remove admins and staff, but never the owner. Nobody changes their own role.
- **UI labels** (Figma shows Owner / Manager / Order staff / Packer):
  - `owner` → "Owner"; `admin` → "Manager"; `staff` → "Staff".
  - Order staff, Packer, the editable permission matrix and the per-person toggles ("Hide product cost & profit"
    and others) are **Phase 8 custom roles**. Show the matrix read-only, using the ADR 0005 matrix, and hide the toggles.
- **Seats.**
  - `seats_used` = active non-owner members + pending (unexpired, unrevoked) invitations.
  - `seats_limit` = `plans.limits.staff_seats` (null = unlimited).
  - Inviting when `seats_used >= seats_limit` → 402.
- **Token.** 32 random bytes, base64url. Only `sha256` is stored. Expires after 7 days.
- **Invitation email.** Queued `StaffInvitationMail` (Mailpit locally) with the link
  `${MERCHANT_APP_URL}/invite?token={token}`. Figma says "SMS"; SMS is blocked (Q16), so it's email only and the UI
  copy says "email".
- **Merchant SPA route `/invite?token=`:**
  - Call `GET /invitations/{token}`.
  - `user_exists=false` → show the set-password form → `POST accept` without `B` → store the token → open the shop.
  - `user_exists=true` → sign in (L1), then `POST accept` with `B`.
- **Audit actions:** `staff.invited`, `staff.invitation_resent`, `staff.invitation_revoked`, `staff.joined`,
  `staff.role_changed` (meta.changes.role from/to), `staff.removed`, `staff.left`.

### 1.4 Store settings (task 2.5, Figma Settings → Store details `60:13854`). `B` + `T`

| Method & path | Roles | Body | Success | Errors |
|---|---|---|---|---|
| `GET /stores` | O A S | `?page&per_page` | 200 `Store[]` + `PaginationMeta` (0 or 1 items) | — |
| `POST /stores` | O A | `CreateStoreInput` | 201 `Store` | 409 `store_limit_reached` (checked **before** validation, so an empty body also gets 409); 403 for S |
| `GET /stores/{store}` | O A S | — | 200 `Store` | 404 |
| `GET /stores/{store}/settings` | O A S | — | 200 `StoreSettings` | 404 |
| `PATCH /stores/{store}/settings` | O A | `UpdateStoreSettingsInput`: **partial**. Only the sections present are changed; inside a section, only the keys present are changed; `null` clears a nullable field | 200 `StoreSettings` | 422; 409 `currency_locked` (from Phase 5, once the store has orders) |

Exact validation for `PATCH /stores/{store}/settings` (the Laravel FormRequest; WEB mirrors it in Zod):

| Field | Rule |
|---|---|
| `identity.name` | `string`, trim, `min:2`, `max:80` |
| `identity.name_bn` | `nullable`, `string`, trim, `max:80` |
| `identity.business_categories` | `array`, `max:6`, `distinct`, each `in:` `BUSINESS_CATEGORIES` codes. Empty array allowed |
| `branding.logo_media_id` | `nullable`, ULID, `exists` in `media` **for this tenant** with `purpose='logo'` and `status!='failed'` |
| `branding.favicon_media_id` | Same as `logo_media_id`, with `purpose='favicon'` |
| `branding.primary_color`, `branding.secondary_color` | `regex:/^#[0-9a-fA-F]{6}$/`, stored lowercase |
| `contact.phone`, `contact.whatsapp` | `nullable`; **phone rule**: BD mobile `^(?:\+?88)?01[3-9]\d{8}$` (stored as `+8801XXXXXXXXX`) or E.164 `^\+[1-9]\d{7,14}$` |
| `contact.email` | `nullable`, `email:rfc`, `max:254`, lowercased |
| `contact.support_hours` | `nullable`, `string`, `max:80` (free text, e.g. "10am–8pm, Sat–Thu") |
| `social.facebook` | `nullable`, `url`, `starts_with:https://`, `max:255`; host ∈ `facebook.com`, `www.facebook.com`, `m.facebook.com`, `fb.com` |
| `social.instagram` | Same; host ∈ `instagram.com`, `www.instagram.com` |
| `social.youtube` | Same; host ∈ `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be` |
| `address.street` | `nullable`, `string`, `max:255` |
| `address.division` | `nullable`, `in:` Barishal, Chattogram, Dhaka, Khulna, Mymensingh, Rajshahi, Rangpur, Sylhet (when `region.country=BD`; otherwise `string`, `max:80`) |
| `address.district`, `address.area` | `nullable`, `string`, `max:80` |
| `address.postcode` | `nullable`; BD: `regex:/^\d{4}$/`; otherwise `max:12` |
| `address.use_for_returns` | `boolean` |
| `region.country` | `string`, `size:2`, uppercase, ISO 3166-1 alpha-2 |
| `region.currency` | `in:BDT,USD` |
| `region.timezone` | `timezone:all` (IANA), default `Asia/Dhaka` |

Not editable here:
- `slug`: changing it is a Phase 6 domain flow; the UI shows it read-only as "Shop address".
- `status`: publish is Phase 5.13.
- Languages and number format: Q8. The UI shows them disabled.

Storage:
- **`stores`:** name, name_bn, business_categories, country, currency, timezone.
- **`store_settings`:** contact, social and address columns, plus logo/favicon media ids.
- **Colours** are written into `store_settings.theme.settings.primaryColor` / `secondaryColor`. That is the single
  source; there is no separate draft theme until the Phase 3 editor.

Side effects: audit `store.settings_updated` (meta.changes lists changed keys only, no values for contact data), and a
storefront revalidation (§1.8).

`POST /stores` changes for 2.1:
- `CreateStoreInput` gains `business_categories` (replaces `business_category`) and optional `name_bn` / `timezone`.
- `country` defaults to `BD`, `currency` to `BDT`.
- Name `min:2|max:80`; slug rules unchanged.

### 1.5 Media upload (task 2.6). `B` + `T`, all roles

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /media` | `multipart/form-data`: `file` (binary), `purpose` (`MediaPurpose`), `alt?` (≤ 255) | 201 `Media` (`status` `processing`, or `ready` when the queue is sync) | 422 `validation_failed` (`details.file`: type, size or dimensions); 413 at Nginx when > 6 MB |
| `GET /media/{media}` | — | 200 `Media` (poll every 1 s, up to 30 s, until `status != 'processing'`) | 404 |
| `DELETE /media/{media}` | — | 204. Deletes the DB row and all objects | 409 `media_in_use` (used as a logo or favicon); O A only for `logo` and `favicon` media |

Rules by purpose. The MIME type is detected from the bytes (`finfo`), never from the extension or client header.

| purpose | MIME allowlist | Max size | Dimensions | Variants (never upscaled) |
|---|---|---|---|---|
| `logo` | png, jpeg, webp | 2 MB | 64–4096 px each side | webp `w160`, `w320`, `w640` |
| `favicon` | png | 1 MB | square (±1 px), 64–1024 px | png `favicon_32` (32), `apple_180` (180), `icon_192` (192), `icon_512` (512; only if the source is ≥ 512) |
| `product_image`, `page_image` | png, jpeg, webp | 5 MB | 200–6000 px each side | webp `w320`, `w640`, `w1024`, `w1600` |

- **Rejected:** SVG, GIF, anything else; images over 40 megapixels (decompression-bomb guard).
- **Processing.** EXIF is stripped, and the original is re-encoded to its own format (this removes any polyglot
  payload). Processing runs in queued job `ProcessMedia` (queue `media`, tenant-aware). On failure,
  `status='failed'` and the objects are deleted.
- **Storage path**, always built with `TenantStorage`:
  - Original: `tenants/{tenant_id}/media/{media_id}/original.{ext}`
  - Variants: `tenants/{tenant_id}/media/{media_id}/{variant_key}.{webp|png}`
  - Disk: env `MEDIA_DISK` (local default `public`, served at `http://localhost:8000/storage/...`; prod: R2 bucket
    behind `cdn.storeplix.com`). Env `MEDIA_URL` is the public base URL.
  - All URLs in responses are absolute.

### 1.6 Plans, trial and FeatureGate (task 2.7)

| Method & path | Auth | Success |
|---|---|---|
| `GET /plans` | public | 200 `Plan[]` (active plans by `sort`) |
| `GET /subscription` | `B` + `T`, O A | 200 `Subscription` |
| `GET /features` | `B` + `T`, O A S | 200 `FeatureAccess`. The frontends use this for gating and "X of Y used" UI |

**Seed plans** (`PlanSeeder`, idempotent `updateOrCreate` by code; runs in `db:seed` and on deploy). Values come from
Figma Settings → Plan & billing `60:16361`:

| code | name | price_amount (BDT minor) | limits | features (true) |
|---|---|---|---|---|
| `free` | Free | 0 | `orders_per_month 50`, `staff_seats 5`, `products 100`, `courier_connections 1` | — |
| `starter` | Starter | 49900 | `orders_per_month 500`, `staff_seats 5`, `products 1000`, `courier_connections null` | `custom_domain`, `all_couriers`, `bulk_courier_booking`, `fake_order_guard`, `sms_automation` |
| `growth` | Growth | 149900 | `orders_per_month null`, `staff_seats 15`, `products null`, `courier_connections null` | everything in starter + `custom_roles`, `multi_warehouse`, `pos`, `profit_reports`, `api_webhooks` |

`null` = unlimited.

**Trial** (proposed default, PO to confirm: OPEN-QUESTIONS Q10):
- When a tenant is created (the `TenantCreated` listener, in the same transaction as registration), insert
  `subscriptions` `{plan: starter, status: trialing, trial_ends_at: now+14d}` and write audit `subscription.trial_started`.
- Daily scheduled command `subscriptions:end-trials`. For each trialing subscription with `trial_ends_at < now`:
  status `active`, plan `free`, `current_period_start` = now, `current_period_end` = +1 month. Audit
  `subscription.trial_ended`. Nothing is locked.
- A migration backfills a trial for every existing tenant without a subscription.

**Server API** (`App\Domain\Billing\FeatureGate`, the only way to check a plan):
```php
FeatureGate::allows(Tenant $t, Feature $f): bool                 // enum Feature: custom_domain, all_couriers, ...
FeatureGate::limit(Tenant $t, Limit $l): ?int                    // enum Limit: orders_per_month, staff_seats, products, courier_connections
FeatureGate::usage(Tenant $t, Limit $l): int                     // computed live (Phase 2: staff_seats only; others return 0 until their module exists)
FeatureGate::assertWithin(Tenant $t, Limit $l, int $adding = 1): void   // throws PlanLimitReached → 402 plan_limit_reached, details {"<limit>": ["Your plan allows N <limit>."]}
FeatureGate::assertAllows(Tenant $t, Feature $f): void           // throws FeatureNotInPlan → 402 feature_not_in_plan, details {"feature": ["<feature>"]}
```
- The effective plan is the plan of the tenant's current subscription (`trialing`, `active` or `past_due`). If there
  is no subscription, `free` applies.
- The result is cached per tenant for 60 s (`TenantCache`) and busted on any subscription change.
- Phase 2 enforces only `staff_seats`. Every other limit is wired when its module lands.

### 1.7 Audit log (task 2.8). `B` + `T`, O A

`GET /audit-logs`. Offset pagination: `page`, `per_page` (default 25, max 100), `PaginationMeta`. This supersedes
the earlier "cursor for audit logs" note in API-CONVENTIONS §4 for Phase 2.

Filters (all optional, combinable):

| Param | Meaning |
|---|---|
| `filter[action]` | Comma list of exact action names, or a prefix with `*` (e.g. `staff.*`) |
| `filter[actor_id]` | User ULID |
| `filter[subject_type]` | One of `store`, `store_settings`, `staff_member`, `staff_invitation`, `media`, `subscription`, `user` |
| `filter[subject_id]` | ULID |
| `filter[created_at][gte]`, `filter[created_at][lte]` | ISO 8601 |

- `sort=-created_at` (the default and the only sort). Unknown filters → 422.
- Only rows with this tenant's `tenant_id` are returned. Rows with tenant_id null (account-level) are never listed here.
- **Actions written in Phase 2:**
  - `auth.registered`
  - `store.created`, `store.settings_updated`, `store.preview_token_issued`
  - `staff.*` (§1.3)
  - `media.deleted`
  - `subscription.trial_started`, `subscription.trial_ended`
- `meta` is redacted: never passwords, tokens, or contact values; only changed key names, and role from/to.

### 1.8 Storefront revalidation (QA M-1, owner API)

- **Observer `StorefrontRevalidationObserver`** registered on:
  - `Store` when `status`, `name`, `slug`, `currency` or `country` change
  - `StoreSettings` on any change (includes theme, colours, logo, favicon, contact, social)
  - `StoreDomain` on created, updated or deleted
- It dispatches **`RevalidateStorefront`** with `afterCommit()`, carrying `{tenant_id, store_id, extra_hosts[]}`.
  `extra_hosts` holds the old hostname when a domain row is changed or deleted.
- **Job `RevalidateStorefront`:**
  - Queue `default`, tenant-aware, `ShouldBeUnique` by `store_id` with `uniqueFor = 2` (debounces bulk edits).
  - Hosts = every `store_domains.hostname` of the store + `extra_hosts`.
  - Request: `POST ${STOREFRONT_REVALIDATE_URL}` with `Authorization: Bearer ${REVALIDATE_SECRET}` and body
    `{"hosts":[...]}`; timeout 5 s.
  - Responses:
    - 2xx → done.
    - 401 or 422 → `fail()` with no retry (config error); log error.
    - 503 `revalidate_disabled` → log warning, no retry.
    - Network error or other 5xx → retry: `tries = 5`, `backoff = [5, 30, 120, 600]` seconds.
  - If either env var is empty → no-op with an info log, so local dev works without a storefront.
- **Env vars:**

  | Var | App | Example | Notes |
  |---|---|---|---|
  | `STOREFRONT_REVALIDATE_URL` | api | `http://localhost:3000/api/revalidate` (docker: `http://storefront:3000/api/revalidate`) | Internal URL; never the public one in prod |
  | `REVALIDATE_SECRET` | api **and** storefront | 32+ random bytes, base64 | Same value in both; never in client bundles |

  QA adds both to `docker-compose.yml` and to both `.env.example` files.
- The storefront route `/api/revalidate` already exists (Bearer secret, `{host}` or `{hosts}`, expires tag
  `store:{host}`); its contract is unchanged.
- **Acceptance:**
  - Changing the logo, colours, contact or status shows on the storefront on the next request, with no 60 s stale window.
  - A feature test fakes HTTP and asserts the payload, the retry on 500, and no retry on 401.

---

## 2. Data (migrations, owner API)

Postgres in CI and prod. Local sqlite must keep working, so array-like data uses `json` (jsonb on pg); partial
indexes use raw SQL that both engines accept. Every new tenant-owned table has `UNIQUE(tenant_id, id)`.
`FK(t)` = composite `(tenant_id, col) → table(tenant_id, id)`.

| Table | Change |
|---|---|
| `users` | + `password_changed_at timestamptz null` |
| `tenant_users` | + `invited_by ulid null` FK users nullOnDelete; + `joined_at timestamptz null` (backfill = created_at); + `UNIQUE(tenant_id, id)`; + partial unique `tenant_users_one_owner ON (tenant_id) WHERE role = 'owner'` |
| `stores` | + `name_bn varchar(80) null`; + `business_categories json not null default '[]'` (backfill: map the old comma-joined labels to codes, drop unknowns), then **drop `business_category`**; + `timezone varchar(64) not null default 'Asia/Dhaka'` |
| `media` (new) | `id ulid pk`, `tenant_id` FK tenants cascade, `purpose varchar(24)`, `disk varchar(32)`, `path varchar(512) unique`, `mime varchar(64)`, `size_bytes int`, `width int`, `height int`, `checksum char(64)`, `alt varchar(255) null`, `status varchar(16) default 'processing'`, `variants json default '[]'` (`[{key,width,height,mime,path}]`), `uploaded_by ulid null` FK users nullOnDelete, timestamps. `UNIQUE(tenant_id,id)`, `INDEX(tenant_id, purpose, created_at)` |
| `store_settings` | + `logo_media_id ulid null` **FK(t) media RESTRICT**; + `favicon_media_id ulid null` **FK(t) media RESTRICT**; **drop** `logo_url`, `favicon_url` (URLs are derived from media; update the seeder); + `contact_phone varchar(16) null`, `contact_email varchar(254) null`, `whatsapp varchar(16) null`, `support_hours varchar(80) null`; + `social_links json not null default '{}'` (`{facebook,instagram,youtube}`); + `business_address json null` (`{street,division,district,area,postcode}`); + `use_address_for_returns boolean default true` |
| `staff_invitations` (new) | `id`, `tenant_id` FK tenants cascade, `email varchar(254)` (lowercased), `name varchar(120) null`, `role varchar(16)` (`admin`\|`staff`), `token_hash char(64) unique`, `invited_by ulid` FK users, `expires_at`, `accepted_at null`, `accepted_user_id ulid null` FK users, `revoked_at null`, `last_sent_at`, timestamps. `UNIQUE(tenant_id,id)`; partial unique `(tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL` |
| `plans` (new, platform) | `id`, `code varchar(32) unique`, `name`, `price_amount bigint`, `currency char(3)`, `interval varchar(8) default 'month'`, `limits json`, `features json`, `is_active bool`, `sort smallint`, timestamps |
| `subscriptions` (new) | `id`, `tenant_id` FK tenants cascade, `plan_id` FK plans restrict, `status varchar(16)` (`trialing`\|`active`\|`past_due`\|`cancelled`\|`expired`), `trial_ends_at null`, `current_period_start null`, `current_period_end null`, `cancel_at_period_end bool default false`, timestamps. `UNIQUE(tenant_id,id)`; partial unique `(tenant_id) WHERE status IN ('trialing','active','past_due')` |
| `audit_logs` | + `user_agent varchar(255) null`; + `INDEX(tenant_id, action, created_at)`, `INDEX(tenant_id, actor_id, created_at)` |

Models:
- `Media`, `StaffInvitation` and `Subscription` use `BelongsToTenant`. `Plan` is a platform model.
- Cross-tenant isolation tests (`assertTenantIsolation`) are required for staff members, invitations, media,
  settings and audit logs.

---

## 3. Types: exact additions/changes to `packages/types/src/index.ts` (the orchestrator applies them)

```ts
// ---------- Inputs (promoted from api-client/models.ts) ----------
export interface RegisterInput { name: string; email: string; password: string; password_confirmation: string; phone?: string }
export interface LoginInput { email: string; password: string }
export interface ForgotPasswordInput { email: string }
export interface ResetPasswordInput { email: string; token: string; password: string; password_confirmation: string }
export interface MessageResponse { message: string }

// ---------- Business categories (decision: ARRAY of codes; replaces Store.business_category) ----------
export const BUSINESS_CATEGORIES = [
  { code: 'fashion', label: 'Fashion' },
  { code: 'beauty', label: 'Beauty' },
  { code: 'kids', label: 'Kids' },
  { code: 'food_grocery', label: 'Food & grocery' },
  { code: 'electronics', label: 'Electronics' },
  { code: 'home', label: 'Home' },
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number]['code'];

export interface CreateStoreInput {
  name: string; slug: string; country?: string; currency?: string;
  business_categories?: BusinessCategory[]; name_bn?: string | null; timezone?: string;
}

// Store: REPLACE `business_category: string | null` with:
//   business_categories: BusinessCategory[]; name_bn: string | null; timezone: string;

// User: ADD
//   password_changed_at: string | null;

// ---------- Account ----------
export interface UpdateProfileInput { name?: string; email?: string; phone?: string | null; current_password?: string }
export interface ChangePasswordInput { current_password: string; password: string; password_confirmation: string }

// ---------- Staff ----------
export type AssignableRole = Exclude<TenantRole, 'owner'>;
export interface StaffMember {
  id: string;                       // tenant_users.id (kind=member) or staff_invitations.id (kind=invitation)
  kind: 'member' | 'invitation';
  user_id: string | null;           // null for invitations
  name: string | null;              // invitation name may be null
  email: string;
  phone: string | null;
  role: TenantRole;
  status: 'active' | 'invited' | 'expired';
  is_you: boolean;
  invited_by: { id: string; name: string } | null;
  joined_at: string | null;
  expires_at: string | null;        // invitations only
  created_at: string;
}
export interface StaffSeatsMeta { seats_used: number; seats_limit: number | null }
export interface InviteStaffInput { email: string; name?: string | null; role: AssignableRole }
export interface UpdateStaffRoleInput { role: AssignableRole }
export interface InvitationPreview {
  tenant_name: string; store_name: string | null; email: string; role: AssignableRole;
  invited_by_name: string; expires_at: string; user_exists: boolean;
}
export interface AcceptInvitationInput { name: string; password: string; password_confirmation: string; phone?: string }

// ---------- Media ----------
export type MediaPurpose = 'logo' | 'favicon' | 'product_image' | 'page_image';
export type MediaStatus = 'processing' | 'ready' | 'failed';
export interface MediaVariant { key: string; width: number; height: number; mime: string; url: string }
export interface Media {
  id: string; purpose: MediaPurpose; status: MediaStatus; mime: string; size_bytes: number;
  width: number; height: number; alt: string | null;
  url: string;                      // original, absolute
  variants: MediaVariant[];         // empty while processing
  created_at: string;
}
/** Compact reference embedded in other resources. `url` = best display variant (or original while processing). */
export interface MediaRef { id: string; url: string; width: number; height: number; status: MediaStatus }

// ---------- Store settings ----------
export interface SocialLinks { facebook: string | null; instagram: string | null; youtube: string | null }
export interface StoreContact { phone: string | null; email: string | null; whatsapp: string | null; support_hours: string | null }
export interface BusinessAddress {
  street: string | null; division: string | null; district: string | null; area: string | null;
  postcode: string | null; use_for_returns: boolean;
}
export interface StoreSettings {
  store_id: string;
  identity: { name: string; name_bn: string | null; slug: string; primary_domain: string | null; business_categories: BusinessCategory[] };
  branding: { logo: MediaRef | null; favicon: MediaRef | null; primary_color: string; secondary_color: string };
  contact: StoreContact;
  social: SocialLinks;
  address: BusinessAddress;
  region: { country: string; currency: string; timezone: string };
  updated_at: string;
}
export interface UpdateStoreSettingsInput {
  identity?: Partial<{ name: string; name_bn: string | null; business_categories: BusinessCategory[] }>;
  branding?: Partial<{ logo_media_id: string | null; favicon_media_id: string | null; primary_color: string; secondary_color: string }>;
  contact?: Partial<StoreContact>;
  social?: Partial<SocialLinks>;
  address?: Partial<BusinessAddress>;
  region?: Partial<{ country: string; currency: string; timezone: string }>;
}

// ---------- Plans / subscription / features ----------
export type FeatureKey =
  | 'custom_domain' | 'all_couriers' | 'bulk_courier_booking' | 'fake_order_guard' | 'sms_automation'
  | 'custom_roles' | 'multi_warehouse' | 'pos' | 'profit_reports' | 'api_webhooks';
export type LimitKey = 'orders_per_month' | 'staff_seats' | 'products' | 'courier_connections';
export interface Plan {
  id: string; code: 'free' | 'starter' | 'growth' | (string & {}); name: string;
  price_amount: number; currency: string; interval: 'month' | 'year';
  limits: Record<LimitKey, number | null>; features: FeatureKey[];
}
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';
export interface Subscription {
  id: string; status: SubscriptionStatus; plan: Plan;
  trial_ends_at: string | null; current_period_start: string | null; current_period_end: string | null;
  cancel_at_period_end: boolean;
}
export interface FeatureAccess {
  plan_code: string; subscription_status: SubscriptionStatus; trial_ends_at: string | null;
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, { limit: number | null; used: number }>;
}

// ---------- Audit ----------
export interface AuditLog {
  id: string; action: string;
  actor: { type: 'user' | 'system'; id: string | null; name: string | null } | null;
  subject: { type: string; id: string } | null;
  meta: Record<string, unknown>;
  ip: string | null; user_agent: string | null; created_at: string;
}
export interface AuditLogFilters {
  action?: string; actor_id?: string; subject_type?: string; subject_id?: string;
  created_from?: string; created_to?: string; page?: number; per_page?: number;
}  // api-client maps these to filter[...] query params

// ---------- StorefrontConfig additions (public render data only) ----------
// store: ADD  icons: { apple_touch: string | null; icon_192: string | null; icon_512: string | null };
//   (logo_url now = logo variant w320 (or original while processing); favicon_url = favicon_32 variant)
// ADD top-level:
//   contact: StoreContact;   // all fields nullable; never the business address
//   social: SocialLinks;
```

Compatibility: the changes are additive, except `Store.business_category` → `business_categories`. API and WEB switch
in the same PR (task 2.1). The storefront must treat a missing `contact`, `social` or `icons` as null, which tolerates
a rolling deploy.

---

## 4. Storefront (SF side of 2.5)

- **Header:** logo (`store.logo_url`, `alt` = store name, height-constrained, no layout shift); falls back to the store
  name in text.
- **`generateMetadata` icons:**
  - `favicon_url` → `<link rel=icon sizes=32x32>`
  - `icons.apple_touch` → `apple-touch-icon`
  - `icon_192` / `icon_512` → web manifest icons
  - No icon set → platform default favicon.
- **Footer:**
  - Contact block: phone as `tel:`, WhatsApp as `https://wa.me/<digits>`, email as `mailto:`, plus support hours.
    Render only non-null items.
  - Social icons for non-null links: `target=_blank`, `rel="noopener noreferrer"`. Accept only `https:` URLs
    (Zod guard); otherwise drop the link.
- **Coming soon** (draft) shows logo, name, contact and social. Nothing else is public.
- **Zod:** extend the StorefrontConfig schema with the new fields, defaulting to null when absent.
- **Tests:** null-tolerance, the https guard, and that the icon tags render.
- **Design:** use the existing Phase 1 theme header/footer components (built from Storefront page `1:9207`, mobile
  `2:6`). Query only the specific header/footer frame ids you already use, never the page.

---

## 5. Figma frames per UI task (file `2W1wMKN79hhcr1czQS63oN`; load `figma:figma-design-to-code` first)

| Task | Frames (ids) |
|---|---|
| 2.3 Staff | Section `89:26676`: list `60:15363` (Main `60:15365`); Invite modal `90:26879` (page frame `90:26504`); Role detail `90:26913`. Build the list (team table, seats card, roles summary, read-only matrix, recent activity from `/audit-logs?filter[action]=staff.*`). Skip "Online now", "Actions today", "Staff sign-in security" and the per-person permission toggles |
| 2.5 Settings | Section `60:11161` → **Store details `60:13854`** cards: Shop identity `61:12261` (logo, name EN `61:12279`, name বাংলা `61:12285`, shop address/slug read-only `61:12292`, business category `61:12298`), Contact `61:12311` (phone, email, WhatsApp, support hours), Social links `73:22338` (Facebook, Instagram, YouTube), Business address `61:12343` (street, division, district, area/thana, postcode, return-address toggle `61:12381`), Language & region `61:12427` (currency `61:12451`, timezone `61:12457` enabled; language chips and number format `61:12463` disabled). Trade licence `61:12389` is Phase 7: hide it. Plan & billing `60:16361`: build only **Current plan `65:17435`** and **Usage this month `65:17455`** (read-only, from `/features` + `/subscription`); Plans `65:17495` read-only list from `/plans` with upgrade buttons disabled. Payment method and Invoices are Phase 7. Other Settings tabs (Shipping `60:14364`, Payments `60:14865`, Notifications `60:15863`, Taxes `60:16858`, Policies `87:25694`) show as nav items with a "coming soon" state |
| 2.5 Account | Section `148:33261` → frame `148:33262`: Profile card `148:33851` (editable), Sign-in & security `148:33899` (Password row `148:33907` → change-password modal; two-step SMS `148:33916`, authenticator `148:33922` and backup codes `148:33928` disabled), Sessions `148:33932` (Phase 4: hide), Your shops `148:33973` (from `/auth/me` tenants), My alerts `148:33995` (hide), Transfer ownership `148:34025` (disabled) |
| 2.9 Checklist | Component `45:8102`: variants `state=done` `45:8087`, `state=todo` `45:8095`. Dashboard checklist items: Name your shop (done), Add logo & contact (done when logo + phone are set), Invite your team (done when an invitation or member exists), Pick a theme (Phase 3, todo/disabled), Add products, Delivery, Get paid, Go live (later phases, disabled) |
| 2.1 Reset password | Onboarding L3 `57:1198` (request; already built) + a reset form in the same AuthShell style (no dedicated Figma frame: reuse L3's layout) |

---

## 6. File ownership for Phase 2

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: migrations (§2), `PlanSeeder`, models, `Domain/Identity` (reset, profile, password), `Domain/Staff` (members, invitations, mails), `Domain/Stores` (settings request/resource, `StorefrontRevalidationObserver`, `RevalidateStorefront`), `Domain/Media` (`ProcessMedia`, `TenantStorage`), `Domain/Billing` (`FeatureGate`, trial listener, `subscriptions:end-trials`), `Domain/Audit` (list endpoint), StorefrontConfigResource additions, `.env.example` (`MERCHANT_APP_URL`, `MEDIA_DISK`, `MEDIA_URL`, `STOREFRONT_REVALIDATE_URL`, `REVALIDATE_SECRET`, mail) |
| **WEB** | `apps/merchant-dashboard/**` (reset-password page, `/invite` page, Staff, Settings → Store details & Plan, Account, onboarding checklist), `packages/api-client/**` (new endpoint methods; delete the inputs from `models.ts` once types land), `packages/ui/**` (Toggle, Modal, Table, FileUpload / ImageUpload, ChecklistItem, Avatar), `packages/config/**`. `apps/super-admin/**`: no Phase 2 work |
| **SF** | `apps/storefront/**`: §4 |
| **QA** | `docker-compose.yml` (mailpit, `REVALIDATE_SECRET`, `STOREFRONT_REVALIDATE_URL`, queue worker), `.github/**`, `tests/e2e/**` (reset password via the Mailpit API, invite → accept, settings → storefront shows the logo), `docs/reviews/**` |
| **Orchestrator** | `packages/types/src/index.ts` (§3), root `package.json` |
| **ARCH** | This file, `docs/api/openapi.yaml`, other `docs/**` |

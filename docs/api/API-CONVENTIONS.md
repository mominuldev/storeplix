# API Conventions

Status: Accepted (Phase 0). Binding for `apps/api` and all clients. Contract types: `packages/types/src/index.ts`.
Spec: `docs/api/openapi.yaml` (Phase 1 endpoints; extended per phase).
**Change process:** response shape change ⇒ update Laravel API Resource + `packages/types` + `openapi.yaml` in the same PR.

## 1. Base & versioning
- Base URL `https://api.storeplix.com/api/v1` (local `http://localhost:8000/api/v1`).
- Major version in path. Within v1 only additive changes (new endpoints, new optional fields, new enum values clients
  must tolerate). Breaking change ⇒ `/api/v2` for the affected routes, v1 kept ≥ 6 months, responses carry
  `Deprecation: true` and `Sunset: <date>` headers.
- Route groups:
  | Prefix | Auth | Tenant |
  |---|---|---|
  | `/auth/*` | public / Bearer | none |
  | `/stores`, `/stores/{store}/*` | Bearer (`merchant` ability) | `X-Tenant-Id`; `{store}` must belong to it (else 404) |
  | other tenant-level merchant routes (`/staff`, `/subscriptions`, `/invoices`, `/audit-logs`, `/media`) | Bearer (`merchant`) | `X-Tenant-Id` |
  | `/storefront/*` | `X-Storefront-Key` | `X-Storefront-Host` |
  | `/admin/*` | Bearer (`admin` ability + platform_role) | explicit route param |
  | `/webhooks/{provider}` | provider signature | resolved from payload |
  | `/health` | public | none |
  One store per tenant (D1, revised); a second `POST /stores` → 409 `store_limit_reached`. Paths keep `{store}` for a
  future multi-store option. Store-scoped resources (`products, categories, inventory, orders, customers, domains,
  themes, pages, payments, shipping`) live under `/api/v1/stores/{store}/` e.g. `/api/v1/stores/{store}/products`.
  Tenant-level resources (`stores, staff, subscriptions, invoices`) live at `/api/v1/{resource}`.
- Phase 1.1 endpoints: `GET/POST /stores`, `POST /stores/{store}/preview-token`, `POST /auth/forgot-password` (see openapi.yaml).
- Phase 2 endpoints (staff, invitations, settings, media, plans/features, audit logs, account): `docs/development/PHASE-2-CONTRACT.md`.

## 2. Requests
- JSON bodies, `Content-Type: application/json`; uploads `multipart/form-data`.
- snake_case keys. IDs are ULID strings. Timestamps ISO 8601 UTC (`2026-11-21T10:00:00Z`).
- Money: `{ "amount": 125000, "currency": "BDT" }` objects in responses, or `*_amount` integer fields alongside a
  resource-level `currency`. Always minor units. Clients format for display (`packages/types` `formatMoney`).
- Headers: `Accept: application/json` (required — API returns JSON regardless), `X-Request-Id` (optional; echoed,
  generated if absent), `Idempotency-Key` (see §9).
- Unknown body fields are ignored; never mass-assigned.

## 3. Response envelope
Success: `{ "data": <object|array>, "meta"?: {...} }` — `201` on create with `data` = created resource; `204` no body on
delete/logout. Never return bare arrays or top-level fields besides `data`/`meta`.

Error: `{ "error": { "code": "snake_case_code", "message": "Human readable, safe to show", "details"?: { "field": ["msg"] } } }`

| HTTP | code | When |
|---|---|---|
| 400 | `bad_request`, `tenant_required`, `idempotency_key_required` | malformed request / missing header |
| 401 | `unauthenticated`, `invalid_storefront_key` | missing/invalid token or key |
| 402 | `plan_limit_reached`, `feature_not_in_plan`, `subscription_inactive` | plan gate (FeatureGate) |
| 403 | `forbidden`, `tenant_forbidden` (not a member of `X-Tenant-Id`), `tenant_suspended`, `cannot_change_own_role`, `invitation_email_mismatch`, `email_not_verified` | authenticated but not allowed |
| 404 | `not_found`, `store_not_found`, `invitation_invalid`, `cart_not_found` | missing **or belongs to another tenant** |
| 409 | `conflict`, `revision_conflict`, `stock_changed`, `import_in_progress`, `category_has_children`, `category_limit_reached`, `store_limit_reached`, `last_owner`, `already_member`, `invitation_pending`, `invitation_not_pending`, `login_required`, `media_in_use`, `currency_locked`, `idempotency_key_in_use`, `idempotency_key_mismatch`, `invalid_state_transition`, `checkout_changed`, `store_not_live`, `launch_blocked`, `coupon_in_use` | state conflict |
| 413 | `payload_too_large` | body/upload over the endpoint limit |
| 419 | `csrf_token_mismatch` | cookie-session write without a valid `X-XSRF-TOKEN` (Phase 4.7) |
| 422 | `validation_failed` (+ `details`), `out_of_stock`, `coupon_invalid`, `insufficient_stock`, `unsupported_file`, `too_many_rows`, `too_many_columns`, `empty_file`, `cart_empty`, `payment_method_unavailable`, `refund_exceeds_paid` | validation / business rule |
| 429 | `rate_limited` | + `Retry-After` header |
| 500 | `server_error` | generic message; correlate via `X-Request-Id` response header |
| 503 | `maintenance` | |

`details` keys are dot paths (`items.0.quantity`, `sections.2.settings.limit`). Laravel exception handler maps
`ValidationException`, `AuthenticationException`, `AuthorizationException`, `ModelNotFoundException`,
`ThrottleRequestsException`, domain exceptions (each has a `code`) into this shape. Stack traces never leave the server.

**Phase 5a codes** (PHASE-5-CONTRACT §3.0):
| HTTP | code | When |
|---|---|---|
| 400 | `idempotency_key_required` (exists) | `Idempotency-Key` missing **or malformed** (§9) |
| 404 | `cart_not_found` | `X-Cart-Token` missing, unknown, expired or not `active`; the storefront clears `sp_cart` |
| 409 | `checkout_changed` | recomputed total ≠ `expected_total_amount`; nothing written |
| 409 | `store_not_live` | storefront checkout on a draft store (preview) |
| 409 | `launch_blocked` | `POST /stores/{store}/publish` with unmet hard requirements (`details.<item_key>`) |
| 409 | `coupon_in_use` | delete a coupon that has redemptions (disable it instead) |
| 422 | `out_of_stock` (exists) | add-to-cart or checkout beyond `available` ("Only 2 left."), **and** storefront checkout of a line that is no longer purchasable (product inactive, variant disabled/deleted: "This item is no longer available."); `details["items.N.quantity"]`, N = cart line index. Manual orders report an unpurchasable line as `validation_failed` on `items.N.variant_id` |
| 422 | `coupon_invalid` (exists) | coupon unknown, inactive, expired, used up, below minimum, not eligible, per-customer or first-order rule (`details.code = [reason]`) |
| 422 | `cart_empty` | checkout with no purchasable lines |
| 422 | `payment_method_unavailable` | payment method not enabled for the store (incl. COD turned off) |
| 422 | `refund_exceeds_paid` | refund > `paid_amount − refunded_amount` |

As built (accepted deviations from the contract draft):
- **No `zone_area_taken`.** An area that sits in two zones of one `PUT /stores/{store}/shipping` payload, or hits the
  `U(store_id, district_code, thana_code)` constraint, is `422 validation_failed` with the field error on
  `zones.N.areas.M` ("Mirpur is already in Inside Dhaka."), not 409.
- **Unavailable lines at storefront checkout** use `422 out_of_stock` (with the line's `details` key), not a separate code.

## 4. Pagination
Offset pagination for dashboard lists: `?page=2&per_page=25` (`per_page` max 100, default 25).
`meta`: `{ "current_page": 2, "per_page": 25, "total": 312, "last_page": 13 }` (= `PaginationMeta`).
Cursor pagination (`?cursor=...`, `meta: { next_cursor, prev_cursor, per_page }`) for high-volume feeds (storefront
product lists, webhook deliveries; audit logs use offset pagination per PHASE-2-CONTRACT §1.7) — added as `CursorMeta` to `packages/types` when first used (Phase 3).

## 5. Filtering, sorting, search, includes
- Filter: `?filter[status]=active&filter[category_id]=01J...&filter[created_at][gte]=2026-01-01`. Allowlisted per endpoint
  (spatie/laravel-query-builder). Multiple values comma-separated: `filter[status]=pending,confirmed`.
- Sort: `?sort=-created_at,name` (prefix `-` = desc); allowlisted; default `-created_at`.
- Search: `?q=shirt` (Postgres full-text / trigram).
- Includes: `?include=variants,images` allowlisted; otherwise relations not loaded (no N+1 by surprise).
- Sparse fields not supported in v1.

## 6. Resource naming
Plural nouns, kebab-case multiword (`/stores/{store}/shipping-methods`), nested max one level below the store
(`/stores/{store}/products/{id}/variants`). Actions that aren't CRUD use sub-resource verbs as POST:
`/stores/{store}/orders/{id}/cancel`, `/stores/{store}/domains/{id}/verify`, `/stores/{store}/themes/{code}/publish`,
`/stores/{store}/preview-token`.
Route params are ULIDs (except `themes/{code}` and storefront `{slug}`).

## 7. Authentication headers
**Phase 4.7 (PHASE-4-CONTRACT §7):** merchant and admin SPAs authenticate with a Sanctum **session cookie** on their own
origin (API proxied same-origin), call `GET /sanctum/csrf-cookie` first and send `X-XSRF-TOKEN` on every write
(missing/stale → 419 `csrf_token_mismatch`). Login responses are `AuthSession {user, expires_at}`; Bearer tokens are
removed in 4.7c. `X-Tenant-Id` is unchanged. The text below describes Phases 1–3.

`Authorization: Bearer <token>`; merchant routes also `X-Tenant-Id: <tenant ulid>`. Storefront server sends
`X-Storefront-Key` and `X-Storefront-Host`; shopper session for cart/checkout via `X-Cart-Token` (set by storefront
server from `sp_cart` cookie) and, for logged-in customers, `X-Customer-Token` (Phase 5). Merchant preview: storefront
forwards the `sp_preview` cookie value as `X-Storefront-Preview`; invalid/expired is silently ignored (`preview: false`).

**Token lifetime (D3):** Sanctum tokens expire after `SANCTUM_EXPIRATION` minutes (default 10080 = 7 days). Token
responses (`register`, `login`) include `expires_at` (ISO 8601). Expired/invalid → 401 `unauthenticated`; clients clear
the session and redirect to login. Store the token in `sessionStorage` until cookie auth (Phase 4).

**Forgot password:** `POST /auth/forgot-password {email}` → always **202** `{data:{status:"sent"}}`, whether or not the
email exists (no enumeration); `auth` rate limiter. Phase 1.1 is a stub (no email sent); real reset emails come in Phase 2.

**Preview token (D2):** `POST /stores/{store}/preview-token` → 201 `{data:{token, url, expires_at}}`; 60-min signed token
bound to the store; see STOREFRONT-ENGINE §4.1.

## 8. Rate limits (Redis, per tenant)
| Limiter | Key | Limit |
|---|---|---|
| `auth` (login/register/forgot) | email + IP | 5/min, 20/hour |
| `merchant` | tenant + user (IP before login) | 300/min (amended 2026-11-22, QA 5a F-L6; was 120) |
| `merchant-bulk` (imports/exports) | tenant | 10/hour |
| `storefront` | store host (`X-Storefront-Host`), whole store | 1 200/min (amended 2026-11-22, QA 5a F-L6; the planned per-shopper-IP 300/min and per-store 3 000/min split is not built; per-IP limits exist only on `cart`, `checkout` and `order-track`) |
| `checkout` (`POST /storefront/checkout`) | store host + shopper IP; store host + normalised phone (`contact.phone`, only when it parses) | 10/min; 5 per 10 min |
| `cart` (all `/storefront/cart*` routes and `GET /storefront/orders/confirmation`) | store host + shopper IP | 60/min |
| `order-track` (`POST /storefront/orders/track`) | store host + shopper IP | 10/min |
| `geo` (`GET /geo/bd`, public, no auth) | request IP | 60/min |
| `POST /stores/{store}/publish` | inline `throttle:20,1` | 20/min |
| `webhooks` | provider | 600/min |
Auth routes (login, register, password reset, OTP send/verify) use per-route limiters; their exact values are
maintained in `apps/api/README.md` (the table above is indicative). Responses include `X-RateLimit-Limit`,
`X-RateLimit-Remaining`; every 429 has body `{error:{code, message, retry_after}}` (`rate_limited` or `otp_rate_limited`)
and a `Retry-After` header with the same seconds. Limits scale with plan (Phase 7).
Phase 5a limiters live in `apps/api/app/Domain/Orders/CommerceServiceProvider.php`; the storefront ones key on
`X-Storefront-Host` (lowercased) and the shopper IP from `X-Storefront-Client-Ip` (trusted only with a valid storefront
key). The cart, checkout and track limiters apply on top of the route group's `storefront` limiter.

## 9. Idempotency
Required `Idempotency-Key` (UUID/ULID, ≤ 64 chars) on: `POST /storefront/checkout`, `POST /storefront/orders/{id}/payments`,
`POST /stores/{store}/orders/{id}/refunds`, `POST /subscriptions/*/pay`, and accepted on all other POSTs.
Behaviour (`idempotency_keys` table, scope = tenant + store + route): first request locks the key and stores status+body;
repeats with the same body hash return the stored response with header `Idempotent-Replayed: true`; same key with a
different body → 409 `idempotency_key_mismatch`; concurrent in-flight → 409 `idempotency_key_in_use`. Keys kept 24 h.

**Phase 5a (as built, `IdempotencyGuard`, route middleware `idempotent:{scope}`):**
- **Key format:** 8–64 characters of `[A-Za-z0-9_-]` (a UUID or ULID fits). A missing **or malformed** key → 400
  `idempotency_key_required` ("The Idempotency-Key must be 8–64 letters, digits, dashes or underscores (a UUID or
  ULID).").
- **Enforced on:** `POST /storefront/checkout` (scope `storefront.checkout`), `POST /stores/{store}/orders` (manual
  order, `orders.create`), `POST /stores/{store}/orders/{order}/refunds` (`orders.refund`). Other POSTs ignore the
  header in 5a. Uniqueness is `U(store_id, scope, key)`.
- **Request hash:** sha256 of method + path, the canonical (key-sorted) JSON body and, for checkout, the sha256 of
  `X-Cart-Token`.
- The key row is inserted as `processing` (`locked_until = now + 30 s`) in its own transaction **before** the business
  transaction. A 2xx response is stored (`response_body` encrypted; it carries the confirmation token) and replayed with
  `Idempotent-Replayed: true` and `Cache-Control: private, no-store`. Any non-2xx response or exception deletes the row,
  so the client can retry with the same key. A `processing` row past `locked_until` is taken over.
- `orders` and `payments` also carry partial `U(store_id, idempotency_key)` as the final guard. Expired rows are
  deleted hourly (`idempotency:prune`).
- Clients: the storefront generates the checkout key server-side per attempt and keeps it in a hidden field; the
  dashboard uses `crypto.randomUUID()` per Create-order form / refund dialog session.

## 10. Webhooks
**Inbound** (`POST /api/v1/webhooks/{bkash|sslcommerz|pathao|steadfast|redx|cloudflare}`): verify signature / validation
API / source IP per provider before anything else; store in `webhook_events` (unique `provider,event_id`); respond 200
fast; process in `webhooks` queue (tenant-aware); never trust payload amounts — re-query provider (ADR 0007).
**Outbound** (Phase 8, Developer section): events `order.created|updated|paid|cancelled`, `product.*`, `inventory.low`,
`customer.created`. Body `{ id, type, created_at, tenant_id, data }`. Headers `X-StorePlix-Event`, `X-StorePlix-Delivery`,
`X-StorePlix-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`; receivers reject if |now − t| > 300 s.
Retries with exponential backoff (1 m → 24 h, 8 attempts), endpoint auto-disabled after 3 days failing.

## 11. Resource representation rules
- Always include `id`, `created_at`, `updated_at`; tenant-owned resources do **not** expose `tenant_id` to storefront.
- Never expose: passwords, tokens, credentials, `cost_amount` on storefront, internal flags, other tenants' data.
- Enums as snake_case strings; nullable fields present with `null` (not omitted).
- Booleans prefixed `is_`/`has_` only where ambiguous.
- Storefront endpoints return render data only (StorefrontConfig, product display data, cart totals).

## 12. Caching headers
Merchant/admin: `Cache-Control: no-store`. Storefront render endpoints: `Cache-Control: public, max-age=0, s-maxage=60`
+ `ETag`; cart/checkout, draft-store and preview responses `private, no-store`. Storefront relies on Next.js tag revalidation (STOREFRONT-ENGINE §5).

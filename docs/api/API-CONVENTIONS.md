# API Conventions

Status: Accepted (Phase 0). Binding for `apps/api` and all clients. Contract types: `packages/types/src/index.ts`.
Spec: `docs/api/openapi.yaml` (Phase 1 endpoints; extended per phase; v1.6.1 after Phase 5b). Phase 5b additions (as built 2026-11-22): §3 (5b codes), §8 (limiters), §9 (scopes), §10.1–10.3 (webhooks, returns, dev endpoints).
**Change process:** response shape change ⇒ update Laravel API Resource + `packages/types` + `openapi.yaml` in the same PR.

## 1. Base & versioning
- Base URL `https://api.storeplix.com/api/v1` (local `http://localhost:8010/api/v1`).
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
  | `/webhooks/{provider}/{route_key}` (5b) | provider-specific (§10) | from the 32-char route key (definer lookup) |
  | `/payments/return/{bkash\|sslcommerz}/{payment}` (5b) | Laravel signed URL (26 h) | from the signed payment id |
  | `/documents/{document}/download`, `/exports/{export}/download` | Laravel signed URL (5 min) | from the signature |
  | `/dev/*` (5b, testing only, §10.3) | none | from the path id |
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
| 401 | `unauthenticated`, `invalid_storefront_key`, `invalid_api_key` (Phase 8.4) | missing/invalid token or key |
| 402 | `plan_limit_reached`, `feature_not_in_plan`, `subscription_inactive` | plan gate (FeatureGate) |
| 403 | `forbidden`, `tenant_forbidden` (not a member of `X-Tenant-Id`), `tenant_suspended`, `cannot_change_own_role`, `permission_not_held` (+ `details.permissions`, Phase 8.3 N1/N2/N5/N6), `cannot_edit_own_role` (Phase 8.3 N3), `api_key_scope_missing` (+ `details.required_scope`, Phase 8.4), `invitation_email_mismatch`, `email_not_verified`, `impersonation_receipt_hidden` (Phase 8.7: receipt link in an impersonation session) | authenticated but not allowed |
| 404 | `not_found`, `store_not_found`, `invitation_invalid`, `cart_not_found`, `unsubscribe_link_invalid` (Phase 8.5), `recovery_link_invalid` (Phase 8.6), `receipt_not_found` (Phase 8.7) | missing **or belongs to another tenant** |
| 409 | `conflict`, `revision_conflict`, `stock_changed`, `import_in_progress`, `category_has_children`, `category_limit_reached`, `store_limit_reached`, `last_owner`, `already_member`, `invitation_pending`, `invitation_not_pending`, `login_required`, `media_in_use`, `currency_locked`, `idempotency_key_in_use`, `idempotency_key_mismatch`, `invalid_state_transition`, `checkout_changed`, `store_not_live`, `launch_blocked`, `coupon_in_use`, `system_role_locked`, `role_in_use` (+ `details.members`, `details.invitations`), `role_limit_reached` (Phase 8.3), `suppression_customer_owned` (Phase 8.5), `automation_exists`, `automation_not_draft` (Phase 8.6), `receipt_processing` (Phase 8.7), `order_held`, `order_not_held`, `already_blocked` (Phase 8.8a); `currency_locked` is enforced from Phase 8.7 (store has an order or an expense, PHASE-8-7 P87-18) | state conflict |
| 413 | `payload_too_large` | body/upload over the endpoint limit |
| 419 | `csrf_token_mismatch` | cookie-session write without a valid `X-XSRF-TOKEN` (Phase 4.7) |
| 422 | `validation_failed` (+ `details`), `out_of_stock`, `coupon_invalid`, `insufficient_stock`, `unsupported_file`, `too_many_rows`, `too_many_columns`, `empty_file`, `cart_empty`, `payment_method_unavailable`, `refund_exceeds_paid`, `scope_not_grantable`, `limit_reached`, `webhook_url_not_allowed` (Phase 8.4), `campaign_quiet_hours`, `campaign_unknown_merge_field`, `campaign_too_long`, `campaign_coupon_inactive`, `campaign_no_recipients` (Phase 8.5), `automation_incomplete` (Phase 8.6), `export_too_large` (Phase 8.7, + `details.limit`), `cod_unavailable`, `order_limit_reached`, `otp_required`, `otp_invalid` (Phase 8.8a, + `details.attempts_left`) | validation / business rule |
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

**Phase 5b codes** (PHASE-5B-CONTRACT §4.0, as built 2026-11-22):
| HTTP | code | When |
|---|---|---|
| 409 | `gateway_busy` | disconnect a gateway that still has `pending` charges or refunds |
| 409 | `courier_busy` | disconnect a courier that still has non-final shipments |
| 409 | `payment_link_active` | a second active payment link for one order |
| 409 | `payment_not_pending` | `POST /storefront/orders/pay` on an order that isn't `pending_payment` or whose 30-min hold expired |
| 409 | `shipment_booked` | book again / edit items while the order has an active courier shipment |
| 409 | `courier_cancel_unsupported` | the courier API can't cancel this parcel; cancel in the courier panel, then `mark-cancelled` |
| 409 | `return_not_allowed` | return on an order that isn't delivered, or the quantities are already returned |
| 422 | `advance_required` | COD checkout in a shop that requires the delivery charge in advance, without `advance_gateway` |
| 422 | `gateway_not_connected` | gateway **or courier** not connected / not enabled for this action (booking, shipment refresh, payment link, exchange `send_payment_link.provider`); also gateway `PATCH` / `test-payment` on a provider with no account |
| 422 | `credentials_invalid` | the provider rejected the credentials on connect/test (`details["credentials.<field>"]` when the provider names it), or on a shipment refresh |
| 422 | `courier_rejected` | the courier refused the booking or cancellation (sanitised courier message) |
| 422 | `gateway_refund_rejected` | the gateway refused a refund (amount, window, partial not allowed) |
| 422 | `total_below_paid` | edited items would make the order total lower than the net paid amount |
| 502 | `provider_unavailable` | gateway/courier timeout, 5xx or transport error on a synchronous call (nothing changed, or the reconcile job finishes it) |

Reused codes: `payment_method_unavailable` (checkout and `orders/pay` with a method the store hasn't enabled),
`out_of_stock`, `refund_exceeds_paid`, `plan_limit_reached` (courier connections, exchange orders),
`feature_not_in_plan` (bulk booking), `invalid_state_transition`, `revision_conflict`, `forbidden` (staff sending
`cod_amount`, staff creating an exchange whose difference needs a refund), `rate_limited` (§8), `unauthenticated`
(courier webhook with a bad secret, §10), `idempotency_key_*`.

5b as-built rules:
- **No `webhook_unauthorized` on the wire.** It is the courier driver's internal error code; the HTTP answer is
  401 `unauthenticated` ("Invalid webhook credentials.").
- **Missing integration account:** courier endpoints (`PATCH`, `test`, `webhook-secret`, `DELETE`, `areas`,
  `pickup-stores`) on a provider that is not connected (no row, or `disconnected`) → **404 `not_found`**. Gateways:
  `PATCH` and `test-payment` → **422 `gateway_not_connected`**; `DELETE` → **404 `not_found`**. `{provider}` outside
  the allowlist → 404 (route constraint).
- Courier area lookups that the courier refuses answer `422 validation_failed` on the offending query field, not
  `courier_rejected`.

**Phase 6 codes** (PHASE-6-CONTRACT §4.0, custom domains):
| HTTP | code | When |
|---|---|---|
| 404 | `domain_not_allowed` | `GET /internal/domains/allowed`: host not allowed, unknown or malformed (identical body for all) |
| 409 | `domain_not_active` | make primary a domain that isn't `active` |
| 409 | `platform_domain_locked` | remove or re-check a platform subdomain (`{slug}.storeplix.com`) |
| 422 | `domain_invalid` | not a usable public hostname: syntax, scheme/path/port, IP literal, single label, a public suffix itself, special-use TLD, invalid IDN (`details.hostname`) |
| 422 | `domain_reserved` | the platform domain or a subdomain of it, `storeplix.com`, the CNAME target, a configured reserved suffix |
| 422 | `domain_taken` | the hostname is on this store already or held by another store and not reclaimable (PHASE-6 P6-6) |
Reused: `feature_not_in_plan` / `plan_limit_reached` (402: `custom_domain` feature, `custom_domains` limit),
`invalid_state_transition` (re-check a suspended domain), `unauthenticated` (`ask` without a valid key),
`rate_limited`. The domain re-check never answers 502: resolver/provider errors are recorded on the row
(`failure_code`) and the request still returns 200.

**Phase 7 codes** (PHASE-7-CONTRACT §6.0, monetization):
| HTTP | code | When |
|---|---|---|
| 409 | `plan_unchanged` | `POST /billing/change-plan` (or quote) to the current plan and interval |
| 409 | `invoice_overdue` | a plan change other than Free while the subscription is `past_due` (pay the overdue invoice first) |
| 409 | `invoice_not_open` | pay a `paid` or `void` invoice |
| 422 | `plan_unavailable` | unknown or inactive plan, an interval the plan doesn't offer, or a change PHASE-7 §3.3 refuses (`details.plan_code`) |
| 422 | `billing_gateway_unavailable` | pay with a provider the platform hasn't configured |
Every 402 (`plan_limit_reached`, `feature_not_in_plan`) may add `details.upgrade_plan: ["<plan code>"]` = the cheapest
plan that would allow the action (P7-17). `subscription_inactive` stays reserved and unused (P7-4: non-payment drops to
Free). Reused: `provider_unavailable` (502 on initiate or invoice PDF), `feature_not_in_plan` (Profit report),
`idempotency_key_*`. Limiter `billing`: 20/min per tenant + user on billing writes, `pay` also 10/min per tenant.
Public billing callbacks: `GET|POST /billing/payments/return/{provider}/{payment}` (signed, 303 to the merchant app,
limiter `payment-returns`) and `POST /billing/webhooks/sslcommerz` (always 200 `WebhookAck`, limiter `webhooks`).

**Phase 8.4 codes** (PHASE-8-4-CONTRACT §6.3, developer API keys and outbound webhooks):
| HTTP | code | When |
|---|---|---|
| 401 | `invalid_api_key` | `/external/*` without `Authorization: Bearer sp_live_…`, malformed, unknown or revoked key — one identical body for all (S101) |
| 403 | `api_key_scope_missing` | the key lacks the route's scope (`details.required_scope`, an array, e.g. `["orders:write"]`) |
| 422 | `scope_not_grantable` | `POST /api-keys` with a scope whose backing permission the actor doesn't hold (`details.scopes`) |
| 422 | `limit_reached` | an 11th active API key per tenant or a 6th webhook endpoint per store (P84-14) |
| 422 | `webhook_url_not_allowed` | endpoint URL not https, credentials in the URL, blocked port, or a host resolving to a private/loopback/link-local/CGNAT/metadata/multicast/ULA address |
| 409 | `webhook_endpoint_disabled` | `POST …/webhook-endpoints/{endpoint}/test` on a disabled endpoint |
Reused: `feature_not_in_plan` (402, `details.upgrade_plan: ["growth"]`: external API and developer writes without
`api_webhooks`), `tenant_suspended` (403 on `/external/*`), `idempotency_key_required` (external order status and stock
adjustment), `rate_limited`. Merchant routes answer an API key with 401 `unauthenticated` (they never accept one).

**Phase 8.5 codes** (PHASE-8-5-CONTRACT §6.3, marketing campaigns and opt-out):
| HTTP | code | When |
|---|---|---|
| 422 | `campaign_quiet_hours` | schedule into, or "send now" during, 21:00–09:00 store time (`details.allowed_from`, ISO date-time of the next 09:00) |
| 422 | `campaign_unknown_merge_field` | body/subject contains a `{…}` other than `{name}`, `{coupon}`, `{shop_link}`, `{product}` (`details.fields`) |
| 422 | `campaign_too_long` | SMS over 5 parts including prefix and footer (`details.parts`, `details.max_parts`) |
| 422 | `campaign_coupon_inactive` | `{coupon}` used with a coupon that is not active (or none selected) |
| 422 | `campaign_no_recipients` | schedule / send while the audience preview is 0 |
| 409 | `suppression_customer_owned` | merchant `DELETE …/customers/{customer}/marketing-opt-out/{channel}` on a shopper-owned (`link`) suppression |
| 404 | `unsubscribe_link_invalid` | `GET|POST /storefront/unsubscribe/{code}` with an unknown, malformed or other-store code (one identical body) |
Reused: `invalid_state_transition`, `revision_conflict`, `store_not_live` (409), `limit_reached` (422: 50 non-terminal
campaigns per store), `plan_limit_reached` (402, `details.campaign_sms_per_month` / `details.campaign_emails_per_month`
`{limit, used, needed}`, `details.upgrade_plan` on Free), `idempotency_key_*` (schedule / send), `rate_limited`.

**Phase 8.6 codes** (PHASE-8-6-CONTRACT §9.3, automations and checkout recovery):
| HTTP | code | When |
|---|---|---|
| 409 | `automation_exists` | `POST /stores/{store}/automations` for a recipe the store already has (one per recipe, P86-1) |
| 409 | `automation_not_draft` | `DELETE …/automations/{automation}` on an automation that is not a never-run `draft` |
| 422 | `automation_incomplete` | `POST …/{automation}/enable` with required settings missing (`details.fields`, e.g. `["coupon_id"]` for the VIP message) |
| 404 | `recovery_link_invalid` | `POST /storefront/carts/recover` with an unknown, malformed or other-store code, a run not `running`/`waiting`/`completed`, or an ended window (one identical body) |
Reused: `validation_failed` (unknown settings keys, conditions outside the recipe's list, bad phone on cart contact),
`revision_conflict` (PATCH), `feature_not_in_plan` (402, `details.feature = sms_automation`: create, enable, PATCH of an
`on` automation, test message), `plan_limit_reached` (402, test message over the shared allowance),
`campaign_unknown_merge_field`, `campaign_too_long` (> 3 SMS parts / > 3,000 email chars), `campaign_coupon_inactive`,
`cart_not_found` (cart contact without an active cart with lines), `rate_limited`.

**Phase 8.8a codes** (PHASE-8-8-CONTRACT §8.4, fake-order guard):
| HTTP | code | When |
|---|---|---|
| 409 | `order_held` | confirm, bulk confirm (per-order skip reason), ready, courier booking (single; bulk per-order failure) or the external API `→ confirmed` while `orders.guard_hold` is set (P88-2) |
| 409 | `order_not_held` | `POST …/orders/{order}/guard/release` on an order without a hold |
| 409 | `already_blocked` | `POST …/fraud-guard/blocked-numbers` for a phone with an active entry |
| 422 | `cod_unavailable` | storefront COD checkout from a blocked number (neutral message; online payment still works) |
| 422 | `order_limit_reached` | the (`daily_limit` + 1)-th storefront COD order of a phone in one store day (P88-11) |
| 422 | `otp_required` | COD checkout without `otp_code` after `POST /storefront/checkout/otp` answered `required: true` |
| 422 | `otp_invalid` | wrong or expired code (`details.attempts_left`; 0 → request a new code) |
Reused: `feature_not_in_plan` (402, `details.feature = fake_order_guard`: settings/blocklist writes, number check),
`validation_failed` (settings ranges, `advance_below < hold_below`, phone, note), `impersonation_read_only`,
`rate_limited`.

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

**API keys (Phase 8.4, ADR 0018):** only `/api/v1/external/*` accepts `Authorization: Bearer sp_live_<40 base62>`; no
session, no CSRF, `X-Tenant-Id` ignored (the key fixes the tenant). Scope per route (PHASE-8-4 §2.2, §3); merchant
routes never accept a key and external routes never accept a session.

**Preview token (D2):** `POST /stores/{store}/preview-token` → 201 `{data:{token, url, expires_at}}`; 60-min signed token
bound to the store; see STOREFRONT-ENGINE §4.1.

## 8. Rate limits (Redis, per tenant)
| Limiter | Key | Limit |
|---|---|---|
| `auth` (login/register/forgot) | email + IP | 5/min, 20/hour |
| `merchant` | tenant + user (IP before login) | 300/min (amended 2026-11-22, QA 5a F-L6; was 120) |
| `merchant-bulk` (imports/exports) | tenant | 10/hour |
| `storefront` (whole `/storefront/*` group) | store host + shopper IP (IPv4, or IPv6 /64) **and** store host; a request without a valid storefront key: request IP only (`sf-keyless:`), never the host bucket | 300/min per host + IP (only when a trusted `X-Storefront-Client-Ip` is present; else a warning is logged once per host per 5 min) **and** 3 000/min per host; keyless 300/min per IP. Env `THROTTLE_STOREFRONT_PER_IP`, `THROTTLE_STOREFRONT_PER_HOST` (5b-1, P5B-9; replaces the 5a 1 200/min host-only limit) |
| `checkout` (`POST /storefront/checkout`, **and** `POST /storefront/orders/pay`) | store host + shopper IP; store host + normalised phone (`contact.phone`, only when it parses) | 10/min; 5 per 10 min |
| `cart` (all `/storefront/cart*` routes and `GET /storefront/orders/confirmation`) | store host + shopper IP | 60/min |
| `order-track` (`POST /storefront/orders/track`) | store host + shopper IP | 10/min |
| `geo` (`GET /geo/bd`, public, no auth) | request IP | 60/min |
| `POST /stores/{store}/publish` | inline `throttle:20,1` | 20/min |
| `pay-link` (`GET /storefront/payment-links/{token}`, `POST …/pay`) | store host + shopper IP (IPv6 /64) | 20/min |
| `webhooks` (all `/webhooks/*`) | route key; sender IP | 600/min per route key **and** 300/min per IP |
| `payment-returns` (`/payments/return/*`) | request IP | 60/min |
| Payment-link resend (`POST …/payment-links/{link}/resend`, in code) | link (tenant-prefixed cache key) | 3/hour |
| Shipment refresh (`POST /stores/{store}/shipments/{shipment}/refresh`, in code) | shipment | 6/min |
| Shipments sync (`POST /stores/{store}/shipments/sync`, in code) | store | 1/min |
| `domains` (Phase 6: `POST`/`DELETE` under `/stores/{store}/domains…`) | tenant + user | 30/min |
| Domain re-check (`POST …/domains/{domain}/verify`, in code) | domain (tenant-prefixed cache key) | 6/min **and** 30/hour |
| `domains-ask` (`GET /internal/domains/allowed`) | request IP | 1 200/min |
| `external-api` (Phase 8.4, all `/external/*`) | API key id (tenant-prefixed) | 120/min per key; `RateLimit-*` headers, 429 `rate_limited` + `Retry-After` |
| Webhook secret reveal (`POST /stores/{store}/webhook-secret/reveal`, Phase 8.4) | user | 10/min |
| `storefront-unsubscribe` (Phase 8.5, `GET|POST /storefront/unsubscribe/{code}`) | shopper IP (`X-Storefront-Client-Ip`, trusted with a valid storefront key; IPv6 /64) | 20/min (on top of `storefront`) |
| `campaign-preview` (Phase 8.5, `POST /stores/{store}/campaigns/audience-preview`) | tenant + user | 30/min |
| `campaign-test` (Phase 8.5, `POST /stores/{store}/campaigns/{campaign}/test`) | tenant + user | 5/hour |
| `storefront-cart-contact` (Phase 8.6, `PUT /storefront/cart/contact`) | shopper IP (`X-Storefront-Client-Ip`, as unsubscribe) | 10/min (on top of `storefront`) |
| `storefront-cart-recover` (Phase 8.6, `POST /storefront/carts/recover`) | shopper IP | 20/min (on top of `storefront`) |
| `automation-dry-run` (Phase 8.6, `POST /stores/{store}/automations/{automation}/dry-run`) | tenant + user | 30/min |
| `automation-test` (Phase 8.6, `POST /stores/{store}/automations/{automation}/test-message`) | tenant + user | 5/hour |
| `expenses-write` (Phase 8.7, `POST`/`PATCH`/`DELETE` `/stores/{store}/expenses…`) | tenant + user | 60/min |
| `expense-receipts` (Phase 8.7, `POST /stores/{store}/expenses/receipts`) | tenant + user | 20/min |
| `expense-receipts.download` (Phase 8.7, signed `GET /expense-receipts/{media}/download`) | request IP | 60/min |
| `fraud-check` (Phase 8.8a, `POST /stores/{store}/fraud-guard/check`) | tenant + user | 30/min |
| `checkout-otp` (Phase 8.8a, `POST /storefront/checkout/otp`) | store + normalised phone; store + shopper IP | 5/hour per phone; 20/hour per IP (on top of `storefront`) |
| Checkout OTP attempts (Phase 8.8a, not HTTP) | OTP row | 5 wrong codes → `otp_invalid` with `attempts_left: 0`, a new code is needed; resend after 60 s; code TTL 5 min |
| Automation frequency cap (Phase 8.6, in the `automations` queue, not HTTP) | store + channel + address | ≤ 2 automation marketing messages per rolling 24 h across automations → step `skipped/frequency_cap` (campaign messages not counted) |
| Campaign send rate (Phase 8.5, in the `campaigns` queue, not HTTP) | store; platform | SMS 10/s per store (`campaigns.sms_rate_per_second`) and 50/s platform-wide (`campaigns.platform_sms_rate_per_second`); email 20/s per store — over the limit the job is released, never dropped |
| Inline `throttle:N,1` (5b) | Laravel default signature: **the user id** (public routes: domain + IP) | gateway connect, gateway test-payment, courier connect / test / webhook-secret, `shipments/bulk`: 20/min; `documents/preview`, courier `pickup-stores`: 30/min; courier `areas`: 120/min; signed `documents/{document}/download`, `dev/*`: 60/min |
Auth routes (login, register, password reset, OTP send/verify) use per-route limiters; their exact values are
maintained in `apps/api/README.md` (the table above is indicative). Responses include `X-RateLimit-Limit`,
`X-RateLimit-Remaining`; every 429 has body `{error:{code, message, retry_after}}` (`rate_limited` or `otp_rate_limited`)
and a `Retry-After` header with the same seconds. Limits scale with plan (Phase 7).
Phase 5a limiters live in `apps/api/app/Domain/Orders/CommerceServiceProvider.php`; the storefront ones key on
`X-Storefront-Host` (lowercased) and the shopper IP from `X-Storefront-Client-Ip` (trusted only with a valid storefront
key). The cart, checkout, track and pay-link limiters apply on top of the route group's `storefront` limiter. 5b named
limiters (`pay-link`, `webhooks`, `payment-returns`) live in the same provider; `storefront` lives in
`AppServiceProvider`. The in-code limits (resend, refresh, sync) answer 429 `rate_limited` with `retry_after` like the
middleware. **Caveat (as built):** inline `throttle:N,1` limiters without a prefix share one counter per user across
every inline-throttled merchant route (each route compares that shared count with its own N), so e.g. 30 area lookups
block `shipments/bulk` for the rest of the minute. Tracked as a code fix (named or prefixed limiters).

Phase 8.7 envelope exception: `GET /stores/{store}/expenses/export` answers `text/csv` (attachment, formula-safe cells
via `CsvCell`) like the import template and document downloads; its errors keep the JSON envelope. The signed receipt
download `GET /expense-receipts/{media}/download` streams the file (tenant from the signature, as `documents.download`).

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
- **Phase 5b scopes:** `storefront.pay` (`POST /storefront/orders/pay`), `storefront.link-pay`
  (`POST /storefront/payment-links/{token}/pay`), `payment-links.create`, `payment-gateways.test`
  (`…/test-payment`), `shipments.book` (`POST …/orders/{order}/shipments`), `returns.exchange`
  (`POST …/returns/{return}/exchange-order`). `PUT …/orders/{order}/items` uses `revision`, not a key.
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
**Inbound** (`POST /api/v1/webhooks/{provider}/{route_key}`, Phase 5b): verify signature / validation
API / source IP per provider before anything else; store in `webhook_events` (unique `provider,event_id`); respond 200
fast; process in `webhooks` queue (tenant-aware); never trust payload amounts — re-query provider (ADR 0007).

**Outbound** (Phase 8.4, PHASE-8-4 §4, ADR 0018): merchant-configured endpoints receive `POST` JSON events (payload
version `2026-12-01`) with `X-Storeplix-Event`, `X-Storeplix-Delivery` (same across retries; receivers dedupe) and
`X-Storeplix-Signature: t=<unix>,v1=<hex>`, `v1 = HMAC-SHA256(secret, "<t>.<raw body>")` (a second `v1=` with the
previous secret for 24 h after a rotation). Any 2xx within 10 s is success; retries at +1 min, +5 min, +30 min, +2 h,
+6 h, +12 h, then `failed`; 72 h of failures auto-disables the endpoint. Sent from queue `webhooks-out` through the
SSRF-safe `OutboundWebhookClient`.

### 10.1 Phase 5b inbound endpoints (as built)
`{route_key}` is a random 32-char `[A-Za-z0-9]` key per integration account, shown on the Integrations page; it
resolves tenant + store + account through a definer function. No tenant header. Bodies are `{ "data": { "received":
true } }` and never carry tenant data. Throttle `webhooks` (§8).

| Path | Auth | Answers |
|---|---|---|
| `POST /webhooks/sslcommerz/{route_key}` (IPN) | route key; `verify_sign` (md5, SSLCommerz SDK scheme) is a **pre-filter only** — every IPN is confirmed with the Validation API in the job | 200 ack; a bad `verify_sign` is stored as `ignored` (still 200); no `tran_id` → 200, nothing stored; unknown key → 404. Never 401 |
| `POST /webhooks/bkash/{route_key}` (SNS-style, optional) | route key; a trigger for Query Payment only (a forged message can't change anything). `SubscriptionConfirmation` is confirmed only for an `https://sns.<region>.amazonaws.com` `SubscribeURL` | 200 ack for any body; unknown key → 404. Never 401 |
| `POST /webhooks/steadfast/{route_key}` | `Authorization: Bearer {secret}` (sha256 + `hash_equals`) | 200 ack; bad/missing secret → **401 `unauthenticated`**, nothing stored, `webhook.rejected` log |
| `POST /webhooks/pathao/{route_key}` | `X-PATHAO-Signature` = secret | **202** ack with Pathao's `X-Pathao-Merchant-Webhook-Integration-Secret` header; `webhook_integration` test event acknowledged and not stored; bad secret → 401 `unauthenticated` |
| `POST /webhooks/redx/{route_key}` | — | **404** until the RedX driver declares webhook support (VERIFY) |

**401 vs 404:** 404 `not_found` when the provider doesn't take webhooks, the route key is unknown, or it belongs to
another provider's account — decided before any credential check. 401 only for a known courier account with a
missing/wrong secret. An authenticated but unreadable courier payload is acknowledged (200/202) and logged, not stored.
Duplicate `event_id` → same ack, no effect.

**Webhook secrets** (Steadfast, Pathao) are issued by us: `PUT /stores/{store}/couriers/{provider}` returns
`meta.webhook_secret` once (the key is always present; `null` for RedX and for a reconnect that keeps the existing
secret); `POST …/webhook-secret` rotates (old secret invalid at once). Only a hint is ever shown again.

### 10.2 Gateway browser returns (as built)
`GET|POST /payments/return/{bkash|sslcommerz}/{payment}` — public, throttle `payment-returns`. The URL is a Laravel
**temporary signed route, 26 h**, built relative and prefixed with `PUBLIC_API_URL` (tunnel-safe).
Verification reads the **first** `expires` / `signature` of the raw query string (bKash appends its own `signature`).
SSLCommerz gets **one** signed URL for `success_url`, `fail_url` and `cancel_url`; the outcome comes from the POSTed
`status` (an optional `r=success|fail|cancel` hint outside the signature is still read). Query/body values are
triggers only: the API verifies with the provider (Execute/Query, Validation API) before any state change.
Answers: valid → **303** to `https://{primary_host}/checkout/payment-result?payment={id}` (`/pay/result?payment=` for
link payments; test payments → the merchant app `/settings/payments?test_payment={id}`; a store with no primary
domain → 200 HTML "Thank you"); bad/expired signature → **403** HTML page, no redirect; unknown payment, wrong
provider or not a charge → **404** HTML page. Redirect targets come only from the DB, never from the request.

### 10.3 Testing-only dev endpoints
`POST /dev/payments/{payment}/expire-now`, `GET /dev/fake-gateway/{payment}` + `POST …/{pay|fail|cancel}` (signed),
`POST /dev/shipments/{shipment}/advance`, (Phase 6) `POST /dev/domains/{domain}/dns`, `…/provider`, `…/age`, and (Phase 8.4)
`GET /dev/webhook-sink` (fake outbound sender sink, `WEBHOOKS_OUT_FAKE=true`, `perm:developers.manage`), and (Phase 8.5)
`GET /dev/stores/{store}/message-sink` (rendered campaign/test messages, last 200 per store, `CAMPAIGNS_DEV_SINK=true`,
`perm:marketing.manage`; the API refuses to boot in production with the sink on; Phase 8.6 adds automation messages with
`automation_id` set and `campaign_id` null):
registered **only outside production** (`APP_ENV != production`) and answer **404** unless `PAYMENTS_FAKE=true`
(payments), `COURIERS_FAKE=true` (shipments) or `DOMAINS_FAKE=true` (domains; PHASE-6-CONTRACT §4.4). They exist for e2e and local
work, are never linked from the apps, and are **not** part of `openapi.yaml`.
### 10.4 Internal endpoints (Phase 6)
`/api/v1/internal/*` is server-to-server only and must not be routed by the public Nginx (RUNBOOK §9). Today:
`GET /internal/domains/allowed?domain={host}&key={DOMAINS_ASK_KEY}` (Caddy on-demand TLS `ask`, PHASE-6 P6-17): 200
`{data:{allowed:true}}` or 404 `domain_not_allowed`; bad/missing key → 401 `unauthenticated`. The key is a query
parameter only because Caddy can't send headers; access logs for this path must drop the query string. No tenant
header, no session, `Cache-Control: no-store`. Cloudflare for SaaS is poll-only in Phase 6: there is no
`/webhooks/cloudflare/*` route (OPEN-QUESTIONS Q74).

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

# Phase 8.4 contract: Developer API keys + outbound webhooks (binding for API, WEB, QA)

Status: **Accepted, 2026-11-24 (PO accepted the proposed defaults for Q126–Q137)**. Branch `feat/phase-8-4-developer-api` (from `main` @ d60997c, Phase 8.3 merged).
Roadmap task **8.4** "Developer API keys + outbound webhooks (Figma 144:40725)"; AC: **"HMAC signatures; retries"**.
Tasks 8.5–8.9 are **not** in this contract.

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1/8-2/8-3 contracts and
docs/api/API-CONVENTIONS.md still applies (envelope, snake_case, ULIDs, cookie sessions, `BelongsToTenant`, RLS,
FeatureGate, `perm:` on every tenant route, audit log). Where this file changes an earlier rule it says **"amends …"**.
Machine-readable spec: `docs/api/openapi.yaml` **v1.12.0**. ADR **0018** (new: API keys and outbound webhooks).
Product defaults: OPEN-QUESTIONS **Q126–Q137**.

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-4-qa.md`). No external provider; outbound HTTP has a fake
driver (`WEBHOOKS_OUT_FAKE`) for local/e2e, refused in production.

| Area | Owner | Ships |
|---|---|---|
| **API keys** | API-KEYS | `api_keys` table; create (shown once) / list / rename / revoke; 7 scopes; sha256 storage; `developers.manage` permission (§2, §5, §6) |
| **External API** | API-KEYS | `/api/v1/external/...` authenticated by `Authorization: Bearer sp_live_…`; scope per route; 120 req/min per key; same response shapes as the merchant API (§3) |
| **Outbound webhooks** | API-HOOKS | `webhook_endpoints`, `webhook_secrets`, `webhook_deliveries`; 10 event types; HMAC-SHA256 signature; retries for 24 h; SSRF-safe sender with fake driver; deliveries log, resend, test event (§4, §5, §6) |
| **Developer page** | WEB | `/integrations/developer` (`144:40726`): plan note, API keys card, Webhooks card, Signing secret, Recent deliveries + log, docs card; modals; Integrations list "Developer" banner (§7) |
| **Docs + types** | ARCH | openapi 1.12.0, `packages/types`, `packages/api-client`, ADR 0018, DATABASE-DESIGN, SECURITY T34, API-CONVENTIONS, MULTI-TENANCY, OPEN-QUESTIONS, FIGMA-INDEX, roadmap (§8) |
| **QA** | QA | Playwright `phase8-4.*`, CI Pest group `developer-api`, TESTING.md, gate report (§10) |

**Out of scope** (hide, never fake): test-mode keys `sp_test_` (Q127), Postman collection (Q134), OAuth apps,
per-key IP allowlists, write scopes for customers and shipments (Q128), webhook payload versions other than `2026-12-01`,
super-admin views of keys/webhooks (Q136), merchant-provided transformation of payloads.

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Actor" = the signed-in member.
- "Key" = an API key row; "plain key" = the full secret string shown once.
- `P(x)` = resolved permission set (PHASE-8-3).

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit. Touch only owned files (§11). Before every Edit of a shared-read file, re-read it (another agent may have
  changed it).
- New dependencies: **none**.
- Never `migrate:fresh` the local dev DB; use Pest or a scratch DB. RLS items run on Postgres with `TENANCY_RLS=true`.

---

## 0. Summary and goals
Merchants on Growth connect their own tools (accounting, warehouse apps, Zapier): **API keys** give scoped, revocable,
server-to-server access to a small external API; **webhooks** push signed JSON events with retries. Both are tenant-
isolated, audited, rate limited and plan-gated (`api_webhooks`, Growth, already seeded in Phase 7 and not enforced
until now — amends PHASE-7 §2.1 row "api_webhooks: not enforced").

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P84-1 | Keys are **tenant-level** (`/api/v1/api-keys`), bound to the tenant's single store at use time; external routes still carry `/stores/{store}/` | One store per tenant today; URLs stay valid when multi-store lands |
| P84-2 | Plain key = `sp_live_` + 40 base62 chars (≈238 bits). Stored: `key_hash` = sha256 hex (unique), `prefix` = first 12 chars (`sp_live_` + 4), `last_four`. Never stored or logged in plain; shown **once** in the create response | Same pattern as courier webhook secrets (T28); Figma `gs_live_` is the old brand prefix |
| P84-3 | Lookup before tenant context via definer function `sp_api_key_owner(p_hash text)` → `(tenant_id, key_id)` only for non-revoked keys (RLS-safe pre-tenant path, like `sp_route_key_owner`) | RLS: app role can't read `api_keys` without a tenant |
| P84-4 | **Separate route namespace** `/api/v1/external/...` with its own middleware stack (`apikey`, `scope:`), thin controllers that reuse the existing services, Form Requests and API Resources. The merchant routes are unchanged and never accept API keys | No mixed-auth on merchant routes; responses identical in shape |
| P84-5 | 7 scopes (§2.2). Non-delegation: the creator can grant a scope only if `P(actor)` holds its backing permission | Same rule as N-rules of 8.3 |
| P84-6 | New permission **`developers.manage`** (group `store`, sensitive): O and A by default, grantable to custom roles; S never | A key is a credential; staff must not mint them |
| P84-7 | Webhook endpoints and the signing secret are **store-scoped** `[S]`; **one signing secret per store** (Figma shows one) | Matches Figma; simpler for receivers |
| P84-8 | Signature header `X-Storeplix-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC_SHA256(secret, "<t>.<raw body>")`. During 24 h after a rotation a second `v1=` with the previous secret is appended | Stripe-style, replay window checkable by receivers |
| P84-9 | Retries: attempt 1 immediately, then +1 min, +5 min, +30 min, +2 h, +6 h, +12 h (7 attempts, ≈ 20.6 h); still failing → `failed` (no later attempts; "Failed deliveries retry for 24 hours") | Figma copy; bounded |
| P84-10 | Success = any 2xx within 10 s (connect 5 s). No redirects followed. Response body: first 1 KB kept (scrubbed of control chars) | SSRF/T14 |
| P84-11 | An endpoint whose deliveries have all failed for **72 h** (no 2xx since its first failure in that window) is **auto-disabled** (`disabled_reason = failing`), audit `webhook_endpoint.auto_disabled`; merchant re-enables manually | Protects queue; visible in UI |
| P84-12 | Payloads are snapshots built with the **same API Resources** as the external API GET of that object, at event time, after commit | Receivers can use one model |
| P84-13 | Plan downgrade: nothing deleted. Without `api_webhooks`: external API → 402 `feature_not_in_plan`; no new deliveries are created (events dropped, not queued); pending retries are marked `failed` with `error = plan`; management endpoints readable, writes → 402 | Phase 7 downgrade rule |
| P84-14 | Limits: ≤ 10 active (non-revoked) keys per tenant, ≤ 5 endpoints per store → 422 `limit_reached` | Abuse bound |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q126–Q137; defaults accepted by the PO 2026-11-24)

| Q | Question | Proposed default |
|---|---|---|
| Q126 | Plan | Growth only (`api_webhooks`), trial included; Figma "Pro plan" copy → "Growth plan" |
| Q127 | Test-mode keys (`gs_test_`)? | Not in 8.4 (no platform test mode); revoked keys keep their prefix as shown |
| Q128 | Scope catalogue | §2.2 (7 scopes); no customer/shipment writes in 8.4 |
| Q129 | Event catalogue | Figma's 10 (§4.1) + `ping` (test only) |
| Q130 | Key expiry | None (revoke manually); `last_used_at` updated at most once per minute |
| Q131 | Who may create keys/endpoints | `developers.manage` (O, A; custom grantable) with scope non-delegation |
| Q132 | Reveal signing secret | Yes, for `developers.manage`, audited; Rotate keeps the old secret valid 24 h |
| Q133 | Retry/auto-disable | P84-9, P84-11 |
| Q134 | Docs card | "API reference" → `DEVELOPER_DOCS_URL` (hidden when unset); "Rate limits" text card; Postman hidden; header "API docs" button = same URL |
| Q135 | Delivery log retention | 30 days (`webhooks:prune-deliveries` daily) |
| Q136 | Super admin | No 8.4 screens; tenant detail unchanged |
| Q137 | Mobile | Responsive composition: cards stack below `lg`; tables scroll inside their card |

## 2. Permission and scopes

### 2.1 New permission (amends PHASE-8-3 §2.1; 23 grantable keys + `billing.manage`)
`developers.manage` — group `store`, after `domains.manage`; sensitive; label "Manage API keys & webhooks";
`SystemRole`: owner ✓, admin ✓, staff ✗. Requires nothing. `RoutePermissionsTest` gains the §6.1 rows.

### 2.2 Scopes (`ApiScope` enum, UI order; label = Figma tag)

| Scope | Label | Backing permission (P84-5) | Grants |
|---|---|---|---|
| `orders:read` | Orders · read | `orders.view` | list/get orders |
| `orders:write` | Orders · write | `orders.process` | status actions (§3), implies `orders:read` |
| `products:read` | Products | `products.edit` **or** base read (`perm:base`) → base | list/get products, categories |
| `products:write` | Products · write | `products.edit` | create/update products (not delete), implies `products:read` |
| `inventory:read` | Stock | base | list inventory |
| `inventory:write` | Stock · write | `inventory.adjust` | adjustments, implies `inventory:read` |
| `customers:read` | Customers · read | `customers.view` | list/get customers |

A key's scopes are stored as given (normalized, de-duplicated, implied read added). Unknown scope → 422.

## 3. External API (owner API-KEYS) — `routes/external.php`

Middleware stack: `apikey` (auth + tenant + RLS GUCs), `throttle:external-api`, `scope:<scope>`, `SubstituteBindings`
after tenant (other tenant's / store's ids → 404). **No** session, no CSRF, no `X-Tenant-Id` (ignored).

`apikey` middleware: header `Authorization: Bearer <plain>` must match `^sp_live_[A-Za-z0-9]{40}$`, else 401
`invalid_api_key`; sha256 → `sp_api_key_owner()`; unknown/revoked → 401 `invalid_api_key` (same body); tenant
suspended → 403 `tenant_suspended`; plan lacks `api_webhooks` → 402 `feature_not_in_plan` (`upgrade_plan: growth`).
Sets `TenantContext` with role kind `api_key`, permission set = scopes' backing permissions, `actor` = the key.
`last_used_at` updated (throttled 1/min, no `updated_at` bump). Successful responses carry `RateLimit-Limit`/`-Remaining`/`-Reset`.

Rate limiter `external-api`: 120/min per key id (`RateLimit-*` + `Retry-After` on 429, code `rate_limited`).

| Method | Path (`/api/v1/external`) | Scope | Reuses |
|---|---|---|---|
| GET | `/me` | (any key) | → `{ data: ApiKeyIdentity }`: key id, name, scopes, tenant_id, store {id, name, currency} |
| GET | `/stores/{store}/orders` | `orders:read` | merchant order list filters (status, updated_since, page, per_page ≤ 100) + `OrderResource` |
| GET | `/stores/{store}/orders/{order}` | `orders:read` | order detail resource |
| POST | `/stores/{store}/orders/{order}/status` | `orders:write` | body `{ status }` ∈ transitions the merchant state machine allows except refund/cancel-with-refund; requires `Idempotency-Key` |
| GET | `/stores/{store}/products` | `products:read` | product list + resource |
| GET | `/stores/{store}/products/{product}` | `products:read` | product detail |
| POST | `/stores/{store}/products` | `products:write` | product create (plan product limit applies) |
| PATCH | `/stores/{store}/products/{product}` | `products:write` | product update |
| GET | `/stores/{store}/categories` | `products:read` | category list |
| GET | `/stores/{store}/inventory` | `inventory:read` | inventory list (sku, updated_since filters) |
| POST | `/stores/{store}/inventory/adjustments` | `inventory:write` | adjustment (ledger row, reason required); requires `Idempotency-Key` |
| GET | `/stores/{store}/customers` | `customers:read` | customer list (phone/email search) |
| GET | `/stores/{store}/customers/{customer}` | `customers:read` | customer detail |

Actor recording: `audit_logs.actor_type = 'api_key'` (exists), `actor_id` = key id; `order_events`,
`inventory_movements` and any other actor-typed table written by these routes gain `'api_key'` in their actor CHECK
(migration, §5.2) with `actor_id` = key id and display name "API: <key name>". Costs (`cost_amount`) are omitted from
responses unless the creator held `costs.view` at creation (`api_keys.include_costs`).

## 4. Outbound webhooks (owner API-HOOKS)

### 4.1 Events (`WebhookEventType` enum; UI order = Figma "Events you can send")
`order.created`, `order.confirmed`, `order.cancelled`, `order.paid`, `shipment.updated`, `shipment.delivered`,
`return.received`, `product.updated`, `stock.low`, `customer.created`; plus `ping` (only from "Send test event").

| Event | Fired when (after commit) | `data.object` |
|---|---|---|
| order.created | order placed (storefront checkout, merchant create, payment-link order) | order |
| order.confirmed / order.cancelled | status transition to `confirmed` / `cancelled` | order |
| order.paid | order payment state becomes fully paid (verified, never from a redirect) | order |
| shipment.updated | any shipment status change | shipment |
| shipment.delivered | shipment → `delivered` (in addition to `shipment.updated`) | shipment |
| return.received | return request → `received` | return request |
| product.updated | product created or updated (merchant, import, external API) | product |
| stock.low | a variant's `on_hand` crosses from `> low_stock_threshold` to `≤` it (once per crossing) | inventory row |
| customer.created | new customer row | customer |

> **Amended by PHASE-8-8C part A (Phase 8.8c, P88C-15, Q219):** an inventory row is now one variant at one location,
> so `stock.low` fires **per location row** (subject = the row; the crossing is that row's `on_hand` against that row's
> threshold). The payload object gains `location: {id, name}`; existing fields keep their meaning for that row. The 8.6
> Low stock alert recipe fires the same way and its message gains "at {location}" when the store has > 1 location.

Emission: domain code calls `WebhookEvents::emit(WebhookEventType, Model $subject)` (one line per emit point);
it records nothing when the store has no active endpoint subscribed, or the plan lacks `api_webhooks`.

### 4.2 Payload (version `2026-12-01`)
```json
{ "id": "<ulid delivery event id>", "type": "order.paid", "api_version": "2026-12-01",
  "created_at": "2026-12-01T10:42:00Z", "store_id": "<ulid>", "data": { "object": { … } } }
```
Headers: `Content-Type: application/json`, `User-Agent: Storeplix-Webhooks/1.0`, `X-Storeplix-Event`,
`X-Storeplix-Delivery` (delivery id; same across retries — receivers dedupe), `X-Storeplix-Signature` (P84-8).
Body ≤ 256 KB (larger → object trimmed to ids + `truncated: true`).

### 4.3 Sending
Queue `webhooks-out` (new Horizon supervisor), job `DeliverWebhook` is `TenantAware`, unique per delivery id.
`OutboundWebhookClient`: https only (http only when `WEBHOOKS_OUT_ALLOW_HTTP=true`, refused in production); resolve
DNS, refuse private/loopback/link-local/CGNAT/metadata/multicast/IPv6 ULA ranges, **pin** the resolved IP for the
connection (no rebinding); no redirects; 5 s connect / 10 s total; port 443 or 1024–65535 except well-known internal
ports listed in config. URL validated on save with the same rules (422 `webhook_url_not_allowed`), and re-checked at
send time. `WEBHOOKS_OUT_FAKE=true` → no HTTP: the fake records the request in a dev sink readable at
`GET /api/v1/dev/webhook-sink` (non-production only, `perm:developers.manage`) and answers per URL path suffix:
`/fail-503` → 503, `/timeout` → timeout, otherwise 200.

### 4.4 Delivery lifecycle
`webhook_deliveries.status`: `pending` → `succeeded` | `retrying` → … → `failed`. Attempts counted; `next_attempt_at`
per P84-9; `response_status`, `response_body_excerpt`, `error_code` (`timeout`, `connection_failed`,
`url_not_allowed`, `http_error`, `plan`, `endpoint_disabled`), `duration_ms`, `last_attempt_at`. Disabled or deleted
endpoint → pending deliveries `failed` with `endpoint_disabled`. Resend creates a **new delivery row** with the stored
payload unchanged (same event `id` in the body, new delivery id in `X-Storeplix-Delivery`); no audit row.
"Resend failed (n)" = failed deliveries of the last 24 h for the store that no later delivery of the same event to the same endpoint has superseded, max 100 per call.
Scheduler: `webhooks:dispatch-due` every minute (safety net for retries), `webhooks:prune-deliveries` daily (30 d),
`webhooks:auto-disable` hourly (P84-11).

## 5. Data (migrations, prefix `2026_12_01_`, forward-only; RLS in the create migration; tables added to `RlsTables::TENANT` and the emergency script by API-KEYS)

### 5.1 New tables
- **api_keys** (tenant) — API-KEYS, `000100`: id · tenant_id · name varchar(60) · prefix varchar(12) · last_four
  char(4) · key_hash char(64) **U** · scopes jsonb (array) · include_costs boolean default false · created_by_user_id FK
  users null on delete · last_used_at, revoked_at timestamptz null · revoked_by_user_id null · timestamps.
  Index `(tenant_id, revoked_at)`. Definer function `sp_api_key_owner(p_hash text)` (same migration).
- **webhook_endpoints** [S] — API-HOOKS, `000200`: id · tenant_id · store_id · url varchar(2048) · description
  varchar(120) null · events jsonb · is_active boolean default true · disabled_reason varchar(24) null (`manual`,
  `failing`) · failing_since timestamptz null · last_delivery_at timestamptz null · last_status smallint null ·
  timestamps. Index `(tenant_id, store_id, is_active)`.
- **webhook_secrets** [S] — API-HOOKS, `000200`: id · tenant_id · store_id **U** · secret_encrypted text
  (IntegrationCredentials encrypter) · last_four char(4) · previous_secret_encrypted text null · previous_expires_at
  timestamptz null · rotated_at timestamptz null · timestamps. Created lazily on first endpoint or first GET.
- **webhook_deliveries** [S] — API-HOOKS, `000200`: id · tenant_id · store_id · endpoint_id FK(t,s) cascade · event_id
  char(26) · event_type varchar(40) · subject_type varchar(24) · subject_id char(26) null · subject_label varchar(40)
  null (e.g. order number `GS-1048`) · payload jsonb · status varchar(12) CHECK · attempts smallint · next_attempt_at,
  last_attempt_at timestamptz null · response_status smallint null · response_body_excerpt varchar(1024) null ·
  error_code varchar(32) null · duration_ms int null · created_at, updated_at. Indexes `(tenant_id, store_id,
  created_at desc)`, `(status, next_attempt_at)`, `(endpoint_id, created_at)`.

### 5.2 Changed (API-KEYS, `000300`)
Actor CHECKs on `order_events`, `inventory_movements` (and any other actor-typed table the external routes write) add
`'api_key'`. Role catalogue backfill: system roles get `developers.manage` per §2.1 (code-defined, no row change for
system roles; custom roles unchanged).

## 6. Merchant API (amends PHASE-8-3 §3 with the rows below; openapi 1.12.0 binding)

### 6.1 Endpoints (all `auth:sanctum` + `surface:merchant,impersonation` + `tenant`; writes need `api_webhooks`)
| Method | Path | perm | Notes |
|---|---|---|---|
| GET | `/api/v1/api-keys` | `developers.manage` | active first, then revoked (last 90 d) |
| POST | `/api/v1/api-keys` | `developers.manage` | `{name, scopes[], include_costs?}` → 201 `{data: ApiKey & {plain_key}}` (only here) ; audit `api_key.created` |
| PATCH | `/api/v1/api-keys/{key}` | `developers.manage` | rename only; audit `api_key.renamed` |
| DELETE | `/api/v1/api-keys/{key}` | `developers.manage` | revoke (idempotent; row kept) → 200 key; audit `api_key.revoked` |
| GET | `/api/v1/api-scopes` | `developers.manage` | catalogue `{key,label,group,backing_permission,implies[]}` + `grantable` for the actor |
| GET | `/api/v1/stores/{store}/webhook-endpoints` | `developers.manage` | each with `success_rate_7d` (null when no deliveries), `last_delivery_at`, `last_status`, `failing_since` |
| POST | `/api/v1/stores/{store}/webhook-endpoints` | `developers.manage` | `{url, events[], description?}`; audit `webhook_endpoint.created` |
| PATCH | `/api/v1/stores/{store}/webhook-endpoints/{endpoint}` | `developers.manage` | `{url?, events?, description?, is_active?}`; audit `webhook_endpoint.updated` |
| DELETE | `/api/v1/stores/{store}/webhook-endpoints/{endpoint}` | `developers.manage` | hard delete (deliveries cascade); audit `webhook_endpoint.deleted` |
| POST | `/api/v1/stores/{store}/webhook-endpoints/{endpoint}/test` | `developers.manage` | sends `ping` now → 202 delivery |
| GET | `/api/v1/stores/{store}/webhook-secret` | `developers.manage` | `{last_four, rotated_at, previous_expires_at}` |
| POST | `/api/v1/stores/{store}/webhook-secret/reveal` | `developers.manage` | `{secret}`; audit `webhook_secret.revealed`; throttle 10/min |
| POST | `/api/v1/stores/{store}/webhook-secret/rotate` | `developers.manage` | `{secret}` (new, once) ; audit `webhook_secret.rotated` |
| GET | `/api/v1/stores/{store}/webhook-deliveries` | `developers.manage` | filters `endpoint_id`, `status`, `event_type`; cursor page 25; without payload |
| GET | `/api/v1/stores/{store}/webhook-deliveries/{delivery}` | `developers.manage` | with payload, request headers (signature redacted), response excerpt |
| POST | `/api/v1/stores/{store}/webhook-deliveries/{delivery}/resend` | `developers.manage` | 202 new delivery |
| POST | `/api/v1/stores/{store}/webhook-deliveries/resend-failed` | `developers.manage` | `{count}` queued (P84 §4.4) |
| GET | `/api/v1/webhook-event-types` | `developers.manage` | catalogue `{key,label,description}` |

Keys routes → `routes/developer-keys.php` (API-KEYS). Webhook routes → `routes/developer-webhooks.php` (API-HOOKS).
`TenantMembership.permissions` naturally includes `developers.manage`; `/auth/me` unchanged otherwise.

### 6.2 Shapes (summary; openapi binding)
- `ApiKey { id, name, prefix, last_four, masked ("sp_live_••••7f2a"), scopes[], include_costs, status ("active"|"revoked"),
  created_at, created_by {id,name}|null, last_used_at, revoked_at }`; create adds `plain_key`.
- `WebhookEndpoint { id, url, description, events[], is_active, disabled_reason, failing_since, last_delivery_at,
  last_status, success_rate_7d (0–100 one decimal, null), created_at, updated_at }`.
- `WebhookSecret { last_four, masked ("whsec_••••3kQ9"), rotated_at, previous_expires_at }`; reveal/rotate add `secret`
  (`whsec_` + 32 base62).
- `WebhookDelivery { id, endpoint_id, event_id, event_type, subject_label, status, attempts, next_attempt_at,
  last_attempt_at, response_status, error_code, duration_ms, created_at }`; detail adds `payload`, `request_headers`,
  `response_body_excerpt`.

### 6.3 Error codes (API-CONVENTIONS §3 gains them)
`invalid_api_key` (401), `api_key_scope_missing` (403, `details.required_scope`: array of scope keys, any of which suffices), `scope_not_grantable` (422,
`details.scopes`), `limit_reached` (422, exists? reuse if present else new), `webhook_url_not_allowed` (422),
`webhook_endpoint_disabled` (409, test event on a disabled endpoint), `feature_not_in_plan` (402, exists).

## 7. Merchant dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`, frame `144:40726`

Route `/integrations/developer`, nav under Integrations (Integrations list gets the "Developer · API & webhooks" banner
card linking here, hidden without `developers.manage`). Page gated on `developers.manage` (else Forbidden state).
- **Header**: title "Developer · API & webhooks", subtitle per Figma; "API docs" (hidden when no docs URL) and
  "+ Create API key".
- **Plan note** (`144:41323`): shown when plan lacks `api_webhooks` ("API keys and webhooks are part of the Growth plan."
  + See plans → `/settings/plan`, all create/edit buttons disabled) or during trial ("…You're trying them free until
  <trial_ends_at>.").
- **API keys card**: table NAME (name + "Created <d MMM> by <name>" / "Revoked <d MMM>"), KEY (masked, mono), ACCESS
  (scope tags; revoked → "Revoked" pill), LAST USED (relative, "—"), row menu (Rename, Revoke with confirm). Empty state.
- **Create key modal**: name, scope checkboxes grouped (read/write per resource; implied reads auto-checked; non-grantable
  disabled with tooltip), include costs (only if actor has `costs.view`). Success step: plain key once with Copy and
  "I've stored it" — closing never shows it again.
- **Webhooks card**: ENDPOINT (url truncated + "Last delivery <rel> · <status>" or red "Failing since <time> · <status>"),
  EVENTS (first 2 tags + "+n"), SUCCESS · 7 DAYS pill (green ≥ 95 %, amber ≥ 80, red "<n>% · failing" when
  `failing_since`), row menu (Edit, Send test event, Disable/Enable, Delete). "+ Add endpoint" modal: URL, events
  checklist (select all), description. Footer "Events you can send:" tags from the catalogue.
- **Signing secret card**: masked, eye → reveal (calls reveal), copy, "Rotate secret" with confirm explaining the 24 h
  overlap; shows the new secret once.
- **Recent deliveries card**: last 5 (status pill code or error, "event · subject_label", time), "Log" → deliveries drawer
  (filters, paginated, detail with payload/headers/response, Resend), "Resend failed (n)" when n > 0.
- **Build with Storeplix card**: API reference (docs URL, hidden when unset), Rate limits "120 requests / minute per key";
  Postman row hidden (Q134).
- States: loading skeletons, empty, error per `148:34032`; 375 px usable (Q137). Tokens only.
- Super admin: nothing.

## 8. ARCH and types (owner ARCH)
openapi **1.12.0** (all §3 and §6 paths, schemas, `ApiKeyAuth` security scheme for `/external`), `packages/types`
(`ApiKey`, `ApiKeyCreated`, `ApiScope`, `ApiScopeInfo`, `WebhookEndpoint`, `WebhookSecret`, `WebhookSecretRevealed`,
`WebhookDelivery`, `WebhookDeliveryDetail`, `WebhookEventType`, `WebhookEventTypeInfo`, inputs; `PermissionKey` gains
`developers.manage`), `packages/api-client` methods for every §6.1 endpoint, ADR 0018, DATABASE-DESIGN §5.x rows (replace
the §6 sketch), SECURITY T34 (S100–S112), API-CONVENTIONS §3 codes + §8 limiter, MULTI-TENANCY (definer function row),
OPEN-QUESTIONS Q126–Q137, FIGMA-INDEX row 144:40725 → built, roadmap 8.4 line. **Types first** (WEB depends on them).

## 9. Security checklist (S100–S112; each has a test)
- **S100** plain key never persisted/logged/returned after create; DB holds sha256 only (column scan test, log scan).
- **S101** unknown, malformed, revoked key → identical 401; timing via hash lookup only.
- **S102** key of tenant A with `/stores/{B store}/…` or B's order id → 404; parity of `assertTenantIsolation` for all
  external GETs.
- **S103** scope enforcement: every external route declares exactly one `scope:` (route test); missing → 403
  `api_key_scope_missing`.
- **S104** external routes refuse session cookies (no `auth:sanctum`); merchant routes refuse API keys (401).
- **S105** non-delegation: creator without `orders.process` can't grant `orders:write` (422); staff can't reach key
  routes (403); custom role with `developers.manage` but only `orders.view` → can grant `orders:read` only.
- **S106** plan: no `api_webhooks` → external 402, writes 402, no deliveries created; nothing deleted on downgrade.
- **S107** SSRF: URLs to `localhost`, `127.0.0.1`, `10/8`, `169.254.169.254`, `[::1]`, `fd00::/8`, DNS name resolving
  to a private IP, `http://` in production config, redirects → refused on save and at send.
- **S108** signature: receiver verification test with the documented algorithm; previous secret valid ≤ 24 h after
  rotation, not after.
- **S109** secret encrypted at rest (not plaintext in DB); reveal/rotate audited; staff 403.
- **S110** deliveries tenant/store isolated (RLS + scope); job runs in the delivery's tenant (`TenantAware`).
- **S111** rate limit 121st request/min per key → 429; keys don't share buckets.
- **S112** fake sink and `WEBHOOKS_OUT_FAKE` / `WEBHOOKS_OUT_ALLOW_HTTP` refuse to boot in production.

## 10. Test requirements
**API (Pest; group `developer-api`; RLS items also `rls`, security `security`)**: CRUD + validation + authz + isolation
for every §6.1 route; every §3 route happy path + scope deny + cross-tenant 404; S100–S112; event emission per §4.1
(one test per event); retry schedule with a frozen clock; auto-disable; prune; resend; signature vector test (fixed
secret/body/t → known hex); RoutePermissionsTest rows; external route scope test.
**Web (Vitest)**: Developer page renders keys/endpoints/deliveries from fixtures; create key shows plain key once;
scope implication + non-grantable disabled; plan note variants; failing pill; permission gating.
**QA (Playwright `tests/e2e/specs/phase8-4.*.spec.ts`, fake driver)**: create key → call `/external/me` and orders with
it → revoke → 401; add endpoint (fake sink) → place order → `order.created` delivered with valid signature; failing
endpoint `/fail-503` → retrying → resend; staff cannot see the page; Free plan shows plan note and 402; 390 px screenshot.

## 11. File ownership for Phase 8.4

| Agent | Owns (create/edit) |
|---|---|
| **API-KEYS** | `apps/api`: `app/Domain/Developer/ApiKeys/**`, `app/Domain/Developer/External/**` (controllers, middleware `apikey`, `scope`), `routes/developer-keys.php`, `routes/external.php`, migrations `2026_12_01_000100`, `000300`, `Tenancy/Authorization/Permission` + `SystemRole` (+`developers.manage`), `RlsTables` + `database/sql/rls-emergency-off.sql` (all four new tables), `bootstrap/app.php` aliases, `AppServiceProvider` limiter `external-api`, actor plumbing in Orders/Inventory services (minimal), RoutePermissionsTest + parity fixture rows, `tests/Feature/Developer/ApiKeys/**`, `tests/Feature/Developer/External/**` |
| **API-HOOKS** | `apps/api`: `app/Domain/Developer/Webhooks/**` (models, `WebhookEvents::emit`, payload builder, `OutboundWebhookClient`, fake + dev sink, jobs, console commands, controllers, requests, resources), `routes/developer-webhooks.php`, migration `000200`, one-line emit calls in Orders/Payments/Couriers/Returns/Catalog/Inventory/Customers services, `config/webhooks_out.php`, Horizon supervisor + `routes/console.php` schedule lines, `tests/Feature/Developer/Webhooks/**` |
| **ARCH** | `docs/**` except `docs/reviews/**` and TESTING.md; `packages/types/**`, `packages/api-client/**` |
| **WEB** | `apps/merchant-dashboard/**`, `packages/ui/**` |
| **QA** | `tests/e2e/**` (`phase8-4.*`), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-4-qa.md` |

Shared-read rule: API-HOOKS needs resources for payloads — use the existing merchant API Resources; API-KEYS must not
rename them. Both API agents edit service files in Orders/Inventory: re-read before each Edit, keep edits minimal.

## 12. Order of work
1. ARCH: types + api-client first (§8), then openapi, ADR and docs.
2. API-KEYS: migration 000100 + `developers.manage` + RlsTables (all 4 tables) first, then key API, then external API.
3. API-HOOKS: migration 000200 → client + fake → emit/payload → jobs/retries → endpoints API → schedule.
4. WEB: page against §6.2 shapes (types from ARCH), fixtures for tests.
5. QA: specs + CI group while the others build; gate after all are green.

## 13. Acceptance criteria
1. **HMAC signatures:** every delivery carries a verifiable `X-Storeplix-Signature`; rotation overlap works.
2. **Retries:** P84-9 schedule, then `failed`; resend and resend-failed work; auto-disable after 72 h.
3. API keys: shown once, sha256 at rest, scoped, revocable, non-delegable, rate limited, audited, Growth-gated.
4. External API: §3 routes, identical resource shapes, tenant/store isolation, scope per route.
5. Developer page matches `144:40726` with the documented omissions; loading/empty/error; 375 px usable.
6. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `developer-api`, `rls`,
   `security`), Playwright `phase8-4.*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

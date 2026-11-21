# Database Design

Status: Accepted (Phase 0). Engine: **PostgreSQL 16+**. ADR 0001. Read MULTI-TENANCY.md first.

## 1. Why PostgreSQL (not MySQL 8)
1. **Row-Level Security** — native defense-in-depth for a shared-schema SaaS; MySQL has no equivalent.
2. **Partial & expression indexes** — e.g. `UNIQUE (tenant_id, sku) WHERE deleted_at IS NULL`,
   `UNIQUE (lower(email))`; MySQL needs generated-column workarounds.
3. **`jsonb` + GIN** — theme configs, page sections, product attributes, provider payloads are queryable
   and validatable (`CHECK (jsonb_typeof(config)='object')`).
4. **Transactional DDL** — failed migrations roll back cleanly.
5. **Composite FKs, `CHECK` constraints, deferrable constraints, `timestamptz`, `citext`** all first-class.
6. Full-text search (`tsvector`) is good enough for product search until a dedicated engine is warranted.
Contract already fixes Postgres on port 5432. MySQL is not supported; no MySQL-compat code paths.

## 2. Global conventions
| Rule | Detail |
|---|---|
| PK | `id char(26)` ULID, app-generated (`HasUlids`). Sortable by creation time. |
| Tenant column | `tenant_id char(26) NOT NULL` on every tenant-owned table, FK → `tenants.id ON DELETE RESTRICT`. |
| Tenant key for composite FKs | Every tenant-owned parent table has `UNIQUE (tenant_id, id)`. Children reference `(tenant_id, parent_id) → parent(tenant_id, id)`. This makes a cross-tenant reference **impossible** at DB level. |
| Store key (D1) | One store per tenant today, but **store-scoped** tables (marked `[S]` below) also have `store_id char(26) NOT NULL` with composite FK `(tenant_id, store_id) → stores(tenant_id, id)`, and expose `UNIQUE (tenant_id, store_id, id)`; their children reference `(tenant_id, store_id, parent_id) → parent(tenant_id, store_id, id)`, so a row can't point at another store's row. Business uniques are per store (e.g. `U(store_id, sku)`). Store-scoped: store_domains, store_settings, store_themes, store_pages, store_navigation, redirects, categories, products, product_variants, product_images, product_categories, inventories, inventory_movements, customers, customer_addresses, carts, cart_items, shipping_methods, coupons, orders, order_items, order_status_history, payments, payment_gateway_accounts, shipping_orders, idempotency_keys, store_counters. Tenant-scoped only: tenant_users, media, subscriptions, subscription_items, invoices, audit_logs (nullable `store_id` column for filtering, no FK requirement). |
| Indexes | Lead with `tenant_id`. Every FK column is indexed (composite with `tenant_id`). On `[S]` tables every listed `IX(tenant_id, x…)` is implemented as `IX(tenant_id, store_id, x…)`. |
| Timestamps | `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`. |
| Soft deletes | `deleted_at timestamptz` only on: `products`, `product_variants`, `categories`, `customers`, `store_pages`, `stores`, `tenants`. Unique constraints on those are partial `WHERE deleted_at IS NULL`. Orders/payments are never deleted. |
| Money | `*_amount bigint NOT NULL` in minor units (BDT poisha) + `currency char(3)`. `CHECK (amount >= 0)` where applicable. |
| Enums | `varchar(32)` + `CHECK (col IN (...))`, mirrored by PHP backed enums. (No PG enum types — painful to alter.) |
| Strings | `varchar(n)` with explicit limits; emails `citext`. |
| JSON | `jsonb`, with `CHECK (jsonb_typeof(x) = 'object')`. |
| Booleans | `boolean NOT NULL DEFAULT false`. |
| Extensions | `citext`, `pg_trgm` (product search fuzzy), `btree_gin`. |

Notation below: **PK** primary key, **FK(t)** composite tenant FK `(tenant_id, col) → table(tenant_id, id)`,
**U** unique, **IX** index. Every tenant-owned table also implicitly has `U(tenant_id, id)` and `IX` on `tenant_id`.

## 3. ERD (core)

```mermaid
erDiagram
  TENANTS ||--|| STORES : owns
  TENANTS ||--o{ TENANT_USERS : has
  USERS ||--o{ TENANT_USERS : member
  STORES ||--o{ STORE_DOMAINS : "served at"
  STORES ||--|| STORE_SETTINGS : has
  STORES ||--o{ STORE_THEMES : has
  THEMES ||--o{ STORE_THEMES : instantiates
  STORES ||--o{ STORE_PAGES : has
  STORES ||--o{ STORE_NAVIGATION : has
  STORES ||--o{ PRODUCTS : sells
  PRODUCTS ||--o{ PRODUCT_VARIANTS : has
  PRODUCTS ||--o{ PRODUCT_IMAGES : has
  MEDIA ||--o{ PRODUCT_IMAGES : file
  PRODUCTS ||--o{ PRODUCT_CATEGORIES : in
  CATEGORIES ||--o{ PRODUCT_CATEGORIES : groups
  CATEGORIES ||--o{ CATEGORIES : parent
  PRODUCT_VARIANTS ||--|| INVENTORIES : stock
  INVENTORIES ||--o{ INVENTORY_MOVEMENTS : ledger
  STORES ||--o{ CUSTOMERS : has
  CUSTOMERS ||--o{ CUSTOMER_ADDRESSES : has
  CUSTOMERS ||--o{ CARTS : has
  CARTS ||--o{ CART_ITEMS : contains
  PRODUCT_VARIANTS ||--o{ CART_ITEMS : refs
  CUSTOMERS ||--o{ ORDERS : places
  ORDERS ||--o{ ORDER_ITEMS : contains
  PRODUCT_VARIANTS ||--o{ ORDER_ITEMS : snapshot
  ORDERS ||--o{ ORDER_STATUS_HISTORY : log
  ORDERS ||--o{ PAYMENTS : paid_by
  SHIPPING_METHODS ||--o{ ORDERS : chosen
  ORDERS ||--o{ SHIPPING_ORDERS : shipped_as
  COUPONS ||--o{ ORDERS : applied
  PLANS ||--o{ SUBSCRIPTIONS : priced
  TENANTS ||--o{ SUBSCRIPTIONS : subscribes
  SUBSCRIPTIONS ||--o{ SUBSCRIPTION_ITEMS : has
  SUBSCRIPTIONS ||--o{ INVOICES : bills
  TENANTS ||--o{ AUDIT_LOGS : records
  USERS ||--o{ AUDIT_LOGS : actor

  TENANTS { char26 id PK; string name; string status }
  STORES { char26 id PK; char26 tenant_id FK; string slug UK; string status }
  STORE_DOMAINS { char26 id PK; char26 tenant_id FK; char26 store_id FK; string hostname UK; string status }
  USERS { char26 id PK; citext email UK; string platform_role }
  TENANT_USERS { char26 id PK; char26 tenant_id FK; char26 user_id FK; string role }
  PRODUCTS { char26 id PK; char26 tenant_id FK; char26 store_id FK; string slug; string type; string status }
  PRODUCT_VARIANTS { char26 id PK; char26 tenant_id FK; char26 product_id FK; string sku; bigint price_amount }
  INVENTORIES { char26 id PK; char26 tenant_id FK; char26 variant_id FK; int on_hand; int reserved }
  ORDERS { char26 id PK; char26 tenant_id FK; char26 store_id FK; string number; string status; bigint total_amount }
  PAYMENTS { char26 id PK; char26 tenant_id FK; char26 order_id FK; string provider; string status }
```

## 4. Platform tables (no tenant_id)

### users
| col | type | notes |
|---|---|---|
| id | char(26) PK | |
| name | varchar(120) | |
| email | citext | **U** |
| phone | varchar(20) null | E.164 |
| password | varchar(255) | argon2id |
| email_verified_at, phone_verified_at | timestamptz null | |
| platform_role | varchar(32) null | `CHECK IN ('super_admin','support','finance')`; null = normal user |
| two_factor_secret, two_factor_recovery_codes | text null | encrypted cast |
| last_login_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

### tenants
id PK · name varchar(160) · status varchar(32) `CHECK IN ('active','suspended','closed')` default active ·
owner_user_id char(26) FK users RESTRICT · country char(2) · default_currency char(3) default 'BDT' ·
timezone varchar(64) default 'Asia/Dhaka' · trial_ends_at timestamptz null · deleted_at · timestamps.
IX(status). IX(owner_user_id).

### plans
id PK · code varchar(40) **U** · name · price_amount bigint · currency char(3) · interval varchar(16)
`CHECK IN ('month','year')` · trial_days smallint · limits jsonb (`{"products":100,"staff":2,"custom_domain":true,...}`) ·
features jsonb · is_active boolean · sort smallint · timestamps.

### themes (platform registry mirror)
id PK · code varchar(40) **U** (`classic`, `minimal`) · name · latest_version varchar(16) · is_active ·
preview_image_url · timestamps. Theme code/schemas live in the storefront repo; this table controls availability.

### personal_access_tokens
Laravel Sanctum default, `tokenable_id char(26)`. `expires_at` set at issue from `SANCTUM_EXPIRATION` (default 10080 min = 7 days, not sliding, D3); `sanctum:prune-expired --hours=24` daily.

## 5. Tenant-owned core tables

### tenant_users
id PK · tenant_id FK tenants · user_id FK users · role varchar(32) `CHECK IN ('owner','admin','staff')` ·
status `CHECK IN ('invited','active','disabled')` · invited_by char(26) null · timestamps.
**U(tenant_id, user_id)**. IX(user_id). Partial **U(tenant_id) WHERE role='owner'** (exactly one owner).
Phase 8: `role_id` → `roles` for custom roles (Figma Staff & roles).

### stores
id PK · tenant_id · name varchar(160) · slug varchar(63) · status `CHECK IN ('draft','active','suspended')` ·
country char(2) · currency char(3) · business_category varchar(64) null · logo_media_id, favicon_media_id FK(t) media null ·
published_at timestamptz null · deleted_at · timestamps.
**U(slug) WHERE deleted_at IS NULL** (global — slug is a subdomain). **U(tenant_id)** — exactly one store per tenant
(D1, revised). **U(tenant_id, id)** (composite FK target). `store_id` columns on store-scoped tables are kept so multi-store
can be enabled later by dropping `U(tenant_id)`.
`CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$')`.

### store_domains
id PK · tenant_id · store_id FK(t) stores CASCADE · hostname varchar(253) (normalized) · type
`CHECK IN ('platform','custom')` · is_primary boolean · status `CHECK IN ('pending_verification','verification_failed','verified','ssl_provisioning','active','expired','suspended')` ·
verification_token varchar(64) · verification_method `CHECK IN ('txt','cname','http')` · verified_at, ssl_issued_at,
ssl_expires_at, last_checked_at timestamptz null · check_attempts int default 0 · failure_reason varchar(255) null ·
provider_hostname_id varchar(64) null (Cloudflare custom hostname id) · timestamps.
**U(hostname)** (global — one host maps to one store). Partial **U(store_id) WHERE is_primary**. IX(status, last_checked_at).

### store_settings (1:1 store)
id PK · tenant_id · store_id FK(t) **U** · contact_email citext null · contact_phone · address jsonb ·
social_links jsonb · seo_title varchar(70) · seo_description varchar(160) · og_image_media_id null ·
checkout jsonb (`guest_checkout`, `cod_enabled`, `min_order_amount`) · tax jsonb (`inclusive`, `rate_bps`) ·
locale varchar(10) default 'en' · timestamps.

### store_themes
id PK · tenant_id · store_id FK(t) · theme_code varchar(40) FK themes(code) · theme_version varchar(16) ·
draft_config jsonb · published_config jsonb null · published_at timestamptz null · is_active boolean · timestamps.
**U(store_id, theme_code)**. Partial **U(store_id) WHERE is_active**. CHECK jsonb object.

### store_pages
id PK · tenant_id · store_id FK(t) · slug varchar(120) · title varchar(160) · type
`CHECK IN ('custom','about','contact','policy','faq')` · sections jsonb (same section schema as theme) ·
body_html text null (sanitized server-side) · seo jsonb · status `CHECK IN ('draft','published')` · deleted_at · timestamps.
**U(store_id, slug) WHERE deleted_at IS NULL**.

### store_navigation
id PK · tenant_id · store_id FK(t) · location `CHECK IN ('header','footer')` · items jsonb
(`[{label, type:'url'|'page'|'category'|'product', ref, children:[]}]`, max depth 2) · timestamps.
**U(store_id, location)**.

### media
id PK · tenant_id · disk varchar(16) · path varchar(255) · mime varchar(64) · size_bytes int · width, height int null ·
alt varchar(255) null · checksum char(64) · uploaded_by char(26) · timestamps. **U(path)**. IX(tenant_id, created_at).

### categories [S]
id PK · tenant_id · store_id · parent_id FK(t) categories null SET NULL · name varchar(120) · slug varchar(140) ·
description text null · image_media_id null · position int · is_visible boolean · seo jsonb · deleted_at · timestamps.
**U(store_id, slug) WHERE deleted_at IS NULL**. IX(tenant_id, parent_id, position).

### products [S]
id PK · tenant_id · store_id · name varchar(200) · slug varchar(220) · type `CHECK IN ('simple','variable')` ·
status `CHECK IN ('draft','active','archived')` · description_html text (sanitized) · short_description varchar(500) ·
brand varchar(120) null · tags text[] default '{}' · options jsonb (`[{name:'Size', values:['S','M']}]`) ·
seo jsonb · search tsvector GENERATED · published_at · deleted_at · timestamps.
**U(store_id, slug) WHERE deleted_at IS NULL**. IX(tenant_id, status, created_at). GIN(search). GIN(tags).
Price lives on variants; a simple product has exactly one variant (`is_default`).

### product_variants [S]
id PK · tenant_id · store_id · product_id FK(t) products CASCADE · sku varchar(64) null · barcode varchar(64) null ·
option_values jsonb (`{"Size":"M"}`) · price_amount bigint · compare_at_amount bigint null ·
cost_amount bigint null · currency char(3) · weight_grams int null · is_default boolean · position int ·
track_inventory boolean default true · allow_backorder boolean default false · deleted_at · timestamps.
**U(store_id, sku) WHERE sku IS NOT NULL AND deleted_at IS NULL**. IX(tenant_id, product_id).
CHECK(price_amount >= 0).

### product_images
id PK · tenant_id · product_id FK(t) CASCADE · variant_id FK(t) null · media_id FK(t) · position int · timestamps.
IX(tenant_id, product_id, position).

### product_categories (pivot)
tenant_id · product_id FK(t) CASCADE · category_id FK(t) CASCADE · position int. **PK(tenant_id, product_id, category_id)**.
IX(tenant_id, category_id, position).

### inventories (1:1 variant, single location until Phase 8 multi-location)
id PK · tenant_id · variant_id FK(t) **U** · on_hand int · reserved int default 0 · low_stock_threshold int null · timestamps.
CHECK(reserved >= 0). CHECK(on_hand >= 0 OR backorder allowed — enforced in app). Stock changes use
`UPDATE ... SET reserved = reserved + :q WHERE id=:id AND on_hand - reserved >= :q` (atomic, no race).

### inventory_movements (append-only ledger)
id PK · tenant_id · variant_id FK(t) · delta int · reason `CHECK IN ('manual','order_reserved','order_released','order_fulfilled','return','import','adjustment','pos_sale','transfer')` ·
reference_type varchar(32) null · reference_id char(26) null · actor_user_id null · note varchar(255) · created_at.
IX(tenant_id, variant_id, created_at).

### customers [S]
id PK · tenant_id · store_id · name varchar(120) · email citext null · phone varchar(20) null · password varchar(255) null
(null = guest) · accepts_marketing boolean · notes text · tags text[] · orders_count int · total_spent_amount bigint ·
risk_flags jsonb (fake-order guard later) · last_order_at · deleted_at · timestamps.
**U(store_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL**; **U(store_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL**.
Customers are per-store identities, never shared across stores or tenants.

### customer_addresses
id PK · tenant_id · customer_id FK(t) CASCADE · name · phone · line1 · line2 · area varchar(120) · city varchar(80) ·
district varchar(80) · postal_code varchar(10) · country char(2) · is_default boolean · timestamps.

### carts
id PK · tenant_id · store_id FK(t) · customer_id FK(t) null · token_hash char(64) (sha256 of opaque cart token) ·
currency char(3) · coupon_code varchar(40) null · status `CHECK IN ('active','converted','abandoned')` ·
expires_at timestamptz · timestamps. **U(token_hash)**. IX(tenant_id, status, updated_at).

### cart_items
id PK · tenant_id · cart_id FK(t) CASCADE · variant_id FK(t) · quantity int CHECK(1..999) · timestamps.
**U(cart_id, variant_id)**. Prices are never stored on cart items; always recomputed server-side.

### shipping_methods
id PK · tenant_id · store_id FK(t) · name varchar(80) · type `CHECK IN ('flat','free_over','zone')` ·
rate_amount bigint · currency char(3) · rules jsonb (zones: `inside_dhaka`/`outside_dhaka`, threshold) ·
courier_provider varchar(32) null · is_active · position · timestamps.

### coupons (Phase 5, needed by checkout)
id PK · tenant_id · code varchar(40) · type `CHECK IN ('percent','fixed','free_shipping')` · value int
(bps for percent, minor units for fixed) · min_subtotal_amount bigint null · usage_limit int null ·
usage_per_customer int null · used_count int · starts_at, ends_at · is_active · timestamps.
**U(store_id, upper(code))**.

### orders [S]
id PK · tenant_id · store_id FK(t) · number varchar(20) (per-store sequence, e.g. `1001`) · customer_id FK(t) null ·
status `CHECK IN ('pending_payment','pending','confirmed','processing','shipped','delivered','cancelled','returned','failed')` ·
payment_status `CHECK IN ('unpaid','authorized','paid','partially_refunded','refunded','failed')` ·
fulfillment_status `CHECK IN ('unfulfilled','partial','fulfilled')` · payment_method varchar(32) (`cod`,`bkash`,`sslcommerz`) ·
currency char(3) · subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount bigint ·
coupon_id FK(t) null · coupon_code varchar(40) null · shipping_method_id FK(t) null ·
customer_snapshot jsonb (name/email/phone) · shipping_address jsonb · billing_address jsonb null ·
notes text · source `CHECK IN ('storefront','pos','manual','inbox','api')` · ip inet · user_agent varchar(255) ·
idempotency_key varchar(64) · placed_at, cancelled_at timestamptz · timestamps.
**U(store_id, number)**. **U(store_id, idempotency_key)**. IX(tenant_id, status, placed_at DESC).
IX(tenant_id, customer_id). CHECK(total_amount = subtotal_amount - discount_amount + shipping_amount + tax_amount).
Order numbers from `store_counters(tenant_id, store_id, key, value)` row updated `... RETURNING value` in the order transaction.

### order_items
id PK · tenant_id · order_id FK(t) CASCADE · product_id FK(t) null SET NULL · variant_id FK(t) null SET NULL ·
product_name varchar(200) · variant_title varchar(120) · sku varchar(64) · unit_price_amount bigint · quantity int ·
discount_amount bigint · total_amount bigint · timestamps. IX(tenant_id, order_id). Snapshots so deletes never break history.

### order_status_history
id PK · tenant_id · order_id FK(t) · from_status, to_status varchar(32) · actor_type `CHECK IN ('user','customer','system','webhook')` ·
actor_id char(26) null · note varchar(500) · created_at. IX(tenant_id, order_id, created_at).

### payments
id PK · tenant_id · order_id FK(t) · provider varchar(32) (`cod`,`bkash`,`sslcommerz`,`nagad`) · type
`CHECK IN ('charge','refund')` · status `CHECK IN ('initiated','pending','authorized','succeeded','failed','cancelled','refunded')` ·
amount bigint CHECK(>0) · currency char(3) · provider_reference varchar(128) null · provider_payment_id varchar(128) null ·
idempotency_key varchar(64) · raw_request jsonb · raw_response jsonb (secrets stripped) · verified_at timestamptz null ·
failure_code varchar(64) · parent_payment_id FK(t) null (refund → charge) · timestamps.
**U(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL**. **U(tenant_id, idempotency_key)**. IX(tenant_id, order_id).

### payment_gateway_accounts (merchant credentials)
id PK · tenant_id · provider · mode `CHECK IN ('sandbox','live')` · credentials text (encrypted cast, never returned by API) ·
is_active · timestamps. **U(store_id, provider)**.

### shipping_orders (courier consignments)
id PK · tenant_id · order_id FK(t) · provider `CHECK IN ('pathao','steadfast','redx','manual')` · consignment_id varchar(64) ·
tracking_code varchar(64) · status `CHECK IN ('created','pending_pickup','picked_up','in_transit','delivered','returned','cancelled','failed')` ·
cod_amount bigint · delivery_fee_amount bigint · raw_response jsonb · last_synced_at · timestamps.
**U(provider, consignment_id)**. IX(tenant_id, order_id). IX(tenant_id, status).

### webhook_events (inbound, platform-level but tenant-tagged)
id PK · tenant_id null (resolved after verification) · provider · event_id varchar(128) · signature_valid boolean ·
payload jsonb · processed_at · error text · created_at. **U(provider, event_id)** — idempotent processing.

### idempotency_keys
id PK · tenant_id · key varchar(64) · scope varchar(64) (route) · request_hash char(64) · response_status smallint ·
response_body jsonb · locked_until timestamptz · created_at. **U(store_id, scope, key)** (store_id nullable for tenant-level routes; then **U(tenant_id, scope, key) WHERE store_id IS NULL**). Rows purged after 24 h.

### redirects (SEO)
id PK · tenant_id · store_id FK(t) · from_path varchar(512) · to_path varchar(512) · code smallint CHECK IN (301,302) · timestamps.
**U(store_id, from_path)**.

### subscriptions
id PK · tenant_id · plan_id FK plans · status `CHECK IN ('trialing','active','past_due','cancelled','expired')` ·
current_period_start, current_period_end, trial_ends_at, cancelled_at timestamptz · cancel_at_period_end boolean ·
provider varchar(32) · provider_subscription_id varchar(128) null · timestamps.
Partial **U(tenant_id) WHERE status IN ('trialing','active','past_due')**.

### subscription_items
id PK · tenant_id · subscription_id FK(t) · type `CHECK IN ('plan','addon')` · code varchar(40) · quantity int ·
unit_amount bigint · currency char(3) · timestamps.

### invoices (SaaS billing)
id PK · tenant_id · subscription_id FK(t) null · number varchar(24) **U** (global `SP-2026-000123`) · status
`CHECK IN ('draft','open','paid','void','uncollectible')` · subtotal_amount, tax_amount, total_amount bigint · currency ·
due_at, paid_at · provider_payment_id null · lines jsonb · pdf_path null · timestamps. IX(tenant_id, created_at DESC).

### audit_logs (append-only; app role has INSERT/SELECT only)
id PK · tenant_id null (null = platform action) · store_id null · actor_type `CHECK IN ('user','platform_admin','system','api_key')` ·
actor_id char(26) null · action varchar(64) (`product.updated`, `domain.verified`, `staff.role_changed`) ·
subject_type varchar(64) · subject_id char(26) · changes jsonb (before/after, secrets redacted) · ip inet ·
user_agent varchar(255) · request_id varchar(64) · created_at. IX(tenant_id, created_at DESC). IX(tenant_id, subject_type, subject_id).
Partitioned by month (`PARTITION BY RANGE (created_at)`) from Phase 9.

## 6. Later-phase tables (Figma-only modules) — brief
All tenant-owned, same conventions. Designed now so core tables don't need breaking changes.

| Module (Figma section) | Tables | Phase |
|---|---|---|
| Staff & roles (89:26676) | `roles(tenant_id, name, is_system)`, `role_permissions(role_id, permission)` — permissions are code constants (`orders.view`, `products.edit`...); `tenant_users.role_id` | 8 |
| Developer API keys & webhooks (144:40725) | `api_keys(tenant_id, name, prefix, key_hash, scopes text[], last_used_at, revoked_at)`; `webhook_endpoints(tenant_id, url, secret enc, events text[], is_active)`; `webhook_deliveries(endpoint_id, event, payload, status, attempts, next_retry_at, response_code)` | 8 |
| Coupons/campaigns (61:12479 Marketing) | `coupons` (core, Phase 5); `coupon_redemptions(coupon_id, order_id, customer_id)`; `campaigns(tenant_id, channel sms/email, audience jsonb, status, scheduled_at)`; `campaign_recipients` | 5 / 8 |
| POS (26:2147, page 22:1736) | `pos_registers(tenant_id, name, location_id)`, `pos_sessions(register_id, opened_by, opening_cash_amount, closing_cash_amount, status)`; POS sales are `orders` with `source='pos'` | 8+ |
| Inbox (141:48129) | `conversations(tenant_id, channel fb/whatsapp/web, external_thread_id, customer_id, status, assigned_user_id)`, `messages(conversation_id, direction, body, attachments jsonb, external_id)`; draft order → `orders.source='inbox'` | 8+ |
| Automations (140:30335) | `automations(tenant_id, trigger, conditions jsonb, actions jsonb, is_active)`, `automation_runs(automation_id, subject_id, status, log)` | 8+ |
| Expenses (144:41613) | `expense_categories(tenant_id, name)`, `expenses(tenant_id, category_id, amount, currency, spent_at, note, receipt_media_id)` | 8 |
| Suppliers / purchasing / transfers (26:2146 Inventory) | `locations(tenant_id, name, type)`; `inventories` gains `location_id` (U(variant_id, location_id)); `suppliers`, `purchase_orders`, `purchase_order_items(received_qty)`, `stock_transfers`, `stock_transfer_items` | 8+ |
| Invoice & label templates (44:16156) | `document_templates(tenant_id, type invoice/label, config jsonb)` — JSON config, no HTML from merchants | 5 |
| Fake-order guard (41:12365) | `customers.risk_flags`, `order_risk_checks(order_id, provider, score, result jsonb)` | 8 |
| Integrations (32:5329–5331) | `integrations(tenant_id, provider, credentials enc, settings jsonb, status)` (generalizes `payment_gateway_accounts`) | 5–8 |

## 7. Migration & operations rules
- One migration per table/change; forward-only after merge; zero-downtime pattern (add nullable → backfill job → constrain).
- Composite FK pattern in migrations: `$table->unique(['tenant_id','id']);` on parent; child
  `$table->foreign(['tenant_id','product_id'])->references(['tenant_id','id'])->on('products')`.
- Seed data idempotent (`updateOrCreate`), dev seed per AGENT-CONTRACTS.md.
- Backups: PITR (WAL archiving) daily base backup, 14-day retention; monthly restore drill (Phase 9).
- RLS (MULTI-TENANCY §9) policies use `tenant_id` only; `store_id` isolation is app-level + composite FKs.
- Tenant export/deletion: all tenant data reachable via `tenant_id`; hard delete job deletes in FK order after 30-day grace.

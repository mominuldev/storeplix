# Phase 4 contract: Merchant dashboard, catalog and operations (binding for API, WEB, SF, QA)

Status: **Binding** from 2026-11-22. Scope: roadmap tasks 4.1–4.9:
- 4.1 categories
- 4.2 products, variants and images
- 4.3 inventory and its movements ledger
- 4.4 CSV import and export
- 4.5 customers
- 4.6 dashboard home KPIs
- 4.7 cookie-based Sanctum auth for the SPAs (its own ordered sub-step, §7)
- 4.8 mobile layouts
- 4.9 onboarding step 05 "Add first products"

It also adds a small read-only storefront product feed so the existing product sections show real products (§8).

**Out of scope** (Phase 5 or later): orders, cart, checkout, payments, shipping, couriers, PDP and PLP pages,
customer accounts and addresses. Show those UI elements disabled or hide them; don't fake them. The full list of
Figma features we defer is in §11.

Everything in AGENT-CONTRACTS.md, PHASE-2-CONTRACT.md, PHASE-3-CONTRACT.md and docs/api/API-CONVENTIONS.md still
applies: envelope, snake_case, ULIDs, roles, error codes. The machine-readable spec is `docs/api/openapi.yaml`
(**v1.4.0**).

Conventions in this file:
- **Headers.** `T` = `X-Tenant-Id`. Until sub-step 4.7 lands, auth is `Authorization: Bearer`. After it lands, auth
  is the session cookie plus `X-XSRF-TOKEN` on writes (§7).
- **Foreign ids.** A `{store}`, `{product}`, `{category}`, `{variant}`, `{customer}`, `{note}`, `{import}` or
  `{export}` from another tenant **or another store** → 404 `not_found`. An id inside a request body that is not in
  this store → 422 `validation_failed` with the field path in `details`. Never 403, so existence never leaks.
- **Roles** (ADR 0005): O = owner, A = admin, S = staff. Policies use the `Permission` enum. New cases are in §1 (P4-14).
- **Errors.** Every endpoint can also return 401 `unauthenticated`, 422 `validation_failed` (with `details`) and
  429 `rate_limited`. After 4.7, any write can also return 419 `csrf_token_mismatch`.
- **Money.** Every `*_amount` is an integer in **paisa** (BDT minor units, 1 ৳ = 100). The JSON number must be an
  integer: `3450.5` → 422. The currency is the store currency (`stores.currency`, BDT).

### Standing rules for every agent
- **Browser checks:** use Playwright only (`tests/e2e`, or a one-off Playwright script). Never use the Claude in
  Chrome extension or the user's own Chrome.
- **Shared working tree:** all agents share one tree. Never run `git stash`, `git reset` or `git checkout -- <path>`.
  Only touch files you own (§13).
- **Dependencies:** every new dependency must be at least 14 days old. Pin exact versions in the owning package's
  `package.json` or `composer.json`. Never bypass pnpm `minimumReleaseAge`.

---

## 0. Summary and goals

1. **Categories.** A tree up to 3 levels deep, ordered by drag and drop. Each has a cover image, description and
   "show in shop menu" flag. Products link to categories many-to-many.
2. **Products.** Simple or variable products:
   - Up to 3 options. Each variant has a SKU that is unique per store (one store per tenant, so also per tenant).
   - Variants carry price, compare-at price, cost, barcode and weight.
   - Status is draft, active or archived.
   - Also: ordered images from the Media pipeline, a `RichTextDoc` description, tags and SEO fields.
   - Plan limit: `products` (Free 100, Starter 1 000, Growth unlimited).
3. **Inventory.** One location. `on_hand`, `committed` (always 0 until Phase 5) and `available`. Adjustments are
   atomic under a row lock and never go negative. Every change appends a row to the `inventory_movements` ledger
   with a reason code. Each variant has a low-stock threshold (default 5).
4. **CSV import and export** for products and customers.
   - Upload, then match columns, then a dry-run with a per-row report, then run.
   - Queued, tenant-aware jobs. Upsert by SKU (products) or phone (customers), and idempotent.
   - Exports are safe against formula injection. 5 000 rows import in under 2 minutes.
5. **Customers.** Created by hand or by CSV import (no storefront accounts or orders yet). Phone is normalised to
   `8801XXXXXXXXX`. Search by name, phone or email. The detail page has notes and tags.
6. **Dashboard home.** Read models only. Real numbers for catalog, stock, customers and the setup checklist. Every
   order or money card shows the Figma empty state.
7. **Cookie-based Sanctum auth** for both SPAs. The SPA reaches the API **same-origin** through a reverse proxy, so
   both cookies are host-only. Tokens disappear from JS storage. It is a strictly ordered sub-step that ships last (§7).
8. **Mobile.** Products list, dashboard, inventory, customers and the product editor work at 390 px (§9.3).
9. **Onboarding 05.** Quick-add products, or "Upload CSV" through the import flow. Products are created in the
   current store.
10. **Storefront.** The featured products, flash sale and hero product card read real active products from
    `GET /storefront/products`. They fall back to the bundled placeholders only when the store has no active
    products. No PDP, PLP or cart.

---

## 1. Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| P4-1 | **Every product has at least one variant.** A simple product has exactly one variant (`is_default = true`, no options). A variable product has 1–3 options. Each option has 1–20 values (each 1–40 chars, unique per option, case-insensitive). The product has 1–100 variants, each with exactly one value per option. Value combinations are unique within the product. Variants that aren't for sale yet are `is_enabled = false` (Figma "On sale" toggle). Switching type is a normal PATCH: send the new `options` and `variants`. | One price/stock code path. This matches DATABASE-DESIGN ("price lives on variants") and the editor (60:9381) variant grid |
| P4-2 | **Options are stored as `products.options` jsonb plus `product_variants.option1..3`** (`varchar(40) NOT NULL DEFAULT ''`). There are no option tables. | Max 3 options keeps it flat. Columns make the combination unique index trivial (`U(product_id, option1, option2, option3) WHERE deleted_at IS NULL`) |
| P4-3 | **SKU is optional and unique per store, case-insensitive.** It is stored as entered after trimming. Pattern: `^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$`. Unique index on `(store_id, lower(sku)) WHERE sku IS NOT NULL AND deleted_at IS NULL`. Barcode is optional, `^[A-Za-z0-9-]{1,64}$`, and not unique. | One store per tenant, so per-store = per-tenant (the roadmap AC). Kept per store so multi-store stays possible. SKU is the import upsert key, so it must be unambiguous |
| P4-4 | **Money is integer paisa.** `price_amount` is 0–1 000 000 000 (৳1 crore). `compare_at_amount` is null or greater than `price_amount`, else 422 "Compare-at price must be higher than the price.". `cost_amount` is null or 0–1 000 000 000. Products store `currency` (copied from the store when created). `price_min_amount` and `price_max_amount` are kept on `products` from enabled variants, for sorting and storefront cards. | CLAUDE.md rule 9. Denormalising only the price range avoids aggregate sorts. Stock is never denormalised onto `products`, so there is no hot row |
| P4-5 | **Cost is private to owner and admin** (new `Permission::ViewCosts`). For staff, `cost_amount` is `null` in every response, the profit, margin and stock-value-at-cost figures are omitted (null), and a `cost_amount` they send is ignored. Import and export are owner/admin only (P4-15), so staff never handle cost through CSV either. Figma says "Cost is private — only you see it". | Margin data is sensitive. Default pending PO (Q21) |
| P4-6 | **Description = `RichTextDoc`** (Phase 3 §4.4), validated by the existing `App\Domain\Pages\RichTextValidator`, ≤ 20 KB. The storefront renders it with the existing `components/rich-text.tsx` (Phase 5 PDP). The editor uses the existing Tiptap setup from `online-store/richtext`. | Reuse. No HTML anywhere (overrides DATABASE-DESIGN `description_html`) |
| P4-7 | **Images = `product_images` rows referencing `media`.** Purpose must be `product_image`, the media must be this tenant's and `status != failed`. Max 10 per product, `U(product_id, media_id)`. Position is the array order, and the first image is the cover. A variant may point at one of its product's images (`image_media_id`); removing that image from the product sets it to null. Upload uses the existing `POST /media`. "Add from URL" is **not** built (SSRF, §11). | Phase 2 pipeline already sniffs, caps size and makes variants. `media_in_use` (409) already covers deletes through the FK RESTRICT mapping |
| P4-8 | **Categories: tree depth ≤ 3**, `parent_id` with `depth` stored (1–3, CHECK). Max 500 per store. Sibling order is `position`. The slug is unique per store among non-deleted rows. Public path is `/c/{slug}` (Figma 60:9778 "mugdho.storeplix.com/c/sarees"); the route itself ships in Phase 5 (Q24). Deleting a category that has children → 409 `category_has_children`. Deleting a leaf soft-deletes it and detaches its products. Moving a category: the new depth plus the height of its subtree must be ≤ 3, and it can't move under its own descendant. "Feature on homepage" is deferred. | Explicit, testable rules. Refusing to delete a non-empty parent is safer than silently re-parenting |
| P4-9 | **Product ↔ category is many-to-many** (`product_categories`), max 10 per product. Figma shows one "Category" select; the editor renders it as a multi-select combobox with the same look. Tags: `products.tags` jsonb array. Each tag is trimmed, lowercased and 1–40 chars; max 20, unique. | Roadmap requires M:N. jsonb works on Postgres (GIN) and the local sqlite |
| P4-10 | **Status rules.** `draft`: not public. `active`: public once the store is live (or in preview). `archived`: hidden and kept for history. The first change to `active` sets `published_at`. A product can be `active` with 0 enabled variants, but then the storefront feed skips it. Delete = **soft delete** (owner/admin). Deleted products, variants and categories free their slug and SKU. | DATABASE-DESIGN soft-delete list. Archive is the everyday action; delete is the rare one |
| P4-11 | **Optimistic concurrency on products and customers.** Each has `revision`, and PATCH must send it. A mismatch → 409 `revision_conflict` ("Changed in another tab or by a teammate"). Same pattern as P3-17. | The editor has one big "Save product", so two tabs can't overwrite each other silently |
| P4-12 | **Stock changes only through `InventoryService`.** Product create (and new variants in a PATCH) may set `initial_on_hand` (ledger reason `initial`). Existing variants' stock changes only through `POST /inventory/adjustments` (the editor's stock cells call it with `mode: "set"` and `expected_on_hand`) or through import (reason `import`). The product PATCH **ignores** `on_hand`. | One audited path to stock, so the ledger is complete by construction |
| P4-13 | **Adjustments are atomic and never negative.** One request has 1–100 items. In a single DB transaction, rows are locked with `SELECT … FOR UPDATE` in `variant_id` order (no deadlocks), the new value is computed, and each change is checked. A result < 0 → 422 `insufficient_stock` for the whole request (`details["items.N.quantity"]`), and nothing is written. `expected_on_hand` set and different from the current value → 409 `stock_changed` (whole request). Each changed variant writes one ledger row with `delta` and `on_hand_after`. A zero delta writes no row. Backorders (`allow_backorder`) only matter for Phase 5 commits; manual and import changes never go negative. `committed` is never written in Phase 4. | "Atomic adjustments, ledger rows" AC. Ordered locking prevents deadlocks under parallel requests. All-or-nothing is easy to reason about in the UI |
| P4-14 | **Permissions** (code map in `Permission`). `Operate` (O A S): catalog, inventory and customer CRUD, except the operations listed next. New `ViewCosts` (O A). New `ManageCatalog` (O A): delete products and categories, delete customers. New `BulkData` (O A): imports and exports (products **and** customers). | ADR 0005 "products, inventory, customers CRUD = all roles", tightened only where data is destructive, bulk or sensitive |
| P4-15 | **Staff and customer PII.** Staff **see** customer name, phone and email; in BD COD retail they call customers to confirm orders. Staff may create and edit customers and add notes. Staff may **not** export or import customers, or delete them. Customer exports are audited (`customer.exported`), and the export file is private with a 5-minute signed URL. | Operational need versus bulk exfiltration. Default pending PO (Q22) |
| P4-16 | **Customers in Phase 4** are created by hand or by CSV import. `source` is `manual` or `import`; Phase 5 adds `storefront`. Each customer needs a phone or an email. Phone: BD mobile only, normalised by `Phone::bdMsisdn` to `8801XXXXXXXXX`, and unique per store. Email is lowercased and unique per store. `orders_count`, `total_spent_amount` and `last_order_at` exist now, always 0/null, and are written only by Phase 5 order code (never mass-assignable). **No addresses table** in Phase 4 (only `district` and `area` text, Figma list column). Addresses come with checkout. | Keep it minimal while matching the Figma list. Phase 5 doesn't need a breaking change |
| P4-17 | **Customer notes** = `customer_notes` rows (body ≤ 1 000, author, time). The author or O/A can delete; nobody can edit. Figma 64:16382 "Notes · only your team can see these". | Matches the design. A timeline is safer than one overwritable text field |
| P4-18 | **Import pipeline** (§5): `data_imports` and `data_import_rows`. The flow is upload, then validate (dry-run, queued), then run (queued). One import per store can be `validating` or `importing` at a time → otherwise 409 `import_in_progress`. **CSV only** (UTF-8, optional BOM; `,` `;` or tab detected from the header line). Limits: ≤ 10 MB, ≤ 5 000 data rows, ≤ 50 columns, ≤ 10 000 chars per cell, ≤ 65 536 bytes per line. No archives are ever opened: ZIP, GZIP or XLSX magic bytes → 422 `unsupported_file`. Excel `.xlsx` is deferred (Q30). | Bounded work, and no decompression, so no zip bombs. Exactly one parser path |
| P4-19 | **Import is idempotent.** Products: a row whose SKU matches a non-deleted variant in this store updates that variant (and, with `update_existing`, the product fields from the group's first row). Rows without SKU always create. `stock` on an update is a **set** (ledger reason `import` with the computed delta; a zero delta writes no row). Running the same file twice gives `unchanged` rows and no new ledger rows. Customers upsert by normalised phone, else by email. | "Idempotent upsert by SKU" |
| P4-20 | **Exports** (`data_exports`) are always queued. They write a private CSV at `tenants/{tenant}/exports/{ulid}.csv` via `TenantStorage`. The file expires after 24 h. `download_url` is a 5-minute signed URL (ADR 0009). Exports use the **same column spec** as imports (round-trip). Every cell is formula-safe (§5.6). | ADR 0009 private files. Round-trip lets merchants edit in Excel and re-import |
| P4-21 | **Plan limit `products`.** Usage = non-deleted products (all statuses). Checked on create, duplicate and every import create (inside the job, per row, under a per-store lock). Over the limit → **402 `plan_limit_reached`** (`details.products`), the existing Phase 2 `PlanLimitReached` exception. Seeded limits (PlanSeeder): **free 100, starter 1 000, growth unlimited (null)**. A downgrade never hides or deletes products; it only blocks new ones. | Uses the Phase 2 convention (402, not 403/422) and the real seeded numbers (the brief's "50" is the Free plan's *orders* limit) |
| P4-22 | **Storefront product feed** `GET /storefront/products` (§8). Card data only, **no cost, stock or SKU**. Returns active products with ≥ 1 enabled variant. Draft store without a valid preview → 404 `store_not_found` (T22). The storefront falls back to placeholders only when `meta.has_products` is false. `bestsellers` sorts like `latest` until Phase 5 has sales (Q27). Cards don't link anywhere until PDP exists in Phase 5 (no dead links). | Small, and it makes the editor preview show the merchant's own products. Placeholders stay for new shops |
| P4-23 | **Revalidation** reuses the single `store:{host}` tag (P3-18). It fires on: a product create, update or delete when the product is or was `active`; any category create, update, delete or reorder (cards show the first category name); and once at the end of an import that touched any active product. Imports **mute** the per-model observer (`StorefrontRevalidation::muted(fn)`), so 5 000 rows give one job. Inventory changes don't revalidate (no stock on cards in Phase 4). | Correct and cheap |
| P4-24 | **Dashboard KPIs** come from one read endpoint `GET /stores/{store}/dashboard` (§3.6), computed with plain aggregates (no new tables) in the store timezone. Order and money metrics are `null`, and the UI shows the empty states from States 148:34032. | "Read models only". No premature aggregate tables |
| P4-25 | **Auth: same-origin cookie sessions** (§7). In prod, `app.storeplix.com` and `admin.storeplix.com` serve `/api/*` and `/sanctum/*` through Nginx to the Laravel upstream. In dev, the Vite proxy does the same on :5173 and :5174. The cookies are host-only (no `Domain`), `HttpOnly` (session), `Secure` (prod), `SameSite=Lax`, and the prod session cookie is named `__Host-sp_session`. CORS is no longer needed for the SPAs. `api.storeplix.com` stays for the storefront server. **Bearer tokens are removed**: no non-browser client exists, and Phase 8 API keys are a separate mechanism. | `app.` and `api.` would be same-site anyway, but a cookie with `Domain=.storeplix.com` would also reach every `{slug}.storeplix.com` storefront. Host-only same-origin cookies avoid that, and avoid credentialed CORS. `__Host-` stops cookie tossing from sibling subdomains |
| P4-26 | **4.7 ships last, in strict order** (§7.6): API dual-mode, then both SPAs switch, then e2e auth cache, then removal of token issuance. Catalog work never depends on it. If 4.7c slips, Phase 4 can close with 4.7a and 4.7b done and token issuance still on (tracked as a follow-up). | The riskiest change, isolated so it can't block the catalog |
| P4-27 | **Onboarding 05** creates products as `active` in the current store. They become public when the store goes live (Phase 5.13). The quick-add "Stock" field means **stock per size** when sizes are chosen; the label changes to "Stock per size" (Q26). "Save & continue" goes to `/` (step 06 Delivery is Phase 5). Figma has **no mobile frame** for step 05: `54:941` (listed as M5) is actually the mobile "You're live" screen. The mobile layout stacks the desktop `50:312` and hides the live phone preview below `lg`. | AC "Product created in active store". Records the Figma mismatch |
| P4-28 | **Sidebar.** "Products" gets children like Orders has: All products `/products`, Categories `/products/categories`, Import `/products/import`. Inventory, Customers and Dashboard keep their single entries. | Figma 60:9778 and 60:10175 sit under the Products nav item. This reuses the existing child-nav pattern (no new style) |

### New OPEN-QUESTIONS (appended to OPEN-QUESTIONS.md)
- **Q21** Should staff see cost price and profit? Default: no (owner/admin only).
- **Q22** Customer PII for staff. Default: staff see phone and email, but can't export, import or delete customers.
- **Q23** Figma "Delivery record across Storeplix" (64:16382) shows a customer's parcels from **other merchants'**
  shops. This is cross-tenant personal data and needs legal and privacy review. Default: not built; any delivery
  record shows this shop's own data only (Phase 5+).
- **Q24** Public category URL: `/c/{slug}` (Figma) versus `/collections/{handle}` (Phase 3 nav link type).
  Default: categories use `/c/{slug}`. Collections (manual or automatic groups) are a separate later feature.
- **Q25** Platform storefront subdomains share the registrable domain with the app (`*.storeplix.com`). Phase 4's
  host-only cookies make this safe. Consider a separate storefront domain before launch anyway (like
  myshopify.com) for defence in depth.
- **Q26** Onboarding quick-add: with sizes chosen, is "Stock" per size (default) or a total to split?
- **Q27** "Bestsellers" storefront section before orders exist. Default: newest products.
- **Q28** CSV "Download photos from image URLs" (Figma 60:10175). Needs an SSRF-safe fetcher (T14). Default: column
  ignored with a warning; the toggle shows "Coming soon".
- **Q29** Do archived products count toward the plan's product limit? Default: yes (all non-deleted).
- **Q30** Excel `.xlsx` import ("Excel or CSV from your old shop", 148:34667). Default: CSV only in Phase 4; the UI
  says "Save as CSV UTF-8 from Excel".

---

## 2. Data (migrations, owner API)

These follow DATABASE-DESIGN §2 and the Phase 3 patterns:
- Postgres in CI and prod; local sqlite must keep working. Partial and expression unique indexes work on both. GIN
  and trigram indexes are created only when `DB::getDriverName() === 'pgsql'`.
- Every new table has `id ulid pk`, `tenant_id` FK tenants cascade, and `store_id ulid`. `FK(s)` means the store
  FK `(tenant_id, store_id) → stores(tenant_id, id)` cascade.
- Every parent table has `UNIQUE(tenant_id, id)` **and** `UNIQUE(tenant_id, store_id, id)`. Children reference
  parents with the **triple** FK `(tenant_id, store_id, parent_id) → parent(tenant_id, store_id, id)`, written
  `FK3(parent)`. That makes cross-tenant **and** cross-store references impossible in the database.
- Media references use `FK(t)`, i.e. `(tenant_id, media_id) → media(tenant_id, id)` RESTRICT. Media is
  tenant-scoped.
- All models use `BelongsToTenant` + `HasUlids` and keep `tenant_id`/`store_id` out of `$fillable`.

New migrations (file prefix `2026_04_01_`):

| Table | Columns / constraints |
|---|---|
| `categories` (000100) | `id`; `tenant_id`; `store_id` FK(s); `parent_id ulid null` **FK3(categories) RESTRICT**; `name varchar(120)`; `slug varchar(140)`; `description varchar(500) null` (plain text); `image_media_id ulid null` FK(t) media RESTRICT; `depth smallint not null` CHECK `depth BETWEEN 1 AND 3`; `position int not null default 0`; `is_visible boolean not null default true` ("Show in shop menu"); `created_by`, `updated_by` FK users nullOnDelete; timestamps; `deleted_at`. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(store_id, slug) WHERE deleted_at IS NULL`; `IX(tenant_id, store_id, parent_id, position)` |
| `products` (000200) | `id`; `tenant_id`; `store_id` FK(s); `name varchar(200)`; `slug varchar(220)`; `type varchar(16)` CHECK IN (`simple`,`variable`); `status varchar(16) default 'draft'` CHECK IN (`draft`,`active`,`archived`); `description jsonb null` (RichTextDoc); `options jsonb not null default '[]'`; `tags jsonb not null default '[]'`; `seo_title varchar(70) null`; `seo_description varchar(160) null`; `currency char(3)`; `price_min_amount bigint not null default 0`; `price_max_amount bigint not null default 0`; `revision int not null default 1`; `published_at timestamptz null`; `created_by`, `updated_by` FK users nullOnDelete; timestamps; `deleted_at`. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(store_id, slug) WHERE deleted_at IS NULL`; `IX(tenant_id, store_id, status, created_at)`; `IX(tenant_id, store_id, price_min_amount)`; pgsql only: `GIN(tags)`, `GIN(name gin_trgm_ops)` (requires `pg_trgm`, created if missing) |
| `product_variants` (000300) | `id`; `tenant_id`; `store_id`; `product_id` **FK3(products) CASCADE**; `title varchar(130)` (derived: values joined by " / ", or "Default"); `option1`, `option2`, `option3 varchar(40) not null default ''`; `sku varchar(64) null`; `barcode varchar(64) null`; `price_amount bigint not null` CHECK `>= 0`; `compare_at_amount bigint null` CHECK `compare_at_amount IS NULL OR compare_at_amount > price_amount`; `cost_amount bigint null` CHECK `>= 0`; `weight_grams int null` CHECK `BETWEEN 0 AND 1000000`; `position smallint not null default 0`; `is_default boolean not null default false`; `is_enabled boolean not null default true`; `track_inventory boolean not null default true`; `allow_backorder boolean not null default false`; `image_media_id ulid null` FK(t) media RESTRICT; timestamps; `deleted_at`. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(store_id, lower(sku)) WHERE sku IS NOT NULL AND deleted_at IS NULL` (raw SQL, both drivers); partial `U(product_id, option1, option2, option3) WHERE deleted_at IS NULL`; `IX(tenant_id, store_id, product_id, position)`; pgsql `GIN(sku gin_trgm_ops)` |
| `product_images` (000400) | `id`; `tenant_id`; `store_id`; `product_id` FK3(products) CASCADE; `media_id` FK(t) media RESTRICT; `position smallint not null`; `alt varchar(160) null`; timestamps. `U(tenant_id,id)`; `U(product_id, media_id)`; `IX(tenant_id, store_id, product_id, position)` |
| `product_categories` (000500) | `tenant_id`; `store_id`; `product_id` FK3(products) CASCADE; `category_id` FK3(categories) CASCADE; `position int not null default 0`. **PK(product_id, category_id)**; `IX(tenant_id, store_id, category_id, position)`. Model is a pivot (`BelongsToTenant` via a custom `Pivot` class) |
| `inventories` (000600) | `id`; `tenant_id`; `store_id`; `variant_id` FK3(product_variants) CASCADE, **U(variant_id)**; `on_hand int not null default 0`; `committed int not null default 0` CHECK `>= 0`; `low_stock_threshold int null` CHECK `BETWEEN 0 AND 100000`; timestamps. `U(tenant_id,id)`; `IX(tenant_id, store_id, on_hand)`. A row is created in the same transaction as its variant, always (also when `track_inventory = false`). Renames DATABASE-DESIGN `reserved` → `committed` |
| `inventory_movements` (000700) | `id`; `tenant_id`; `store_id`; `variant_id` FK3(product_variants) CASCADE; `delta int not null` CHECK `delta <> 0`; `on_hand_after int not null`; `reason varchar(32) not null` CHECK IN (`initial`,`received`,`correction`,`damaged`,`lost`,`returned`,`import`,`other`); `note varchar(255) null`; `reference_type varchar(32) null` (`import`; Phase 5 adds `order`); `reference_id char(26) null`; `actor_user_id ulid null` FK users nullOnDelete; `created_at timestamptz not null default now()` (**no `updated_at`**). `IX(tenant_id, store_id, variant_id, created_at)`; `IX(tenant_id, store_id, created_at)`. **Append-only:** the model throws on `updating`/`deleting`, `$timestamps` handles `created_at` only, and an arch test forbids `InventoryMovement::…->update/delete` outside tenant purge. Phase 5 adds the `order_*` reasons with a migration that changes the CHECK |
| `customers` (000800) | `id`; `tenant_id`; `store_id` FK(s); `name varchar(120)`; `phone varchar(13) null` (`8801XXXXXXXXX`); `email varchar(254) null` (lowercased; plain varchar for sqlite parity, compared lowercased); `district varchar(80) null`; `area varchar(120) null`; `channel varchar(16) null` CHECK IN (`facebook`,`instagram`,`whatsapp`,`website`,`phone`,`walk_in`,`other`); `source varchar(16) not null default 'manual'` CHECK IN (`manual`,`import`,`storefront`); `tags jsonb not null default '[]'`; `accepts_marketing boolean not null default false`; `orders_count int not null default 0`; `total_spent_amount bigint not null default 0`; `last_order_at timestamptz null`; `revision int not null default 1`; `created_by` FK users nullOnDelete; timestamps; `deleted_at`. CHECK `phone IS NOT NULL OR email IS NOT NULL`. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(store_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL`; partial `U(store_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL`; `IX(tenant_id, store_id, created_at)`; pgsql `GIN(name gin_trgm_ops)` |
| `customer_notes` (000900) | `id`; `tenant_id`; `store_id`; `customer_id` FK3(customers) CASCADE; `body varchar(1000)`; `author_user_id` FK users nullOnDelete; timestamps. `IX(tenant_id, store_id, customer_id, created_at)` |
| `data_imports` (001000) | `id`; `tenant_id`; `store_id` FK(s); `type varchar(16)` CHECK IN (`products`,`customers`); `status varchar(16)` CHECK IN (`uploaded`,`validating`,`validated`,`importing`,`completed`,`failed`,`cancelled`); `file_path varchar(255)` (private disk); `filename varchar(255)` (sanitised display name); `size_bytes int`; `checksum char(64)`; `delimiter char(1)`; `headers jsonb`; `samples jsonb`; `column_map jsonb null`; `options jsonb not null default '{}'`; `row_count int null`; `processed_rows int not null default 0`; `summary jsonb null`; `failure_reason varchar(255) null`; `validated_at`, `started_at`, `completed_at timestamptz null`; `created_by` FK users nullOnDelete; timestamps. `U(tenant_id,id)`, `U(tenant_id,store_id,id)`; partial `U(store_id) WHERE status IN ('validating','importing')` (the database enforces one active import) |
| `data_import_rows` (001100) | `id`; `tenant_id`; `store_id`; `import_id` FK3(data_imports) CASCADE; `row_number int`; `status varchar(8)` CHECK IN (`ready`,`warning`,`error`); `action varchar(12)` CHECK IN (`create`,`update`,`unchanged`,`skip`); `label varchar(200)`; `key varchar(254) null` (SKU or phone/email); `values jsonb` (normalised parsed values used by run); `messages jsonb not null default '[]'`; `result_id char(26) null` (created/updated product or customer id after run). `U(import_id, row_number)`; `IX(tenant_id, store_id, import_id, status)` |
| `data_exports` (001200) | `id`; `tenant_id`; `store_id` FK(s); `type` as above; `status varchar(16)` CHECK IN (`queued`,`running`,`completed`,`failed`,`expired`); `filters jsonb`; `file_path varchar(255) null`; `row_count int null`; `expires_at timestamptz null`; `created_by` FK users nullOnDelete; timestamps. `U(tenant_id,id)`; `IX(tenant_id, store_id, created_at)` |
| `personal_access_tokens` (4.7c only, 001300) | Data migration: `DELETE FROM personal_access_tokens WHERE name = 'merchant-dashboard'`, forcing a fresh cookie login. The table stays (Sanctum). `down()` is a no-op |

Models (API): `Category`, `Product`, `ProductVariant`, `ProductImage`, `ProductCategory` (pivot), `Inventory`,
`InventoryMovement`, `Customer`, `CustomerNote`, `DataImport`, `DataImportRow`, `DataExport`.
- `Store` gets `hasMany` relations for products, categories, customers, imports and exports, so routes can use
  `scopeBindings()`.
- `Product` uses `SoftDeletes`. Its route binding resolves through `$store->products()`.
- `FeatureGate::usage(Limit::Products)` = `Product::query()->count()` (tenant scope; soft-deleted excluded).
- `assertTenantIsolation` **and** `assertStoreIsolation` are required for every new model.

Retention (scheduled):
- `data:prune-imports` daily deletes imports (rows and file) older than 30 days.
- `data:expire-exports` hourly deletes files of exports past `expires_at` and sets `status = expired`.

---

## 3. API endpoints (owner API)

All of these are under `auth` + `tenant` middleware. Routes with `{store}` use `Route::scopeBindings()`, so a nested
id that isn't in the store is a 404. Throttle: default `merchant` limiter. Bulk routes use `merchant-bulk`.

### 3.1 Categories

| Method & path | Roles | Body | Success | Errors |
|---|---|---|---|---|
| `GET /stores/{store}/categories` | O A S | `?q=` (name contains, ≤ 80) | 200 `Category[]`, **flat, depth-first tree order** (parent, then its children by `position`), max 500, not paginated. `meta: {count, limit: 500}` | 404 |
| `POST /stores/{store}/categories` | O A S | `CreateCategoryInput` | 201 `Category`, appended as the last sibling | 409 `category_limit_reached`; 422 (depth: `details.parent_id = ["Categories can only be three levels deep."]`; slug taken: `details.slug = ["This link is already used by another category."]`; unknown `parent_id`/`image_media_id` → "Unknown category." / "Unknown image.") |
| `GET /stores/{store}/categories/{category}` | O A S | — | 200 `Category` | 404 |
| `PATCH /stores/{store}/categories/{category}` | O A S | `UpdateCategoryInput` (partial) | 200 `Category`. A changed `parent_id` moves it to the end of the new siblings and recomputes `depth` for the subtree | 404; 422 (`details.parent_id`: "A category can't be moved inside itself." / depth rule) |
| `PUT /stores/{store}/categories/order` | O A S | `ReorderCategoriesInput` = **every** category of the store, in display order, with `parent_id` | 200 `Category[]`. Rewrites `parent_id`, `depth` and `position` in one transaction | 422 if the id set ≠ the store's categories (`details.items = ["The list is out of date. Reload and try again."]`), on a cycle, or on depth > 3 |
| `DELETE /stores/{store}/categories/{category}` | O A | — | 204. Soft-deletes it, deletes its `product_categories` rows, revalidates | 404; 409 `category_has_children` |

Validation:
- `name`: 1–120 chars, trimmed, no control characters.
- `slug`: optional (default = the slugified name; for a Bangla-only name, `c-{6 random [a-z0-9]}`). It must match
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`, be ≤ 140 chars and be unique per store.
- `description`: ≤ 500 chars, no control characters except `\n`.
- `image_media_id`: media of this tenant, purpose `product_image` or `page_image`, not failed.
- `is_visible`: bool.

Audit: `category.deleted` only. Creates and updates are not audited (low risk, high volume).

### 3.2 Products

| Method & path | Roles | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /stores/{store}/products` | O A S | `filter[status]=draft,active,archived` (default: all non-deleted), `filter[category_id]=`, `filter[stock]=in\|low\|out`, `q=` (name or any variant SKU/barcode contains, ≤ 100; trigram on pgsql, `LIKE` on sqlite), `sort=` one of `-created_at` (default), `created_at`, `name`, `-name`, `price`, `-price`, `-updated_at`; `page`, `per_page` (≤ 100, default 25) | 200 `ProductSummary[]` + `meta: ProductListMeta` | 422 unknown filter or sort |
| `POST /stores/{store}/products` | O A S | `CreateProductInput` | 201 `Product` | **402 `plan_limit_reached`**; 422 |
| `GET /stores/{store}/products/{product}` | O A S | — | 200 `Product` | 404 |
| `PATCH /stores/{store}/products/{product}` | O A S | `UpdateProductInput` (partial; **`revision` required**; `variants`, `images` and `category_ids` are **full replacements** when present) | 200 `Product` (`revision` + 1) | 404; 409 `revision_conflict`; 422 |
| `DELETE /stores/{store}/products/{product}` | O A | — | 204. Soft-deletes the product and its variants (inventory rows are kept for the ledger) | 404 |
| `POST /stores/{store}/products/{product}/duplicate` | O A S | — | 201 `Product`: status `draft`, name "Copy of {name}" (trimmed to 200), slug `{slug}-copy[-n]`, same options, images, categories and tags, variant SKUs **null**, stock 0 (no ledger rows) | 402; 404 |
| `POST /stores/{store}/products/bulk` | O A S (`delete`: O A) | `ProductBulkInput` (1–100 ids) | 200 `ProductBulkResult` | 403 `forbidden` (staff delete); 422 (`details["ids.N"] = ["Unknown product."]` when any id isn't in the store; nothing is applied) |

Bulk actions:
- `activate`, `draft`, `archive`, `delete`.
- `set_categories` (replaces) and `add_categories`, both with `category_ids`.

Bulk actions run in one transaction and bump each product's `revision`. Audit: one `product.bulk_updated` row with
`{action, count}`.

**`CreateProductInput` / `UpdateProductInput` validation** (FormRequest + `ProductPayloadValidator`; errors use dot
paths):

| Field | Rule |
|---|---|
| `name` | required on create; 1–200, trimmed, no control characters |
| `slug` | optional (default from the name; Bangla-only → `p-{6 random}`); `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤ 220, unique per store (`"This link is already used by another product."`) |
| `status` | `in:draft,active,archived`; default `draft` |
| `description` | null or RichTextDoc (existing validator), ≤ 20 480 bytes as JSON |
| `tags` | array ≤ 20 of strings 1–40 (trimmed, lowercased, duplicates removed) |
| `category_ids` | array ≤ 10 of distinct ULIDs of **this store's** non-deleted categories (`"Unknown category."`) |
| `options` | array 0–3 of `{name 1–40, values: 1–20 distinct (case-insensitive) strings 1–40}`; option names distinct. `type` is derived: `simple` iff `options` is empty |
| `variants` | required on create; 1–100 items (exactly 1 when `options` is empty). Each item: |
| `variants.*.id` | PATCH only: ULID of a **non-deleted variant of this product** (`"Unknown variant."`). Absent = new variant. Existing variants missing from the list are soft-deleted (their SKU is freed) |
| `variants.*.option_values` | array whose length equals `options.length`; each value must be in the matching option's `values`; combinations distinct (`"This combination already exists."`). Must be `[]` for simple products |
| `variants.*.sku` | null or per P4-3, unique per store excluding this variant, and distinct inside the payload |
| `variants.*.barcode` | null or per P4-3 |
| `variants.*.price_amount` | required integer 0–1 000 000 000 |
| `variants.*.compare_at_amount` | null or integer > `price_amount` |
| `variants.*.cost_amount` | null or integer 0–1 000 000 000; **ignored for staff** (P4-5) |
| `variants.*.weight_grams` | null or integer 0–1 000 000 |
| `variants.*.is_enabled`, `track_inventory`, `allow_backorder` | bool (defaults true, true, false) |
| `variants.*.image_media_id` | null or a `media_id` present in this payload's `images` (or in the product's current images when `images` is absent) |
| `variants.*.initial_on_hand` | **new variants only**: integer 0–1 000 000 (default 0), written with ledger reason `initial` when > 0. Sending it for an existing variant → 422 `"Change stock from Inventory."` |
| `variants.*.low_stock_threshold` | null or integer 0–100 000 (stored on `inventories`) |
| `images` | array ≤ 10 of `{media_id, alt?: ≤ 160}`; distinct; media of this tenant, purpose `product_image`, `status != failed` (`"Unknown image."`) |
| `seo.title` / `seo.description` | null or ≤ 70 / ≤ 160 |
| `revision` | PATCH: required integer |

Any other key is ignored and never mass-assigned. This includes `tenant_id`, `store_id`, `price_min_amount`,
`revision` (except as the lock value), `published_at`, `on_hand` and `committed`.

**Service** (`ProductService::save`) runs one transaction:
1. Lock the product row (`lockForUpdate`) and compare `revision`.
2. Validate SKU uniqueness again inside the transaction. A unique-index violation maps to 422 `details["variants.N.sku"]`.
3. Diff variants, images and categories.
4. Create an `inventories` row for each new variant, plus `initial` ledger rows.
5. Recompute `price_min_amount` and `price_max_amount` over **enabled** variants (0/0 when none).
6. Set `published_at` on the first change to `active`.
7. Bump `revision`.

Plan check (`FeatureGate::assertWithin(Limit::Products)`) runs inside the transaction for create and duplicate,
under a per-store advisory lock (`pg_advisory_xact_lock(hashtext(store_id))`, a no-op on sqlite).

Audit: `product.created` and `product.deleted` (meta `{name, sku_count}`). Updates are not audited, except a status
change to or from `active` (`product.status_changed`, meta `{from, to}`).

**Example.** `POST /stores/01J…/products`:
```json
{
  "name": "Jamdani Three-Piece — Handwoven Dhakai",
  "status": "active",
  "description": { "type": "doc", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Soft handwoven Dhakai jamdani three-piece." } ] } ] },
  "tags": ["jamdani", "eid"],
  "category_ids": ["01JCAT00000000000000000001"],
  "options": [ { "name": "Size", "values": ["M", "L"] }, { "name": "Colour", "values": ["Red"] } ],
  "variants": [
    { "option_values": ["M", "Red"], "sku": "JT-RD-M", "price_amount": 345000, "compare_at_amount": 395000, "cost_amount": 210000, "initial_on_hand": 14 },
    { "option_values": ["L", "Red"], "sku": "JT-RD-L", "price_amount": 345000, "initial_on_hand": 9, "is_enabled": true }
  ],
  "images": [ { "media_id": "01JMEDIA000000000000000001", "alt": "Red jamdani three-piece" } ]
}
```
→ 201 `{ "data": { "id": "01JPROD…", "type": "variable", "status": "active", "revision": 1, "price_min_amount": 345000,
"variants": [ { "id": "…", "title": "M / Red", "inventory": { "on_hand": 14, "committed": 0, "available": 14, "status": "in_stock", … }, … } ], … } }`

When the Free plan already has 100 products:
`402 {"error":{"code":"plan_limit_reached","message":"Your plan allows 100 products.","details":{"products":["Your plan allows 100 products."]}}}`

### 3.3 Inventory

| Method & path | Roles | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /stores/{store}/inventory` | O A S | `q=` (product name, SKU, barcode), `filter[stock]=in,low,out,untracked`, `filter[category_id]=`, `filter[product_id]=`, `sort=` `name` (default), `available`, `-available`, `-updated_at`; `page`, `per_page` | 200 `InventoryItem[]` (one per **non-deleted variant of a non-deleted product**) + `meta: InventoryListMeta` (pagination + `summary: InventorySummary`) | 422 |
| `PATCH /stores/{store}/inventory/{variant}` | O A S | `{ low_stock_threshold: int\|null }` | 200 `InventoryItem` | 404 |
| `POST /stores/{store}/inventory/adjustments` | O A S | `StockAdjustmentInput` | 200 `{ data: { items: InventoryItem[], movements: StockMovement[] } }` | 409 `stock_changed` (`details["items.N.expected_on_hand"] = ["Stock changed to 12 since you opened this. Check and try again."]`); 422 `insufficient_stock` (`details["items.N.quantity"] = ["Only 3 in stock."]`); 422 `validation_failed` |
| `GET /stores/{store}/inventory/movements` | O A S | `filter[variant_id]=`, `filter[product_id]=`, `filter[reason]=…`, `filter[created_at][gte\|lte]=`, `page`, `per_page` (newest first) | 200 `StockMovement[]` + `PaginationMeta` | 422 |

Definitions:
- `available = on_hand − committed`.
- `effective_threshold = low_stock_threshold ?? 5` (`DEFAULT_LOW_STOCK_THRESHOLD`).
- `status`:
  - `untracked` when `track_inventory = false`;
  - else `out_of_stock` when `available ≤ 0`;
  - else `low_stock` when `available ≤ effective_threshold`;
  - else `in_stock`.

Summary:
- `stock_value_cost_amount = Σ max(on_hand,0) × cost_amount` (variants with a cost; **null for staff**).
- `stock_value_price_amount = Σ max(on_hand,0) × price_amount`.
- `units_on_hand`, `committed_units` (0), `low_stock_variants`, `out_of_stock_variants`, `variants_count`,
  `products_count`.

`StockAdjustmentInput`:
- `reason`: `received`, `correction`, `damaged`, `lost`, `returned` or `other`.
- `note`: ≤ 255, required when `reason = other`.
- `items`: 1–100 entries of `{variant_id, mode, quantity, expected_on_hand?}`, with distinct `variant_id`s of this
  store's non-deleted variants (`"Unknown variant."`).
- `mode: "delta"`: `quantity` is an integer from −1 000 000 to 1 000 000, not 0.
- `mode: "set"`: `quantity` is an integer 0–1 000 000.

Variants with `track_inventory = false` can still be adjusted; the value is kept for when tracking is turned on.

**Atomicity** (`InventoryService::adjust`, one transaction):
1. `SELECT … FROM inventories WHERE variant_id IN (…) ORDER BY variant_id FOR UPDATE`.
2. For each item, check `expected_on_hand` and compute `new = set ? quantity : on_hand + quantity`.
3. If any `new < 0`, throw `insufficient_stock` (and roll back).
4. For each changed row, `UPDATE inventories SET on_hand = :new …` and insert the movement
   (`delta = new − old`, `on_hand_after = new`, `actor_user_id`, `reason`, `note`).

The same service is used by import (reason `import`, `reference_type = import`) and product create (`initial`).
Audit: none (the ledger is the audit trail).

### 3.4 Imports and exports (O A only, `Permission::BulkData`; `throttle:merchant-bulk` on create and run)

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /stores/{store}/imports/template?type=products\|customers` | — | 200 `text/csv; charset=utf-8` (UTF-8 BOM, header plus 2 example rows from §5.2/§5.3), `Content-Disposition: attachment; filename="storeplix-{type}-template.csv"` | 422 bad type |
| `POST /stores/{store}/imports` | multipart: `file` (required), `type` (`products`\|`customers`) | 201 `DataImport`, status `uploaded`. Synchronous **streaming** pass: checks bytes, encoding, delimiter, header, counts rows (§5.1), stores the file privately, fills `headers`, `samples` (first non-empty value per column, ≤ 60 chars) and `suggested_map` | 409 `import_in_progress`; 413 `payload_too_large` (> 10 MB); 422 `unsupported_file` (binary, archive, not UTF-8: message "Save the file as CSV UTF-8 and try again."), `too_many_rows` (> 5 000), `too_many_columns` (> 50), `empty_file` (no data rows), `validation_failed` (duplicate or blank header names) |
| `GET /stores/{store}/imports/{import}` | — | 200 `DataImport` (poll every 2 s while `validating`/`importing`) | 404 |
| `POST /stores/{store}/imports/{import}/validate` | `{ column_map: Record<header, field\|null>, options: ImportOptions }` | 202 `DataImport`, status `validating`. Dispatches `ValidateImport` (TenantAware, queue `bulk`). Allowed from `uploaded` or `validated` (re-validate after changing the map) | 409 `import_in_progress` / `invalid_state_transition`; 422 (unknown field; a field mapped twice; a required field unmapped: products need `name` and `price`; customers need `name` and one of `phone`/`email`) |
| `GET /stores/{store}/imports/{import}/rows` | `filter[status]=ready,warning,error`, `page`, `per_page` (≤ 100) | 200 `DataImportRow[]` + `PaginationMeta` (ordered by `row_number`) | 404; 409 `invalid_state_transition` if not validated yet |
| `GET /stores/{store}/imports/{import}/error-report` | — | 200 `text/csv`: the original columns plus an `errors` column, for rows with status `error` or `warning`. Formula-safe (§5.6) | 404; 409 not validated |
| `POST /stores/{store}/imports/{import}/run` | — | 202 `DataImport`, status `importing`. Dispatches `RunImport`. Only from `validated` | 402 `plan_limit_reached` when `summary.create` exceeds the remaining product limit (message says how many fit; the UI offers "Import as many as fit" = proceed: over-limit rows end as `error`) — **unless** the body is `{ "allow_partial": true }`; 409 `invalid_state_transition` / `import_in_progress` |
| `DELETE /stores/{store}/imports/{import}` | — | 204: status `cancelled`, file deleted. Not while `validating`/`importing` | 409 `invalid_state_transition` |
| `POST /stores/{store}/exports` | `CreateExportInput` | 202 `DataExport` (`queued`). Dispatches `RunExport` (TenantAware) | 422 |
| `GET /stores/{store}/exports/{export}` | — | 200 `DataExport`. When `completed` and not expired, `download_url` = a **fresh** 5-minute signed URL each call (`Storage::temporaryUrl`; local disk → signed Laravel route `exports.download` with the same TTL) | 404 |

Audit:
- `import.run` (meta `{type, summary}`) when an import completes.
- `export.created` (meta `{type, filters}`).
- `customer.exported` additionally for customer exports.

### 3.5 Customers

| Method & path | Roles | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /stores/{store}/customers` | O A S | `q=` (≤ 100, see below), `filter[channel]=`, `filter[created_at][gte]=`, `filter[tag]=`, `sort=` `-created_at` (default), `name`, `-total_spent`, `-last_order_at`; `page`, `per_page` | 200 `Customer[]` + `meta: CustomerListMeta` | 422 |
| `POST /stores/{store}/customers` | O A S | `CreateCustomerInput` | 201 `CustomerDetail` | 422 (`details.phone = ["A customer with this phone already exists."]`, same for email) |
| `GET /stores/{store}/customers/{customer}` | O A S | — | 200 `CustomerDetail` (notes newest first, max 100) | 404 |
| `PATCH /stores/{store}/customers/{customer}` | O A S | `UpdateCustomerInput` (partial, `revision` required) | 200 `CustomerDetail` | 404; 409 `revision_conflict`; 422 |
| `DELETE /stores/{store}/customers/{customer}` | O A | — | 204 (soft) | 404 |
| `POST /stores/{store}/customers/{customer}/notes` | O A S | `{ body: 1–1000 }` | 201 `CustomerNote` | 404; 422 |
| `DELETE /stores/{store}/customers/{customer}/notes/{note}` | author, or O A | — | 204 | 403 `forbidden`; 404 |

Search `q`:
- Digits only after `Phone::clean` and ≥ 4 digits: phone search. `01…` is rewritten to `8801…`, and it is a prefix
  match when it starts with `01`/`8801`, otherwise a contains match.
- Contains `@`: email contains (lowercased).
- Otherwise: name contains (trigram on pgsql).

Validation:
- `name`: 1–120, no control characters.
- `phone`: optional, normalised with `Phone::bdMsisdn`; a non-BD number → `"Enter a Bangladeshi mobile number (01XXXXXXXXX)."`.
- `email`: optional, `email:rfc`, ≤ 254, lowercased.
- At least one of `phone` and `email`.
- `district`: ≤ 80. `area`: ≤ 120. `channel`: enum.
- `tags`: ≤ 20 × 1–40, lowercased.
- `accepts_marketing`: bool.

Never writable: `orders_count`, `total_spent_amount`, `last_order_at`, `source`, `revision`.

Audit: `customer.deleted`. Create and update are not audited; the PII is in the row itself.

Example `POST /stores/{store}/customers` `{ "name": "Farhana Rahman", "phone": "01556-120987", "district": "Narayanganj", "channel": "instagram", "tags": ["repeat buyer"] }`
→ 201 `{ "data": { "id": "…", "name": "Farhana Rahman", "phone": "8801556120987", "email": null, "orders_count": 0, "total_spent_amount": 0, "currency": "BDT", "source": "manual", "revision": 1, "notes": [], … } }`.

### 3.6 Dashboard

`GET /stores/{store}/dashboard` (O A S) → 200 `DashboardSummary`. `Cache-Control: no-store`. Plain queries, < 50 ms
on 5 000 products. Fields:

| Field | Source |
|---|---|
| `currency`, `timezone` | store |
| `products.{total, active, draft, archived}` | non-deleted products by status |
| `products.limit` | `FeatureGate::limit(Limit::Products)` (null = unlimited) |
| `inventory.{low_stock_variants, out_of_stock_variants, units_on_hand}` | as in §3.3 (tracked, enabled variants of active products) |
| `inventory.stock_value_cost_amount` | §3.3; **null for staff** |
| `customers.{total, new_this_month}` | month boundary in the store timezone |
| `orders` | always `null` in Phase 4 (Phase 5 fills `{received_this_month_amount, count, …}`) |
| `setup.has_products` | `products.total > 0` |

### 3.7 Auth changes (4.7, see §7)

| Method & path | Change |
|---|---|
| `GET /sanctum/csrf-cookie` (**outside `/api/v1`**) | 204. Sets `XSRF-TOKEN` (readable) and the session cookie |
| `POST /auth/register`, `/auth/login`, `/auth/login/otp`, `/invitations/{token}/accept` (new-user path), `PUT /auth/password` | Stateful request (from an allowed SPA origin): `Auth::guard('web')->login($user)`, `session()->regenerate()`, put `auth_expires_at = now + SANCTUM_EXPIRATION` in the session, and respond `{data: AuthSession}` = `{user, expires_at}`. **4.7a (transition only):** also includes `token` (deprecated) so un-migrated clients keep working. **4.7c:** `token` removed; non-stateful calls get 400 `stateful_required` ("Sign in from the Storeplix app.") |
| `POST /auth/logout` | Stateful: `Auth::guard('web')->logout()`, `session()->invalidate()`, `session()->regenerateToken()` → 204, and the session cookie expires. (4.7a: also deletes the current PAT if bearer) |
| `GET /auth/me` | Adds `meta: { session_expires_at }` (absolute expiry) |
| `PUT /auth/password` | Also `Auth::logoutOtherDevices()` (needs `AuthenticateSession`); the current session is regenerated |
| `POST /auth/reset-password`, `/auth/reset-password/otp` | Unchanged response; other sessions die on their next request (password hash check by `AuthenticateSession`) |

### 3.8 Storefront product feed (server-to-server; `X-Storefront-Key` + `X-Storefront-Host`, optional `X-Storefront-Preview`)

`GET /storefront/products?sort=latest|bestsellers&limit=1..24&on_sale=0|1&category=<slug>` → 200
`{ data: StorefrontProductCard[], meta: { has_products: boolean } }`.

- Only `active`, non-deleted products with ≥ 1 enabled variant.
- `sort=latest` → `published_at desc, id desc`. `bestsellers` → same as latest (P4-22).
- `on_sale=1` → the card variant has `compare_at_amount > price_amount`.
- `category` → products in that category **or its descendants**. An unknown slug gives an empty list, not 404.
- Card variant = the enabled variant with the lowest `price_amount` (ties: `position`).
- `meta.has_products` = the store has ≥ 1 feed-eligible product (ignores the filters), so the storefront can tell
  "new shop" from "no sale items".

Draft store without a valid preview → 404 `store_not_found`. Preview → served, `private, no-store`. Public →
`Cache-Control: public, max-age=0, s-maxage=60`.

Never present: `cost_amount`, SKU, barcode, stock, tenant or store ids, draft or archived products. A resource test
asserts the exact key set.

Throttle: `storefront` (existing).

---

## 4. Products and categories UI rules (owner WEB) — summary of behaviour

- **List (60:8984).** Status tabs All/Active/Draft/Archived with counts. Four KPI cards: Active products, Low stock,
  Out of stock, and the **fourth card "Top seller" is replaced** by "Products on your plan: {used} of {limit}"
  (no sales data yet). Search, then category filter, then stock filter, then sort. Row: thumbnail, name, first SKU ·
  first category, variants count, stock (`Σ on_hand`, "Low · N variants"), price (min, plus compare-at struck
  through), profit/unit (O A only: price − cost of the card variant, with %), status badge, edit, ••• (Duplicate,
  Archive/Activate, Delete for O A).
  - **Hidden:** SOLD column, "Hide from Facebook shop", "Edit prices" bulk action, barcode-scan icon,
    "Sort: Best selling".
  - Bulk bar: Change category, Archive, Publish (= `activate`), Delete (O A).
  - Pagination: Previous/Next with "Showing a–b of n".
- **Editor (60:9381)** at `/products/new` and `/products/:id`. Left cards:
  - Product name; Description (Tiptap, existing extensions; no "Write with AI").
  - Photos: drag to reorder; upload via `POST /media` with purpose `product_image` and a progress bar; "5 of 10";
    no "Add from URL".
  - Pricing: price, compare-at, cost (O A); a derived strip shows profit per item, margin and "Buyers see N% off".
    The "After COD fee" tile is hidden.
  - Inventory: SKU, barcode, total stock (read-only sum; for a simple product the stock cell edits through the
    adjustment API), "Keep selling when out of stock" (= `allow_backorder` on all variants).
  - Variants: option chips with "+ Add", "+ Add option" (max 3), and a grid that regenerates when options change
    (keeps the existing variant ids per combination). Columns: price, cost (O A), stock (new variants =
    `initial_on_hand`; existing = adjustment with `set` + `expected_on_hand`), SKU, On-sale toggle (= `is_enabled`).
  - Shipping: **weight only** (package and delivery charge cards are hidden).
  - Search & link preview: Google snippet, URL handle (slug), page title (`seo.title`), description.

  Right column:
  - Unsaved-changes bar (Discard / Save product), same pattern as the Phase 3 DraftBar.
  - Status (Active / Draft / Archived) and Organize (categories multi-select, tags). **Collections are hidden.**
  - Hidden: "Where it's sold", "Order form on product page", "Last 30 days".

  Header: Duplicate, "Preview on shop" (disabled with the tooltip "Product pages arrive with checkout"). 409 → the
  Phase 3 conflict dialog. A leave guard runs while there are unsaved changes.
- **Categories (60:9778)** at `/products/categories`.
  - The tab "Collections" is hidden.
  - "Shop menu order" list with drag handles: drop on a row to nest, max depth 3; "/slug · N sub-categories"; product
    count; "In menu"/"Hidden" badge.
  - Side panel "Edit category": cover image, name, link (copy), parent select (limited to valid targets), short
    description, "Show in shop menu", "N products in {name}" thumbnails (from `GET /products?filter[category_id]=…`).
  - Hidden: "Feature on homepage", "sales · 30d", and the Collections card.
- **Import (60:10175)** at `/products/import` (and `?type=customers` from Customers). It follows the 4 steps
  (Upload, Match columns, Review rows, Import):
  - The column map uses the API's `suggested_map` and marks unmatched columns orange.
  - "Ready to import" card shows the summary. Options: "Update products with the same SKU" (`update_existing`),
    "Import as Draft" (`import_as_draft`), "Create missing categories" (`create_missing_categories`, not in Figma,
    default on). "Download photos from image URLs" is shown **disabled** with "Coming soon".
  - Review table: filter chips All/Errors/Warnings. Inline "click a cell to fix" is **not** built; fix the file and
    re-upload.
  - Buttons: "Download error report", "Download sample CSV" (template), Cancel (DELETE).
- **Empty state (148:34667).** "Add your first product" with Add product and Import CSV buttons, plus the "Ways to
  add" cards. "Copy from Facebook posts" shows a "Coming soon" badge.

---

## 5. CSV specification (owner API; WEB mirrors field labels)

### 5.1 Upload checks (in order; first failure returns)
1. Size ≤ 10 485 760 bytes, else 413. The upload uses the existing upload hardening: `UploadedFile` validity,
   random storage key, private disk, tenant prefix via `TenantStorage`, and the original name only in `filename`
   (stripped to `[\w .()-]`, ≤ 255).
2. The first 8 bytes are not a ZIP (`PK\x03\x04`), GZIP (`\x1f\x8b`), OLE/XLS (`\xD0\xCF\x11\xE0`) or PDF (`%PDF`)
   signature, and there is no NUL byte in the first 64 KB → else 422 `unsupported_file`. Nothing is ever
   decompressed.
3. UTF-8 is valid (`mb_check_encoding` on the streamed chunks); a leading BOM is stripped. Else 422
   `unsupported_file`.
4. Delimiter: the most common of `,` `;` `\t` outside quotes in the header line.
5. Parse with `league/csv` (pinned version, ≥ 14 days old) in streaming mode. A line over 65 536 bytes, a cell over
   10 000 chars, > 50 columns, or > 5 000 data rows → 422 with the matching code. Fully blank rows are skipped and
   not counted.
6. Header names: trimmed, non-empty and unique (case-insensitive).

### 5.2 Product columns (one row per variant; rows of one product share `handle`, or `name` when `handle` is empty)

| Field | Header aliases (auto-match, case-insensitive; Shopify/WooCommerce names in brackets) | Rules / normalisation |
|---|---|---|
| `handle` | handle, url handle, slug, [Handle] | optional; slugified; groups rows. Rows with the same handle must sit together; a non-contiguous repeat → error "Rows for one product must be next to each other." |
| `name` | name, title, product name, [Title], [Name] | required on the first row of a group |
| `description` | description, body, [Body (HTML)], [Description] | plain text → RichTextDoc paragraphs (blank line = new paragraph, single newline = hardBreak). HTML tags are **stripped** to text (warning "Formatting was removed") |
| `status` | status, [Status], [Published] | `draft`/`active`/`archived` (also `true`→active, `false`→draft); default `active`, or `draft` when the `import_as_draft` option is on |
| `category` | category, categories, [Product Category], [Categories] | path `Parent > Child`; several separated by `|` or `,` (≤ 10). Matched case-insensitively by name along the path; else by slug. Missing → created when `create_missing_categories` (depth and 500 limits apply), otherwise warning "Category not found — product imported without it" |
| `tags` | tags, [Tags] | comma-separated |
| `option1_name`…`option3_name`, `option1_value`…`option3_value` | [Option1 Name], [Option1 Value], size, colour/color (a single `size` or `colour` column is accepted as option name + value) | the option rules of §3.2 per group |
| `sku` | sku, [Variant SKU] | P4-3; upsert key (P4-19) |
| `barcode` | barcode, [Variant Barcode] | P4-3 |
| `price` | price, price (bdt), [Variant Price], [Regular price] | **required**. Major units: strips `৳`, `tk`, `taka`, `bdt`, spaces and thousands separators; Bangla digits ০–৯ → 0–9; ≤ 2 decimals; → paisa. A changed value gives a **warning** "Price "950tk" read as ৳ 950" (Figma "Fixed") |
| `compare_at_price` | compare at price, compare-at price, [Variant Compare At Price], [Sale price]* | as price. *WooCommerce: when both Regular and Sale price exist, sale → price and regular → compare_at |
| `cost_price` | cost, cost price, cost per item, [Cost per item] | as price |
| `stock` | stock, qty, quantity, stock quantity, [Variant Inventory Qty], [Stock] | integer ≥ 0 (after digit normalisation); negative → error "Stock can't be negative"; on update = **set** |
| `weight_kg` | weight, weight (kg), [Variant Grams]→÷1000 | decimal kg → grams |
| `seo_title`, `seo_description` | seo title, [SEO Title], seo description, [SEO Description] | ≤ 70 / ≤ 160 (longer → truncated + warning) |
| `image_urls` | image, image url, photos, [Image Src], [Images] | **ignored** in Phase 4 → warning "Photos from links aren't imported yet" (Q28) |

Row outcomes:
- `ready`, `warning` (imported, with normalisation notes) or `error` (skipped).
- `action`: `create`, `update`, `unchanged` (an update with no effective change) or `skip`.
- The summary counts `create`, `update`, `unchanged`, `warnings`, `errors`, and `over_limit` (creates beyond the
  product limit; known at validate time, re-checked at run).

### 5.3 Customer columns
`name` (required), `phone` (BD mobile → `8801…`; else error), `email`, `district`, `area`, `channel`
(enum; else warning and null), `tags`, `accepts_marketing` (yes/no/true/false/1/0), `note` (→ one `customer_notes`
row on create only, authored by the importer).
- Rows need a phone or an email.
- Upsert: match by phone, else by email. With `update_existing`, non-empty cells overwrite; empty cells keep the
  current values.
- Duplicate keys inside the file → second and later rows are errors "Same phone as row N".

### 5.4 Jobs
- `ValidateImport` and `RunImport` both `implements ShouldQueue` and `use TenantAware`; queue `bulk`;
  `$timeout = 300`; `$tries = 1` (failure → status `failed`, `failure_reason` = a safe generic message, details
  logged with `import_id`).
- They acquire `Cache::lock("import:{store}", 600)` via `TenantCache`.
- Validate streams the file and writes `data_import_rows` in batches of 500. Lookups use preloaded maps (existing
  SKUs → variant ids, category paths, customer phones and emails): one query each, not one per row.
- Run reads `data_import_rows` (`ready`/`warning`, action ≠ `unchanged`) in **chunks of 200 rows, one transaction
  per chunk**:
  - Products: `ProductService` with a bulk path (multi-row inserts for variants, inventories and movements). The
    plan limit is checked per create, under the advisory lock.
  - Customers: upsert.
- After each chunk, `processed_rows` is updated.
- Inside `StorefrontRevalidation::muted()`; one `RevalidateStorefront` dispatch at the end if any touched product
  is or was active.
- **Target: 5 000 product rows (≈ 1 700 products × 3 variants) validate in < 30 s and run in < 90 s** on the CI
  Postgres service. QA has a perf test with a generated fixture; it fails the build when the total is > 120 s.

### 5.5 Export
- `RunExport` (TenantAware, queue `bulk`) streams with `cursor()` to a temp file, then puts it on the private disk.
- Products are exported in the §5.2 columns: one row per variant, all statuses unless filtered; `cost_price` is
  included (exports are O A only). Customers use the §5.3 columns minus `note`.
- UTF-8 with BOM, CRLF line ends, every field quoted (RFC 4180).
- Filename: `{store-slug}-{type}-{YYYYMMDD-HHmm}.csv`.

### 5.6 Formula-injection safety (both export and error report; `CsvCell::safe(string): string`)
- If a cell's first character is one of `=`, `+`, `-`, `@`, TAB (0x09), CR (0x0D), or the full-width `＝ ＋ － ＠`,
  prefix it with a single quote `'`. This also applies to cells that start with whitespace followed by one of these.
- Numbers we generate (prices, stock, weight) are never negative, so they are never prefixed.
- On **import**, one leading `'` is stripped when the next character is one of the trigger characters, so files
  round-trip.
- Unit test: every trigger character, a Bangla string, an empty string, and `"-5"` text.

---

## 6. § Types (orchestrator applies) — `packages/types/src/index.ts`

```ts
// ---------- Auth (Phase 4.7) ----------
/** Response of register / login / login/otp / invitation accept / password change after 4.7. */
export interface AuthSession { user: User; /** absolute session expiry, ISO-8601 */ expires_at: string }
// AuthToken: KEEP until 4.7c, then DELETE. During 4.7a the API returns AuthSession & { token: string }.
export interface MeMeta { session_expires_at: string | null }

// ---------- Permissions surfaced to the UI ----------
/** Mirrors App\Domain\Tenancy\Authorization\Permission (P4-14). UI derives from TenantMembership.role. */
export const ROLE_CAN = {
  view_costs: ['owner', 'admin'],
  manage_catalog: ['owner', 'admin'],   // delete products/categories/customers
  bulk_data: ['owner', 'admin'],        // imports & exports
} as const satisfies Record<string, readonly TenantRole[]>;

// ---------- Catalog (Phase 4) ----------
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
export const CATALOG_LIMITS = {
  options: 3, option_values: 20, variants: 100, images: 10, categories_per_product: 10,
  tags: 20, category_depth: 3, categories_per_store: 500, bulk_ids: 100, adjustment_items: 100,
  max_amount: 1_000_000_000,
} as const;

export type ProductStatus = 'draft' | 'active' | 'archived';
export type ProductType = 'simple' | 'variable';
export interface ProductOption { name: string; values: string[] }
export interface CategoryRef { id: string; name: string; slug: string }

export interface Category {
  id: string; parent_id: string | null; name: string; slug: string; description: string | null;
  image: MediaRef | null; depth: 1 | 2 | 3; position: number; is_visible: boolean;
  url_path: string;                 // "/c/{slug}"
  product_count: number; children_count: number;
  created_at: string; updated_at: string;
}
export interface CreateCategoryInput {
  name: string; slug?: string; parent_id?: string | null; description?: string | null;
  image_media_id?: string | null; is_visible?: boolean;
}
export type UpdateCategoryInput = Partial<CreateCategoryInput>;
export interface ReorderCategoriesInput { items: { id: string; parent_id: string | null }[] }

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'untracked';
export interface InventoryLevel {
  on_hand: number; committed: number; available: number;
  low_stock_threshold: number | null; effective_threshold: number; status: StockStatus;
}
export interface ProductVariant {
  id: string; title: string; option_values: string[];      // ordered like Product.options
  sku: string | null; barcode: string | null;
  price_amount: number; compare_at_amount: number | null;
  cost_amount: number | null;                              // null for staff (ViewCosts)
  weight_grams: number | null; position: number; is_default: boolean; is_enabled: boolean;
  track_inventory: boolean; allow_backorder: boolean; image_media_id: string | null;
  inventory: InventoryLevel; updated_at: string;
}
export interface ProductImage { media_id: string; alt: string | null; position: number; media: MediaRef }
export interface ProductStockSummary { on_hand: number; available: number; low_variants: number; out_variants: number; tracked: boolean }
export interface ProductSummary {
  id: string; name: string; slug: string; type: ProductType; status: ProductStatus; currency: string;
  image: MediaRef | null;                                  // cover (first image)
  price_min_amount: number; price_max_amount: number;
  /** Card variant = cheapest enabled variant (first variant when none enabled). */
  price_amount: number; compare_at_amount: number | null; cost_amount: number | null;
  variants_count: number; first_sku: string | null;
  stock: ProductStockSummary; categories: CategoryRef[];
  published_at: string | null; created_at: string; updated_at: string;
}
export interface Product extends ProductSummary {
  description: RichTextDoc | null; tags: string[]; options: ProductOption[];
  variants: ProductVariant[]; images: ProductImage[];
  seo: { title: string | null; description: string | null };
  url_path: string;                                        // "/products/{slug}" (route ships in Phase 5)
  revision: number; created_by: UserRef | null; updated_by: UserRef | null;
}
export interface ProductVariantInput {
  id?: string; option_values?: string[]; sku?: string | null; barcode?: string | null;
  price_amount: number; compare_at_amount?: number | null; cost_amount?: number | null;
  weight_grams?: number | null; is_enabled?: boolean; track_inventory?: boolean; allow_backorder?: boolean;
  image_media_id?: string | null;
  /** New variants only. */
  initial_on_hand?: number;
  low_stock_threshold?: number | null;
}
export interface ProductImageInput { media_id: string; alt?: string | null }
export interface CreateProductInput {
  name: string; slug?: string; status?: ProductStatus; description?: RichTextDoc | null;
  tags?: string[]; category_ids?: string[]; options?: ProductOption[];
  variants: ProductVariantInput[]; images?: ProductImageInput[];
  seo?: { title?: string | null; description?: string | null };
}
export interface UpdateProductInput extends Partial<Omit<CreateProductInput, 'variants'>> {
  revision: number; variants?: ProductVariantInput[];
}
export type ProductSort = '-created_at' | 'created_at' | 'name' | '-name' | 'price' | '-price' | '-updated_at';
export interface ProductListFilters {
  status?: ProductStatus[]; category_id?: string; stock?: 'in' | 'low' | 'out'; q?: string;
  sort?: ProductSort; page?: number; per_page?: number;
}
export interface ProductListMeta extends PaginationMeta {
  counts: Record<'all' | ProductStatus, number>;
  summary: { active_products: number; active_variants: number; low_stock_variants: number; out_of_stock_variants: number };
  plan: { limit: number | null; used: number };
}
export type ProductBulkAction = 'activate' | 'draft' | 'archive' | 'delete' | 'set_categories' | 'add_categories';
export interface ProductBulkInput { action: ProductBulkAction; ids: string[]; category_ids?: string[] }
export interface ProductBulkResult { action: ProductBulkAction; updated: number }

// ---------- Inventory ----------
export interface InventoryItem {
  variant_id: string;
  product: { id: string; name: string; status: ProductStatus; image: MediaRef | null };
  title: string; option_values: string[]; sku: string | null; barcode: string | null;
  on_hand: number; committed: number; available: number;
  low_stock_threshold: number | null; effective_threshold: number; status: StockStatus;
  track_inventory: boolean; price_amount: number; cost_amount: number | null; updated_at: string;
}
export interface InventorySummary {
  currency: string; stock_value_cost_amount: number | null; stock_value_price_amount: number;
  units_on_hand: number; committed_units: number; low_stock_variants: number; out_of_stock_variants: number;
  variants_count: number; products_count: number;
}
export interface InventoryListMeta extends PaginationMeta { summary: InventorySummary }
export interface InventoryListFilters {
  q?: string; stock?: ('in' | 'low' | 'out' | 'untracked')[];
  category_id?: string; product_id?: string;
  sort?: 'name' | 'available' | '-available' | '-updated_at'; page?: number; per_page?: number;
}
export type StockMovementReason = 'initial' | 'received' | 'correction' | 'damaged' | 'lost' | 'returned' | 'import' | 'other';
export type ManualStockReason = Exclude<StockMovementReason, 'initial' | 'import'>;
export interface StockAdjustmentItem { variant_id: string; mode: 'delta' | 'set'; quantity: number; expected_on_hand?: number }
export interface StockAdjustmentInput { reason: ManualStockReason; note?: string | null; items: StockAdjustmentItem[] }
export interface StockMovement {
  id: string; variant_id: string; product: { id: string; name: string };
  variant_title: string; sku: string | null; delta: number; on_hand_after: number;
  reason: StockMovementReason; note: string | null;
  reference: { type: 'import'; id: string } | null; actor: UserRef | null; created_at: string;
}
export interface StockAdjustmentResult { items: InventoryItem[]; movements: StockMovement[] }
export interface StockMovementFilters {
  variant_id?: string; product_id?: string; reason?: StockMovementReason[];
  created_from?: string; created_to?: string; page?: number; per_page?: number;
}  // api-client maps to filter[...] / filter[created_at][gte|lte]

// ---------- Customers ----------
export type CustomerChannel = 'facebook' | 'instagram' | 'whatsapp' | 'website' | 'phone' | 'walk_in' | 'other';
export interface Customer {
  id: string; name: string;
  phone: string | null;                                    // "8801XXXXXXXXX"
  email: string | null; district: string | null; area: string | null;
  channel: CustomerChannel | null; source: 'manual' | 'import' | 'storefront';
  tags: string[]; accepts_marketing: boolean;
  orders_count: number; total_spent_amount: number; currency: string; last_order_at: string | null;
  notes_count: number; revision: number; created_at: string; updated_at: string; created_by: UserRef | null;
}
export interface CustomerNote { id: string; body: string; author: UserRef | null; created_at: string; can_delete: boolean }
export interface CustomerDetail extends Customer { notes: CustomerNote[] }
export interface CreateCustomerInput {
  name: string; phone?: string | null; email?: string | null; district?: string | null; area?: string | null;
  channel?: CustomerChannel | null; tags?: string[]; accepts_marketing?: boolean;
}
export interface UpdateCustomerInput extends Partial<CreateCustomerInput> { revision: number }
export interface CustomerListFilters {
  q?: string; channel?: CustomerChannel[]; tag?: string; created_from?: string;
  sort?: '-created_at' | 'name' | '-total_spent' | '-last_order_at'; page?: number; per_page?: number;
}
export interface CustomerListMeta extends PaginationMeta { counts: { all: number; new_this_month: number } }

// ---------- Imports / exports ----------
export type DataImportType = 'products' | 'customers';
export type DataImportStatus = 'uploaded' | 'validating' | 'validated' | 'importing' | 'completed' | 'failed' | 'cancelled';
export type ProductImportField =
  | 'handle' | 'name' | 'description' | 'status' | 'category' | 'tags'
  | 'option1_name' | 'option1_value' | 'option2_name' | 'option2_value' | 'option3_name' | 'option3_value'
  | 'sku' | 'barcode' | 'price' | 'compare_at_price' | 'cost_price' | 'stock' | 'weight_kg'
  | 'seo_title' | 'seo_description' | 'image_urls';
export type CustomerImportField = 'name' | 'phone' | 'email' | 'district' | 'area' | 'channel' | 'tags' | 'accepts_marketing' | 'note';
export type ImportField = ProductImportField | CustomerImportField;
export interface ImportOptions { update_existing: boolean; import_as_draft: boolean; create_missing_categories: boolean }
export interface ImportSummary {
  total: number; create: number; update: number; unchanged: number;
  warnings: number; errors: number; over_limit: number;
}
export interface DataImport {
  id: string; type: DataImportType; status: DataImportStatus;
  filename: string; size_bytes: number; row_count: number | null;
  headers: string[]; samples: Record<string, string | null>;
  suggested_map: Record<string, ImportField | null>;
  column_map: Record<string, ImportField | null> | null;
  options: ImportOptions; summary: ImportSummary | null;
  progress: { processed: number; total: number };
  failure_reason: string | null; created_by: UserRef | null;
  created_at: string; validated_at: string | null; completed_at: string | null;
}
export interface ValidateImportInput { column_map: Record<string, ImportField | null>; options: ImportOptions }
export interface RunImportInput { allow_partial?: boolean }
export interface ImportRowMessage { level: 'warning' | 'error'; field: ImportField | null; message: string }
export interface DataImportRow {
  row_number: number; status: 'ready' | 'warning' | 'error';
  action: 'create' | 'update' | 'unchanged' | 'skip';
  label: string; key: string | null;
  preview: { price_amount: number | null; stock: number | null; variants: number | null };
  messages: ImportRowMessage[]; result_id: string | null;
}
export type DataExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';
export interface DataExport {
  id: string; type: DataImportType; status: DataExportStatus; row_count: number | null;
  filename: string | null; download_url: string | null; expires_at: string | null;
  created_by: UserRef | null; created_at: string;
}
export type CreateExportInput =
  | { type: 'products'; filters?: Omit<ProductListFilters, 'page' | 'per_page' | 'sort'> & { ids?: string[] } }
  | { type: 'customers'; filters?: Omit<CustomerListFilters, 'page' | 'per_page' | 'sort'> };

// ---------- Dashboard ----------
export interface DashboardSummary {
  currency: string; timezone: string; generated_at: string;
  products: { total: number; active: number; draft: number; archived: number; limit: number | null };
  inventory: { low_stock_variants: number; out_of_stock_variants: number; units_on_hand: number; stock_value_cost_amount: number | null };
  customers: { total: number; new_this_month: number };
  /** Phase 5 fills this; null means "no order data yet" → empty states. */
  orders: null;
  setup: { has_products: boolean };
}

// ---------- Storefront product feed ----------
export interface StorefrontProductCard {
  id: string; slug: string; name: string;
  subtitle: string | null;                                 // first category name
  price_amount: number; compare_at_amount: number | null; currency: string;
  on_sale: boolean; image: StorefrontMedia | null;
}
export interface StorefrontProductListMeta { has_products: boolean }
export interface StorefrontProductQuery { sort?: 'latest' | 'bestsellers'; limit?: number; on_sale?: boolean; category?: string }
```
Notes:
- `AuditLogFilters.subject_type` allowlist (API) gains `product`, `category`, `customer`, `data_import`,
  `data_export`.
- `LimitKey` is unchanged (`products` already exists). `FeatureAccess.limits.products.used` now reports real usage.
- Compatibility: everything is additive except `AuthToken` → `AuthSession` (4.7c). The storefront's local
  `StorefrontProductCard` in `lib/products.ts` moves to `@storeplix/types` (prices become **paisa**; placeholders are
  converted).

---

## 7. Auth migration (task 4.7) — cookie-based Sanctum

### 7.1 Topology
| Env | SPA origin | API reached at | Cookie host |
|---|---|---|---|
| dev | `http://localhost:5173` (merchant), `http://localhost:5174` (admin) | same origin: Vite `server.proxy` for `/api` and `/sanctum` → `VITE_API_PROXY_TARGET` (default `http://localhost:8000`), `changeOrigin: false`, `xfwd: true` | `localhost` (cookies ignore ports, so in dev the two SPAs **share one session**; documented, acceptable) |
| docker | same, target `http://api:8000` | | |
| prod | `https://app.storeplix.com`, `https://admin.storeplix.com` | Nginx on those hosts: `location /api/` and `location = /sanctum/csrf-cookie` → the Laravel upstream, `proxy_set_header Host $host`, `X-Forwarded-Proto` | host-only per SPA host |
| storefront | — | `https://api.storeplix.com` (server-to-server, key auth, **no cookies**) | — |

### 7.2 Laravel configuration (API)
- `bootstrap/app.php`: `$middleware->statefulApi()`. This adds Sanctum's `EnsureFrontendRequestsAreStateful` to
  the api group: cookies, session, CSRF for stateful origins.
- Trust proxies for `X-Forwarded-*` (`TRUSTED_PROXIES` env).
- `config/sanctum.php`:
  - `stateful` = env `SANCTUM_STATEFUL_DOMAINS`: dev `localhost:5173,localhost:5174`; prod
    `app.storeplix.com,admin.storeplix.com`. **Remove** the framework defaults (`localhost`, `127.0.0.1:8000`, …),
    so a request from the storefront host is never stateful.
  - `guard = ['web']`.
  - `middleware.authenticate_session = Laravel\Sanctum\Http\Middleware\AuthenticateSession`, so password changes
    kill other sessions.
- Session env (prod / dev):
  - `SESSION_DRIVER=redis` / `database`.
  - `SESSION_LIFETIME=10080` (idle, minutes).
  - `SESSION_EXPIRE_ON_CLOSE=false`.
  - `SESSION_COOKIE=__Host-sp_session` / `sp_session`.
  - `SESSION_DOMAIN=null` (host-only).
  - `SESSION_PATH=/`.
  - `SESSION_SECURE_COOKIE=true` / `false`.
  - `SESSION_HTTP_ONLY=true`.
  - `SESSION_SAME_SITE=lax`.

  `XSRF-TOKEN` gets the same Secure, SameSite and host-only settings and is **not** HttpOnly.
- **Absolute expiry = 7 days (D3 unchanged).** On login, `session(['auth_expires_at' => now()->addMinutes(config('sanctum.expiration'))])`.
  New middleware `EnforceAbsoluteSessionExpiry` on `auth:sanctum` routes: when the session is past it → logout +
  invalidate → 401 `unauthenticated`. Bearer requests (4.7a only) keep the PAT `expires_at`.
- CSRF failure (`TokenMismatchException`) → 419 `{error:{code:"csrf_token_mismatch", message:"Your session
  refreshed. Please try again."}}` via `ApiExceptionRenderer`.
- CORS: `supports_credentials` stays **false**. `CORS_ALLOWED_ORIGINS` becomes empty in prod after 4.7b; same-origin
  needs no CORS.
- `X-Tenant-Id` stays a request header (validated per request, unchanged). The active tenant is **not** stored in the
  session, so two tabs can work in two shops.
- Login throttles are unchanged. `session()->regenerate()` on every login (prevents fixation).
- Logout invalidates the session and rotates the CSRF token.
- **Super admin:** same mechanism on `admin.` (its own host-only session in prod). Platform-role gating stays
  Phase 8 (ADR 0005); nothing about admin abilities changes now. T11 ("merchant session never reaches admin APIs")
  becomes a Phase 8 test because `/admin/*` doesn't exist yet.

### 7.3 Client (`packages/api-client`, both SPAs) (WEB)
- `createApiClient({ baseUrl: '' , credentials: 'include' })`: same-origin relative URLs, `fetch(…, {credentials:
  'same-origin'})`. The XHR upload path sets `withCredentials` only when cross-origin (never, in this design).
- New `ensureCsrf()`: `GET /sanctum/csrf-cookie` once on app boot, after login, and after logout.
  - On every non-GET request, read `XSRF-TOKEN` from `document.cookie`, `decodeURIComponent` it, and send
    `X-XSRF-TOKEN`.
  - On 419: call `ensureCsrf()` and retry the request **once**.
- `createAuthSession` keeps **no token**. It keeps `expires_at` (non-secret) in `sessionStorage` for the proactive
  logout timer and the active tenant in `localStorage` (unchanged). `getToken`, `setAuth({token})` and the
  `Authorization` header are removed in 4.7b.
- Boot: `GET /auth/me`. 200 → signed in (use `meta.session_expires_at`). 401 → signed out.
  `onUnauthorized` → `session.expire()` and the existing "Your session expired, please sign in again" notice.
- Logout: `POST /auth/logout`, then clear the TanStack Query cache, the expiry and the notice, then
  `ensureCsrf()`. The tenant preference is kept.
- "Choose a shop" (L4) and the tenant switcher are unchanged. They set the `X-Tenant-Id` preference and reset query
  keys `[tenantId, storeId, …]`.
- `.env`: `VITE_API_URL` is removed or empty in both SPAs. New `VITE_API_PROXY_TARGET` (dev server only).
- CSP for the SPAs (QA/Nginx): `connect-src 'self'` plus the media CDN, no API origin.

### 7.4 Playwright e2e auth cache (QA)
- `tests/e2e/support/api.ts`: `Session` becomes `{ storageState: string; tenantId; storeId; expires_at }`. Helpers
  use `request.newContext({ baseURL: urls.merchant, storageState, extraHTTPHeaders: { Accept: 'application/json',
  Referer: urls.merchant + '/' } })`, so calls go through the Vite proxy and are stateful.
- For writes, `api()` reads the `XSRF-TOKEN` cookie from the context and sends `X-XSRF-TOKEN`.
- `demoSession()`:
  1. If `.auth/demo.json` (Playwright storage state) exists and `GET /api/v1/auth/me` returns 200 with
     `session_expires_at` more than 1 h away, reuse it.
  2. Otherwise `GET /sanctum/csrf-cookie`, then `POST /api/v1/auth/login`, then `context.storageState({ path })`.
     This is still one login per run (login throttle).
- Browser specs: `test.use({ storageState: '.auth/demo.json' })` replaces injecting the token into
  `sessionStorage`. The tenant preference is written into the storage state's `localStorage` origin entry.
- New spec `phase4.auth-cookie.spec.ts`:
  - after login there is no `token` key in `sessionStorage` or `localStorage`, and `document.cookie` contains no
    session cookie (it's HttpOnly);
  - a write without `X-XSRF-TOKEN` → 419;
  - after logout, `/auth/me` → 401;
  - a request from a storefront-host origin is not stateful.

### 7.5 Pest
`Sanctum::actingAs` keeps working for unit and feature tests. New feature tests (group `security`):
- Stateful login sets the session cookie: `HttpOnly`, `SameSite=Lax`, no `Domain`.
- A POST without the CSRF header → 419 `csrf_token_mismatch`.
- `Origin: http://demo.localhost:3000` → not stateful → 401.
- Session past `auth_expires_at` → 401.
- Password change → another session gets 401.
- Logout → 401 on reuse.
- 4.7c: a non-stateful login → 400 `stateful_required`, and no `token` in responses.

### 7.6 Strict order (P4-26)
1. **4.7a API (dual mode).** Sessions, CSRF and absolute expiry. Login responses return `AuthSession` **plus**
   deprecated `token`. Bearer still accepted. All existing tests stay green.
2. **4.7b WEB.** api-client and both SPAs switch to cookies (Vite proxy, CSRF, no token storage). Merchant and admin
   are released together.
3. **4.7b QA.** e2e support switches to storage state. Docker and Nginx get the proxy locations. The full e2e suite
   is green.
4. **4.7c API + orchestrator.** Remove `token` from responses and `AuthToken` from types. Add the PAT purge
   migration. Make `/auth/*` login routes stateful-only. Update openapi (`AuthTokenResponse` removed).

Each step merges only when the previous one is green. Until 4.7a lands, everything else uses Bearer as today.

---

## 8. Storefront changes (owner SF)

- `lib/products.ts`:
  - `getFeaturedProducts(host, limit, source)` and `getFlashDeals(host, limit)` call `GET /storefront/products`
    through the existing `storefront-api.ts`.
  - Public fetches use `next: { tags: [storeTag(host)], revalidate: 300 }`; preview uses `cache: 'no-store'`. The
    request is built with `config-request.ts`, so the preview header is forwarded exactly like `/storefront/config`.
  - Validate the response with Zod. Invalid → log and treat as `has_products: false`.
- Fallback rules:
  - `meta.has_products === false` → current placeholders (converted to paisa, still marked `PLACEHOLDER`).
  - `has_products === true`:
    - featured and hero get real cards (fewer than `limit` is fine; never pad with placeholders);
    - flash sale gets `on_sale=1` results, and an empty result hides the section in live mode;
    - in preview with an empty result, the section shows a small inline note "No sale items yet — add a compare-at
      price to show products here" (preview only).
  - Real flash deals have no stock meter, `claimed_percent` or `stock_left`: the bar is hidden. Their
    `discount_label` = `−{round((1 − price/compare_at) × 100)}%`.
- Product cards render **without a link** for real products (`href` null → `<div>`) until the PDP ships in Phase 5.
  Placeholders keep their current non-functional link → change them to no link as well, for consistency.
- Price display: `lib/format.ts` `formatBdt(paisa)` → `৳ 3,450` (no decimals when `% 100 === 0`). The UI never
  computes prices beyond formatting.
- Images: `StorefrontMedia` through the existing `next/image` loader and media origins. `image: null` → the theme's
  neutral image placeholder (not a demo product photo).
- Draft store: the coming-soon layout never calls the feed. Preview calls it with the token header.
- No PDP or PLP routes, no `/c/{slug}` route, and no cart in Phase 4.

---

## 9. Dashboard screens (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`

Every screen ships loading (skeleton rows `148:35302`), error (`148:35336`, "Try again") and no-results (`148:35352`)
states. Use `packages/ui` components and tokens only. Staff: delete and bulk-data controls are hidden; cost, profit
and stock-value-at-cost are hidden.

### 9.1 Screens

| Screen / route | Figma frame ids | Build | Skip / disable |
|---|---|---|---|
| Dashboard `/` | Desktop `10:600` (Main `10:754`, Page header `10:782`, Row KPIs `10:797`, Today to-do `10:958`); Empty pattern `148:34033` (Card / Empty `148:34624`); mobile Today `31:4281` | Greeting header (`10:782`) with "{store} · N products, M low on stock". **SetupChecklist** (existing) with the new "Add products" item. **KPI row:** the 4 KPI tiles `13:964` show Orders / Delivery success / Net profit / Returns cost as **"—"** with hint "Starts with your first order". The hero money card `10:798` shows the Card / Empty pattern "No sales yet" + "Share your shop link" (copy link) and "Preview shop". **Needs you today** `10:958`: only the "Restock products" task (`10:1011`; count = low + out; links to `/inventory?stock=low,out`) plus "Add your first product" while `has_products` is false. **Catalog card** (reuses the Products KPI card style from `60:8984`): Active products, Low stock, Out of stock, Customers | Range toggle `10:786`, Sales chart `10:890`, Orders by source `10:1024`, Courier performance `10:1061`, Money flow `10:1085`, Orders waiting `10:1115`, Best sellers `10:1168`, Confirm/Book/Call/Advance tasks |
| Products list `/products` | `60:8984` (Main `60:8986`); Product row symbol `60:11336`; empty state `148:34667` (Card / Empty `148:35263`, Ways to add `148:35276`); mobile `139:1077`, ProductCard `139:1065` | §4 | §4 hidden list |
| Product editor `/products/new`, `/products/:id` | `60:9381` (Main `60:9383`); Variant row `61:13220` | §4 | Write with AI, Add from URL, Collections, Where it's sold, Order form, Last 30 days, package/delivery charge, Preview on shop (disabled) |
| Categories `/products/categories` | `60:9778` (Main `60:9780`); Category row `63:13890` | §4 | Collections tab/card, New collection, Feature on homepage, sales · 30d |
| Import `/products/import` (`?type=customers`) | `60:10175` (Main `60:10177`); Column map row `63:16638`; Import preview row `63:16857` | §4 | Image URL download (disabled), inline fix |
| Inventory `/inventory` | `11:589` (Main `11:743`) | Header: "+ Receive stock" (adjustment dialog, reason `received`). Tabs **Stock levels** and **Stock movements** (ledger list with filters reason/product/date). KPI cards: Stock value (cost; O A) with "Selling value"; Units on hand; Held for orders (= `committed_units`, "Starts with orders"); Low or out of stock. Table: product, variant · SKU, on hand, held, available, status badge, Adjust (dialog: reason select, + / − / set to, note; sends `expected_on_hand`). Right card **Latest stock changes** = last 6 movements + "Ledger →" (switches tab). Low-stock threshold editable in the Adjust dialog | Tabs Purchase orders, Suppliers, Warehouses, Stock count; buttons Transfer stock, Purchase order; Incoming column; warehouse selector; Reorder suggestion card; barcode scan |
| Customers `/customers` | `63:14972` (Main `63:14974`); Customer/Row `61:12494`; Avatar `61:12493` | Header: Import (O A → import `?type=customers`), Export (O A → `POST /exports`), "+ Add customer" (Dialog: name, phone, email, district, area, channel, tags). Tabs **All**, **New this month**. KPI: Total customers, New this month, and Repeat rate / Avg order value as "—" with "Starts with your first order". Search "Name, phone or email". Table: customer (avatar initials, "Since {month year} · {channel}"), phone (formatted `+880 1712-345678`), district, orders (0), total spent (৳ 0), last order "—", chevron → detail | Tabs Repeat, Risky, Blocked; risky banner; district/risk/last-order filters; Delivered, Returns and Risk columns (render nothing); order-number search |
| Customer detail `/customers/:id` | `64:16382` (Main `64:16384`) | Header: name, "Customer since …", tags as badges; buttons **WhatsApp** (opens `https://wa.me/{phone}` in a new tab, `rel="noopener noreferrer"`) and an Edit dialog. Cards: Contact (phone with call/WhatsApp icon links, email, district · area), Tags (add/remove, PATCH), Notes (list, add, delete own / O A), stat tiles Total spent / Avg order / Delivered / Returns cost showing "—". O A: Delete customer (confirm) | SMS button, Block, Create order, Addresses, Delivery record across Storeplix (Q23), Orders table, Lifetime value, Message composer, Messenger contact |
| Onboarding 05 `/onboarding/products` | desktop `50:312`; mobile: none in Figma (P4-27; `54:941` is "You're live" and stays Phase 5.13) | Step rail (step 5 current). Choice cards: **Add manually** (selected), **Upload CSV / Excel** (→ `/products/import?from=onboarding`, back returns here), **Import from Facebook** (disabled, "Coming soon"). Quick add card: photos (≤ 8, first = Cover), product name, description (plain textarea → RichTextDoc paragraphs), price, compare-at, stock ("Stock per size" when sizes are chosen), size chips S/M/L/XL/XXL (+ custom), "+ Add colours" (second option). "Product N of 3" counter; "+ Add another product" saves the current one (`POST /products`, status `active`) and clears the form; "Saved" indicator. Right panel: static `PhonePreview` (existing) listing the products added in this session + the "{name} is live" toast card. Footer: Back (→ `/onboarding/theme`), Skip for now (→ `/`), Save & continue (saves a filled form, then → `/`) | "Write description in Bangla (AI)", Import from Facebook |
| Mobile shell | Tab bar `30:3170` (variants Today `30:3022`, Orders `30:3059`, Products `30:3096`, More `30:3133`); More `32:6541`; MenuRow `30:3202` | Existing `MobileNav` gains the Products tab (`/products`) with an active state. The centre "+" opens "Add product". The Orders tab stays a placeholder | Orders badge counts |

Dashboard checklist (`SetupChecklist`): new item "Add products" (hint "Your first items"). It is `done` when
`dashboard.setup.has_products`, and links to `/onboarding/products` when not done. `PickThemePage` now navigates to
`/onboarding/products` after a successful apply (previously `/`). StepRail marks step 5 current on
`/onboarding/products`.

### 9.2 Client rules
- Query keys: `[tenantId, storeId, 'products', filters]`, `[…, 'product', id]`, `[…, 'categories']`,
  `[…, 'inventory', filters]`, `[…, 'movements', filters]`, `[…, 'customers', filters]`, `[…, 'customer', id]`,
  `[…, 'dashboard']`, `[…, 'import', id]`.
- After a product save, invalidate products, inventory and dashboard. After an adjustment, invalidate inventory,
  movements, the product and dashboard.
- Forms: React Hook Form + Zod schemas mirroring §3 rules, including money inputs (৳ major units in the UI, converted
  to paisa with integer math: `Math.round(Number(str) * 100)` only after a `^\d{1,8}(\.\d{1,2})?$` check). Bangla
  digits are accepted and normalised.
- Map server `details` dot paths to fields, e.g. `variants.3.sku` → that grid cell.
- Import polling: `refetchInterval` 2 000 ms while status is `validating` or `importing`; stops otherwise.
- Exports: after `POST /exports`, poll until `completed`, then `window.location.assign(download_url)` (same tab,
  attachment).
- Any 402 `plan_limit_reached` → the existing plan-limit banner/modal from `plan/Banners.tsx` with "Upgrade to Starter".

### 9.3 Mobile (task 4.8)

Must pass at 390×844 (Playwright viewport) with no horizontal scroll:

| Screen | Mobile spec |
|---|---|
| Products list | **Figma `139:1077`**: card list (`139:1065`: thumb, name, "N variants · N in stock", price, stock badge) with a status toggle (active ↔ draft; staff included), filter chips All/Active/Low stock/Sold out, search bar. Bulk select hidden |
| Dashboard | **Figma `31:4281`**: shop header, greeting, empty money card, 3 compact KPI tiles ("—"), "Needs you today" list, checklist |
| Product editor, Categories, Inventory, Customers (+ detail), Import, Onboarding 05 | **No mobile frames.** Single column in the desktop card order; the right column stacks after the main cards (status first); tables become stacked rows (label/value) under `md`; sticky bottom action bar for Save/Discard. No new visual styles: same tokens and components |
| Shell | Bottom tab bar `30:3170` and More `32:6541` (existing, + Products tab) |

---

## 10. Security checklist (each item has a test in §12)

| Threat | Control |
|---|---|
| **Cross-tenant/cross-store references** (category_ids, parent_id, media ids, variant ids, image_media_id, customer/note ids, import/export ids) | `BelongsToTenant` + store-scoped `exists` rules (`Rule::exists(...)->where('store_id', $store->id)->whereNull('deleted_at')`) → 422; **triple composite FKs** make the database reject foreign store rows; `scopeBindings()` → 404 for nested route ids |
| **SKU/slug collisions across tenants** | Uniqueness is per store (partial unique indexes). Another tenant using the same SKU or slug is allowed and never revealed. The uniqueness query runs inside tenant scope; the DB index is the final guard → 422 |
| **IDOR on variants, images, adjustments, notes** | Variants change only through their product's payload (ids checked against `product_id`). Adjustment `variant_id`s are checked against the store. `inventory/{variant}` is bound through the store. Notes through `customers/{customer}/notes/{note}` with `scopeBindings`. Note delete: author or O A |
| **Mass assignment** | FormRequest `validated()` only; explicit DTO mapping in services. `$fillable` excludes `tenant_id`, `store_id`, `revision`, `price_*_amount` (derived), `published_at`, `orders_count`, `total_spent_amount`, `last_order_at`, `source`, `committed`, `on_hand`. MassAssignment security test posts each of them and asserts no effect |
| **Price manipulation** | Integer-only amounts with bounds; `compare_at > price` (validation + DB CHECK). No storefront endpoint accepts a price. Card prices come from the DB. `cost_amount` never leaves the API on storefront routes (resource key-set test) and is null for staff |
| **Stock integrity / races** | Row locks in sorted order inside one transaction; all-or-nothing; never negative; append-only ledger (model guard + arch test); parallel adjustment test (two processes, 50 × −1 on stock 50 → exactly 0, 50 ledger rows, no negative) |
| **CSV formula injection** | `CsvCell::safe` on every exported cell (export + error report), including full-width triggers and leading whitespace; template file safe too |
| **Malicious uploads / zip bombs / DoS** | 10 MB cap (also Nginx `client_max_body_size 12m` on the import route), magic-byte rejection of archives/binaries, no decompression, UTF-8 check, streaming parser, 5 000-row / 50-col / 10 000-char / 64 KB-line limits, one active import per store (DB partial unique), `merchant-bulk` throttle (10/hour/tenant), job timeout 300 s, file in private bucket with tenant prefix |
| **CSV content injection** | Description text → RichTextDoc text nodes (HTML stripped, never rendered as HTML); names/tags have control characters stripped; `image_urls` never fetched (no SSRF) |
| **CSRF (cookie auth)** | Sanctum CSRF (`XSRF-TOKEN` / `X-XSRF-TOKEN`) on every stateful write; `SameSite=Lax`; host-only cookies, so storefront subdomains can't read `XSRF-TOKEN`; `__Host-` session cookie (no tossing); stateful domains are an exact list without the storefront hosts; custom header `X-Tenant-Id` forces a CORS preflight that the SPA host never grants cross-origin |
| **Session security** | `HttpOnly` + `Secure` + regenerate on login, invalidate on logout, absolute 7-day expiry, `AuthenticateSession` (password change kills other sessions); no token in JS storage (e2e asserts) |
| **PII exposure** | Customer phone/email only on merchant routes for members of the tenant; staff can't export, import or delete (403); exports audited, private, 5-minute signed URLs, auto-expire 24 h; logs never contain row values (only `import_id`, row numbers, codes); error report download O A only |
| **Plan limit bypass** | Limit checked inside the transaction under a per-store advisory lock for create, duplicate and every import create; parallel create test at limit − 1 → exactly one succeeds |
| **Draft store catalog exposure (T22)** | `/storefront/products` → 404 for draft stores without a valid preview; preview responses `private, no-store`, never tagged |
| **Queue tenant leaks (T19)** | All jobs `TenantAware`; import/export files resolved via `TenantStorage`; job test asserts the context and that an import id from tenant B can't be processed under A |

SECURITY.md updates (ARCH, done with this contract):
- T13 is extended.
- T17 is rewritten for cookie auth.
- New T24 "Bulk import abuse" and T25 "Customer PII bulk exfiltration".

---

## 11. Figma features deferred (record, don't build)

| Area | Deferred (frame) | Where it goes |
|---|---|---|
| Products | Collections, manual and automatic (60:9778 tab/card) · Product reviews (60:10572) · Barcode labels (147:32835, symbol 147:32805) and barcode-scan search · "Where it's sold" channels (Facebook shop, POS, Instagram) · Order form on product page · Write with AI · Add photo from URL · Last 30 days sales card · Package size and per-product delivery charge · SOLD column, Top seller card, Sort by best selling · Copy from Facebook posts | Phase 5 (sales data, delivery charge), Phase 8 (reviews, channels, AI, barcodes), Q28 (URL photos) |
| Inventory | Warehouses / multi-location (plan feature `multi_warehouse`) · Purchase orders (35:5619, 35:6210, 36:6607) · Suppliers (153:35999) · Stock transfers (153:34425) · Stock count (153:35246) · Incoming column · Reorder suggestion | Phase 8 (DATABASE-DESIGN §6) |
| Customers | Segments (65:16718) · Blocked customers (66:17034) · Risk / fake-order guard and "Delivery record across Storeplix" (Q23) · Addresses · Orders table, LTV chart · SMS/WhatsApp composer · Create order | Phase 5 (addresses, orders), Phase 8 (segments, blocking, risk, messaging) |
| Dashboard | Every order, money, courier and source metric; range toggle; best sellers | Phase 5 / 7 |
| Onboarding | Import from Facebook; AI description; mobile frame for step 05 (none exists) | Phase 8 / design follow-up |

---

## 12. Test requirements

### API (Pest; `#[Group('tenancy')]`, `#[Group('security')]`, `#[Group('perf')]` as noted)
- **Categories:** CRUD; depth 4 → 422; move under own descendant → 422; reorder full list (bad set → 422); delete
  with children → 409; delete leaf detaches products; slug unique per store but the same slug in another store is
  OK; limit 500 → 409; staff delete → 403.
- **Products:**
  - Create simple and variable; type derived; option rules (4 options, 21 values, duplicate combination, wrong
    value) → 422.
  - SKU case-insensitive uniqueness, including SKUs inside the payload; a deleted variant frees its SKU.
  - `compare_at <= price` → 422; float amount → 422.
  - Images: order, max 10, foreign/failed/wrong-purpose media → 422; variant image must be among the product's
    images.
  - PATCH replaces variants (missing ones soft-deleted), keeps ids; revision conflict 409; `initial_on_hand` on an
    existing variant → 422; `on_hand` ignored.
  - Duplicate; bulk actions (foreign id → 422, nothing applied); staff cost null and ignored; `price_min/max`
    recomputed; `published_at` set once.
  - Plan limit 402 at 100 on Free (and parallel create at 99 → one 201, one 402).
  - Revalidation dispatched only when the product is or was active (Bus fake); category change dispatches.
- **Inventory:**
  - delta/set; negative → 422 `insufficient_stock` with nothing written; `expected_on_hand` mismatch → 409.
  - Ledger row per change, zero delta → no row; `on_hand_after` correct.
  - Movements filters; summary math incl. staff null; status thresholds incl. `untracked`.
  - Ledger update/delete throws; **concurrency test** (two DB connections or `pcntl_fork`, Postgres only, group
    `perf`): 50 × −1 on 50 → 0, 50 rows.
- **Imports:**
  - Upload checks (zip, gzip, xlsx, pdf magic → 422; invalid UTF-8; 10 MB+1 → 413; 5 001 rows; 51 columns; 10 001
    char cell; empty).
  - Suggested map for Shopify and WooCommerce headers; validate summary (create/update/unchanged/warnings/errors)
    for a fixture with every normalisation (`950tk`, Bangla digits, `৳ 3,450`, negative stock, missing price,
    non-contiguous handle, unknown category with and without `create_missing_categories`).
  - Run is idempotent (second run all `unchanged`, no new ledger rows); stock set via ledger `import`; plan limit
    (402 without `allow_partial`, over-limit rows error with it); one active import (409); cancel; error report CSV
    is formula-safe.
  - Customer import upsert by phone/email and in-file duplicates.
  - **perf group:** 5 000-row product fixture validate + run < 120 s on CI Postgres.
- **Exports:** products and customers CSVs match the template columns; `CsvCell::safe` unit test (all triggers,
  full-width, leading space, Bangla); download URL expires; expired export → `expired`; staff → 403;
  `customer.exported` audit.
- **Customers:** phone normalisation (`01556-120987`, `+8801556120987`, `8801556120987` → same; foreign number
  → 422); duplicate phone/email → 422; search by `0155`, `8801556`, email part, name; revision 409; notes add,
  delete (author vs other staff 403 vs admin OK); staff delete → 403; never-writable fields ignored.
- **Dashboard:** counts, staff `stock_value_cost_amount` null, month boundary in Asia/Dhaka.
- **Storefront feed:** only active with an enabled variant; card variant = cheapest enabled; `on_sale`; category
  includes descendants; `has_products`; draft store 404, with preview 200 `no-store`; **exact key set** (no cost,
  sku, stock, ids beyond product id).
- **tenancy group:**
  - `assertTenantIsolation` + `assertStoreIsolation` for Category, Product, ProductVariant, ProductImage,
    Inventory, InventoryMovement, Customer, CustomerNote, DataImport, DataImportRow, DataExport.
  - Tenant A using B's category/media/variant/customer/import ids in A's payloads → 422; in A's routes → 404.
  - A's SKU equal to B's → allowed.
  - Import/export jobs restore the right tenant; a file path of B is never readable under A.
  - `/storefront/products` with host A never returns B's products.
- **security group:**
  - Mass-assignment probes.
  - Staff can't see cost, export, import or delete.
  - Formula-injection export.
  - Archive/binary upload rejection.
  - CSV with `<script>` in the description stays text.
  - Auth cookie tests (§7.5).
  - Storefront feed has no cost.
  - Plan-limit race.

### Storefront (Vitest)
- Feed client: Zod parse; invalid → placeholders; `has_products` false → placeholders; true + fewer than the limit
  → no padding; flash sale empty → hidden (live), note (preview); discount label rounding; paisa formatting
  (`345000` → `৳ 3,450`, `345050` → `৳ 3,450.50`); cards without links; preview fetch `no-store`, public fetch
  tagged.

### Dashboard (Vitest + Testing Library)
- Money input parsing (Bangla digits, commas, 2 decimals, rejects 3 decimals) → paisa.
- Variant grid regeneration keeps ids for unchanged combinations, max 100, option rules.
- Product form maps `variants.N.sku` errors to cells; 409 conflict dialog; 402 banner; staff hides cost and delete.
- Category tree drag rules (depth 3, no self-nesting).
- Adjustment dialog sends `expected_on_hand`; 409 refresh message.
- Import wizard state machine (upload → map → validate polling → review filters → run → done); disabled
  image-URL toggle.
- Customer phone display formatting; search input passes through.
- Dashboard empty states when `orders === null`; checklist "Add products".
- Onboarding 05 creates variable products from size chips and resets the form.
- api-client (4.7b): CSRF header on writes, 419 retry once, no Authorization header, `credentials` set; session
  store keeps no token.

### QA (Playwright, `tests/e2e/specs/phase4.*.spec.ts`)
- **catalog:** create a variable product with 2 photos, then the list shows it, then archive, activate, and
  duplicate.
- **inventory:** adjust stock; ledger row visible; low-stock badge.
- **import:** upload a fixture, fix the column map, review errors, run, see products; re-run gives unchanged.
- **customers:** add a customer, search by phone, add a note, staff can't see Export.
- **onboarding05:** quick-add 2 products, then the dashboard checklist shows done.
- **storefront:** the demo store home shows real product names after seeding/publishing; a new store shows
  placeholders.
- **mobile:** products, dashboard, inventory and customers at 390 px with no horizontal overflow (screenshot +
  `scrollWidth` check).
- **auth-cookie:** §7.4.
- CI: `perf` group job on the Postgres service.

---

## 13. File ownership for Phase 4

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`. This covers: migrations (§2); models and policies; `Domain/Catalog` (Category, Product, ProductService, ProductPayloadValidator, controllers, presenters); `Domain/Inventory` (InventoryService, controllers); `Domain/Customers`; `Domain/DataTransfer` (imports, exports, CSV reader, `CsvCell`, jobs, scheduled prune/expire commands); `Domain/Dashboard`; storefront `StorefrontProductController`; `Permission` cases; `FeatureGate::usage(Products)`; `StorefrontRevalidationObserver` registration + `muted()`; `MediaController` in-use mapping for product images; `ApiExceptionRenderer` (419); auth/session changes for 4.7a and 4.7c (`IssuesTokens` → session login, `EnforceAbsoluteSessionExpiry`, config `sanctum`/`session`/`cors`, `bootstrap/app.php`); `composer.json` (`league/csv`, pinned); `DemoSeeder` (demo catalog: 3 categories, 8 active products using the theme demo images as media, 5 customers; idempotent); `.env.example` |
| **WEB** | `apps/merchant-dashboard/**` (§9 routes, nav children, MobileNav Products tab, onboarding 05, checklist, PickTheme redirect), `apps/super-admin/**` (4.7b auth switch only), `packages/api-client/**` (catalog, inventory, customers, imports, exports, dashboard methods; cookie/CSRF client in 4.7b), `packages/ui/**` (DataTable with selection, Tabs with counts, StockBadge, MoneyInput, TagInput, ChipSelect, Stepper, FileDrop, SortableTree depth-3, Dialog/Drawer additions), `packages/config/**`. Vite proxy config in both SPAs |
| **SF** | `apps/storefront/**` (§8: `lib/products.ts`, `lib/format.ts`, product card/hero/flash-sale/featured sections, Zod schema) |
| **QA** | `tests/e2e/**` (§12, storage-state auth §7.4), `docker-compose.yml` / `.env` wiring (`VITE_API_PROXY_TARGET`, `SANCTUM_STATEFUL_DOMAINS`, session env), `infrastructure/nginx/**` (`/api/` + `/sanctum/` proxy on app/admin hosts, `client_max_body_size`), `.github/**` (perf job on Postgres, Horizon `bulk` queue in compose), `docs/development/TESTING.md`, `docs/reviews/phase-4-qa.md` |
| **Orchestrator** | `packages/types/src/index.ts` (§6; 4.7c removal of `AuthToken`) |
| **ARCH** | This file, `docs/api/openapi.yaml` (1.4.0), API-CONVENTIONS.md (§7 auth), SECURITY.md (T13, T17, T24, T25), ADR 0005 amendment, DATABASE-DESIGN.md (Phase 4 tables), OPEN-QUESTIONS.md, FIGMA-INDEX.md, DEVELOPMENT-ROADMAP.md |

---

## 14. Order of work

1. **Orchestrator** applies §6 types (all additive; `AuthToken` stays).
2. **API: migrations + models + policies + catalog/inventory/customers endpoints.** **WEB** starts in parallel
   against openapi 1.4.0 and MSW mocks: products list/editor, categories, inventory, customers, dashboard. **SF**
   builds the feed client against mocks.
3. **API: import/export pipeline + dashboard + storefront feed + DemoSeeder.** WEB: import wizard, onboarding 05,
   mobile layouts.
4. **QA**: Phase 4 e2e specs (Bearer helpers still), perf job.
5. **Sub-step 4.7 in strict order** (§7.6): 4.7a API, then 4.7b WEB (both SPAs) + QA storage-state, then 4.7c API +
   orchestrator. Nothing in steps 1–4 depends on it.
6. QA review → `docs/reviews/phase-4-qa.md`.

---

## 15. Acceptance criteria

1. Categories: create a 3-level tree, reorder by drag, a 4th level is refused, deleting a parent with children is
   refused, and isolation tests pass.
2. Products:
   - A simple product and a variable product (2 options, 6 variants) can be created, edited, duplicated, archived
     and deleted.
   - SKU uniqueness is enforced per store, case-insensitively.
   - Images keep their order and the first is the cover.
   - Staff never see cost.
   - The Free plan stops at 100 products with 402 and the upgrade banner.
3. Inventory: receive, correct (set) and damage adjustments are atomic. The ledger shows every change with the actor
   and reason. Stock never goes negative. The concurrency test passes. Low/out badges follow the threshold.
4. CSV:
   - A 5 000-row product file validates and imports in < 2 min on CI Postgres.
   - Dry-run shows per-row ready/warning/error and nothing changes until Run.
   - Re-importing the same file changes nothing.
   - The export re-imports cleanly.
   - Every exported cell starting with `= + - @` (or TAB/CR) is prefixed.
   - Archives, binaries and oversized files are rejected.
5. Customers:
   - Add a customer by hand and by CSV.
   - `01556-120987` is stored as `8801556120987`.
   - Search by phone fragment, email or name works.
   - Notes work.
   - Staff can't export, import or delete.
6. The dashboard shows real catalog, stock and customer numbers, and every order or money card shows the Figma empty
   state. Loading and error states exist on every Phase 4 screen.
7. Onboarding 05 quick-adds products (with sizes → variable product) in the current store. The checklist marks
   "Add products" done. Pick a theme now leads to step 05.
8. Storefront:
   - The demo store's featured, hero and flash-sale sections show real active products (a preview of a draft
     store too).
   - A store without products shows placeholders.
   - A product change appears on the public storefront within 5 s of saving.
   - The feed never exposes cost or stock.
9. Mobile: Products, Dashboard, Inventory, Customers, the product editor and onboarding 05 work at 390 px with no
   horizontal scroll. The tab bar has Products.
10. Auth (4.7):
    - After 4.7b, no token exists in `sessionStorage` or `localStorage`.
    - Login sets an HttpOnly session cookie.
    - Writes without CSRF get 419.
    - Logout and expiry return to `/login` with the notice.
    - Choose a shop still works.
    - The super-admin still logs in.
    - The e2e suite runs on the storage-state cache.
    - After 4.7c, responses carry no token.
11. `pnpm -r test`, `pnpm -r typecheck`, `php artisan test --group=tenancy,security`, the perf job and the
    Playwright suite are green. openapi.yaml 1.4.0 parses and matches §6.

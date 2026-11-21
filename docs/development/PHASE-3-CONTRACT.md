# Phase 3 contract: Storefront engine (binding for API, WEB, SF)

Status: **Binding** from 2026-11-21. Scope: roadmap tasks 3.1–3.8 (theme config API with draft/publish, the theme,
the V3 theme editor, pages, navigation, SEO, onboarding "Pick a theme"). **Out of scope:** products, collections,
cart, checkout, customer accounts (Phase 5); custom domains and non-primary-host redirects (Phase 6); landing pages,
popups, media library page, "Ask AI" / "Rewrite with AI", "Save as my section", "Copy to another page", version
history, scheduled publishing, premium theme purchase, theme upload, languages (Q8). Show those UI elements
disabled or hide them. Don't fake them.

Everything in AGENT-CONTRACTS.md, PHASE-2-CONTRACT.md and docs/api/API-CONVENTIONS.md still applies: envelope,
snake_case, ULIDs, roles, `B`/`T` header shorthands, error codes. The machine-readable spec is
`docs/api/openapi.yaml` (**v1.3.0**).

Conventions in this file (same as Phase 2):
- **Headers.** `B` = `Authorization: Bearer`. `T` = `X-Tenant-Id`. A `{store}`, `{page}` or media id from another
  tenant → 404 `not_found`.
- **Roles** (ADR 0005): O = owner, A = admin, S = staff. Staff may **read** theme, pages and navigation (all `GET`s)
  but every write is O A only (`Permission::ManageSettings`); otherwise 403 `forbidden`.
- **Errors.** Every endpoint can also return 401 `unauthenticated`, 422 `validation_failed` (with `details`) and
  429 `rate_limited`.

---

## 0. Summary and goals

1. Merchants edit their storefront in a **V3 "premium & simple" editor** (Figma `2028:44400`): ordered home-page
   sections with per-section content and design settings, global "brand style" (colours, fonts, corners), live
   preview in an iframe, Publish / Discard.
2. Theme config has a **draft and a published copy** (`store_themes`). The public storefront only ever renders the
   published copy; a valid preview token renders the draft.
3. One **JSON Schema per theme major version** is the single source of truth, shared by Laravel (validate on save),
   the dashboard (form generation, client checks) and the storefront (parity test against its self-healing Zod).
4. **No merchant HTML, CSS or JS ever executes.** Rich text is stored as a restricted JSON document (a strict subset
   of ProseMirror/Tiptap JSON), never as HTML, and is rendered with React elements (auto-escaped).
5. **Pages** (`/pages/{slug}`), **navigation** menus (header, footer, help) and **store-level SEO** (title,
   description, share image, hide-from-search) with canonical URLs, OG/Twitter, JSON-LD, sitemap and robots.
6. Onboarding step 04 "Pick a theme" works end to end.

Products: **there are no product tables or product APIs yet** (checked: no `products` migration, model or route;
`apps/storefront/lib/products.ts` returns `PLACEHOLDER_PRODUCTS`). Every product-driven section (featured products,
flash sale, hero featured-product card) keeps rendering **placeholder demo products** until Phase 5 replaces
`getFeaturedProducts()` with the real API. The editor labels those sections "Shows sample products until you add
your own" (no fake settings for product pickers).

---

## 1. Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| P3-1 | **Editor = Online store V3** (`2028:44400`). Settings that V3 omits but V1 (`60:11061`) / V2 (`2007:46186`) show (button style solid/outline, logo for dark backgrounds, header sticky/search toggles) stay in the schema and API with defaults, not surfaced in the UI | Product-owner instruction; keeps the schema forward-compatible. Answers OPEN-QUESTIONS Q13 |
| P3-2 | **One fully implemented theme**: existing code `modern-commerce`, display name **"Gallery"** (V3 theme-library card "Gallery · Editorial serif, shop by age & collection · New · Free" is the Babur Gallery design of Storefront `1:9207` / mobile `1:10335`). The 8 other library cards (Boutique, Bazaar, Minimal, Festive, Saree House, Kids Corner, Classic, One Product) have **no storefront designs** in Figma; they get registry entries with `status: "coming_soon"` and cannot be applied. Theme version bumps to **1.1.0** | Only implement what is designed. The code stays `modern-commerce` so existing stored configs keep working. Note: the "Classic" card is a different, undesigned theme, so modern-commerce is *not* renamed "classic" (STOREFRONT-ENGINE examples updated) |
| P3-3 | **Section and block ids**: every section and block has a client-generated `id` (`^[a-z0-9]{8,16}$`, unique within the config) | Stable React keys, selection, preview click-to-select, diffing "3 changes" |
| P3-4 | **The whole theme document is camelCase**, including section and block settings (matches the existing storefront schemas, e.g. `primaryCtaLabel`). The API passes it through untransformed. Page bodies, navigation and every other API resource stay snake_case | Resolves OPEN-QUESTIONS Q9 (and corrects STOREFRONT-ENGINE §4, which said section settings were snake_case while the code used camelCase) |
| P3-5 | **Schema source of truth = JSON Schema** (draft 2020-12) in a new workspace package **`packages/themes`** (`@storeplix/themes`, owner SF). Laravel validates with `opis/json-schema` against a byte-identical copy in `apps/api/resources/themes/`; the storefront keeps its self-healing Zod schemas for render; **shared fixtures** (valid + invalid configs) run through all three validators in CI | Replaces ADR 0004's "Zod → exported JSON Schema" build step, which needed a codegen step across apps. A hand-written JSON Schema is reviewable, readable by PHP and by the dashboard form generator, and the fixture parity test catches drift |
| P3-6 | **Draft/publish only for the theme document.** Pages, navigation and store SEO save **live** (no draft copy). Pages have `status` `draft`/`published`/`hidden` instead | Matches Figma: Navigation and SEO settings have "Save"; Pages list shows Published/Draft/Hidden; only the editor and Brand style say "Buyers still see the live style until you publish". Keeps the phase small |
| P3-7 | **Logo, favicon and share image are store-level, saved immediately** (`PATCH /stores/{store}/settings`), even when edited on the Brand style screen. Colours, fonts and corners are part of the theme draft | Logo/favicon already live on `store_settings` (Phase 2) and are used by Coming soon, icons and JSON-LD. The Brand style "Logo & icons" card shows "Saved, live now" instead of counting toward draft changes |
| P3-8 | **Phase 2 colour fields** (`branding.primary_color` / `secondary_color` on `PATCH /stores/{store}/settings`) stay as a shortcut: they write the **active theme's draft and published** `primaryColor` / `secondaryColor` in one go (and revalidate). `GET .../settings` reads them from the published config | Keeps Store details (Phase 2) and onboarding "Make it yours" working without a publish step; Brand style is the primary UI |
| P3-9 | **Preview refresh = debounced save-draft + postMessage refresh.** The editor saves the draft 600 ms after the last change (`PUT .../draft`), then posts `{type:"refresh"}` to the iframe, whose preview bridge calls `router.refresh()` (keeps scroll position). Fallback when no `ready` message arrives in 8 s: reload the iframe `src`; after a further failure show "Open preview in a new tab" | Server-rendered preview stays the single rendering path (no second client renderer to keep in sync); `router.refresh()` avoids a full reload flash. Measured target: change → updated preview < 2 s |
| P3-10 | **Embedded preview cookie.** The editor iframe loads `{preview url}&embed=1`. For `embed=1` the storefront sets `sp_preview` (and `sp_embed=1`) with `SameSite=None; Secure; Partitioned; HttpOnly`; non-embed preview keeps `SameSite=Lax`. Responses carry `Content-Security-Policy: frame-ancestors` = the editor origins only when an `sp_preview` cookie is present; otherwise `frame-ancestors 'none'` + `X-Frame-Options: DENY` | The dashboard (`app.storeplix.com`, `localhost:5173`) and store hosts are cross-site in local dev and with future custom domains; Lax cookies would not be sent inside the iframe. Partitioned keeps the cookie scoped to the editor top-level site. Live pages can no longer be framed (clickjacking) |
| P3-11 | **Rich text = JSON, never HTML.** `RichTextDoc` (§4.4) is a strict subset of Tiptap/ProseMirror JSON. Server validates structure and link hrefs; storefront renders nodes with a `switch` to React elements. No `dangerouslySetInnerHTML` anywhere in the storefront (lint rule) | Eliminates HTML sanitizer bypasses entirely; Tiptap (dashboard) emits this shape natively |
| P3-12 | **Media in theme config and pages is referenced by `*MediaId` / `media_id`** (tenant-owned, checked on save). The storefront config and page responses carry a `media` map `{id → StorefrontMedia}` for exactly the ids they reference. Missing/failed media → the section renders its bundled demo image (theme sections) or nothing (page blocks) | Removes merchant-supplied image URLs (SSRF/tracking/mixed content). Existing URL fields (`image`, `detailImage`) are replaced by media ids |
| P3-13 | **Default content for new stores** (`StoreContentProvisioner`): active `store_themes` row from theme defaults; pages About us + Contact (**published**), Privacy policy, Terms of service, Delivery & return policy (**draft** — legal text must be reviewed by the merchant, see Q17); menus `main`, `footer`, `help`. Existing stores (incl. `demo`) get the same via idempotent command `php artisan stores:ensure-content` (run by `DemoSeeder` and on deploy) | Merchant gets a working site; no unreviewed legal claims go public. Draft pages linked from menus are hidden publicly until published (§3.3) |
| P3-14 | **Theme data moves from `store_settings.theme` to `store_themes`.** A migration copies every store's `store_settings.theme` into an active `store_themes` row (normalized to 1.1.0, draft = published), then **drops** `store_settings.theme` | One source of truth; a stale column invites bugs. `down()` restores it from `published_config` |
| P3-15 | **No plan gating in Phase 3.** Phase 2 `FeatureGate` has no theme/page/SEO features, and Figma shows no plan lock on any Phase 3 screen (the lock icons on Header/Footer/Announcement mean "fixed position", not "paid"). Premium themes (Festive ৳990, Saree House ৳1,490, One Product ৳790) are one-off purchases in Figma, not plan features: they show as "coming soon" (Q18) | Don't invent paid features |
| P3-16 | **Limits** (constants, both sides): ≤ **30** sections per theme config; per-type `maxInstances` and `maxBlocks` (§4.3); config ≤ **64 KB** (UTF-8 JSON); ≤ **50** pages per store; page body ≤ **40** blocks and ≤ **128 KB**; menu ≤ **60** items total, ≤ **20** top-level, ≤ **20** children per item, depth ≤ **2** | Bounded payloads and render cost |
| P3-17 | **Optimistic concurrency** on theme draft, pages and menus: every write sends the `revision` it was based on; mismatch → 409 `revision_conflict`. The dashboard then refetches and shows "Changed in another tab or by a teammate. Reload to continue" | Two admins (or two tabs) can't silently overwrite each other |
| P3-18 | **Revalidation**: theme **publish/apply**, any page change that affects public output, navigation saves, and store SEO changes dispatch the existing `RevalidateStorefront` job (single `store:{host}` tag per host, Phase 2 §1.8). **Draft saves do not revalidate** (preview is `no-store`) | Reuses the proven pipeline; per-page tags are not needed at this scale |
| P3-19 | **Local preview URL** prefers a `*.localhost` store domain when `APP_ENV=local` and the store has one (demo: `http://demo.localhost:3000/?preview=…`) | Browsers accept `Secure`/`SameSite=None` cookies on `http://*.localhost` but not on `http://*.storeplix.test`, so the embedded preview works in dev |

### New OPEN-QUESTIONS (appended to OPEN-QUESTIONS.md)
- **Q17** Default legal pages (Privacy, Terms, Delivery & return): ship neutral templates as drafts (default) or
  published? Who owns the template wording (legal review)?
- **Q18** Theme roadmap: which of the 8 "coming soon" library themes get storefront designs, and in what order?
  Premium themes (Festive ৳990, Saree House ৳1,490, One Product ৳790): one-off purchase, plan feature, or drop?
- **Q19** Figma naming conflict: the V3 editor toolbar says "Boutique theme" while showing the Gallery (Babur
  Gallery) design. Default: the implemented theme is named **Gallery**.
- **Q20** Pages in two languages (V1 Edit page has বাংলা / English tabs). Default: one language per page until Q8.

---

## 2. Data (migrations, owner API)

Postgres in CI/prod; local sqlite must keep working (jsonb → json on sqlite; partial indexes via raw SQL both accept).
Every new tenant-owned table has `UNIQUE(tenant_id, id)`. `FK(t)` = composite `(tenant_id, col) → table(tenant_id, id)`.
All models use `BelongsToTenant` + `HasUlids`.

| Table | Columns / change |
|---|---|
| `store_themes` (new) | `id ulid pk`; `tenant_id` FK tenants cascade; `store_id ulid` **FK(t) stores cascade**; `theme_code varchar(64)`; `theme_version varchar(20)` (version of `draft_config`); `draft_config jsonb not null`; `draft_revision int not null default 1`; `draft_updated_at timestamptz`; `draft_updated_by ulid null` FK users nullOnDelete; `published_config jsonb null`; `published_revision int null` (= the draft_revision that was published); `published_at timestamptz null`; `published_by ulid null` FK users nullOnDelete; `is_active boolean not null default false`; `applied_at timestamptz null` (set only by an explicit apply; drives the onboarding checklist); timestamps. `UNIQUE(tenant_id,id)`; `UNIQUE(store_id, theme_code)`; partial unique `store_themes_one_active ON (store_id) WHERE is_active`; `INDEX(tenant_id, store_id)` |
| `store_pages` (new) | `id`; `tenant_id` FK tenants cascade; `store_id` **FK(t) stores cascade**; `title varchar(120)`; `slug varchar(80)`; `status varchar(16) default 'draft'` (`draft`\|`published`\|`hidden`); `template varchar(32) default 'blank'`; `body jsonb not null default '[]'` (PageBlock[]); `seo_title varchar(70) null`; `seo_description varchar(160) null`; `og_image_media_id ulid null` **FK(t) media RESTRICT**; `revision int not null default 1`; `published_at timestamptz null` (first time it became published); `created_by`, `updated_by ulid null` FK users nullOnDelete; timestamps. `UNIQUE(tenant_id,id)`; `UNIQUE(store_id, slug)`; `INDEX(tenant_id, store_id, status)` |
| `store_navigation` (new) | `id`; `tenant_id` FK tenants cascade; `store_id` **FK(t) stores cascade**; `handle varchar(32)` (`main`\|`footer`\|`help`); `title varchar(40)`; `items jsonb not null default '[]'` (NavItem[] tree); `revision int not null default 1`; `updated_by ulid null` FK users nullOnDelete; timestamps. `UNIQUE(tenant_id,id)`; `UNIQUE(store_id, handle)` |
| `store_settings` | + `og_image_media_id ulid null` **FK(t) media RESTRICT**; + `noindex boolean not null default false`. Existing `seo_title` / `seo_description` are reused (validation ≤ 70 / ≤ 160). **Drop `theme`** after the data copy (P3-14) |

Data migration (same migration file as `store_themes`, after create): for each `store_settings` row, run
`ThemeConfigUpgrader::toV1_1(array $old)` (pure PHP, no models): set `version` `1.1.0`, fill missing global settings
from defaults, map `primaryColor`/`secondaryColor`/`fontFamily` (drop a font not in the allowlist), give each section
an `id`, drop unknown section types and unknown keys, replace a missing/empty `sections` with the default sections.
Insert `{theme_code, theme_version, draft_config = published_config = upgraded, draft_revision = published_revision = 1,
published_at = now, is_active = true}`. Then drop the column. Unit-test the upgrader with the Phase 2 default config
and the demo config.

Models: `StoreTheme`, `StorePage`, `StoreNavigation`. `Store` gets `activeTheme()` (hasOne where is_active), `pages()`,
`navigation()`. Cross-tenant isolation tests (`assertTenantIsolation`) are required for all three.

Media references: `MediaController::destroy` returns 409 `media_in_use` when the id is referenced by
`store_settings` (logo, favicon, og image), `store_pages.og_image_media_id`, or appears as a string inside any
`store_themes.draft_config` / `published_config` / `store_pages.body` of the tenant (ULIDs are unique, so a
JSON-text `LIKE '%{id}%'` scan within the tenant is acceptable at this scale). FK RESTRICT violations map to the same 409.

---

## 3. API endpoints

### 3.1 Theme catalog and store themes. `B` + `T`

| Method & path | Roles | Body | Success | Errors |
|---|---|---|---|---|
| `GET /themes` | O A S | — | 200 `ThemeCatalogEntry[]` (registry order) | — |
| `GET /stores/{store}/themes` | O A S | — | 200 `StoreThemeSummary[]` (installed rows; active first) | 404 |
| `GET /stores/{store}/themes/{code}` | O A S | — | 200 `StoreTheme` | 404 `not_found` (not installed for this store) |
| `PUT /stores/{store}/themes/{code}/draft` | O A | `SaveThemeDraftInput` | 200 `StoreTheme` (`draft_revision` + 1) | 404; 409 `revision_conflict`; 422 `validation_failed`; 422 `theme_mismatch` (`config.theme` ≠ `{code}` or major version ≠ registry major); 413 `payload_too_large` (> 64 KB) |
| `POST /stores/{store}/themes/{code}/publish` | O A | `PublishThemeInput` | 200 `StoreTheme`. Copies draft → published, `published_revision = draft_revision`, `published_at = now`. Revalidates. Publishing an unchanged draft is allowed (idempotent) | 404; 409 `revision_conflict` (draft changed since the client saw it); 409 `theme_not_active` (only the active theme can be published in Phase 3) |
| `POST /stores/{store}/themes/{code}/discard` | O A | — | 200 `StoreTheme`. Draft := published, `draft_revision` + 1. No revalidation | 404; 409 `nothing_published` (published_config null) |
| `POST /stores/{store}/themes/{code}/apply` | O A | — (empty) | 200 `StoreTheme`. Creates the row if missing from registry defaults **carrying over** the current active theme's `primaryColor`, `secondaryColor`, `textColor`, `backgroundColor`, `fontFamily`, `headingFontFamily`, `cornerStyle`; sets draft = published (rev 1), `is_active = true` (others false), `applied_at = now`. Revalidates | 409 `theme_unavailable` (registry `status != available`, or `tier = premium`); 404 unknown code |

Throttles: draft `throttle:120,1` per user; publish/discard/apply `throttle:20,1`.
Audit: `theme.published` (meta `{code, revision}`), `theme.discarded`, `theme.applied`. Draft saves are not audited.
`{code}` route constraint `[a-z0-9-]{1,64}`.

**Validation of `PUT .../draft`** (`ThemeConfigValidator`, in this order; first failing stage returns):
1. Envelope (FormRequest): `config` required array; `base_revision` required integer ≥ 1. Raw JSON of `config` ≤ 65 536 bytes.
2. Normalise: lowercase every value of keys ending in `Color`; trim every string.
3. JSON Schema (`opis/json-schema` 2.x, draft 2020-12) against `resources/themes/{code}/schema.v{major}.json`.
   Errors map to `details` with **dot paths** relative to `config` (e.g. `"config.sections.1.settings.limit"`),
   message = opis' first error for that path. At most 50 entries.
4. Semantic checks the schema can't express: section `id`s unique, block `id`s unique within the config;
   per-type `maxInstances` (manifest); every value of a key ending in `MediaId` is null or a media id of **this
   tenant** with `status != failed` and purpose ∈ `page_image|product_image|logo` → else
   `details["config.<path>"] = ["Unknown image."]`; every `href`-type string passes `SafeHref::theme()` (§8).
5. Optimistic lock: `UPDATE ... WHERE id = ? AND draft_revision = base_revision`; 0 rows → 409 `revision_conflict`.

### 3.2 Pages. `B` + `T`

`{page}` = `store_pages.id`.

| Method & path | Roles | Body | Success | Errors |
|---|---|---|---|---|
| `GET /page-templates` | O A S | — | 200 `PageTemplate[]` (static list, §4.6) | — |
| `GET /stores/{store}/pages` | O A S | `?filter[status]=draft,published,hidden&q=` (q: title/slug contains, ≤ 80) | 200 `{data: StorePageSummary[], meta: PageListMeta}` sorted `updated_at desc`; not paginated (≤ 50) | 404 |
| `POST /stores/{store}/pages` | O A | `CreatePageInput` | 201 `StorePage`. If `template` given and `body` absent, body/title/slug come from the template (store name, phone and email filled in). `add_to_menu` appends a `{type:"page"}` item to that menu (same transaction, menu revision + 1) | 409 `page_limit_reached` (50); 422 |
| `GET /stores/{store}/pages/{page}` | O A S | — | 200 `StorePage` | 404 |
| `PATCH /stores/{store}/pages/{page}` | O A | `UpdatePageInput` (partial; `revision` required) | 200 `StorePage` (`revision` + 1). Revalidates when the page is or was `published` | 404; 409 `revision_conflict`; 422 |
| `DELETE /stores/{store}/pages/{page}` | O A | — | 204. Menu items pointing at it stay and resolve as `page_missing` (hidden publicly). Revalidates if it was published | 404 |

Validation (FormRequest + `PageBodyValidator`):

| Field | Rule |
|---|---|
| `title` | required on create; `string`, trim, `min:1`, `max:120`, no control chars |
| `slug` | optional on create (default = slugified title, ASCII; Bangla-only titles fall back to `page-{6 random [a-z0-9]}`); `regex:/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, `max:80`; unique per store (`"This link is already used by another page."`); not in **reserved slugs**: `new, edit, index, home, api, admin, search, cart, checkout, account, accounts, login, logout, register, collections, products, orders, track, track-order, sitemap, robots, preview, pages, static, assets, themes, _next` |
| `status` | `in:draft,published,hidden`; default `draft`. First transition to `published` sets `published_at` |
| `template` | `in:` PageTemplateCode; create only (immutable after) |
| `body` | `array`, `max:40` blocks, ≤ 131 072 bytes as JSON; each block per §4.5 (unique `id`, known `type`, no unknown keys) |
| `seo.title` | `nullable`, `max:70` · `seo.description` `nullable`, `max:160` · `seo.share_image_media_id` `nullable`, media of this tenant, purpose `page_image`, not failed |
| `add_to_menu` | create only; `nullable`, `in:main,footer,help` |
| `revision` | PATCH: required integer |

Audit: `page.created`, `page.updated` (meta `changes` = changed top-level keys), `page.published` (status → published),
`page.deleted`.

### 3.3 Navigation. `B` + `T`

| Method & path | Roles | Body | Success | Errors |
|---|---|---|---|---|
| `GET /stores/{store}/navigation` | O A S | — | 200 `NavigationMenu[]`, always the three handles in order `main, footer, help` (rows are created lazily with defaults) | 404 |
| `PUT /stores/{store}/navigation/{handle}` | O A | `SaveNavigationInput` (whole menu) | 200 `NavigationMenu` (`revision` + 1). Revalidates | 404 unknown handle; 409 `revision_conflict`; 422 |

Item rules: `id` `^[a-z0-9]{8,16}$` unique in the menu; `label` 1–40 chars, no control chars; depth ≤ 2 (children
of children → 422 `details["items.3.children.0.children"]=["Menus can only be two levels deep."]`); counts per P3-16.
`link` (discriminated by `type`):

| type | fields | rule | resolves to |
|---|---|---|---|
| `home` | — | — | `/` |
| `page` | `page_id` | ULID of a page **of this store** | `/pages/{slug}`; `link_status` `ok` if published, `page_unpublished` if draft/hidden, `page_missing` if deleted |
| `url` | `url` | `max:2048`; scheme `http` or `https` only; must have a host; no credentials; no control chars or whitespace | the URL; storefront renders external links with `rel="noopener noreferrer"` |
| `collection` | `handle` | `regex:/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, `max:80` | `/collections/{handle}` (route 404s until Phase 5; dashboard shows "Collections arrive with products") |
| `builtin` | `target` | `in:track_order,cart,search` | `/track-order`, `/cart`, `/search` (Phase 5 routes) |

Defaults: `main` "Main menu" = Home, About us; `footer` "Shop" = Home; `help` "Help" = Contact, Delivery & return
policy, Privacy policy, Terms of service.
Audit: `navigation.updated` (meta `{handle}`).

### 3.4 Store SEO (extends Phase 2 `PATCH /stores/{store}/settings`, O A)

New optional section `seo` in `UpdateStoreSettingsInput` and `StoreSettings`:

| Field | Rule | Storage |
|---|---|---|
| `seo.title` | `nullable`, trim, `max:70` | `store_settings.seo_title` |
| `seo.description` | `nullable`, trim, `max:160` | `seo_description` |
| `seo.share_image_media_id` | `nullable`, media of this tenant, purpose `page_image`, not failed (recommend 1200×630; not enforced) | `og_image_media_id` |
| `seo.hide_from_search` | `boolean` | `noindex` |

Revalidates (already: any `StoreSettings` change). Audit `store.settings_updated` lists `seo.*` keys.

### 3.5 Media list (new, needed by the editor's media picker `2053:51939`). `B` + `T`, O A S

`GET /media?filter[purpose]=page_image,logo&page&per_page` (default 24, max 60) → 200 `Media[]` + `PaginationMeta`,
newest first, `status != failed`. Unknown filter → 422.

### 3.6 Preview token (Phase 1.1, extended)

Unchanged contract, plus P3-19 (local `.localhost` preference). The token stays **read-only**: it never authorises a
write, and the API ignores `X-Storefront-Preview` on every merchant route. Its scope is "render the draft theme and
non-public pages of exactly this store". The dashboard re-issues a token when `expires_at` is < 5 min away and
reloads the iframe.

### 3.7 Storefront API (server-to-server; `X-Storefront-Key` + `X-Storefront-Host`, optional `X-Storefront-Preview`)

| Method & path | Success | Notes |
|---|---|---|
| `GET /storefront/config` | 200 `StorefrontConfig` (extended, §7.2) | `theme` = active theme's **published_config** (null → registry defaults); valid preview → **draft_config**. `navigation` resolved per §3.3: public drops items whose `link_status != ok` (a parent without an href and with no remaining children is dropped too); preview keeps `page_unpublished` items. `media` holds exactly the ids referenced by the served theme config |
| `GET /storefront/pages` | 200 `StorefrontPageIndexEntry[]` | **Published** pages only, always (ignores preview). For sitemap. Max 50 |
| `GET /storefront/pages/{slug}` | 200 `StorefrontPage` | Public: `published` only, else 404 `page_not_found`. Valid preview: any status. Slug param must match the slug regex, else 404 |

All three: tenant from host only; preview responses `Cache-Control: private, no-store` (existing middleware).

---

## 4. Theme schema format

### 4.1 Package layout — `packages/themes` (`@storeplix/themes`, owner SF, private, no build step)

```
packages/themes/
  package.json                       name @storeplix/themes, "exports": { "./*": "./*" }, scripts.test = vitest (AJV parity)
  registry.json                      ThemeCatalogEntry[] metadata (all 9 library themes)
  fonts.json                         font allowlist + pairings
  modern-commerce/
    schema.v1.json                   JSON Schema 2020-12 for ThemeConfig of major 1 (strict: additionalProperties false)
    defaults.json                    complete valid default config (new stores, fallback, "Reset to theme")
    manifest.json                    editor metadata: section catalog, field order/labels/widgets, presets, limits
  fixtures/modern-commerce/
    valid/*.json                     ≥ 6 configs (defaults, every section type with max blocks, minimal, all-disabled…)
    invalid/*.json                   ≥ 20 configs, each { "config": {...}, "expect": "sections.0.settings.heading" } (§9)
```
Laravel copy: `apps/api/resources/themes/` mirrors `registry.json`, `fonts.json`, `modern-commerce/*` and
`fixtures/` byte-for-byte. `ThemeSchemaSyncTest` (PHP) compares sha256 of each file with
`base_path('../../packages/themes/…')` when that path exists (monorepo checkout / CI) and fails on drift.
`config('storeplix.default_theme')` is removed; defaults come from `resources/themes/{code}/defaults.json`.

### 4.2 Document shape (camelCase, P3-4)

```json
{
  "theme": "modern-commerce",
  "version": "1.1.0",
  "settings": {
    "primaryColor": "#0846c2", "secondaryColor": "#ff7a00", "textColor": "#0e1a33", "backgroundColor": "#fffcf8",
    "fontFamily": "Instrument Sans", "headingFontFamily": "Fraunces",
    "cornerStyle": "rounded", "buttonStyle": "solid", "stylePreset": null,
    "logoOnDarkMediaId": null,
    "announcement": { "enabled": true, "text": "Free delivery inside Dhaka over ৳2,000 · Cash on delivery nationwide", "href": null },
    "header": { "sticky": true, "showSearch": true, "promoLink": { "label": "Winter offers", "href": "/collections/winter" } },
    "footer": { "tagline": "A calm, carefully edited home for everything children need.", "showPaymentMethods": true,
                "paymentMethods": ["cod", "bkash", "nagad", "visa", "mastercard"] }
  },
  "sections": [
    { "id": "h3ro0001", "type": "hero", "enabled": true,
      "settings": { "heading": "Little things,", "headingAccent": "chosen well.", "imageMediaId": null, "layout": "image_right",
                    "design": { "background": "default", "customBackground": null, "textTone": "auto",
                                "paddingTop": 64, "paddingBottom": 48,
                                "visibility": { "desktop": true, "tablet": true, "phone": true } } },
      "blocks": [ { "id": "st4t0001", "type": "stat", "settings": { "value": "4.9★", "label": "11k+ parent reviews" } } ] }
  ]
}
```
Rules: `settings` keys are **all required** in the schema (defaults.json supplies them; the editor always sends the
full document). Section `settings` may omit keys (renderer fills defaults) except those marked *req* below;
`blocks` is required (possibly empty) for types that have blocks and forbidden otherwise.

### 4.3 Global settings and section catalog (modern-commerce 1.1)

`$defs` used below: `hex` = `^#[0-9a-f]{6}$`; `text(n)` = string, `maxLength n`, pattern `^[^\u0000-\u001f\u007f]*$`;
`href` = string ≤ 2048, `^(/(?!/)[^\s\\]*|https://[^\s\\]+)$` (plus server `SafeHref::theme()`); `mediaId` = ULID
pattern or null; `design` = common section design object (below).

**Global settings** (V3 Brand style `2035:46054` + editor "Theme style" tab):

| Key | Type | Notes / UI |
|---|---|---|
| `primaryColor`, `secondaryColor`, `textColor`, `backgroundColor` | hex | V3 "Primary", "Accent" (= secondary), "Text", "Background". Dashboard shows WCAG contrast badge vs background/white and the "Low on white" warning; never blocks saving |
| `fontFamily`, `headingFontFamily` | enum `fonts.json` allowlist: `Instrument Sans`, `Inter`, `Hind Siliguri`, `Fraunces`, `Noto Serif Bengali`, `Baloo Da 2` | UI shows **pairings** (`fonts.json`): *Gallery* (Fraunces / Instrument Sans, theme default), *Modern* (Inter + Hind Siliguri), *Editorial* (Fraunces + Noto Serif Bengali), *Friendly* (Baloo Da 2). A pairing writes both keys. Bangla glyphs always fall back to Hind Siliguri in the CSS stack |
| `cornerStyle` | `square`\|`rounded`\|`pill` | "Corners & buttons" |
| `buttonStyle` | `solid`\|`outline` | V1 only; not surfaced |
| `stylePreset` | `null` or preset id from manifest (`mugdho-violet`, `jamdani-green`, `eid-gold`, `rose-blush`, `midnight`, `fresh-market`, `ocean`, `terracotta`) | "Start from a style": a preset writes the four colours (+ pairing) and records its id; any later colour edit sets it to `null` |
| `logoOnDarkMediaId` | mediaId | V1 only; not surfaced |
| `announcement` | `{enabled: bool, text: text(120) req, href: href\|null}` | Locked "Announcement bar" row |
| `header` | `{sticky: bool, showSearch: bool, promoLink: {label: text(30), href} \| null}` | Locked "Header & menu" row; menu links come from Navigation |
| `footer` | `{tagline: text(240)\|null, showPaymentMethods: bool, paymentMethods: enum[] (`cod`,`bkash`,`nagad`,`rocket`,`upay`,`visa`,`mastercard`,`amex`), unique, ≤ 8}` | Locked "Footer" row |

**`design`** (every section; V3 "Design" tab `2050:49617`): `{ background: "default"|"muted"|"brand"|"accent"|"inverse"|"custom",
customBackground: hex|null (required non-null iff background = custom), textTone: "auto"|"dark"|"light",
paddingTop: 0–160 multipleOf 8, paddingBottom: 0–160 multipleOf 8, visibility: {desktop, tablet, phone: bool} }`.
Visibility is applied with CSS media classes (no JS); "Hidden parts still load fast" copy from Figma stands.
V3 Design accordions "Text", "Buttons", "Image", "Animation" and "Different design on phones" are **not** in Phase 3.

**Section types** (Figma desktop `1:10112`, tablet `1:10482`, mobile `1:10335`; editor labels from `2045:48301`):

| type | Editor label | Figma desktop / mobile | maxInstances | Settings (camelCase; *req* = required) | Blocks (maxBlocks) | Data |
|---|---|---|---|---|---|---|
| `hero` | Hero | `1:10114` / `1:10337` | 1 | `eyebrow` text(40); `heading` text(60) *req*; `headingAccent` text(60); `subheading` text(140); `primaryCtaLabel` text(30); `primaryCtaHref` href; `secondaryCtaLabel` text(30); `secondaryCtaHref` href; `imageMediaId`; `imageAlt` text(160); `detailImageMediaId`; `tagLabel` text(24); `showFeaturedProduct` bool; `layout` `image_right`\|`image_left`\|`full_image`; `height` `fit`\|`half`\|`full` | `stat` {`value` text(12) *req*, `label` text(40) *req*} (3) | featured card = placeholder product |
| `chip-links` | Shop by age | `1:10153` / `1:10355` | 3 | `title` text(60); `subtitle` text(60) | `chip` {`badge` text(6), `label` text(24) *req*, `sublabel` text(24), `href` *req*} (8) | static |
| `flash-sale` | Flash sale | `1:10195` / `1:10373` | 1 | `eyebrow` text(24); `title` text(60) *req*; `subtitle` text(140); `endsAt` ISO-8601 date-time\|null (countdown hidden when null or past); `linkLabel` text(30); `linkHref` href; `limit` 1–8 | — | placeholder products |
| `category-grid` | Categories | `1:10216` / `1:10391` | 3 | `title` text(60); `subtitle` text(140) | `category` {`title` text(40) *req*, `imageMediaId`, `href` *req*} (8) | static |
| `featured-products` | New arrivals / Bestsellers | `1:10225`, `1:10279` / `1:10406` | 3 | `eyebrow` text(40); `title` text(60) *req*; `linkLabel` text(30); `linkHref` href; `source` `latest`\|`bestsellers`; `limit` 1–8 | — | placeholder products |
| `image-with-text` | Editorial | `1:10238` / `1:10419` | 3 | `eyebrow` text(40); `heading` text(80) *req*; `text` text(400); `ctaLabel` text(30); `ctaHref` href; `imageMediaId`; `imageAlt` text(160); `layout` `image_left`\|`image_right` | — | static |
| `feature-tiles` | Three worlds | `1:10248` / `1:10427` | 3 | `title` text(60); `subtitle` text(140) | `tile` {`title` text(40) *req*, `text` text(140), `imageMediaId`, `href` *req*, `linkLabel` text(30)} (3) | static |
| `trust-badges` | Promises | `1:10292` / `1:10456` | 2 | — (design only) | `badge` {`icon` enum `truck`,`cash`,`return`,`shield`,`chat`,`gift`,`star`,`leaf` *req*, `title` text(40) *req*, `text` text(100)} (4) | static |
| `reviews-club` | Reviews & club | `1:10297` / `1:10461` | 1 | `title` text(60); `subtitle` text(140); `club` {`enabled` bool, `heading` text(60), `text` text(200), `ctaLabel` text(30), `ctaHref` href} | `review` {`quote` text(280) *req*, `author` text(40) *req*, `location` text(40), `rating` int 1–5} (6) | static. The club card is a link, **not** a signup form (newsletter capture is Marketing, later) |
| `rich-text` | Text | — (generic) | 5 | `heading` text(80)\|null; `doc` RichTextDoc *req* (≤ 10 KB); `align` `left`\|`center`; `width` `narrow`\|`wide` | — | static |

Header (`1:10645` / `1:10751` / tablet `1:10799`), footer (`1:10700` / `1:10765`), announcement bar (inside the
header) and the mobile tab bar (`1:10782`, Phase 5 links) are **theme chrome**, not sections. Mega menu (`1:13837`) is
out of scope: children render as a simple dropdown (desktop) and in the menu drawer (`1:14585`, mobile).

Default home order (defaults.json): hero, chip-links (Shop by age), flash-sale, category-grid, featured-products
(New arrivals, `latest`), image-with-text (Editorial · Winter), feature-tiles (Three worlds), featured-products
(Bestsellers, `bestsellers`, **enabled false on phone** per editor mock "Phone off"), trust-badges, reviews-club.
Copy and demo images from the Figma frames; demo images ship in `apps/storefront/public/themes/modern-commerce/images/`.

### 4.4 RichTextDoc (P3-11)

```
doc        := { type:"doc", content: block[] (≤ 100) }
block      := paragraph | heading | bulletList | orderedList | blockquote
paragraph  := { type:"paragraph", content?: inline[] }
heading    := { type:"heading", attrs:{ level: 2|3 }, content?: inline[] }
bulletList / orderedList := { type, content: listItem[] (1–50) }
listItem   := { type:"listItem", content: paragraph[] (1–5) }        // no nested lists
blockquote := { type:"blockquote", content: paragraph[] (1–10) }
inline     := { type:"text", text: string (1–5000, no U+0000–U+001F / U+007F; line breaks are hardBreak nodes), marks?: mark[] } | { type:"hardBreak" }
mark       := {type:"bold"} | {type:"italic"} | {type:"underline"} | {type:"strike"}
            | {type:"link", attrs:{ href }}                          // no other attrs (target/rel are added on render)
```
Unknown node/mark types, unknown keys and extra `attrs` → 422. Link `href`: relative `/…` (not `//`), `https://`,
`http://`, `mailto:` (strict address, no `?`), `tel:` (`^tel:\+?[0-9]{7,15}$`) — anything else (incl. `javascript:`,
`data:`, `vbscript:`, entity/whitespace-obfuscated variants) → 422. The dashboard uses Tiptap with only these
extensions enabled and strips anything else before sending.

### 4.5 Page blocks (`store_pages.body`, snake_case, V1 Edit page `74:22532` block list)

| type | fields | rules |
|---|---|---|
| `heading` | `text`, `level` | text 1–120; level 2\|3 |
| `rich_text` | `doc` | RichTextDoc ≤ 20 KB |
| `image` | `media_id`, `alt`, `caption` | media of tenant, purpose `page_image`, nullable; alt ≤ 160; caption ≤ 200 |
| `button` | `label`, `href`, `style` | label 1–40; href = theme `href` rule **or** `https://wa.me/<digits>` / `tel:`; style `primary`\|`secondary` |
| `callout` | `title`, `items`, `tone` | title ≤ 80 nullable; items 1–8 strings ≤ 200; tone `info`\|`success`\|`warning` |
| `table` | `headers`, `rows` | headers 1–6 strings ≤ 60; rows 1–50, each exactly `headers.length` strings ≤ 200 |

Every block has `id` (`^[a-z0-9]{8,16}$`, unique in the body) and `type`; unknown keys → 422.

### 4.6 Page templates (`GET /page-templates`, server-defined content in `resources/page-templates/*.json`)

| code | name | category | default slug | default status on create via template |
|---|---|---|---|---|
| `blank` | Blank page | `blank` | from title | draft |
| `about` | Our story / About us | `about` | `about` | draft |
| `contact` | Contact | `about` | `contact` | draft |
| `faq` | FAQ (cash on delivery & bKash, delivery inside/outside Dhaka, returns, checking the parcel) | `help_policies` | `faq` | draft |
| `size_guide` | Size guide | `help_policies` | `size-guide` | draft |
| `how_to_order` | How to order | `selling` | `how-to-order` | draft |
| `wholesale` | Wholesale enquiry | `selling` | `wholesale` | draft |
| `privacy` | Privacy policy | `help_policies` | `privacy` | draft |
| `terms` | Terms of service | `help_policies` | `terms` | draft |
| `returns` | Delivery & return policy | `help_policies` | `delivery-return` | draft |

"Fill in with my shop's details" (New page dialog) is always on in Phase 3: placeholders `{store_name}`,
`{store_phone}`, `{store_email}`, `{support_hours}` are replaced server-side as plain text at creation (missing
values → the sentence containing them is omitted). Delivery charges/payment methods placeholders wait for Phase 5.

---

## 5. Storefront rendering, caching, preview (owner SF)

### 5.1 Routes
- `/` home: sections of the resolved theme config in order; skip `enabled:false`; unknown types skipped (logged).
  Each section is wrapped in `<section data-sp-section-id={id} class="…visibility classes…">` with design CSS
  variables (`--sp-section-bg`, padding) from validated values only.
- `/pages/[slug]` **new**: fetch `/storefront/pages/{slug}`; 404 → themed NotFound (Figma 404 `1:13565`/`1:13588`).
  Layout per Policy page (mobile `149:1294`) and V1 Edit page preview (`74:22532`): breadcrumb (Home › title), H1,
  "Updated {date}", blocks; contact card aside on desktop when the store has phone/WhatsApp. Coming-soon stores still
  render Coming soon on this route (layout rule unchanged).
- Header nav = `navigation.main` (children as dropdown / drawer); footer columns = `navigation.footer` and
  `navigation.help` (column titles = menu titles), plus contact, social and payment badges from settings.
- Renderers for `RichTextDoc` and `PageBlock` live in `apps/storefront/components/rich-text.tsx` /
  `page-blocks.tsx`: pure React, unknown node → skipped, hrefs re-checked with `sanitizeHref` (+ `mailto:`/`tel:`
  helpers from `lib/contact.ts`), external links get `rel="noopener noreferrer"`. ESLint `react/no-danger: error`
  for the whole app.
- Media: theme/page images resolve through the response's `media` map (`StorefrontMedia`), rendered with `next/image`
  and the configured media origins; unresolved id → bundled demo image (theme sections) or block omitted (pages).
- Product sections keep `getFeaturedProducts()` placeholders (labelled internally `PLACEHOLDER`).

### 5.2 Caching and revalidation
| Fetch | Public | Preview cookie present |
|---|---|---|
| `/storefront/config` | `next: { tags: ['store:{host}'], revalidate: STOREFRONT_CONFIG_REVALIDATE }` (unchanged) | `cache: 'no-store'` |
| `/storefront/pages/{slug}` | same tag `store:{host}`, `revalidate: 300` | `no-store` |
| `/storefront/pages` (sitemap) | same tag, `revalidate: 300` | not used |

`/api/revalidate` contract unchanged. Laravel revalidates on: theme publish/apply, page create/update/delete when the
page is or was `published`, navigation save, store settings (incl. SEO) save. Acceptance: publish → public storefront
shows the change in < 5 s.

### 5.3 Preview and the editor bridge (P3-9, P3-10)
- Proxy: `?preview=<t>` (existing) + optional `embed=1`. With `embed=1`: cookies `sp_preview=<t>` and `sp_embed=1`,
  both `HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=3600`; redirect strips both params.
  Without `embed`: unchanged (`SameSite=Lax`, Secure except local dev hosts), and clears `sp_embed`.
- Framing headers (set in the proxy on every HTML response): `sp_preview` cookie present →
  `Content-Security-Policy: frame-ancestors 'self' <STOREFRONT_EDITOR_ORIGINS…>`; otherwise
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.
  New env `STOREFRONT_EDITOR_ORIGINS` = comma list of exact origins (`http://localhost:5173`, prod
  `https://app.storeplix.com`); no wildcards; empty → embedding impossible (fail closed).
- `PreviewBridge` client component, rendered only when `mode === 'preview'` and `sp_embed` is set (the server passes
  a boolean and the allowed origins, never the token):
  - Accepts `message` events only if `event.source === window.parent` **and** `event.origin` ∈ editor origins
    **and** the data parses with Zod as an `EditorToPreviewMessage`. Everything else is ignored silently.
  - On `refresh` → `router.refresh()`; on `select` → outline the matching `[data-sp-section-id]`; on `scroll-to` →
    `scrollIntoView({block:'center'})`.
  - Posts to `window.parent` with **targetOrigin = the exact origin of `document.referrer` if it is in the allowlist**,
    else does not post: `ready` (on mount and after each refresh, with `path`), `section-click` (click on a section
    while holding no modifier; `preventDefault` on links inside the preview so clicks select instead of navigate),
    `navigated` (path changes).
  - Messages never carry tokens, cookies or config.
- Message shapes (`@storeplix/types`, §7): `{ source:'storeplix-editor'|'storeplix-preview', v:1, type, … }`.

### 5.4 SEO
- `generateMetadata`: home title = `seo.title || store.name`; pages: `page.seo.title || page.title` with template
  `%s · {store.name}`; description = page `seo.description` → store `seo.description`; **canonical** =
  `originForHost(store.primary_host) + path` (not the request host); `openGraph` (`type: website`, `siteName`,
  `url` canonical, `images` = page share image → store share image (`seo.og_image_url`) → logo), `twitter`
  `summary_large_image`.
- Robots meta `noindex, nofollow` when: draft store (Coming soon), preview, or `seo.noindex`.
- JSON-LD in the layout (live mode only): `Organization` {name, url, logo, sameAs (non-null social), contactPoint
  {telephone, contactType:"customer service"} if phone} and `WebSite` {name, url}. Serialised with `JSON.stringify`
  then `<` → `<`, `>` → `>`, `&` → `&`, U+2028/2029 escaped, inside
  `<script type="application/ld+json">`. No SearchAction until `/search` exists.
- `robots.txt`: live and not noindex → existing allow list + `Disallow: /search` + `Sitemap:` (primary host);
  otherwise `Disallow: /`.
- `sitemap.xml`: live and not noindex → `/` + every published page (`<lastmod>` = `updated_at`), canonical origin
  = primary host; otherwise empty urlset (unchanged).

---

## 6. Dashboard screens (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`

Routes live under `/online-store`. A shared tab bar (V3 local component OS3/NavPill `2033:46029`): Overview, Themes,
Brand style, Pages, Landing pages (disabled, "Coming soon"), Navigation, Popups (disabled). Sidebar "Online store"
children (Media, Domains, SEO, Shop settings): SEO enabled; Media, Domains, Shop settings remain placeholders.
Staff (role `staff`) see every screen read-only (inputs disabled, no Publish/Save, editor opens in view mode with a
"Ask a manager to make changes" banner).

| Screen / route | V3 frame ids | Build | Skip / disable |
|---|---|---|---|
| Overview `/online-store` | `2028:44401` (Main `2028:44403`) | Hero card: shop name, live/draft badge, current theme name, "N theme changes waiting" (from `has_unpublished_changes`), Customise theme, Preview (new tab). "Your website, part by part" cards: Theme & brand style, Pages, Navigation, Domain & SEO (SEO part only) | Stats row (visits, orders, conversion), "steps left" card, Landing pages / Popups cards |
| Themes `/online-store/themes` | `2032:44891` (Main `2032:44893`) | Current theme card (colours, fonts, buttons summary; Customise, Preview); Theme library from `GET /themes` with All / Free / Premium filter; available theme: Preview + Apply/Customise; coming-soon themes: "Coming soon" badge, buttons disabled | Upload theme, Buy & apply, More actions |
| Editor `/online-store/editor?page=home` (full screen, outside AppShell) | Home desktop `2045:48301` (Toolbar `2045:48302`, Body `2045:48342`); Block actions dropdown `2057:51109`; Show on submenu `2057:51202`; Design tab `2050:49617` (Toolbar `2050:49618`, Body `2050:49660`); Full screen `2047:49102` (bar `2047:50107`); Phone `2045:48770`; Locked block dropdown `2057:51297`; Media picker `2053:50828` / `2053:51939`; dragging `2054:51605` | **Toolbar:** back, theme · page label, "N changes" pill, "Saved hh:mm"/"Saving…", Desktop/Tablet/Phone toggle (iframe 1440 scaled to fit / 834 / 390), zoom %, Full screen (F), Undo (client history, 50 steps), Preview (new tab), Publish. **Left panel tabs:** *Sections* (Header · every page: Announcement bar, Header & menu — locked rows open global settings; Home page: section rows with drag handle, eye toggle (`enabled`), "Phone off" pill when `visibility.phone=false`, ••• menu: Duplicate, Move up/down, Show on…, Delete; "+ Add section" picker from manifest respecting maxInstances/30; Footer · every page: locked) and *Theme style* (global settings, same form as Brand style). **Right panel:** breadcrumb "Home page › Section", Content / Design tabs, fields generated from `manifest.json` (widgets: text, textarea with counter, rich text (Tiptap), link (page picker + URL), image (media picker: upload or choose from `GET /media`), select, segmented, toggle, slider, colour, date-time, blocks list with add/reorder/remove), "Reset to theme" (section defaults from defaults.json). Click a section in the preview → selects it | "Ask AI", "Change it with words", "Save as my section", "Copy to another page", "Rewrite with AI", history (clock) button, Rename, floating in-preview toolbar (the list's ••• menu covers the same actions), Text/Buttons/Image/Animation design accordions, "Different design on phones" |
| Brand style `/online-store/brand-style` | `2035:46054` (Main `2035:46056`); logo quick picker `2053:52103` / `2053:52607` | Logo & icons (logo, favicon, share image — saved immediately via settings PATCH, P3-7), Start from a style (8 presets), Colours (4 + contrast badges + "Fix for me" = pick readable ink), Fonts (pairings), Corners & buttons; right-side static preview card; bottom draft bar "N changes in draft · Discard · Save draft · Publish" (Save draft = PUT draft; Publish = publish) | "Live / New" toggle on the preview card (show "New" only) |
| Pages `/online-store/pages` | `2036:46279` (Main `2036:46281`) | Search, filter chips All/Yours/Hidden counts, "Missing a page buyers look for?" template chips (FAQ, Size guide, How to order, Wholesale → create from template), "Your pages" table (title, `/pages/slug`, "In footer/In main menu" badge from `in_menus`, edited time · user, status badge, preview eye, Edit, ••• (Publish/Unpublish/Hide, Delete)). "Built-in shop pages": show Home only (Edit → editor); others hidden until Phase 5 | Built-in tab count beyond Home |
| New page dialog | page `2046:48852`, dialog `2046:49298` | Template grid with category filter (All / Help & policies / About the shop / Selling), name, link (auto from name, editable), "Comes with answers about" list, "Also add to Footer menu" checkbox (→ `add_to_menu: "footer"`), Create page → opens the page editor | "Fill in with my shop's details" toggle (always on, shown checked and disabled) |
| Page editor `/online-store/pages/:pageId` | Editor shell `2045:48301` reused; block list and form per V1 Edit page `74:22532` (V3 has no page-body frame) | Left: page title, link, Blocks list (heading, text, image, button, callout, table) with add/reorder/remove; right: Visibility (Published / Draft / Hidden), "Show in menu" checkboxes (main / footer / help — edits the menus), SEO (title, description, share image); preview iframe at `/pages/{slug}` (drafts visible via preview). Save = PATCH (debounced 800 ms autosave, same refresh flow) | Revision history, page SEO score, Scheduled, বাংলা/English tabs, template switch |
| Navigation `/online-store/navigation` | `2037:46510` (Main `2037:46512`) | Menus list (Main menu, Footer, Help) with link counts; tree editor (drag to reorder, drop on a link to nest, max depth 2), edit/delete/un-nest actions, "+ Add a link" with link-type picker (Home, Page, Collection, Built-in, Web address), suggested chips from published pages; broken-link warning for `page_unpublished`/`page_missing`; live preview card; bottom bar "N unsaved changes · Discard · Save menu" (PUT) | "Mobile bar" menu, "+ New menu", Landing page link type |
| SEO `/online-store/seo` | Settings `2044:48073` (Main `2044:48075`); "On Google" preview card from `2043:47848` | Store-level: home title + description with Google snippet preview and length hints (60/160), default share image, "Hide the whole shop from Google" toggle, sitemap row (URL, read-only, "N pages"). Bottom bar Discard / Save (settings PATCH) | SEO score overview `2043:47848`, product/collection title templates, price/stock/ratings toggles, robots editor, redirects, Search Console / Bing |
| Onboarding 04 `/onboarding/theme` | desktop `48:8119`, mobile M4 `54:810` | "Pick a look for your shop": theme cards from `GET /themes` (available themes selectable; coming-soon cards disabled with badge, max 4 shown as in Figma), "Make it yours" colour swatches + custom hex, "Upload your logo" (media purpose `logo`), static PhonePreview tinted with the chosen colour, Back / Save & exit / "Use {name} theme". Submit = `POST .../themes/{code}/apply` → `PATCH settings {branding:{primary_color, logo_media_id?}}` → `/`. NameShopPage now navigates to `/onboarding/theme` after creating the shop; StepRail marks step 4 current there | — |

Dashboard checklist (`SetupChecklist`): "Pick a theme" becomes active: `done` when the active theme's `applied_at`
is set or `published_revision > 1`; `to: '/online-store/themes'`. StepRail: "Pick a theme" `current` on step 04.

**Editor state rules**
- Local draft = `StoreTheme.draft_config`; every edit goes through a pure reducer (`editorReducer`) that enforces
  limits (30 sections, maxInstances, maxBlocks) and generates ids (`crypto.getRandomValues`, 10 chars `[a-z0-9]`).
- Autosave: debounce 600 ms; at most one request in flight; queued latest state saved after it; each response sets
  `base_revision`. 409 → stop autosave, show conflict dialog (Reload). 422 → show field errors from `details`
  (map `config.sections.N…` to the section/field) and keep the local state.
- "N changes" = number of sections added/removed/changed/moved + number of changed global-settings groups, comparing
  the local draft with `published_config`.
- Unsaved-changes guard: while a debounce is pending or a save is in flight, `beforeunload` prompt and React Router
  blocker ("Your latest change is still saving"). Unpublished-but-saved changes are not "unsaved" (they persist as
  draft) — leaving shows no prompt.
- Publish: flush pending save → `POST publish {draft_revision}` → toast "Published. Your shop updates in a few
  seconds." Discard: confirm dialog → `POST discard` → refresh iframe.
- postMessage (dashboard side): send with `targetOrigin = new URL(previewUrl).origin`; accept only
  `event.source === iframe.contentWindow && event.origin === previewOrigin` and Zod-valid
  `PreviewToEditorMessage`.

---

## 7. § Types (orchestrator applies) — `packages/types/src/index.ts`

```ts
// ---------- Theme engine (Phase 3) ----------
export interface ThemeBlock { id: string; type: string; settings: Record<string, unknown> }
// ThemeSection: REPLACE with
export interface ThemeSection {
  id: string; type: string; enabled: boolean;
  settings?: Record<string, unknown>;
  blocks?: ThemeBlock[];
}
// ThemeConfig: REPLACE settings type with
export interface ThemeGlobalSettings {
  primaryColor: string; secondaryColor: string; textColor: string; backgroundColor: string;
  fontFamily: string; headingFontFamily: string;
  cornerStyle: 'square' | 'rounded' | 'pill'; buttonStyle: 'solid' | 'outline'; stylePreset: string | null;
  logoOnDarkMediaId: string | null;
  announcement: { enabled: boolean; text: string; href: string | null };
  header: { sticky: boolean; showSearch: boolean; promoLink: { label: string; href: string } | null };
  footer: { tagline: string | null; showPaymentMethods: boolean; paymentMethods: PaymentMethodBadge[] };
  [k: string]: unknown;                     // theme-specific extras (validated by the theme's JSON Schema)
}
export type PaymentMethodBadge = 'cod' | 'bkash' | 'nagad' | 'rocket' | 'upay' | 'visa' | 'mastercard' | 'amex';
export interface ThemeConfig { theme: string; version: string; settings: ThemeGlobalSettings; sections: ThemeSection[] }

export type ThemeAvailability = 'available' | 'coming_soon';
export interface ThemeCatalogEntry {
  code: string; name: string; description: string; version: string;
  status: ThemeAvailability; tier: 'free' | 'premium';
  price_amount: number | null;              // BDT minor units, premium only (display; not purchasable in Phase 3)
  currency: string | null; tags: string[]; is_new: boolean;
}
export interface UserRef { id: string; name: string }
export interface StoreThemeSummary {
  id: string; code: string; name: string; version: string; is_active: boolean;
  draft_revision: number; published_revision: number | null; has_unpublished_changes: boolean;
  draft_updated_at: string; draft_updated_by: UserRef | null;
  published_at: string | null; published_by: UserRef | null; applied_at: string | null;
}
export interface StoreTheme extends StoreThemeSummary {
  draft_config: ThemeConfig;
  published_config: ThemeConfig | null;
  /** Media referenced by draft or published config, for editor thumbnails. */
  media: Record<string, MediaRef>;
}
export interface SaveThemeDraftInput { config: ThemeConfig; base_revision: number }
export interface PublishThemeInput { draft_revision: number }

// ---------- Rich text (strict subset of ProseMirror/Tiptap JSON) ----------
export type RichTextMark =
  | { type: 'bold' | 'italic' | 'underline' | 'strike' }
  | { type: 'link'; attrs: { href: string } };
export interface RichTextText { type: 'text'; text: string; marks?: RichTextMark[] }
export interface RichTextHardBreak { type: 'hardBreak' }
export type RichTextInline = RichTextText | RichTextHardBreak;
export interface RichTextParagraph { type: 'paragraph'; content?: RichTextInline[] }
export interface RichTextHeading { type: 'heading'; attrs: { level: 2 | 3 }; content?: RichTextInline[] }
export interface RichTextListItem { type: 'listItem'; content: RichTextParagraph[] }
export interface RichTextList { type: 'bulletList' | 'orderedList'; content: RichTextListItem[] }
export interface RichTextBlockquote { type: 'blockquote'; content: RichTextParagraph[] }
export type RichTextBlock = RichTextParagraph | RichTextHeading | RichTextList | RichTextBlockquote;
export interface RichTextDoc { type: 'doc'; content: RichTextBlock[] }

// ---------- Pages ----------
export type PageStatus = 'draft' | 'published' | 'hidden';
export type PageTemplateCode =
  | 'blank' | 'about' | 'contact' | 'faq' | 'size_guide' | 'how_to_order' | 'wholesale' | 'privacy' | 'terms' | 'returns';
export type PageBlock =
  | { id: string; type: 'heading'; text: string; level: 2 | 3 }
  | { id: string; type: 'rich_text'; doc: RichTextDoc }
  | { id: string; type: 'image'; media_id: string | null; alt: string | null; caption: string | null }
  | { id: string; type: 'button'; label: string; href: string; style: 'primary' | 'secondary' }
  | { id: string; type: 'callout'; title: string | null; items: string[]; tone: 'info' | 'success' | 'warning' }
  | { id: string; type: 'table'; headers: string[]; rows: string[][] };
export interface PageTemplate {
  code: PageTemplateCode; name: string; description: string;
  category: 'blank' | 'help_policies' | 'about' | 'selling';
  default_title: string; default_slug: string | null; highlights: string[];
}
export interface StorePageSummary {
  id: string; title: string; slug: string; url_path: string;   // "/pages/{slug}"
  status: PageStatus; template: PageTemplateCode;
  in_menus: NavigationHandle[]; revision: number;
  published_at: string | null; updated_at: string; updated_by: UserRef | null;
}
export interface StorePage extends StorePageSummary {
  body: PageBlock[];
  seo: { title: string | null; description: string | null; share_image: MediaRef | null };
  media: Record<string, MediaRef>;          // images referenced by body
}
export interface PageListMeta { counts: Record<'all' | PageStatus, number>; limit: number }
export interface CreatePageInput {
  title?: string; slug?: string; template?: PageTemplateCode; status?: PageStatus; body?: PageBlock[];
  seo?: { title?: string | null; description?: string | null; share_image_media_id?: string | null };
  add_to_menu?: NavigationHandle | null;
}  // title required unless template given
export interface UpdatePageInput {
  revision: number; title?: string; slug?: string; status?: PageStatus; body?: PageBlock[];
  seo?: { title?: string | null; description?: string | null; share_image_media_id?: string | null };
}

// ---------- Navigation ----------
export type NavigationHandle = 'main' | 'footer' | 'help';
export type NavLink =
  | { type: 'home' }
  | { type: 'page'; page_id: string }
  | { type: 'url'; url: string }
  | { type: 'collection'; handle: string }
  | { type: 'builtin'; target: 'track_order' | 'cart' | 'search' };
export interface NavItem { id: string; label: string; link: NavLink; children?: NavItem[] }
export type NavLinkStatus = 'ok' | 'page_unpublished' | 'page_missing';
export interface NavItemResolved extends Omit<NavItem, 'children'> {
  href: string | null; link_status: NavLinkStatus; page_title?: string | null; children?: NavItemResolved[];
}
export interface NavigationMenu {
  id: string; handle: NavigationHandle; title: string; items: NavItemResolved[];
  revision: number; updated_at: string;
}
export interface SaveNavigationInput { title?: string; items: NavItem[]; revision: number }

// ---------- Store SEO (StoreSettings / UpdateStoreSettingsInput additions) ----------
export interface StoreSeo { title: string | null; description: string | null; share_image: MediaRef | null; hide_from_search: boolean }
// StoreSettings: ADD  seo: StoreSeo;
// UpdateStoreSettingsInput: ADD
//   seo?: Partial<{ title: string | null; description: string | null; share_image_media_id: string | null; hide_from_search: boolean }>;

// ---------- Media list ----------
export interface MediaListFilters { purpose?: MediaPurpose[]; page?: number; per_page?: number }

// ---------- Storefront payload additions ----------
export interface StorefrontMedia {
  id: string; url: string; width: number; height: number; alt: string | null;
  srcset: { url: string; width: number }[];
}
export interface StorefrontNavItem { id: string; label: string; href: string; children: StorefrontNavItem[] }
export interface StorefrontNavMenu { title: string; items: StorefrontNavItem[] }
// StorefrontConfig: CHANGE
//   store: ADD primary_host: string;                       // canonical host
//   seo: REPLACE with { title: string; description: string | null; og_image_url: string | null; noindex: boolean };
//   ADD navigation?: { main: StorefrontNavMenu; footer: StorefrontNavMenu; help: StorefrontNavMenu };
//   ADD media?: Record<string, StorefrontMedia>;           // ids referenced by `theme`
//   (optional on the wire for rolling deploys; the storefront defaults them to empty)
export interface StorefrontPage {
  id: string; slug: string; title: string; status: PageStatus; body: PageBlock[];
  media: Record<string, StorefrontMedia>;
  seo: { title: string | null; description: string | null; og_image_url: string | null };
  updated_at: string;
}
export interface StorefrontPageIndexEntry { slug: string; updated_at: string }

// ---------- Editor ↔ preview postMessage protocol ----------
export type EditorToPreviewMessage =
  | { source: 'storeplix-editor'; v: 1; type: 'refresh' }
  | { source: 'storeplix-editor'; v: 1; type: 'select'; section_id: string | null }
  | { source: 'storeplix-editor'; v: 1; type: 'scroll-to'; section_id: string };
export type PreviewToEditorMessage =
  | { source: 'storeplix-preview'; v: 1; type: 'ready'; path: string }
  | { source: 'storeplix-preview'; v: 1; type: 'section-click'; section_id: string }
  | { source: 'storeplix-preview'; v: 1; type: 'navigated'; path: string };
```
Compatibility: `ThemeSection.id` becomes required — API (migration adds ids) and SF (Zod accepts missing ids by
generating `type-index`) ship before WEB's editor. `StorefrontConfig.seo` gains fields (additive);
`navigation`/`media` optional. `AuditLogFilters.subject_type` allowlist gains `store_theme`, `store_page`,
`store_navigation` (API).

---

## 8. Security checklist (each item has a test in §9)

| Threat | Control |
|---|---|
| **XSS via rich text** | Stored as `RichTextDoc` JSON (no HTML); schema rejects unknown nodes/marks/attrs; React renders text nodes (escaped); `react/no-danger` lint error in storefront; dashboard Tiptap limited to the same nodes |
| **XSS / `javascript:` links** | Server `SafeHref`: `theme()` = relative `/…` (not `//`, no `\`, no control chars, no whitespace) or `https://` with host and no credentials; nav `url` = http/https only; rich-text links additionally `mailto:`/`tel:` (strict). Decoding check: reject if `rawurldecode` of the value contains a scheme other than allowed or control chars. Storefront re-checks every href with `sanitizeHref` before render (defence in depth) |
| **CSS injection via colours/fonts** | Colours `^#[0-9a-f]{6}$` only; fonts and all enums are closed lists; values reach CSS only as React `style` custom properties from the allowlisted maps (`themes/fonts.ts`, `css-vars.ts`), never string-concatenated CSS; no merchant CSS field exists |
| **Plain-text fields** | Control characters rejected; rendered as React text only |
| **JSON-LD script breakout** | Escape `<`, `>`, `&`, U+2028/2029 after `JSON.stringify` |
| **Cross-tenant access (themes, pages, nav, media refs)** | `BelongsToTenant` scope + policies; `{store}`/`{page}` from another tenant → 404; FK(t) on every store/media FK; `*MediaId`/`media_id`/`page_id` values checked against the current tenant; storefront endpoints resolve the tenant only from `X-Storefront-Host`, a slug of another store's page → 404 |
| **Preview token scope** | HMAC, store-bound, 60 min (unchanged); grants read of draft theme and non-public pages of that store only; ignored on merchant routes; token for store B sent with host A → public view; preview responses `private, no-store`, never tagged; token never sent to client JS or in postMessage; proxy strips it from the URL |
| **Clickjacking / framing** | `frame-ancestors 'none'` + `X-Frame-Options: DENY` on live pages; `frame-ancestors` = exact editor origins only with a preview cookie |
| **postMessage** | Both sides: exact-origin allowlist + `event.source` check + Zod validation; explicit `targetOrigin` (never `*`); no secrets in messages; storefront bridge only mounts in embedded preview |
| **Cookies** | `sp_preview` HttpOnly always; embedded variant Secure + SameSite=None + Partitioned; non-embedded stays Lax |
| **Payload abuse / DoS** | Config ≤ 64 KB, page body ≤ 128 KB, counts per P3-16; throttles §3.1; opis max errors 50 |
| **Concurrency / lost updates** | Revision checks → 409 |
| **SSRF** | **None expected**: no endpoint fetches a merchant-supplied URL. URLs are stored and emitted only as links; images are only tenant media ids (no remote URL ingestion). Any future "import image from URL" needs a separate review |
| **Role enforcement** | All writes `Permission::ManageSettings` (O A); staff GET only; UI mirrors with `can.editSettings` |
| **Audit** | publish/discard/apply/page/nav actions logged with redacted meta |

---

## 9. Test requirements

### API (PHPUnit; `#[Group('tenancy')]` and `#[Group('security')]` as noted)
- **Themes:** GET catalog; get/put draft/publish/discard/apply happy paths; revision conflict 409; publish copies
  draft and dispatches `RevalidateStorefront` (Bus fake), draft save does **not**; discard restores published; apply
  carries colours and sets `applied_at`; apply of coming_soon/premium → 409; staff 403 on writes, 200 on GETs.
- **Schema parity:** every `resources/themes/fixtures/modern-commerce/valid/*.json` validates; every `invalid/*`
  fails with its `expect` path in `details`; `ThemeSchemaSyncTest`; `ThemeConfigUpgrader` tests (Phase 2 default
  config, demo config, garbage input).
- **Pages:** CRUD, templates fill placeholders, reserved/duplicate slug 422, limit 50 → 409, `add_to_menu`, delete
  leaves `page_missing` nav item, revalidation only when public output changes.
- **Navigation:** defaults created lazily, depth 3 → 422, counts, link resolution statuses, revision conflict.
- **Storefront:** config serves published vs draft (with valid token), nav filtering public vs preview, `media` map
  contains only referenced ids; pages index published only; page by slug public 404 for draft/hidden, 200 with token.
- **Migration:** backfill from `store_settings.theme`, `stores:ensure-content` idempotent (run twice → same rows).
- **tenancy group:** `assertTenantIsolation` for `StoreTheme`, `StorePage`, `StoreNavigation`; tenant A cannot read or
  write B's theme/page/menu (404); media id of tenant B in A's config / page / SEO → 422; `page_id` of B in A's menu → 422;
  host A + slug of B's page → 404; preview token of B with host A → public published data only.
- **security group:** rich text with `<script>` as text stays text (and is returned verbatim, not executed —
  renderer test on SF); unknown node `{"type":"html"}` → 422; link marks with `javascript:alert(1)`,
  ` JaVaScRiPt:…`, `java\tscript:`, `%6a%61vascript:`, `data:text/html,…`, `//evil.com`, `/\evil.com`,
  `https://user:pw@x.com` → 422; nav url `http://x.com` OK, `ftp://`, `javascript:` → 422; colour `red`, `#fff;}`,
  `#FFFFFF` (normalised OK), `url(x)` → 422/normalised; font `Comic Sans` → 422; unknown settings key → 422; config
  > 64 KB → 413; 31 sections → 422; staff role cannot publish; `X-Storefront-Preview` header on merchant routes has no effect.

### Storefront (Vitest)
- Fixture parity: every valid fixture resolves with `usedFallback === false`; every invalid fixture is rejected by AJV
  against `schema.v1.json` (in `packages/themes` tests) and the Zod resolver never throws on it.
- Rich text and page-block renderers: script text escaped, disallowed href dropped, unknown nodes skipped, external
  links `rel`, no `dangerouslySetInnerHTML` (lint + grep test).
- JSON-LD escaping; canonical uses `primary_host`; noindex meta/robots/sitemap for draft, preview and `seo.noindex`;
  sitemap lists published pages.
- Proxy: embed cookie attributes (`SameSite=None; Secure; Partitioned; HttpOnly`), non-embed unchanged,
  `frame-ancestors` headers with and without cookie, empty `STOREFRONT_EDITOR_ORIGINS` → no framing.
- PreviewBridge: ignores wrong origin, wrong source, malformed data; posts only to an allowlisted referrer origin.
- Nav rendering with children; media map fallback to demo image; section visibility classes; design vars sanitised.

### Dashboard (Vitest + Testing Library)
- `editorReducer`: add (respects maxInstances and 30), remove, duplicate (new ids), reorder, toggle, visibility,
  block add/remove at maxBlocks, change counter vs published.
- Autosave: debounce, single in-flight, 409 → conflict dialog, 422 → field errors mapped from dot paths.
- postMessage handler ignores wrong origin/source; sends with explicit targetOrigin.
- Unsaved guard fires only while pending/in-flight.
- Schema form renders every widget type from manifest; staff sees read-only.
- Navigation tree: nesting limited to depth 2, counts; page slug auto-generation; onboarding apply flow (mocked API).

---

## 10. File ownership for Phase 3

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: migrations (§2), `StoreTheme`/`StorePage`/`StoreNavigation` models + policies, `Domain/Themes` (registry loader, `ThemeConfigValidator`, `ThemeConfigUpgrader`, `SafeHref`, controllers, presenters), `Domain/Pages` (controllers, `PageBodyValidator`, templates in `resources/page-templates/`), `Domain/Navigation`, `StoreContentProvisioner` + `stores:ensure-content`, storefront pages endpoints and `StorefrontConfigResource` extensions, settings `seo` section, `GET /media`, media in-use check, revalidation observer registration, audit subject types, `resources/themes/**` (synced copy), `composer.json` (`opis/json-schema`), `DemoSeeder`, `.env.example` |
| **WEB** | `apps/merchant-dashboard/**` (Online store routes §6, editor, onboarding 04, checklist/StepRail), `packages/api-client/**` (new methods: themes, pages, page templates, navigation, media list, settings seo), `packages/ui/**` (SegmentedControl, ColorSwatch, DraftBar, SortableList/Tree, Drawer, Dialog additions), `packages/config/**`. Adds `@tiptap/*` and `ajv` (editor route only, code-split) to its own package.json |
| **SF** | `apps/storefront/**` (§5: theme 1.1 sections, chrome, `/pages/[slug]`, renderers, SEO, proxy embed/framing, PreviewBridge, env `STOREFRONT_EDITOR_ORIGINS`), **`packages/themes/**`** (schema, defaults, manifest, registry, fonts, fixtures, AJV parity test). Ships `packages/themes` first; API copies it |
| **QA** | `docker-compose.yml` / `.env` wiring for `STOREFRONT_EDITOR_ORIGINS`, CI job running `packages/themes` tests + PHP `ThemeSchemaSyncTest`, `tests/e2e/**` (edit hero → preview updates; publish → public shows it; page create/publish → `/pages/slug`; nav item → header link; noindex toggle → robots), `docs/reviews/phase-3-qa.md` |
| **Orchestrator** | `packages/types/src/index.ts` (§7); `pnpm-workspace.yaml` already covers `packages/*` (no change) |
| **ARCH** | This file, `docs/api/openapi.yaml` (1.3.0), STOREFRONT-ENGINE.md, ADR 0004, OPEN-QUESTIONS.md, FIGMA-INDEX.md |

Order of work: Orchestrator types → SF `packages/themes` (schema + defaults + fixtures) → API and WEB in parallel
(WEB against the openapi spec and mocks) → SF rendering → QA e2e.

---

## 11. Acceptance criteria

1. Migration moves every store's theme into `store_themes` (active, draft = published) and drops
   `store_settings.theme`; `stores:ensure-content` gives the demo store default pages and three menus; running it twice
   changes nothing.
2. A new store gets an active `modern-commerce` 1.1.0 theme, About + Contact (published), three draft policy pages
   and three menus.
3. Editing any section in the V3 editor updates the iframe preview within 2 s without a full reload; the public
   storefront is unchanged until Publish; after Publish it shows the change in < 5 s. Discard restores the
   published look in the editor and preview.
4. Reorder, toggle, add (respecting limits), duplicate, delete and Show on (desktop/tablet/phone) all persist and
   render; device toggle shows 1440/834/390 widths; leaving during a pending save prompts.
5. Two tabs editing the same draft: the second save gets 409 and the UI asks to reload (no silent overwrite).
6. Invalid config (any `invalid` fixture) → 422 with a usable path; the storefront never 500s on stored config.
7. All 10 section types render per Figma desktop `1:10112`, tablet `1:10482` and mobile `1:10335`; product
   sections show placeholder products; Lighthouse mobile ≥ 90 on the demo home page.
8. Brand style changes (preset, colours, pairing, corners) go to the draft and publish with the theme; logo/favicon/
   share image save immediately.
9. Pages: create from each template, edit blocks, publish → `/pages/{slug}` renders with breadcrumb and SEO
   metadata; draft/hidden pages 404 publicly and render in preview; reserved and duplicate slugs rejected.
10. Navigation: main menu items (with one nested level) appear in the header and drawer; footer/help menus in the
    footer; links to draft or deleted pages are hidden publicly and flagged in the dashboard.
11. SEO: canonical points at the primary host; OG/Twitter tags and Organization/WebSite JSON-LD validate (Rich
    Results test fixtures); sitemap lists home + published pages; "Hide the whole shop from Google" → noindex meta and
    `Disallow: /`; draft stores stay noindex with empty sitemap.
12. Onboarding 04 applies the theme, colour and logo and lands on the dashboard; the checklist marks "Pick a theme" done.
13. Staff can view Online store screens read-only and get 403 on every write.
14. Every item in §8 has a passing test; `pnpm -r test`, `php artisan test --group=tenancy,security` and the theme
    parity jobs are green.

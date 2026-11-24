# Storefront Engine

Status: Accepted (Phase 0), refined in Phase 3 (docs/development/PHASE-3-CONTRACT.md is binding where they differ).
ADRs 0002 (central storefront), 0004 (theme config & rendering).
Owner app: `apps/storefront` (Next.js App Router). Data source: `/api/v1/storefront/*` only.

## 1. Principles
- One Next.js deployment renders every store; tenant = normalized `Host`.
- Themes are **code in this repo**, registered in a typed registry. Merchants supply **only JSON config**
  validated against the theme's schema. No merchant HTML/JS/CSS is executed or injected
  (colors/fonts go through CSS variables from validated values only).
- Server Components fetch render data; client components only for interactivity (cart drawer, variant picker, gallery).
- Storefront never sees internal data (cost prices, other customers, merchant users).

## 2. Request pipeline
```
middleware.ts
  host = normalizeHost(req.headers.get('host'))        // lib/host.ts, same rules as API HostNormalizer
  if host is platform app host (app./admin./api.) → 404
  rewrite → /_store/{host}{pathname}                    // host is a route segment ⇒ part of the cache key
app/_store/[host]/layout.tsx
  config = await getStorefrontConfig(host)              // fetch with X-Storefront-Host, X-Storefront-Key
  if 404 → notFound() (platform "store not available" page, noindex)   // unknown host or suspended store
  if config.store.status === 'draft' && !config.preview → render <ComingSoon> (§4.1)
  if config.preview → render the store + "Preview — not public yet" banner
  theme = themeRegistry.get(config.theme.theme)
  parsed = theme.schema.safeParse(config.theme)         // Zod; on failure fall back to theme.defaults + log
  <ThemeProvider tokens=parsed.settings><theme.Layout>{children}</theme.Layout></ThemeProvider>
```
`X-Storefront-Key` is read from server-only env (`import 'server-only'`); never sent to the browser.
Shopper-side mutations (cart, checkout) go through Next.js Route Handlers / Server Actions that proxy to the
API with the same headers plus the shopper's cart token (httpOnly cookie `sp_cart`, per host).

## 3. Theme registry contract
> **Phase 3 note:** the shipped registry is `apps/storefront/themes/registry.ts` with one theme, `modern-commerce`
> (display name "Gallery", v1.1.0; see `themes/types.ts` for the real `ThemeDefinition`). Theme metadata, JSON Schema,
> defaults and editor manifest live in `packages/themes` (PHASE-3-CONTRACT §4). The interface below is the target
> shape; `classic`/`minimal` are illustrative names only.
```ts
// apps/storefront/src/themes/types.ts
export interface ThemeDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  code: string;                    // 'classic' — matches themes.code in DB
  name: string;
  version: string;                 // semver; config.version must satisfy same major
  schema: S;                       // Zod schema for the full ThemeConfig of this theme
  defaults: z.infer<S>;            // valid default config (used on store creation + fallback)
  sections: Record<string, SectionDefinition>;   // section type → definition
  templates: {                     // page templates
    Layout: ComponentType<LayoutProps>;          // header + footer + children
    Home: ComponentType<HomeProps>;              // renders config.sections in order
    ProductList: ComponentType<PlpProps>;
    ProductDetail: ComponentType<PdpProps>;
    Cart: ComponentType<CartProps>;
    Checkout: ComponentType<CheckoutProps>;
    Page: ComponentType<CmsPageProps>;
    NotFound: ComponentType;
  };
  migrate?: (config: unknown, fromVersion: string) => unknown;   // minor/major config upgrades
}
export interface SectionDefinition<P extends z.ZodTypeAny = z.ZodTypeAny> {
  type: string;                    // 'hero' | 'featured_products' | 'category_grid' | 'banner' | 'rich_text' | 'testimonials' | 'newsletter'
  label: string;
  settingsSchema: P;               // Zod for section.settings
  maxInstances?: number;
  Component: ComponentType<{ settings: z.infer<P>; ctx: SectionContext }>;  // async Server Component allowed
}
// apps/storefront/src/themes/registry.ts
export const themeRegistry = new Map<string, ThemeDefinition>([['classic', classic], ['minimal', minimal]]);
```
Adding a theme = add a folder under `src/themes/<code>/`, register it, export its JSON Schema (below), add a
`themes` DB row via migration/seeder. Unknown section types in config are skipped and logged, never crash.

## 4. Config schema (matches `ThemeConfig` in `@storeplix/types`)
> **Phase 3:** the authoritative document shape, section catalog, limits and media/link rules are in
> PHASE-3-CONTRACT §4 (sections and blocks carry ids; images are `*MediaId`; the whole document is camelCase).
> The example below is the Phase 0 sketch.
```json
{
  "theme": "classic",
  "version": "1.0.0",
  "settings": {
    "primaryColor": "#5b53ff", "secondaryColor": "#fc856d", "fontFamily": "Inter",
    "borderRadius": "md", "buttonStyle": "solid",
    "header": { "layout": "logo_left", "sticky": true, "announcement": "Free delivery in Dhaka" },
    "footer": { "showSocial": true, "copyright": "© Acme" }
  },
  "sections": [
    { "type": "hero", "enabled": true, "settings": { "heading": "...", "image_media_id": "01J...", "cta_label": "Shop", "cta_href": "/collections/all" } },
    { "type": "featured_products", "enabled": true, "settings": { "title": "New arrivals", "source": "latest", "limit": 8 } }
  ]
}
```
Constraints (both sides): colors `^#[0-9a-fA-F]{6}$`; `fontFamily` ∈ allowlisted Google fonts per theme;
strings length-capped (heading ≤ 120, text ≤ 2000); links are relative paths (`^/[^/]`) or `https://` URLs —
no `javascript:`/`data:`; images referenced by `media_id` (tenant-owned, resolved server-side to CDN URLs);
≤ 30 sections; config payload ≤ 64 KB.

Keys inside the theme config document are camelCase **throughout** (global, section and block settings; Q9 decided
in Phase 3); the API passes the document through untransformed (exception to snake_case JSON).

### Dual validation
1. **Source of truth (Phase 3):** hand-written JSON Schema `packages/themes/<code>/schema.v<major>.json`; Laravel
   validates against its byte-identical copy in `apps/api/resources/themes/` (sync test); shared fixtures prove the
   storefront Zod schemas accept every valid config without fallback (parity test).
2. **On save (Laravel):** `PUT /api/v1/stores/{store}/themes/{code}/draft` validates with Form Request rules for the
   envelope (theme, version, settings, sections array) and `opis/json-schema` against the exported schema;
   also checks referenced `media_id`s belong to the tenant. Invalid → 422 `validation_failed` with JSON-pointer keys
   in `details` (e.g. `"sections.1.settings.limit"`).
3. **On render (Next.js):** `schema.safeParse`. Failure → render `defaults` merged with valid parts and report to Sentry.
   Storefront never 500s due to config.

### Draft vs published
`store_themes.draft_config` is edited by the merchant editor (debounced autosave with `base_revision`; 409 on conflict);
`POST /api/v1/stores/{store}/themes/{code}/publish` copies it to `published_config`, sets `published_at` and dispatches
`RevalidateStorefront`. `.../discard` resets the draft to published; `.../apply` activates a theme. Draft saves never
revalidate. Pages, navigation and store SEO have no draft copy (they save live). Storefront config endpoint returns
**published** config unless a valid preview token is sent (then `draft_config`, falling back to published/defaults).

### 4.1 Draft stores: Coming soon and preview (PO decision D2)
`StorefrontConfig.store.status` is `'active' | 'draft'`; suspended stores stay 404.

**Public visitor, draft store:** HTTP 200 branded **Coming soon** page (store name, logo, theme colours from the
validated config, no catalog data), `<meta name="robots" content="noindex">`, `robots.txt` = `Disallow: /`, empty
sitemap. Rendered dynamically with `Cache-Control: private, no-store`; it never goes into the shared ISR/edge cache
keyed by host, so publishing shows the live store at once. On draft → active the API revalidates `store:{id}` and `host:{host}`.

**Merchant preview:**
1. Dashboard calls `POST /api/v1/stores/{store}/preview-token` (Bearer + `X-Tenant-Id`, any role with store access)
   → 201 `{data:{token, url, expires_at}}`. Token = HMAC-SHA256-signed payload `{store_id, exp, jti}` with
   `PREVIEW_TOKEN_SECRET` (separate from `APP_KEY` and the storefront key), TTL **60 min**.
   `url` = `https://{primary_domain}/?preview={token}` (local: `http://{host}:3010/...`).
2. Storefront `middleware.ts` sees `?preview=`: sets cookie `sp_preview` (httpOnly, `Secure` in prod, `SameSite=Lax`,
   `Max-Age=3600`, host-only) and 302s to the same URL **without** the param, so the token doesn't stay in history,
   logs or `Referer`.
3. Server reads the cookie and forwards it as `X-Storefront-Preview` to `/storefront/config` (and later catalog
   endpoints). These fetches use `cache: 'no-store'` and the response is `private, no-store`. Preview never reads
   from or writes to the tagged shared cache.
4. API verifies the signature, expiry and `store_id == resolved store`. If valid → `preview: true` (+ draft theme); if
   invalid, expired or for another store → treated as a public visitor (`preview: false`), with no error detail.
5. Storefront renders the real store with a fixed "Preview — not public yet" banner, `noindex`.
6. **Embedded preview (Phase 3 editor):** `?preview=…&embed=1` sets `sp_preview`/`sp_embed` with
   `SameSite=None; Secure; Partitioned; HttpOnly`; `frame-ancestors` allows only `STOREFRONT_EDITOR_ORIGINS` when a
   preview cookie is present (otherwise `'none'` + `X-Frame-Options: DENY`). A `PreviewBridge` exchanges
   `refresh`/`select`/`section-click` postMessages with exact-origin and `event.source` checks
   (PHASE-3-CONTRACT §5.3). Preview also shows draft/hidden pages.

## 5. Caching, ISR and revalidation
| Data | Fetch cache | Tags | Revalidated by |
|---|---|---|---|
| Store config | `next: { revalidate: 300, tags: ['store:{store_id}', 'host:{host}'] }` | store, host | theme publish, settings/logo/navigation change, domain change |
| Product detail | `revalidate: 300, tags: ['store:{id}', 'product:{product_id}']` | product | product/variant/inventory-visible change |
| Product listings/categories | `revalidate: 120, tags: ['store:{id}:catalog']` | catalog | any product/category change |
| CMS pages | Phase 3: `revalidate: 300, tags: ['store:{host}']` (host tag, like config) | host | page save affecting public output, navigation save |
| Cart, checkout, account, Coming soon, any request with `sp_preview` | `cache: 'no-store'` | — | — |

Revalidation flow (as implemented; details PHASE-2-CONTRACT §1.8): `StorefrontRevalidationObserver` (Store status/name/slug,
StoreSettings incl. theme, StoreDomain) → queued `RevalidateStorefront` job (after commit, unique per store for 2 s, retries) →
`POST ${STOREFRONT_REVALIDATE_URL}` (internal, e.g. `http://storefront:3010/api/revalidate`) with
`Authorization: Bearer ${REVALIDATE_SECRET}` and `{ "hosts": [...] }` → route handler expires tag `store:{host}` for each
host. `REVALIDATE_SECRET` is distinct from `STOREFRONT_API_KEY`. Phase 1 uses a single host-level tag; per-product/catalog
tags in the table above arrive with the catalog endpoints (Phase 5). If Cloudflare caches
HTML (Phase 9), the same listener purges by Cloudflare cache tag `store-{id}` (`Cache-Tag` response header).
Stock levels on PDP are fetched client-side (`/storefront/products/{slug}/availability`, no-store) so stock changes
don't invalidate HTML.

## 6. SEO
- `generateMetadata` per route: title template `%s · {store.name}`, description, canonical = `StorefrontConfig.store.primary_host`
  (`store_domains.is_primary`) + path. Phase 6 (PHASE-6-CONTRACT P6-15): the API sets `store.redirect_host` (the primary) for
  every other host of the store when the primary or the request host is a custom domain and the storefront permanently redirects page requests
  to the same path + query on the primary (`permanentRedirect`, 308; `robots.txt`/`sitemap.xml` 301; never for previews,
  `/api/*` or Server Actions). Platform hosts never redirect to a platform primary.
- Open Graph + Twitter cards from product images / store `og_image`.
- JSON-LD: `Organization` + `WebSite` (layout), `Product` + `Offer` (price in major units, `priceCurrency`,
  availability), `BreadcrumbList`, `ItemList` on PLP.
- Store-level `seo.noindex` ("Hide the whole shop from Google") forces noindex, `Disallow: /` and an empty sitemap.
- JSON-LD strings are escaped (`<`, `>`, `&`, U+2028/9) after `JSON.stringify`.
- `app/sitemap.xml` and `app/robots.txt` route handlers per host (Phase 3: home + published pages): sitemap index of products, categories, pages
  (from `/storefront/sitemap`), chunked at 5 000 URLs. Draft stores: `noindex`, `Disallow: /`, empty sitemap; preview: `noindex`; suspended: 404.
- Merchant redirects (`redirects` table) resolved in middleware via cached `/storefront/redirects` map.
- Images via `next/image` with CDN loader; width-based srcset; LCP image `priority`.
- Performance budget: LCP < 2.5 s on 4G mid-tier Android (primary BD device), JS < 120 KB gz on home.

## 7. Directory layout
```
apps/storefront/src/
  middleware.ts
  app/_store/[host]/(routes)  layout.tsx, page.tsx, products/[slug], collections/[slug], pages/[slug], cart, checkout, account
  app/api/revalidate/route.ts
  lib/host.ts  lib/api.ts (server-only fetcher)  lib/money.ts (minor units → display)
  themes/types.ts  themes/registry.ts  themes/classic/  themes/minimal/
  sections/ (shared section components themes may reuse)
```
Visual design of themes follows Figma page `1:9207` (Storefront) and `2:6` (Storefront – Mobile).

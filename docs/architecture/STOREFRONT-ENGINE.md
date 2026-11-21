# Storefront Engine

Status: Accepted (Phase 0). ADRs 0002 (central storefront), 0004 (theme config & rendering).
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
  if 404 → notFound() (platform "store not available" page, noindex)
  theme = themeRegistry.get(config.theme.theme)
  parsed = theme.schema.safeParse(config.theme)         // Zod; on failure fall back to theme.defaults + log
  <ThemeProvider tokens=parsed.settings><theme.Layout>{children}</theme.Layout></ThemeProvider>
```
`X-Storefront-Key` is read from server-only env (`import 'server-only'`); never sent to the browser.
Shopper-side mutations (cart, checkout) go through Next.js Route Handlers / Server Actions that proxy to the
API with the same headers plus the shopper's cart token (httpOnly cookie `sp_cart`, per host).

## 3. Theme registry contract
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

Keys inside the theme config document are camelCase at the top `settings` level as fixed by the
`ThemeConfig` type; the API passes the document through untransformed (exception to snake_case JSON).
Section settings use snake_case. (See OPEN-QUESTIONS Q9 to unify.)

### Dual validation
1. **Source of truth:** Zod schema in the theme. Build step `pnpm --filter @storeplix/storefront theme:export`
   emits JSON Schema (`zod-to-json-schema`) to `apps/storefront/theme-schemas/<code>@<major>.json`.
   The Laravel agent copies/consumes it (CI checks the copy in `apps/api/resources/theme-schemas/` matches).
2. **On save (Laravel):** `PUT /api/v1/merchant/themes/{code}/config` validates with Form Request rules for the
   envelope (theme, version, settings, sections array) and `opis/json-schema` against the exported schema;
   also checks referenced `media_id`s belong to the tenant. Invalid → 422 `validation_failed` with JSON-pointer keys
   in `details` (e.g. `"sections.1.settings.limit"`).
3. **On render (Next.js):** `schema.safeParse`. Failure → render `defaults` merged with valid parts and report to Sentry.
   Storefront never 500s due to config.

### Draft vs published
`store_themes.draft_config` is edited by the merchant editor; `POST /merchant/themes/{code}/publish` copies it
to `published_config`, sets `published_at`, and emits `StoreThemePublished`. Storefront config endpoint returns
**published** only. Preview: editor iframe loads `https://{host}/?preview=<signed token>`; token (HMAC, 15 min,
bound to store_id) makes the API return `draft_config`; preview responses are `Cache-Control: private, no-store`
and use Next.js `draftMode()`.

## 5. Caching, ISR and revalidation
| Data | Fetch cache | Tags | Revalidated by |
|---|---|---|---|
| Store config | `next: { revalidate: 300, tags: ['store:{store_id}', 'host:{host}'] }` | store, host | theme publish, settings/logo/navigation change, domain change |
| Product detail | `revalidate: 300, tags: ['store:{id}', 'product:{product_id}']` | product | product/variant/inventory-visible change |
| Product listings/categories | `revalidate: 120, tags: ['store:{id}:catalog']` | catalog | any product/category change |
| CMS pages | `revalidate: 600, tags: ['store:{id}:page:{slug}']` | page | page publish |
| Cart, checkout, account | `cache: 'no-store'` | — | — |

Revalidation flow: Laravel listener (queued, tenant-aware) on domain events → `POST https://storefront.internal/api/revalidate`
with `{ tags: [...] }` and header `X-Revalidate-Secret` (`STOREFRONT_REVALIDATE_SECRET`, distinct from the API key) →
route handler calls `revalidateTag` for each. Debounced per store (1 s) to batch bulk edits. If Cloudflare caches
HTML (Phase 9), the same listener purges by Cloudflare cache tag `store-{id}` (`Cache-Tag` response header).
Stock levels on PDP are fetched client-side (`/storefront/products/{slug}/availability`, no-store) so stock changes
don't invalidate HTML.

## 6. SEO
- `generateMetadata` per route: title template `%s | {store.name}`, description, canonical = primary domain
  (`store_domains.is_primary`) + path; non-primary hosts 301 to primary (platform subdomain redirects once custom domain is `active`).
- Open Graph + Twitter cards from product images / store `og_image`.
- JSON-LD: `Organization` + `WebSite` (layout), `Product` + `Offer` (price in major units, `priceCurrency`,
  availability), `BreadcrumbList`, `ItemList` on PLP.
- `app/_store/[host]/sitemap.ts` and `robots.ts` per host: sitemap index of products, categories, pages
  (from `/storefront/sitemap`), chunked at 5 000 URLs. Draft/suspended stores and preview: `noindex`.
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

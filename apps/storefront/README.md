# @storeplix/storefront

One shared Next.js (App Router) app that renders every merchant's store. The tenant is resolved
from the request hostname; store config comes from Laravel `GET /api/v1/storefront/config`.

## Run locally (demo.localhost:3000)

1. Start the API (`apps/api`) on port 8000 and seed it: `php artisan db:seed`
   (creates store slug `demo` with domains `demo.localhost` and `demo.storeplix.test`).
2. Configure the storefront:
   ```sh
   cp apps/storefront/.env.example apps/storefront/.env.local
   # set STOREFRONT_API_KEY to the same value as the API's STOREFRONT_API_KEY
   ```
3. From the repo root: `pnpm install && pnpm dev:storefront`
4. Open **http://demo.localhost:3000** (`*.localhost` resolves to 127.0.0.1 in modern browsers;
   with curl use `curl -H 'Host: demo.localhost' http://127.0.0.1:3000/`).

Useful checks:

| URL | Expected |
|---|---|
| http://demo.localhost:3000/ | Demo store homepage (modern-commerce theme) |
| http://nope.localhost:3000/ | 404 "Store not found" (Store Plix branded) |
| http://demo.localhost:3000/robots.txt, /sitemap.xml | Per-host robots / sitemap |
| `curl -H 'Host: bad_host' http://127.0.0.1:3000/` | 400 invalid host |

Revalidate after publishing (Laravel calls this):

```sh
curl -X POST http://demo.localhost:3000/api/revalidate \
  -H "Authorization: Bearer $REVALIDATE_SECRET" -H 'content-type: application/json' \
  -d '{"host":"demo.localhost"}'        # or {"hosts":["a.example.com","b.example.com"]}
```

## Environment (server-only; never prefix with NEXT_PUBLIC_)

| Var | Purpose |
|---|---|
| `STOREFRONT_API_URL` | Laravel base URL (default `http://localhost:8000`) |
| `STOREFRONT_API_KEY` | Sent as `X-Storefront-Key` |
| `REVALIDATE_SECRET` | Bearer secret for `POST /api/revalidate` (endpoint returns 503 when unset) |
| `STOREFRONT_CONFIG_REVALIDATE` | Config cache TTL in seconds (default 60) |
| `TRUSTED_PROXY` | `true` only behind our own proxy that overwrites `X-Forwarded-Host` |
| `STOREFRONT_LOCAL_PORT` | Port used in canonical URLs for `*.localhost` / `*.test` hosts (default 3000) |

## How it works

- **`proxy.ts`** normalizes the host (lowercase, strip port + trailing dot), rejects malformed
  hosts with 400 and overwrites the internal `x-storeplix-host` request header.
  `X-Forwarded-Host` is ignored unless `TRUSTED_PROXY=true`. Logic: `lib/host.ts`.
- **`lib/storefront-api.ts`** fetches config with `X-Storefront-Host` / `X-Storefront-Key`,
  cached with fetch tag `store:{host}` (revalidate 60s) and validated with Zod.
- **Theme engine** (`themes/`): `registry.ts` maps theme id → `{version, Zod schemas, Layout,
  sections}`. `resolve.ts` validates merchant JSON and falls back to defaults per field /
  section; unknown themes use `modern-commerce`, other major versions use defaults.
  Colors (hex/rgb only) and fonts (allowlist) become CSS variables on `<html>`
  (`themes/css-vars.ts`); derived tones use `color-mix()` in `themes/modern-commerce/theme.css`.
  Merchant data is rendered as text only: no merchant HTML/JS/CSS is ever executed.
- **modern-commerce v1.0.0**: header, footer, `hero`, `featured-products` sections, matching
  Figma (file `2W1wMKN79hhcr1czQS63oN`, pages Storefront `1:9207` / Storefront – Mobile `2:6`).
  Products are placeholders (`lib/products.ts`) until the public product API exists.
- Pages read request headers, so they're rendered dynamically: `next build` never calls the API.

## Scripts

`pnpm --filter @storeplix/storefront <dev|build|start|typecheck|test>`

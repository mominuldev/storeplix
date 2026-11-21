# Store Plix — Product & Technical Blueprint (condensed source brief)

Multi-tenant e-commerce website-builder SaaS. Promise: "Create your online store, connect your domain, and start selling within minutes." Primary market: Bangladesh (BDT, bKash, SSLCommerz, Pathao/Steadfast/RedX couriers).

## Stack
- Backend `apps/api`: Laravel (latest stable), PHP 8.4, REST `/api/v1`, Sanctum, Queues, Events, Policies/Gates, PostgreSQL (or MySQL 8), Redis (cache/queues/rate limit).
- Merchant dashboard `apps/merchant-dashboard`: React + Vite + TS + Tailwind + React Router + TanStack Query + React Hook Form + Zod.
- Super admin `apps/super-admin`: React + Vite + TS + Tailwind; shared UI, separate permissions/navigation.
- Storefront `apps/storefront`: Next.js App Router, TS, Server Components, hostname-based tenant resolution, Tailwind.
- Packages: `packages/ui`, `packages/types`, `packages/api-client`, `packages/config`.
- Infra: Redis, S3-compatible storage, Cloudflare CDN/DNS, Nginx, Docker, automated SSL, GitHub Actions, centralized logging.

## Multi-tenancy (most important decision)
- Shared DB, shared schema, `tenant_id` on every tenant-owned row. Separate DBs = future enterprise option.
- Core tables: tenants, stores, store_domains, users, tenant_users, products, product_variants, categories, product_categories, inventories, customers, carts, cart_items, orders, order_items, payments, shipping_methods, shipping_orders, store_settings, store_themes, store_pages, store_navigation, subscriptions, subscription_items, invoices, audit_logs.
- Required: central tenant resolution service; tenant-aware middleware; scoping enforced at app + authorization layers (global scopes, not developer memory); tenant-aware cache keys; queue jobs carry tenant context and cannot act on other tenants; automated cross-tenant security tests; consider DB constraints / Postgres RLS.

## Onboarding
Register (name, email, password, phone) → create store (name, slug, business category, country, currency) → pick template → customize (logo, favicon, colors, typography, homepage sections, contact, social) → add products (manual/CSV) → publish at `slug.storeplix.com`; custom domain later.

## Domains
Platform subdomain auto-assigned; custom domain flow: validate → uniqueness → DNS verification record → instructions → background DNS check → verify → route → SSL → activate. Statuses: pending_verification, verification_failed, verified, ssl_provisioning, active, expired, suspended. Storefront resolves tenant from normalized hostname; never trust forwarded host headers without validating against registered domains. One shared storefront app for all merchants.

## Theme engine
Theme = id, name, version, JSON config schema, homepage layouts, header/footer, PLP/PDP/cart/checkout templates. Merchant config is schema-validated JSON (`{theme, version, settings:{primaryColor,...}, sections:[{type, enabled}]}`). Extensible theme registry in Next.js. No merchant-provided JS ever executes.

## Modules
Store mgmt · Products (simple/variable, variants, SKU, images, prices, stock, categories, tags, SEO) · Inventory · Orders · Customers · Cart & checkout (guest + registered, coupons, tax, shipping) · Payment gateway abstraction (initiate, verify, webhook, refund, status; never trust redirects) · Courier abstraction (Pathao, Steadfast, RedX) · SEO (sitemap, robots, canonical, OG, structured data, redirects) · SaaS subscriptions (plans, trials, limits, feature gates) · Super admin.

## API
Versioned REST `/api/v1/{auth,merchant,stores,products,categories,inventory,orders,customers,domains,themes,subscriptions,payments,shipping}`. Public storefront: `/api/v1/storefront/{config,products,categories,cart,checkout,orders}`. Consistent response envelope, validation, errors, pagination, rate limiting, authorization. Storefront gets only render data; never expose merchant/admin APIs publicly.

## Security
Tenant isolation, RBAC, CSRF where applicable, validation, no SQLi/XSS, rate limiting, secure uploads, domain ownership verification, webhook signatures, payment verification, audit logs, secrets mgmt, backups. Tests for cross-tenant access, unauthorized ops, payment manipulation, domain-ownership bypass.

## Roadmap
0 Architecture (PRD, architecture, ERD, tenancy strategy, API spec, infra plan, security, standards) → 1 Foundation (monorepo, all apps run & talk, shared types, API client, auth, tenant infra, Docker, CI) → 2 SaaS foundation → 3 Storefront engine → 4 Merchant dashboard → 5 Commerce → 6 Custom domains → 7 Monetization → 8 Super admin/analytics → 9 Production readiness.

## Required docs
CLAUDE.md; docs/architecture/{SYSTEM-ARCHITECTURE,MULTI-TENANCY,DATABASE-DESIGN,STOREFRONT-ENGINE,DOMAIN-INFRASTRUCTURE,SECURITY}.md; docs/development/{CODING-STANDARDS,DEVELOPMENT-ROADMAP}.md; docs/api/API-CONVENTIONS.md; ADRs in docs/adr for: shared DB vs separate; central storefront vs per-tenant deploys; domain routing & SSL; theme config/rendering; merchant auth & roles; cart/checkout; payment abstraction; subscription/billing; file storage & CDN; horizontal scaling/deploy.

## Definition of done
Backend works · validation · authorization · tenant isolation tested · frontend integrated · responsive verified · tests pass · errors handled · docs updated · reviewed.

## Design
All UI follows the Figma file — see `docs/design/FIGMA-INDEX.md`. Note: the Figma scope is larger than the blueprint (POS, Inbox, Automations, Expenses, Staff roles, Developer API keys/webhooks, invoice/label templates, fake-order guard). Treat Figma as the UI source of truth.

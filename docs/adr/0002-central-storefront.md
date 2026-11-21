# ADR 0002 — One central Next.js storefront for all merchants

Status: Accepted · Date: 2026-11-21

## Context
Each merchant needs a fast, SEO-friendly store reachable at a subdomain or custom domain, published "within minutes".

## Decision
A single `apps/storefront` deployment serves every store. Tenant resolved from normalized `Host` in middleware,
rewritten into a `[host]` route segment. Data via server-to-server `/api/v1/storefront/*` with `X-Storefront-Host` +
`X-Storefront-Key`. Themes are code in the repo; merchants supply JSON config only (ADR 0004).

## Consequences
+ Publishing is a DB write + cache revalidation — no builds or deploys per merchant.
+ One codebase to patch, monitor, and scale horizontally.
+ No merchant code execution → strong security posture.
− A storefront outage affects all stores → multiple replicas, edge cache serves stale on origin error.
− Less merchant flexibility than custom code (intentional; theme sections cover Figma designs).
− Cache keys must always include host/store — enforced by the `[host]` segment.

## Alternatives
- **Per-tenant static builds/deploys (e.g. Vercel project per store):** slow publish, cost per store, deploy-rate limits.
- **Laravel Blade storefront:** simpler stack but loses RSC/ISR performance and the Next.js image/SEO tooling.

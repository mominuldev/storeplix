# ADR 0010 — Horizontal scaling and deployment

Status: Accepted · Date: 2026-11-21

## Context
Small team, cost-sensitive, needs zero-downtime deploys and room to grow to ~10k stores.

## Decision
- **Containers everywhere** (Docker images built in GitHub Actions, pushed to GHCR). Images: `api` (PHP-FPM + Nginx,
  or FrankenPHP/Octane once stable in our tests), `worker` (same image, Horizon), `scheduler` (same image, single
  replica), `storefront` (Next.js standalone), SPAs as static assets on Cloudflare (R2/Pages) or Nginx.
- **Phase 1–8 hosting:** Docker Compose on 2+ VMs behind a load balancer (Hetzner/DigitalOcean, Singapore region),
  managed Postgres where available. Phase 9: evaluate k8s (k3s) only if VM ops becomes the bottleneck.
- Stateless app tiers; sessions/cache/locks in Redis; files in object storage; storefront ISR cache shared via
  Next.js custom cache handler on Redis so replicas agree on revalidation.
- **Deploy:** GitHub Actions → build → tests → push → `migrate --force` (backward-compatible migrations only) → rolling
  restart → smoke test `/api/v1/health` → automatic rollback on failure. `main` → staging auto; tag `v*` → production with approval.
- Scale signals: API p95 latency, queue wait time per queue (Horizon), Postgres CPU/connections, storefront TTFB.

## Consequences
+ Cheap, understandable, scales horizontally by adding replicas.
− Manual capacity management on VMs; DB is the vertical bottleneck (read replica Phase 9, partitioning audit logs).

## Alternatives
- Serverless (Vercel for storefront + Vapor for API): fast to start, but custom-hostname scale, cost unpredictability and Cloudflare-SaaS fit are worse; revisit storefront-on-Vercel if edge perf demands it.
- Kubernetes from day one: too much ops for the team now.

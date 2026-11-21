# ADR 0003 — Domain routing and SSL: Cloudflare for SaaS

Status: Accepted (pending PO confirmation, OPEN-QUESTIONS Q3) · Date: 2026-11-21

## Context
Every store gets `{slug}.storeplix.com`; paid plans connect custom domains with automatic HTTPS. Ownership must be proven.

## Decision
- Platform: wildcard DNS + wildcard edge cert on Cloudflare; origin protected by Cloudflare Origin CA + IP allowlist.
- Custom: merchant adds TXT `_storeplix-verify.<host>` (ownership) + CNAME → `customers.storeplix.com`;
  API creates a **Cloudflare for SaaS Custom Hostname**; Cloudflare issues/renews certs.
- State machine `pending_verification → verified → ssl_provisioning → active` (+ failed/expired/suspended) in one class.
- Host validated against `store_domains` at Nginx, storefront and API. Details: DOMAIN-INFRASTRUCTURE.md.

## Consequences
+ No ACME/cert storage ops; WAF, DDoS, CDN included; good latency in BD.
− Vendor dependency and per-hostname cost beyond 100 hostnames; apex domains need CNAME flattening or the Apex Proxying add-on.
− Origin must only accept Cloudflare traffic.

## Alternatives
- **Caddy on-demand TLS + `ask` endpoint:** free and self-hosted, but we own ACME rate limits, cert sync across nodes, and DDoS exposure. Documented fallback; `ask` endpoint built in Phase 6.
- **cert-manager / Let's Encrypt per domain on k8s:** most ops; rejected for team size.

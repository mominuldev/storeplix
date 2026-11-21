# Open Questions for the Product Owner

Each item has a **default** the team builds against until the PO answers. Answer by editing "Decision".

| # | Question | Default (in effect) | Impact if changed | Decision |
|---|---|---|---|---|
| Q1 | Figma scope exceeds the blueprint (POS, Inbox, Automations, Expenses, custom Staff roles, Developer API keys/webhooks, suppliers/POs/transfers, fake-order guard, AI integrations). Which are in v1 launch? | Launch = blueprint modules + coupons + invoice/label templates. Others Phase 8+ (tables sketched in DATABASE-DESIGN §6). | Pulling POS/Inbox earlier adds ~2 phases | |
| Q2 | Database: PostgreSQL vs MySQL 8 (blueprint allows either) | **PostgreSQL 16+** (RLS, partial indexes, jsonb; contract already uses port 5432) | Switching later is costly; decide now | |
| Q3 | SSL/custom-domain provider | **Cloudflare for SaaS** (custom hostnames), Caddy on-demand TLS as documented fallback | Cost ~$0.10/hostname/month beyond 100 | |
| Q4 | Apex custom domains (`acme.com` without www) at launch? | Support `www.`/subdomains; apex only via CNAME-flattening DNS providers; apex proxying add-on later | Cloudflare enterprise add-on cost | |
| Q5 | Payment providers for SaaS billing (platform collecting subscription fees) | bKash (tokenized) + SSLCommerz with **platform** merchant accounts; manual renewal invoices | Needs company merchant accounts + KYC | |
| Q6 | One store per tenant, or multiple stores per merchant account? | One (unique `stores.tenant_id`) | Multi-store requires `store_id` scoping on catalog tables | |
| Q7 | Merchant payment gateways at launch | COD + bKash + SSLCommerz; Nagad later | Each driver ≈ 1 week incl. sandbox certification | |
| Q8 | Languages: Bangla UI for merchants and/or storefronts at launch? | English UI, i18n-ready; storefront content in merchant's language | Translation + Bangla font pairing in Figma | |
| Q9 | Theme config keys are camelCase (`primaryColor`) in `ThemeConfig`, while the API is snake_case | Keep camelCase inside the theme document as an explicit exception | Changing later needs a config migration | |
| Q10 | Plans & pricing (names, BDT prices, limits: products, staff, custom domain, transaction fees?) | Placeholder plans `free_trial`, `starter`, `growth`, `pro`; no platform transaction fee | Affects FeatureGate and billing UI | |
| Q11 | Courier integrations at launch | Pathao, Steadfast, RedX via merchant's own credentials | — | |
| Q12 | Hosting region / provider | Singapore VMs (Hetzner/DO) + Cloudflare R2; data residency in BD not required | BD-hosted DB if regulation requires | |
| Q13 | Online store editor: V1 (60:11061) vs proposals V2 (2007:46186) / V3 (2028:44400) | Build V1 section-based editor; V3 page-builder later | V3 changes ADR 0004 | |
| Q14 | Customer accounts on storefronts at launch (login, order history) or guest-only? | Guest checkout + optional phone-OTP account in Phase 5 | SMS OTP cost | |
| Q15 | Data retention after subscription expiry / tenant deletion | Read-only 90 days, then hard delete with export offered | Legal review | |

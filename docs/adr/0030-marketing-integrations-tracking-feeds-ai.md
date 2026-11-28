# ADR 0030 — Integrations without merchant code: tracking, product feeds, Nagad and metered AI

Status: Accepted (Phase 8.9d; PO (product owner) scope and defaults Q330–Q369 accepted, 2026-11-28; Q346 Google API and
Q358 image provider open, defaults in effect) · Date: 2026-11-28 · Binding detail: PHASE-8-9D-CONTRACT §1 (P89D-1 –
P89D-60), §3–§13, §14.2 (S330–S349)
Builds on: ADR 0001 (shared-database tenancy), 0004 (theme config, no merchant JS), 0007 (payment gateway abstraction),
0012 (Postgres RLS), 0018 (outbound webhooks and delivery rows), 0026 (SMS credits ledger), 0027 (write-only provider
credentials, endpoint guard).

## Context
Merchants need the Meta pixel and Conversions API, GA4, TikTok and Google Tag Manager, live product catalogs on
Facebook/Instagram and Google, Nagad next to bKash, and help writing product copy and cleaning photos. Every tracking
vendor's own instructions say "paste this snippet", and GTM's web container runs any tag configured in Google's UI —
both would execute merchant-controlled JavaScript on the shared storefront, which CLAUDE.md rule 7 forbids. Feeds need
OAuth tokens that must stay secret and refreshed. AI calls cost money per request, like SMS.

## Decision
1. **IDs and tokens only.** Tracking settings hold validated IDs (regex per provider; pasted markup is refused with a
   specific error) and write-only tokens. The storefront renders the official base tags from Storeplix templates with the
   validated ID as the only variable. **GTM is server-container only**: Storeplix forwards GA4-format events from its
   server to the merchant's tagging server; a web container is rejected by design.
2. **Purchases from the server, once.** Purchase (and GA4/GTM refunds) are sent server-side when the order reaches the
   configured trigger (default: confirmed), with deterministic event ids and a unique index per destination; browser
   events share a browser-made ULID with their server mirror (Meta, TikTok) and are never mirrored where the provider
   can't deduplicate (GA4). Customer data is normalised (BD phone E.164) and SHA-256 hashed per provider format.
3. **One registry table.** `store_integrations` holds one row per (store, provider) for tracking, feeds and AI tools with
   typed settings (validated per provider) and encrypted, write-only credentials (last-4 hints). High-volume data lives
   in child tables (`tracking_events`, `tracking_daily_stats`, `order_tracking_contexts`, `catalog_items`,
   `catalog_sync_runs`, `ai_generations`). Payment gateways keep `payment_gateway_accounts`.
4. **Queued, retried, pruned delivery.** Every server event is an outbox row delivered by a tenant-aware job with a
   lease and a minute sweep (ADR 0018 pattern), 5 attempts within 24 h, auth failures stop and flag the integration;
   logs are kept 7/30 days and payloads nulled when final.
5. **Outbound safety.** Provider hosts are fixed in config and called through `SafeHttpClient`; the only merchant URL
   (GTM tagging server) passes the 8.9b resolve-and-pin guard, generalised as `PublicEndpointGuard`.
6. **Feeds by OAuth.** Meta Catalog Batch API and Google's **Merchant API** (the Content API for Shopping is being shut
   down; Q346 records the deviation from the original request), hourly full sync plus 5-minute deltas, item issues and
   attention states, website claim through a Storeplix-written verification meta tag.
7. **Nagad behind the 5b interface**, paid only after server-side Verify Payment; callback and webhook bodies are
   triggers; capabilities are declared per driver so the UI greys out what a gateway can't do.
8. **AI metered like SMS.** One credit pool per tenant: monthly plan allowance, then staff-granted bonus credits;
   append-only ledger, idempotent consume and refund per generation, failures free. Text via Anthropic Claude through
   the official PHP SDK with a configurable model id (default `claude-opus-5-5`), structured outputs, refusal handling
   and server-side fallbacks; the output is rebuilt into sanitized rich text and never saved automatically. The image
   provider sits behind an interface with a fake driver until chosen.

## Consequences
+ Rule 7 holds: no merchant string ever becomes script; the storefront CSP can allow a short, fixed host list.
+ Server-side purchases survive ad blockers and COD reality (counted on confirmation, not attempt).
+ Adding a tracker, feed or AI tool is a settings DTO + driver, not a new table.
− Merchants can't add arbitrary tags (Hotjar, chat widgets, custom pixels); each needs a first-party integration.
− Meta feeds need app review and Google OAuth verification before production — deployment dependencies.
− Our consent bar is minimal; a merchant needing a full CMP can't plug one in.
− One more vendor dependency (`anthropic-ai/sdk`) and per-request AI cost carried by the platform within allowances.

## Alternatives considered
- **"Custom code" box / GTM web container**: what competitors offer and merchants ask for; rejected — it is arbitrary
  JavaScript on a shared, multi-tenant storefront (XSS, card skimming, session theft across shops).
- **Per-integration tables**: clearer columns, but eight copies of the same lifecycle and migrations for every new
  provider; typed settings DTOs give the safety without the sprawl.
- **Browser-only purchase events**: simpler, but blocked by ad blockers and fired on attempts that COD shops later cancel.
- **Merchant-pasted catalog/system-user tokens**: avoids app review, but long-lived secrets typed by merchants and no
  refresh; rejected for OAuth.
- **Bring-your-own AI key**: no platform cost, but a key per merchant to store and support; later row (Q364).

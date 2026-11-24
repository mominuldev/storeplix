# ADR 0018 — API keys and outbound webhooks

Status: Accepted (Phase 8.4; defaults Q126–Q137 accepted 2026-11-24) · Date: 2026-11-24 · Binding detail:
PHASE-8-4-CONTRACT §1 (P84-1 – P84-14), §2–§5, §9
Builds on: ADR 0005 (merchant auth), 0012 (Postgres RLS), 0017 (granular permissions).

## Context
Figma "Developer · API & webhooks" (`144:40725`) lets a merchant mint API keys for their own tools (accounting,
warehouse apps, Zapier) and register webhook endpoints that receive signed events with retries. The Growth plan has
advertised `api_webhooks` since Phase 7 without enforcing it. Constraints:
- The merchant API authenticates with cookie sessions + `X-Tenant-Id` + `perm:` (ADR 0017); mixing a second credential
  type into those routes would widen every route's attack surface and its tests.
- With RLS (ADR 0012) the app role can't read a tenant table before the tenant is known, so a bearer key needs a
  pre-tenant lookup like the inbound webhook route keys.
- A key is a credential: it must be revocable, never stored in plain, never stronger than its creator, and isolated per
  tenant and store like everything else.
- Outbound HTTP to merchant-chosen URLs is an SSRF vector (T14) and a queue-capacity risk if endpoints stay down.
- No merchant-provided code may execute: payloads are fixed, versioned JSON.

## Decision
1. **API keys are tenant-level rows** (`api_keys`), bound to the tenant's single store at use time. Plain key
   `sp_live_` + 40 base62, shown once; only the sha256 hex (unique), a 12-char prefix and the last four are stored.
   No expiry; revocation keeps the row.
2. **Pre-tenant lookup by a definer function** `sp_api_key_owner(p_hash)` → `(tenant_id, key_id)` for non-revoked keys
   only, after a strict format check. Every failure answers the same 401 `invalid_api_key`.
3. **Separate namespace** `/api/v1/external/...` with its own middleware (`apikey` → tenant context + RLS GUCs,
   `throttle:external-api` 120/min per key, exactly one `scope:` per route). Controllers are thin and reuse the merchant
   services, Form Requests and API Resources, so shapes are identical. Merchant routes never accept a key; external
   routes never accept a session.
4. **Seven scopes**, each backed by a permission of ADR 0017. **Non-delegation**: a member can grant a scope only when
   they hold its backing permission; creating keys needs the new sensitive permission `developers.manage` (owner,
   admin, grantable to custom roles, never staff). The key's effective permission set = its scopes' backing permissions;
   actions are recorded with actor type `api_key`.
5. **Webhooks are store-scoped**: endpoints, one signing secret per store (encrypted with the IntegrationCredentials
   encrypter, revealable and rotatable with a 24 h overlap), and a delivery log kept 30 days.
6. **Signature** `X-Storeplix-Signature: t=<unix>,v1=<hex>` with `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`; during
   an overlap a second `v1=` uses the previous secret. Payload version `2026-12-01`; `data.object` is built with the same
   API Resource as the external GET, after commit.
7. **Delivery**: queue `webhooks-out`, `TenantAware` job, 7 attempts (now, +1 m, +5 m, +30 m, +2 h, +6 h, +12 h), any 2xx
   in 10 s is success, then `failed`; resend creates a new delivery with the same payload; endpoints failing for 72 h
   are auto-disabled. `OutboundWebhookClient`: https only, blocked private/loopback/link-local/CGNAT/metadata/multicast/
   ULA ranges and internal ports, resolved IP pinned, no redirects; checked on save and at send. A fake driver and a dev
   sink serve local/e2e work and refuse to boot in production.
8. **Plan gate** `api_webhooks` (Growth). On downgrade nothing is deleted: the external API answers 402, no deliveries
   are recorded, pending retries fail with `plan`, management stays readable.

## Consequences
- Integrations get a small, stable surface; new external routes must add a scope (or reuse one) and the route scope
  test fails otherwise. Resource changes on the merchant API also change external responses and webhook payloads: the
  payload version must be bumped for breaking changes.
- One more pre-tenant definer function and four RLS tables to keep in the emergency script.
- `order_events`, `inventory_movements` and audit logs show "API: <key name>" actors; UIs must tolerate actor type
  `api_key`.
- Receivers must verify signatures and dedupe on `X-Storeplix-Delivery`; retries can deliver out of order.
- Test-mode keys, OAuth apps, per-key IP allowlists, write scopes for customers/shipments and super-admin views are
  not supported yet; each fits this model as an added column, scope or screen.

## Alternatives considered
- **Sanctum personal access tokens on the merchant routes**: one auth path, but every merchant route would accept a
  second credential, `perm:` would need key-aware branches, and tokens are user-bound (they die with the membership and
  carry the user's full permission set).
- **OAuth 2 client credentials / authorization code**: right for third-party apps across merchants, far more surface
  (consent, refresh, client registry) than a single merchant connecting their own tools needs today.
- **Per-endpoint signing secrets**: Figma shows one secret; one per store is simpler for receivers. Can be added later
  without changing the header format.
- **Unsigned webhooks or a shared platform secret**: receivers could not tell deliveries from forgeries, or one leak
  would expose every merchant.

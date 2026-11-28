# Phase 8.9d contract: Integrations — tracking pixels, product feeds, Nagad, AI tools (binding for ARCH, API, WEB, SF, ADMIN, QA)

Status: **Accepted, 2026-11-28 — PO (product owner) set the scope (tracking, product feeds, Nagad, AI; later rows recorded)
and accepted the proposed defaults for Q330–Q369**. Q346 (Google Merchant API instead of the Content API) and Q358
(image provider) stay **open — default in effect**; Q363, Q364 and Q367 are record-only later rows (open). Branch `feat/phase-8-9d-integrations` (stacked on 8.9a, 8.9b and the
8.8e Inbox contract; rebased on `main` once those merge).
Roadmap task **8.9d** "Integrations: payments, tracking, product feeds, AI" (Figma section `32:5331`, FIGMA-INDEX "Phase
8.9 — Integrations"). AC: **"A merchant connects Meta, GA4, TikTok or a GTM server container by pasting IDs and tokens
only, and purchases reach them from the server once, hashed and deduplicated; the shop's products sync to Facebook &
Instagram and Google Merchant Center hourly with price and stock changes inside 15 minutes and item errors shown;
shoppers can pay with Nagad, verified server-side; staff write product descriptions with Claude and clean product photos
from one shared pool of AI credits; nothing changes for a shop that connects nothing"** (§17).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-9B, PHASE-8-8E and
docs/api/API-CONVENTIONS.md still applies. PHASE-5B §1.B (gateway interface, P5B-10 encrypted credentials, P5B-16
server-side verification, P5B-18 signed returns, P5B-19 webhook storage, P5B-20 idempotent transitions, P5B-29 fake
drivers), PHASE-8-4 §4 (outbound delivery rows, retry sweep, `WebhookUrlGuard`), PHASE-8-9A §4–§5 (credit account lock,
append-only ledger, idempotent consume/refund, admin adjust) and PHASE-8-9B P89B-3/P89B-4 (write-only credentials with
hints, `SmsEndpointGuard` resolve-and-pin) apply in full. **Amends** PHASE-5B P5B-12 (checkout methods gain `nagad`),
P5B-27 (Nagad on every plan), PHASE-8-9A P89A-24 (Integrations list groups), STOREFRONT-ENGINE §"No merchant JavaScript"
(new §6.1: fixed pixel templates), and CLAUDE.md rule 7 is **restated, not relaxed** (P89D-8, P89D-9).
Machine-readable spec: `docs/api/openapi.yaml` **v1.27.0** (tags `integrations`, `ai`, plus `payments`, `storefront`,
`billing`, `admin`, `webhooks`). **1.26.0 is skipped on purpose**: it belongs to the parallel Help center contract.
ADR **0030** (new). Product defaults: OPEN-QUESTIONS **Q330–Q369**.

### Scope and parts

The phase ships as **two parts, two QA gates**. Both build against the types and client written here (§15).

| Part | Area | Owner | Ships |
|---|---|---|---|
| **A** | **Registry** | API/WEB | `store_integrations`, typed settings, write-only credentials, connect / update / verify / disconnect, Integrations list groups (§3, §4) |
| **A** | **Tracking** | API/WEB/SF | Meta Pixel + Conversions API, GA4 + Measurement Protocol, TikTok Pixel + Events API, GTM **server container** forwarding; storefront base tags from fixed templates, consent bar, beacon; server purchase/refund; queued delivery, event log, stats, Test & verify (§5, §6) |
| **A** | **Product feeds** | API/WEB/SF | Meta catalog (Catalog Batch API) and Google Merchant Center (Merchant API), OAuth, hourly full sync + 15-minute deltas, item issues, Needs attention, website claim through a Storeplix-written meta tag (§7) |
| **B** | **Nagad** | API/WEB/SF | Third gateway behind the 5b interface: credentials, initialise/complete, signed callback + server Verify, untrusted webhook trigger, reconcile; capabilities greyed in the UI (§9) |
| **B** | **AI credits** | API/WEB/ADMIN | Plan allowance + bonus credits, append-only ledger, idempotent consume/refund, admin adjust (§10) |
| **B** | **AI tools** | API/WEB | Product description writer (Anthropic Claude) in the product editor; AI product photos (remove / replace background, fake driver until the provider is chosen) (§11) |
| — | **Docs + types** | ARCH | openapi 1.27.0, `packages/types`, `packages/api-client` (**written**, §15), ADR 0030, DATABASE-DESIGN §5.16, SECURITY T47, MULTI-TENANCY count, OPEN-QUESTIONS, roadmap |
| — | **QA** | QA | `phase8-9d-a*.spec.ts`, `phase8-9d-b*.spec.ts`, Pest groups `integrations`, `tracking`, `feeds`, `ai`, `nagad` (§16) |

**Who starts with what:** API starts **part A** (migrations `000100`–`000600`, registry, tracking, then feeds), then
part B. WEB starts **part A** (list groups, pixel pages, feed pages), then part B (Nagad page, AI writer, AI photos).
SF does **part A** (base tags, consent bar, beacon, checkout context, site-verification meta) and the one-line part B
change (Nagad payment method). ADMIN works only in **part B** (AI credits card + adjust dialog on the merchant page).

**Out of scope** (hide, never fake; Q367): Mailchimp or other email-tool sync; OpenAI / Gemini and "bring your own
API key"; EPS, aamarPay, PayStation; the separate Events and Settings tabs of each pixel beyond what §5 lists (their
content lives on Overview + Event log); mobile detail frames (pages stack below `lg`, as 8.9a); **test orders** ("place a
test order, tagged Test, never sent to a courier"); bulk photo editing and auto-edit of new uploads; buying AI credit
packs; TikTok `PlaceAnOrder`; Meta / TikTok refund events; Google Ads conversions, Pinterest, Snap; Claude for Inbox
replies and "Order from chat" (8.8f); a web GTM container (rejected, P89D-9); Nagad pre-authorised advance, tokenised
(agreement) checkout and "remember number".

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role.
- **Provider** = a value of `IntegrationProvider` (`meta_pixel`, `ga4`, `tiktok_pixel`, `gtm_server`, `meta_catalog`,
  `google_merchant`, `ai_writer`, `ai_photos`), used verbatim as the `{provider}` path segment. Payment gateways keep
  `GatewayProvider` (`bkash`, `sslcommerz`, **`nagad`**) under `/payment-gateways`.
- **Browser event** = fired by the official tag on the storefront. **Server event** = sent by the API (CAPI, MP, Events
  API, tagging server). **Mirror** = a server copy of a browser event with the same `event_id`.
- `[S]` store-scoped (`BelongsToStore`), `[T]` tenant-level (`BelongsToTenant`). Money: integer minor units; a value
  sent to a tracker is converted at the edge (P89D-21). Times: store timezone for days/months.
- Local runs: api **:8010**, merchant **:5183**, super-admin **:5184**, storefront **:3010**. Fakes: `TRACKING_FAKE=true`
  (no provider calls; deliveries succeed), `FEEDS_FAKE=true` (OAuth returns a canned token; items accepted),
  `PAYMENTS_FAKE=true` (Nagad uses `FakeGateway`), `AI_DRIVER=fake`, `AI_IMAGE_DRIVER=fake`.

### Standing rules for every agent
- Browser checks: Playwright only. Never `git stash`, `git reset`, `git checkout -- <path>` in a shared tree; touch only
  owned files (§16.1). Re-read shared-read files before each Edit.
- New dependencies: **one** — `anthropic-ai/sdk` (official Anthropic PHP SDK, API only), pinned to an exact version
  released ≥ 14 days before install (Q369). Nothing else (no pixel SDKs server-side, no Google client library: plain HTTP
  through `SafeHttpClient`).
- **Rule 7**: no merchant-provided markup or script reaches a page. Pixels take IDs; tags come from Storeplix templates
  (§6). A static test fails if any storefront component interpolates an integration value into a script body without
  the shared validator (§16).
- **Secrets never leave the server** (8.9b rule): no response, log line, audit meta, exception, job payload, event-log
  row or Playwright trace contains a token, API secret, OAuth refresh token or Nagad private key.
- **Nothing changes for a shop that connects nothing** (P89D-2).

---

## 0. Summary and goals
Merchants in Bangladesh sell through Facebook and Instagram ads and Google; they need the pixel, server-side
conversions and a live catalog, and they ask for Nagad next to bKash. They also want help writing product copy and
cleaning photos. 8.9d delivers these as integrations on the existing Integrations page (Figma `32:5331`) without ever
running merchant code: Storeplix renders the official base tags from validated IDs, sends purchases from the server
once per order, syncs feeds with OAuth, adds Nagad behind the 5b gateway interface, and meters AI through one credit
pool like 8.9a SMS credits.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P89D-1 | **Scope and split** (Q330): part A tracking + feeds, part B Nagad + AI; later rows §"Out of scope" | Tracking/feeds share the registry and storefront; Nagad and AI are independent |
| P89D-2 | **Opt-in only**: no row → no tag, no beacon, no consent bar, no server events, no sync, no AI button, Nagad absent from checkout. Every existing test stays green except added enum values and plan fixtures | Same principle as 8.9a / 8.8e |
| P89D-3 | **One `store_integrations` table** (Q331) for the eight tracking, feed and AI providers: one row per (store, provider) with `settings jsonb` validated by a per-provider typed schema and `credentials` encrypted. Child tables only where rows are many (events, stats, feed items, sync runs, AI jobs). **Payment gateways stay in `payment_gateway_accounts`** (Nagad = new provider value) — money paths, route keys and webhook binding already depend on it | Eight identical lifecycles (connect, verify, hint, revision, disconnect, audit) in one place instead of eight tables; payments keep their tested model |
| P89D-4 | **Typed settings**: `App\Domain\Integrations\Settings\{Provider}Settings` DTOs with `rules()`; unknown keys → 422; defaults per provider (§4.3) returned as `defaults`; `revision` optimistic lock (409 `revision_conflict`) | jsonb flexibility without untyped blobs |
| P89D-5 | **Credentials** encrypted with the integration-credentials encrypter (`INTEGRATION_CREDENTIALS_KEY`, `EncryptedCredentials` cast, `integration:rotate-key` covers the new column), hidden on the model, write-only; response `credentials_hint` = `{field: "••••" + last 4}`; jobs load by row id, never carry secrets | 5b / 8.9b proven pattern |
| P89D-6 | **IDs only** (Q332): Meta pixel `^\d{10,20}$`, GA4 `^G-[A-Z0-9]{4,12}$`, TikTok `^[A-Z0-9]{20}$`, GTM `^GTM-[A-Z0-9]{4,10}$`, test codes `^[A-Za-z0-9]{4,32}$`; trimmed, upper-cased where the format is upper case. Input that matches `PASTED_CODE_PATTERN` (`<script`, `fbq(`, `gtag(`, `ttq.`, `gtm.js`, `function(`) → 422 `integration_code_pasted` (`details.field`), UI copy "This looks like code. Paste only the {Pixel ID} …" (Figma `2133:53731`); other mismatch → 422 `integration_id_invalid` | Rule 7 at the boundary; a friendly message for the most common mistake |
| P89D-7 | **Secrets are write-only** (Q341): Figma GA4 `2132:53511` "Show" on the API secret becomes **"Replace"**; masked `••••abcd` (last 4) everywhere, as 8.9b | A shown secret is a leaked secret |
| P89D-8 | **Storeplix renders the official base tags** (Meta `fbevents.js`, GA4 `gtag.js`, TikTok `events.js`) from fixed templates in `apps/storefront/components/tracking/**`; the only variable is the validated ID, re-validated by the storefront Zod schema and inserted with `JSON.stringify`. No HTML/script field exists anywhere (API, DB, UI) | Rule 7: IDs are data, the code is ours |
| P89D-9 | **GTM is server-container only** (Q333): a web container (`gtm.js`) runs any tag the merchant adds in Google's UI — arbitrary merchant JavaScript on our storefront — so it is **rejected** (card "Web containers aren't supported · By design", message "Use a server container"). Storeplix forwards events from **its server** to the merchant's tagging server as GA4 Measurement Protocol requests | Rule 7; server-side tagging still gives the merchant GTM's routing |
| P89D-10 | **Browser events** (Q334): `page_view`, `view_item`, `add_to_cart`, `begin_checkout` fired by the base tags (when consented) **and** reported to the storefront beacon (§6.2). **Mirror defaults**: Meta and TikTok `mirror_browser_events = true` (CAPI/Events API recommended, deduplicated by `event_id`); **GA4 never mirrors** (Measurement Protocol does not deduplicate against gtag); GTM server receives every selected event from the server (there is no browser container) | Better match rates where dedupe exists; no double counting where it doesn't |
| P89D-11 | **Purchase is server-only** (Q335): sent when the order reaches `purchase_trigger` — `order_placed`, **`order_confirmed` (default)**, `order_delivered` — hooked where `WebhookEvents::orderStatus` / `OrderNotifier` already fire (after commit). Cancelled before the trigger → nothing. POS sales (`channel = pos`) are never sent. TikTok name `CompletePayment` | COD-heavy shops count real orders, not attempts (Figma "Order is confirmed") |
| P89D-12 | **Event ids** (Q336): browser events carry a ULID made in the browser, shared by the tag call and the mirror; server events use deterministic ids `purchase.{order_id}` and `refund.{payment_id}` (`transaction_id` = order number). `UNIQUE(store_integration_id, event_id, channel)` makes every server send at most once per destination even on replays | Provider-side dedupe + our own idempotency |
| P89D-13 | **Customer data** (Q337), only when `send_customer_data` (default true) and consent allows: email trimmed + lower-cased → SHA-256 hex; phone normalised to E.164 `+8801XXXXXXXXX` (`Phone::e164`, invalid → omitted) → SHA-256 of the E.164 string; **Meta `ph` hashes the digits without `+`** (Meta format); first name, last name, city lower-cased, spaces removed → SHA-256; country `bd` → SHA-256; `external_id` = SHA-256(customer id). Raw values never stored outside the order; hashed values exist only in the delivery payload until final. Per-provider field formats marked **VERIFY** against each provider's current docs in the API PR | Match quality without storing extra personal data |
| P89D-14 | **Consent** (Q338): per integration `wait_for_consent` (default **false**: BD has no consent law in force; merchants who sell abroad turn it on). When any enabled integration waits, the storefront shows the **Storeplix consent bar** (fixed component, Accept / Decline, `sp_consent` cookie 12 months, not httpOnly so the tag loader can read it; no third-party CMP). Waiting integrations load nothing and mirror nothing until Accept; their order events are sent only when the order's saved consent is `granted` (else `skipped`, `no_consent`). Integrations that don't wait record `not_required` | Honest consent without a CMP dependency |
| P89D-15 | **Queued delivery** (Q342): every server event is a `tracking_events` row (`pending`) delivered by `Tracking\Jobs\DeliverTrackingEvent` (`TenantAware`, queue `tracking`, `ShouldBeUnique` by row, `tries = 1`); a minute sweep `tracking:dispatch-due` re-dispatches due rows (8.4 pattern). **5 attempts**: immediately, +1 min, +10 min, +1 h, +6 h, then +16 h final check inside 24 h → `failed`. 429 respects `Retry-After` (≤ 1 h). Lease 120 s so the job and sweep never double-send | GTM frame "Retrying n of 5", "retry for 24 h" |
| P89D-16 | **Auth failures stop and flag**: HTTP 401/403 or the provider's invalid-token code → row `failed` (`auth`), no retry; the integration gets attention `token_invalid`, owner + admins emailed once per transition ("Your {Meta} access token stopped working"); later events are `skipped` (`no_token`) until the token is replaced. ≥ 20 failed of the last 50 server events → attention `delivery_failing` | Don't hammer a dead token; tell the merchant once |
| P89D-17 | **Outbound HTTP** (Q343): every provider call goes through `SafeHttpClient` with **fixed hosts from config** (`graph.facebook.com`, `www.google-analytics.com`, `business-api.tiktok.com`, `merchantapi.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com/siteVerification`, Nagad base URLs, `api.anthropic.com` via the SDK). The **only merchant URL** is the GTM tagging server: validated on save and pinned per send by the 8.9b guard, moved to `App\Domain\Integrations\PublicEndpointGuard` (`SmsEndpointGuard` delegates to it): https, port 443 only, host name not IP, no local suffixes, every resolved address public, `CURLOPT_RESOLVE` pin, no redirects, 5 s connect / 10 s total → 422 `integration_endpoint_blocked` on save, `endpoint_blocked` on send | SSRF closed by construction |
| P89D-18 | **Retention** (Q340): `tracking_events` delivered / skipped **7 days**, failed **30 days** (`tracking:prune`, daily); payload (hashed data, IP, user agent) nulled as soon as a row is final; `tracking_daily_stats` 90 days; `order_tracking_contexts` IP and user agent nulled after 90 days, row deleted after 180 days; `catalog_sync_runs` 90 days; AI generation outputs 90 days | Logs for debugging, not a data lake |
| P89D-19 | **Test & verify** (Q339): **Send test event** = synchronous synthetic event (default `purchase`, value ৳1) with Meta/TikTok `test_event_code` or GA4's validation endpoint (`/debug/mp/collect`) or the tagging server; **Open shop in test mode** (Meta, TikTok) = signed storefront link `?sp_test={token}` (30 min) → httpOnly `sp_track_test` cookie → that browser's mirrors carry the test code and its events are logged individually with `test: true` (Test events table, 5 s polling, "Deduplicated" = a browser and a server row share an id). **Test orders are not built** (Q339) | Real verification without fake orders in reports |
| P89D-20 | **Refunds**: GA4 and GTM `refund` when a refund payment succeeds (gateway or manual, `PaymentService::applyRefund` / manual refund path, after commit), only if the purchase was sent and `send_refunds` (GA4 default true). Meta and TikTok have no standard refund event → none (Q335) | Correct revenue where the platform supports it |
| P89D-21 | **Values**: purchase `value` = order `total_amount` (or minus `shipping_amount` when `include_delivery_charge = false`, default false), converted minor → decimal string at send time (`MoneyFormat::decimal`, 2 places), `currency` = store currency; items = lines (variant id, name, quantity, unit price). Browser-event values come from the catalogue on the API, **never from the browser** | Rule 9 kept internally; trackers get their format |
| P89D-22 | **Storefront render data** (Q362): `StorefrontConfig.tracking` = pixel IDs, `wait_for_consent`, `collect`, `currency`, `site_verification.google` — **never a token, secret, tagging URL or test code**; null for Coming soon and preview renders and when nothing is connected (P89D-2) | The storefront needs IDs only |
| P89D-23 | **Audit** every connect, update, credential replacement (field names + hints), OAuth connect, account choice, website claim, test event/mode, sync-now, disconnect, AI on/off, photo apply/undo, AI credit adjust (`INTEGRATION_AUDIT_ACTIONS`) | Figma: "Every connect, disconnect, token change and feed connection writes audit_logs" |
| P89D-24 | **Meta catalog connection** (Q345): OAuth (Facebook Login for Business; scopes `catalog_management`, `business_management`), then choose a catalog or create "Storeplix · {shop}" (`PUT …/account`). Items via the **Catalog Batch API** (`/{catalog_id}/items_batch`, `PRODUCT_ITEM`, UPDATE/DELETE, ≤ 5,000 per request) and status via `check_batch_request_status` + item review fields (**VERIFY** names). Needs a Meta app with Advanced Access after **app review** — a deployment dependency recorded in RUNBOOK; until approved, the card shows "Coming soon" when `META_APP_ID` is unset | Official API; merchants never paste catalog tokens |
| P89D-25 | **Google Merchant Center uses the Merchant API** (Q346, **open — default in effect**): the PO asked for the Content API for Shopping, but Google replaced it with the **Merchant API** (`merchantapi.googleapis.com`) and announced the Content API's shutdown in 2026. Build against Merchant API `products` / `productInputs` (insert, delete), `accounts` and `issueresolution`/product statuses; **VERIFY** current versions in the API PR. If the Content API is still serving at build time, the driver interface `FeedDriver` keeps a switch | Don't build on a sunset API |
| P89D-26 | **OAuth tokens** stored encrypted in `credentials` (`access_token`, `refresh_token`, `expires_at`); Google access tokens refreshed 5 min before expiry under a per-row lock; Meta long-lived tokens (≈ 60 days) re-exchanged when < 10 days remain, else attention `token_expiring` (7 d) → `token_expired` ("Reconnect"). `state` = encrypted+signed `{tenant, store, user, provider, nonce, exp}`, nonce single-use in the tenant cache (10 min) | No pasted long-lived secrets; replay-proof callback |
| P89D-27 | **Item mapping** (Q347): one item per **variant** (`id` = variant ULID, `item_group_id` = product id); title (product name + variant title), description (rich text → plain text, ≤ 5,000), link `https://{primary_host}/products/{slug}?variant={id}`, image (main image CDN URL, ≤ 10 additional), price (variant price, `1250.00 BDT`), sale price when `use_sale_price` and `compare_at_amount > price` (price = compare-at, sale = price), availability from the **online location** (P8.8c) `in stock` / `out of stock`, brand (product brand else `default_brand` else store name), condition (Google setting, default `new`), language (Google `feed_language`, default `bn`), country `BD`, gtin/mpn omitted (`identifier_exists = no`) | One mapping for both channels |
| P89D-28 | **Inclusion**: active, published, not archived, price > 0, ≥ 1 image; `include = categories` limits to chosen categories; `hide_sold_out` excludes out-of-stock variants (else sent as out of stock). Excluded items carry `excluded_reason`; an item that becomes excluded is **deleted** from the catalog (status `deleting` → removed) | Clean feeds, explained exclusions |
| P89D-29 | **Cadence** (Q348): `feeds:sync` **hourly** queues one full sync per connected feed (content-hash skips unchanged items); price, stock and product changes mark items dirty (`catalog_items.dirty_at`) from `ProductService` / `InventoryService` hooks (the same points that emit `product.updated` / `stock.low`, after commit) and `feeds:sync-deltas` **every 5 minutes** pushes dirty items, so changes land **within 15 minutes**. Product deletion → delete item. One run per feed at a time (`Cache::lock`, tenant key). Provider 429 → backoff, run `partial` | Hourly truth + fast deltas |
| P89D-30 | **Issues and Needs attention** (Q349): provider item errors/warnings stored on the item (`issues`, message escaped, ≤ 300 chars, `fix` target); grouped issues on the overview; status `needs_attention` when any reason in §4.4 holds (e.g. `items_with_issues` when disapproved items > 0, `website_not_claimed`, `token_expiring`), `error` when the last two runs failed for auth/account reasons | Figma "Needs attention" `2134:66100` |
| P89D-31 | **Disconnect** (Q350): typed **DISCONNECT** dialog (Figma `2135:55831`, used for every integration in this phase); stops sync/sending, best-effort token revoke, deletes credentials and local `catalog_items`; products already at Meta/Google stay there ("Storeplix deletes its access"); event log kept until retention | Predictable, reversible on the provider side |
| P89D-32 | **Website claim** (Q351): "Verify and claim website" (Google) needs a **live** store with a primary host (409 `store_not_live`); API gets a META token from the Site Verification API with the merchant's OAuth, publishes it through `StorefrontConfig.tracking.site_verification.google` (rendered as `<meta name="google-site-verification">` by Storeplix), verifies, then claims the host in Merchant Center. Nothing is pasted | Figma "Verification without code" |
| P89D-33 | **AI credits** (Q357): one pool per tenant shared by every AI tool; **plan allowance** `ai_credits_per_month` **Free 20 · Starter 300 · Growth 1,500** per calendar month (store tz), plus **bonus credits** (never expire) granted by staff. Allowance first, then bonus. No purchase in 8.9d | Figma "AI credits shared with Claude (resets monthly)" |
| P89D-34 | **Ledger and idempotency** (8.9a pattern): `ai_credit_accounts` row lock (`FOR UPDATE`) serialises charging; append-only `ai_credit_ledger` (`consume`, `refund`, `admin_adjust`, with `source` allowance/bonus and `period`); **consume and refund unique per generation**; allowance used = Σ allowance consumes − refunds in the period. The charge and the generation row are written in one transaction; the request's `Idempotency-Key` maps to one generation (`U(store_id, requested_by, idempotency_key)`) | No double charge, no free retries |
| P89D-35 | **Admin adjust** (Q357): `POST /admin/tenants/{tenant}/ai-credits/adjust` (`manage_billing`), bonus ±1…100,000 (never 0), reason 5–500 shown to the merchant, Idempotency-Key, never below 0 (422 `ai_credits_insufficient`), audited `ai_credits.adjusted`, `// cross-tenant: AI credit adjustment` | Goodwill and corrections, traceable |
| P89D-36 | **Text provider: Anthropic Claude** (Q355), official PHP SDK `anthropic-ai/sdk`, Messages API only. Model id **configurable**: `AI_TEXT_MODEL` default **`claude-opus-5-5`** (Anthropic's current default model, verified with the `claude-api` reference on 2026-11-28; ids are used exactly, never date-suffixed), `AI_TEXT_EFFORT` default `medium` (`output_config.effort`). Platform key `ANTHROPIC_API_KEY` (secret manager); `AI_DRIVER=anthropic|fake` | One supplier, swap the model by config |
| P89D-37 | **Request shape**: system prompt fixed in `resources/ai/product-description.md`; **structured outputs** (`output_config.format` JSON schema: `variants[{paragraphs[], highlights[], seo_title, meta_description}]`); `max_tokens` 4,096; **no `temperature`/`top_p`**, no `thinking` parameter (Opus 5.5 always thinks; `disabled` and budgets are rejected), no assistant prefill, no tools; server-side refusal fallback on (`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`); `stop_reason = refusal` → `failed` `ai_refused` + refund; `max_tokens` or schema failure → `ai_output_invalid` + refund; SDK timeout 60 s, `maxRetries` 2; usage tokens stored on the generation | Current API surface; refusals handled, never billed to the merchant |
| P89D-38 | **Data sent to AI** (Q356): product name, category, option names/values, merchant key points (≤ 10 × 200), tone/length/language, and the main product image only when `use_product_image` (default true; re-encoded JPEG ≤ 1,568 px, base64). **Never** customer, order, price-cost or staff data. Merchant text is data inside a delimited block; output is plain strings only | Minimum necessary; prompt-injection blast radius is the merchant's own copy |
| P89D-39 | **Image provider is open** (Q358, default in effect): `App\Domain\Ai\Photos\PhotoEditor` interface with `FakePhotoEditor` (copies the source onto the chosen solid background, flags `check_edges` on a seeded 10 %); real driver chosen later (candidates recorded in Q358), called through `SafeHttpClient` with a fixed host. Until a real driver is configured, the AI photos card is visible only with `AI_IMAGE_DRIVER=fake` outside production ("Coming soon" in production) | Ship the flow; don't guess a vendor |
| P89D-40 | **Plan gating** (Q344): Meta / GA4 / TikTok pixels on **every plan**; **`product_feeds`** (Starter, Growth) for Meta catalog + Google Merchant Center; **`server_side_tagging`** (Growth) for GTM server; AI tools on every plan with the credit allowance (P89D-33); Nagad on every plan. Downgrade: gated integrations pause (attention `plan_required`, no sync/forwarding), reads stay; writes 402 `feature_not_in_plan` | Pixels drive adoption; feeds and sGTM are the paid value |
| P89D-41 | **Permissions** (Q361, no new key): reads `integrations.manage \| marketing.manage`; writes, OAuth, test, sync-now, disconnect `integrations.manage`; AI generate / apply / undo / history `products.edit` (+ the AI tool on); AI on/off and settings `integrations.manage`; AI credits read `products.edit \| integrations.manage \| billing.view`, ledger `billing.view \| integrations.manage`; Nagad as 5b gateways (`integrations.manage`). Staff (S) has `products.edit` → can use the writer, not configure | Existing keys map cleanly |
| P89D-42 | **Impersonation**: every write → 403 `impersonation_read_only`; AI generation is a write (costs credits) | PHASE-8-1 rule |
| P89D-43 | **Dependency** (Q369): `anthropic-ai/sdk` is the only new package (exact pin ≥ 14 days old, `composer.lock`); no other SDKs — Meta, Google, TikTok, Nagad and the image provider are plain HTTP | Official SDK where one exists; small surface elsewhere |
| P89D-44 | **Nagad = third gateway** (Q352): `NagadGateway implements PaymentGateway` (5b), provider `nagad` in `payment_gateway_accounts`; credentials `merchant_id`, `merchant_number`, `merchant_private_key` (PEM RSA ≥ 2048, parsed with OpenSSL on save), `pg_public_key` (PEM); hint = merchant ID last 4; `checkCredentials` = sandbox/live **initialize** call for a throw-away order id (no money moves); test payment ৳10 sandbox / ৳1 live as 5b | Same checkout, links, refunds UI and state machine |
| P89D-45 | **Capabilities** (Q352): `PaymentGatewayAccount.capabilities` — bkash `refund, refund_partial, query`; sslcommerz `refund, refund_partial, query, webhook`; nagad `query, webhook` (+ `refund` only when `NAGAD_REFUNDS=true` after certification). `preauth`, `agreement` offered by no driver: Nagad page shows "Pre-authorise advance", "Agreement checkout", "Remember number" **greyed and off** ("Not offered by Nagad yet") | Honest UI from one source |
| P89D-46 | **Rule 8 for Nagad**: initialize (sensitive data RSA-encrypted with the PG public key, signed SHA256withRSA with the merchant key; headers `X-KM-Api-Version`, `X-KM-IP-V4`, `X-KM-Client-Type`) → complete → shopper redirected to Nagad → callback to the **signed API return URL** (`/payments/return/nagad/{payment}`, P5B-18) → API calls **Verify Payment** (`/verify/payment/{payment_ref_id}`) and applies the result only when status `Success` **and** amount = charge **and** `orderId` = payment id **and** BDT. Unclear → query again; `payments:expire` reconciles. Endpoint paths and signatures **VERIFY** against the Nagad sandbox before the QA gate | Redirects are never trusted |
| P89D-47 | **Nagad webhook** (Q353): `POST /webhooks/nagad/{route_key}` accepted as an **untrusted trigger** (no documented signature): stored in `webhook_events` (dedupe by `payment_ref_id` + status), then Verify Payment decides. Unknown route key 404, never 401 | Works if Nagad sends IPNs; safe if forged |
| P89D-48 | **Nagad refunds** (Q352): until certified, a gateway refund to Nagad → 422 `gateway_refund_unsupported` ("Refund in the Nagad merchant portal, then record a manual refund"); cancel-and-refund (P5B-25) defaults to off for Nagad | No guessed refund API |
| P89D-49 | **EPS, aamarPay, PayStation** (Q354) are later rows; their cards stay hidden; they will reuse the Nagad layout and this interface | Scope |
| P89D-50 | **Integrations list** (Q368): groups Payments (bKash, SSLCommerz, **Nagad**), Couriers, **Marketing & tracking** (Meta Pixel + CAPI, Google Analytics 4, TikTok Pixel, Google Tag Manager (server)) with the note "IDs and tokens only", **Sales channels** (Facebook & Instagram catalog, Google Merchant Center), Messaging (SMS), **AI for growth** (Claude product descriptions, AI product photos), Developer banner. Chips gain "Marketing & tracking", "Sales channels", "AI" | Figma `14:980`, `2136:1866` |
| P89D-51 | **Writer flow**: "Write with AI" in the product editor and on the Claude page `31:5788`; `POST /ai/product-descriptions` → 202 generation (queued) → poll every 1.5 s (stop after 2 min with a retry message) → variants shown → merchant picks one → it fills the editor fields (unsaved) | Async keeps requests short; the editor stays the save point |
| P89D-52 | **AI output is never auto-saved** (Q360): no endpoint writes AI text to a product; applying = the normal product update by the member | The merchant owns the copy |
| P89D-53 | **Output is built, not trusted**: the API turns `paragraphs` / `highlights` into rich-text HTML (`<p>`, `<ul><li>`) through the shared sanitizer; strings are stripped of control characters and markup, capped (paragraph 1,000, highlight 160, seo_title 70, meta_description 160) | No model-made HTML reaches a page |
| P89D-54 | **AI tools are integrations** (`ai_writer`, `ai_photos`): On/Off ("Turn off" instead of Disconnect) with settings; **default Off** (P89D-2); Off → 409 `ai_integration_off` | Merchants opt in to sending data to an AI provider |
| P89D-55 | **Costs** (Q357): description request = **1 credit** (1–3 variants), photo edit = **2 credits** (`config('ai.costs')`); 402 `ai_credits_exhausted` (details `needed`, `available`, `resets_at`) | Simple and predictable |
| P89D-56 | **Failures are free**: any `failed` generation refunds its credits (ledger `refund`, unique per generation); undoing an applied photo does not refund | Figma "Failed · free" |
| P89D-57 | **Photo edits** (Q359): operations `remove_background`, `replace_background` with **presets only** (`studio_white`, `soft_grey`, `warm_beige`, `pastel_pink`, `mint`, `transparent`) — no free-text prompts; source = a product image of this store (JPG/PNG/WebP ≤ 10 MB, ≥ 300 px); "the product itself is never redrawn" | Bounded output, no generated imagery |
| P89D-58 | **Results and undo**: the result is a private `media` row (purpose `ai_photo`, tenant prefix, re-encoded, EXIF stripped) until **Save to product** (`apply`: replaces the chosen image in place, else appends; result becomes a normal product image with variants); the original is **kept 30 days** for **Undo**, then pruned unless still used; unapplied results pruned after 7 days | Figma "keep originals 30 days" |
| P89D-59 | **Abuse limits**: `ai-generate` 20/min and 300/day per member; `integration-verify` 10/min, `integration-test` 10/min per store; `feed-sync-now` 1 per 10 min per feed; `tracking-beacon` 120/min per shopper IP + 6,000/min per host; `oauth-callback` 30/min per IP | Cost and provider-quota protection |
| P89D-60 | **Later rows** (Q363–Q367): Mailchimp sync, OpenAI/Gemini/BYO key, EPS/aamarPay/PayStation, pixel Events/Settings tab depth, mobile detail screens, test orders, bulk/auto photo edits, AI credit packs, TikTok PlaceAnOrder, more ad platforms | Recorded, not built |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q330–Q369)
**Answered 2026-11-28: proposed defaults accepted**, except Q346 and Q358 (**open — default in effect**) and the
record-only Q363, Q364, Q367 (open). Full rows in
OPEN-QUESTIONS.md; one line each here.

| Q | Topic | Default |
|---|---|---|
| Q330 | 8.9d scope and parts | A tracking + feeds, B Nagad + AI (P89D-1) |
| Q331 | Data model | One `store_integrations` table + child tables; payments stay (P89D-3) |
| Q332 | Which trackers | Meta Pixel + CAPI, GA4 + MP, TikTok + Events API, GTM server; IDs/tokens only (P89D-6) |
| Q333 | GTM web container | Rejected (rule 7); server container only (P89D-9) |
| Q334 | Browser events and mirroring | 4 events; Meta/TikTok mirror, GA4 never, GTM server-forwarded (P89D-10) |
| Q335 | Purchase/refund | Server-only, on confirm by default; refunds GA4 + GTM only (P89D-11, P89D-20) |
| Q336 | Dedupe | Shared ULID for browser+mirror; `purchase.{order}`, `refund.{payment}` (P89D-12) |
| Q337 | Customer data | Normalised + SHA-256; BD phone E.164 (P89D-13) |
| Q338 | Consent | Per-integration wait (default off) + Storeplix consent bar (P89D-14) |
| Q339 | Test & verify | Test event, 30-min test mode link; no test orders (P89D-19) |
| Q340 | Event log retention | 7 d delivered, 30 d failed, stats 90 d (P89D-18) |
| Q341 | Secret display | Write-only, last 4, "Replace" (P89D-7) |
| Q342 | Delivery retries | 5 attempts within 24 h; auth errors stop + flag (P89D-15, P89D-16) |
| Q343 | Outbound safety | Fixed hosts; GTM URL through the 8.9b guard, pinned (P89D-17) |
| Q344 | Plans | Pixels all; feeds Starter+; sGTM Growth; AI allowance (P89D-40) |
| Q345 | Meta catalog connection | OAuth + Catalog Batch API; app review is a deployment dependency (P89D-24) |
| Q346 | Google API | **Open — default in effect**: Merchant API (Content API sunset) (P89D-25) |
| Q347 | Item mapping | Variant per item, online-location stock (P89D-27, P89D-28) |
| Q348 | Sync cadence | Hourly full, 5-min deltas (≤ 15 min) (P89D-29) |
| Q349 | Item errors / Needs attention | Stored per item, grouped, attention reasons (P89D-30) |
| Q350 | Disconnect | Typed DISCONNECT; items stay at the provider (P89D-31) |
| Q351 | Site verification | Storeplix meta tag + claim; live store only (P89D-32) |
| Q352 | Nagad | Third gateway; capabilities; refunds manual until certified (P89D-44, P89D-45, P89D-48) |
| Q353 | Nagad notifications | Callback + webhook are triggers; Verify decides (P89D-46, P89D-47) |
| Q354 | Other BD gateways | EPS, aamarPay, PayStation later (P89D-49) |
| Q355 | AI text provider + model | Anthropic Claude, `AI_TEXT_MODEL` default `claude-opus-5-5`, effort medium (P89D-36) |
| Q356 | Data sent to AI | Product data + optional main image only (P89D-38) |
| Q357 | AI credits | Shared pool, Free 20 / Starter 300 / Growth 1,500 monthly + staff bonus; 1 text, 2 photo; failures free; no packs (P89D-33–35, P89D-55, P89D-56) |
| Q358 | Image provider | **Open — default in effect**: fake driver; vendor later (P89D-39) |
| Q359 | Photo operations | Remove/replace background, presets only (P89D-57) |
| Q360 | Saving AI output | Never automatic (P89D-52) |
| Q361 | Permissions | Existing keys (P89D-41) |
| Q362 | Storefront render data | Pixel IDs + site verification only (P89D-22) |
| Q363 | Mailchimp | Later |
| Q364 | OpenAI / Gemini / own key | Later |
| Q365 | Pixel Events / Settings tabs | Content on Overview + Event log tab; separate tabs later |
| Q366 | Mobile detail screens | Stack below `lg`; frames later |
| Q367 | Other later items | See "Out of scope" |
| Q368 | Integrations list groups | P89D-50 |
| Q369 | New dependency | `anthropic-ai/sdk` only (P89D-43) |

## 2. Permission and plan
No new permission key (P89D-41). Route map rows for every §13 route (O/A/S parity fixture): **Owner** ✓; **Admin**
has `integrations.manage`, `marketing.manage`, `products.edit`, `billing.view` → everything; **Staff** has `products.edit`
→ AI writer/photos (when On), history and credits summary only; the Integrations page shows staff no tracking/feeds.
Plans (P89D-40): `Feature::ProductFeeds = 'product_feeds'` (Starter, Growth), `Feature::ServerSideTagging =
'server_side_tagging'` (Growth), `Limit::AiCreditsPerMonth = 'ai_credits_per_month'` (Free 20, Starter 300, Growth
1,500) in `PlanSeeder` and a data migration updating existing plan rows (`2026_12_15_001000`). No external-API (API key)
scope reaches any route of this phase.

## 3. Data (owner API; forward-only; RLS in each create migration; `database/sql/rls-emergency-off.sql`)
Migrations prefix **`2026_12_15_`**. Nine new tables (**+9** to the `RlsTables::TENANT` count; part A six, part B three).
DATABASE-DESIGN §5.16 is the long form.

### 3.1 Part A
- **store_integrations** (`000100`, `[S]`): id · tenant_id · store_id · provider varchar(24) CHECK in the 8 values ·
  status varchar(16) CHECK `IN ('setup_required','connected','needs_attention','error','disconnected')` · settings jsonb
  · credentials text null (encrypted) · credentials_hint jsonb default `{}` · attention jsonb default `[]` ·
  token_expires_at null · last_verified_at null · last_error_code varchar(32) null · connected_by null FK users SET NULL ·
  connected_at null · disconnected_at null · revision int default 1 · timestamps. **U(store_id, provider)**;
  IX(tenant_id, provider, status). Row kept on disconnect (status `disconnected`, credentials null).
- **tracking_events** (`000200`, `[S]`): id · tenant_id · store_id · store_integration_id FK (tenant_id, …) CASCADE ·
  provider varchar(24) · event_name varchar(16) · provider_event_name varchar(40) null · event_id varchar(64) · channel
  varchar(8) CHECK `IN ('browser','server')` · source varchar(16) CHECK `IN ('browser_mirror','order','refund','test')` ·
  test bool default false · order_id char(26) null (soft ref) · payment_id char(26) null (soft ref) · page_path
  varchar(300) null · value_amount bigint null · currency char(3) null · status varchar(10) CHECK `IN ('pending',
  'retrying','delivered','failed','skipped')` · skip_reason varchar(24) null · attempts smallint default 0 ·
  next_attempt_at null · last_attempt_at null · http_status smallint null · error_code varchar(24) null · payload jsonb
  null (hashed data, IP, UA; nulled when final) · delivered_at null · timestamps. **U(store_integration_id, event_id,
  channel)**; IX(tenant_id, store_id, store_integration_id, created_at DESC, id DESC); partial IX(next_attempt_at) WHERE
  status IN ('pending','retrying'); IX(created_at) (prune).
- **tracking_daily_stats** (`000300`, `[S]`): id · tenant_id · store_id · store_integration_id FK CASCADE · date ·
  event_name · browser_count int · server_sent int · server_failed int · server_skipped int · last_at · **U(store_integration_id,
  date, event_name)**; upserted with `ON CONFLICT … DO UPDATE SET x = x + excluded.x`.
- **order_tracking_contexts** (`000400`, `[S]`): id · tenant_id · store_id · order_id **U** FK (tenant_id, order_id) →
  orders CASCADE · consent varchar(12) CHECK `IN ('granted','denied','not_required')` · fbp varchar(200) null · fbc
  varchar(500) null · ttp varchar(200) null · ttclid varchar(500) null · ga_client_id varchar(100) null · ga_session_id
  varchar(100) null · client_ip varchar(45) null · user_agent varchar(400) null · created_at. Written by checkout when
  `CheckoutInput.tracking` is present **and** the store has a tracking integration (else ignored).
- **catalog_sync_runs** (`000500`, `[S]`): id · tenant_id · store_id · store_integration_id FK CASCADE · kind CHECK
  `IN ('full','delta','manual')` · trigger CHECK (6 values) · status CHECK `IN ('running','done','partial','failed')` ·
  items_sent · items_failed · items_deleted int default 0 · error_code null · started_at · finished_at null.
  IX(tenant_id, store_integration_id, started_at DESC).
- **catalog_items** (`000600`, `[S]`): id · tenant_id · store_id · store_integration_id FK CASCADE · product_id char(26)
  · variant_id char(26) (soft refs: a deleted product must still be deleted remotely) · status CHECK `IN ('pending',
  'synced','error','excluded','deleting')` · review_status varchar(12) null CHECK `IN ('approved','in_review','limited',
  'disapproved')` · excluded_reason varchar(20) null · issues jsonb default `[]` · content_hash char(64) null · dirty_at
  null · last_synced_at null · timestamps. **U(store_integration_id, variant_id)**; IX(tenant_id, store_integration_id,
  status); partial IX(store_integration_id, dirty_at) WHERE dirty_at IS NOT NULL.

### 3.2 Part B
- **ai_credit_accounts** (`000700`, `[T]`): id · tenant_id **U** · bonus_balance int default 0 CHECK `>= 0` ·
  last_adjusted_at null · timestamps. Lazily created (`INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE`).
- **ai_credit_ledger** (`000700`, `[T]`, append-only: SELECT + INSERT policies only): id · tenant_id · type CHECK
  `IN ('consume','refund','admin_adjust')` · source varchar(10) null CHECK `IN ('allowance','bonus')` (null only for
  admin_adjust) · credits int (signed; CHECK consume < 0, refund > 0, admin_adjust ≠ 0) · bonus_after int CHECK `>= 0` ·
  period char(7) (`YYYY-MM`, store tz) · ai_generation_id char(26) null (soft ref) · reason varchar(500) null ·
  actor_type CHECK `IN ('system','user','platform')` · actor_user_id null FK users SET NULL · idempotency_key
  varchar(100) null · request_hash char(64) null · created_at. Partial **U(ai_generation_id, type) WHERE
  ai_generation_id IS NOT NULL**; partial **U(tenant_id, idempotency_key) WHERE type = 'admin_adjust'**;
  IX(tenant_id, period, type); IX(tenant_id, created_at DESC, id DESC).
- **ai_generations** (`000800`, `[S]`): id · tenant_id · store_id · kind CHECK `IN ('product_description','photo_edit')`
  · status CHECK `IN ('queued','running','succeeded','failed','applied','undone')` · product_id null FK (tenant_id, …) SET
  NULL · source_media_id null FK media SET NULL · result_media_id null FK media SET NULL · original_media_id null (kept
  for undo) · input jsonb · output jsonb null · credits smallint · charged_from varchar(10) null · refunded bool default
  false · provider varchar(24) · model varchar(64) null · usage jsonb null · flags jsonb default `{}` · error_code
  varchar(24) null · requested_by null FK users SET NULL · idempotency_key varchar(64) · request_hash char(64) ·
  finished_at · applied_at · undone_at · original_kept_until null · timestamps. **U(store_id, requested_by,
  idempotency_key)**; IX(tenant_id, store_id, kind, created_at DESC, id DESC).

### 3.3 Changed tables (`000900`)
- `payment_gateway_accounts.provider`, `payments.provider`, `webhook_events.provider` CHECKs + `nagad` (where CHECKs exist).
- `media.purpose` + `ai_photo` (`MediaPurpose::AiPhoto`: private until applied, no variants, never a library purpose).
- Plans data migration (`001000`): features/limits per P89D-40 / P89D-33.

### 3.4 Locking
AI charge: `ai_credit_accounts` row → insert generation + ledger (one transaction); never hold it while calling a
provider. Feed sync: tenant cache lock `feeds:{integration}`; item updates in batches without row locks across HTTP calls.
Tracking delivery: row claim `UPDATE … SET next_attempt_at = now() + lease WHERE id = ? AND status IN (…) AND
(next_attempt_at IS NULL OR next_attempt_at <= now())` (8.4 lease pattern). Integration writes: `revision` compare-and-set.

## 4. Registry (part A; `App\Domain\Integrations\*`, `routes/integrations.php`)

### 4.1 Read
`GET /stores/{store}/integrations` → `IntegrationSummary[]` in `INTEGRATION_PROVIDERS` order (absent = `not_connected`,
`summary` one line, `plan_required`, `attention`). `GET …/{provider}` → `StoreIntegration` (settings or null, `defaults`,
`credentials_hint`, `token_expires_at`, `attention`, `can`).

### 4.2 Write
`PUT …/{provider}` (tracking + AI only; feeds → 422 `integration_setup_required`): validate settings (P89D-4, P89D-6),
merge credentials field by field (omitted = keep), live-check tokens where the provider allows (Meta: `GET /{pixel_id}?
fields=name` with the token → `found_name`; TikTok: pixel lookup **VERIFY**, else format only; GA4: validation server
with a no-op event; GTM: `GET {tagging_url}/healthy` expecting 200 — a failure saves with attention
`endpoint_unreachable`, never blocks), status → `connected`. `PATCH` = partial settings with `revision`. Audits per
P89D-23.

### 4.3 Defaults
Meta / TikTok: `purchase_trigger order_confirmed`, `include_delivery_charge false`, `wait_for_consent false`,
`send_customer_data true`, `mirror_browser_events true`, `test_event_code null`. GA4: same + `send_refunds true`. GTM:
`events` all six, `send_customer_data true`, `wait_for_consent false`, `purchase_trigger order_confirmed`. Feeds:
`include all`, `hide_sold_out false`, `use_sale_price true`; Meta `default_brand null`; Google `feed_language bn`,
`condition new`. AI writer: `bn`, `friendly`, `medium`, `use_product_image true`. AI photos: `studio_white`, 30.

### 4.4 Status and attention
`connected` → `needs_attention` when any of `token_expiring`, `website_not_claimed`, `store_not_live`,
`items_with_issues`, `plan_required`, `endpoint_unreachable`, `delivery_failing`; → `error` on `token_invalid` /
`token_expired` or two consecutive failed feed runs for auth/account reasons. Recomputed after each delivery batch, sync
run, verify and nightly (`integrations:health`). Transitions into `error` email owner + admins once.

### 4.5 Verify `POST …/{provider}/verify` → `IntegrationCheck` rows (ok/warn/fail/skipped) per provider: ID format, token
valid, found name, server events in the last 24 h, consent setting, test code saved; feeds: token, account reachable,
website claimed, last run; AI: provider reachable (fake → ok).

### 4.6 Disconnect `POST …/{provider}/disconnect {confirm: 'DISCONNECT'}` — P89D-31; pending `tracking_events` →
`skipped` (`disabled`); feeds: revoke + delete local items; AI: `turned_off`, queued generations still finish.

## 5. Tracking (part A; `App\Domain\Tracking\*`)

### 5.1 Event names — `TRACKING_EVENT_NAMES` (types): Meta PageView / ViewContent / AddToCart / InitiateCheckout /
Purchase; GA4 and GTM the canonical names + `refund`; TikTok Pageview / ViewContent / AddToCart / InitiateCheckout /
CompletePayment. `null` = not sent.

### 5.2 Drivers `TrackingDriver::send(StoreIntegration, TrackingEvent): DeliveryResult` — `MetaCapiDriver`
(`POST graph.facebook.com/{version}/{pixel_id}/events`, `event_source_url`, `action_source website`, `user_data`
hashed + `client_ip_address`, `client_user_agent`, `fbp`, `fbc`), `Ga4MpDriver` (`POST /mp/collect?measurement_id&
api_secret`, `client_id` from `_ga` else random per order, `user_data` hashed, `transaction_id`), `TiktokEventsDriver`
(`POST business-api.tiktok.com/open_api/{version}/event/track/`, `event_source web`, `ttclid`, `ttp`), `GtmServerDriver`
(`POST {tagging_url}/mp/collect?measurement_id` GA4 MP body via `PublicEndpointGuard`), `FakeTrackingDriver`. API
versions in `config/tracking.php` (**VERIFY**). Error mapping → `TrackingErrorCode`; provider text redacted (tokens
removed) and only shown in the test result (≤ 200 chars).

### 5.3 Purchase (P89D-11, P89D-21): listener on the order status change (after commit) → for each tracking integration
of the store that is `connected|needs_attention`, whose trigger matches, and plan allows: insert `tracking_events`
(`source order`, `event_id purchase.{order_id}`, `ON CONFLICT DO NOTHING`), payload from the order + its
`order_tracking_contexts` (consent rule P89D-14) → dispatch.

### 5.4 Refund (P89D-20): listener on a refund payment reaching `succeeded` → GA4 / GTM rows `refund.{payment_id}` with
the refunded amount, only if `purchase.{order_id}` was delivered.

### 5.5 Checkout context: `CheckoutInput.tracking` (SF reads `_fbp`, `_fbc`, `_ttp`, `ttclid` from URL→cookie,
`_ga`, consent cookie, user agent, and sends the shopper IP via `X-Storefront-Client-Ip`) → `order_tracking_contexts`.
Invalid values are dropped, never 422 (checkout must not fail on tracking).

### 5.6 Event log `GET …/{provider}/events` (P89D-18): server rows and test browser rows; filters; 50, cursor;
`deduplicated` computed (browser + server rows share `event_id`); never exposes payloads.

### 5.7 Stats `GET …/{provider}/stats?days=7|30` from `tracking_daily_stats` (browser = beacon counts per provider for
events that provider receives; server sent/failed/skipped from deliveries); `delivery_rate` = sent / (sent + failed).

### 5.8 Test (P89D-19): `POST …/test-event` (synthetic event id `test.{ulid}`, `test: true`, never counted in stats);
`POST …/test-mode` → `{url: https://{primary_host}/?sp_test={token}, expires_at}` (token = signed `{store, integration,
exp}`; requires `test_event_code`); proxy turns it into the httpOnly `sp_track_test` cookie (30 min) like `sp_preview`.

## 6. Storefront (part A, owner SF)

### 6.1 Render (`components/tracking/**`, store layout): when `config.tracking` is non-null and `mode === 'live'`:
fixed loaders for each non-null ID (`next/script` `afterInteractive`; IDs re-validated with the type patterns; loader
code is ours and contains no merchant string except the ID via `JSON.stringify`); consent bar when `wait_for_consent`
and no `sp_consent` decision — loaders wait for Accept; `<meta name="google-site-verification">` from
`site_verification.google` (pattern-validated) in `generateMetadata`. Hosts allowed in CSP: `TRACKING_SCRIPT_HOSTS`
(SECURITY T47) — the storefront CSP (roadmap 9.4) must add them only for stores with that ID. Coming soon / preview /
`noindex` previews: nothing.

### 6.2 Beacon: browser helper `track(name, data)` fires the tag call (with `eventID` / `event_id`) and queues the same
event to `POST /api/t` (same origin, `navigator.sendBeacon`, batched ≤ 20, ≤ 1 per 2 s); the route handler adds the
cookie context (§5.5) and calls `client.storefront.tracking.events` server-to-server with the shopper IP. The API
validates, prices from the catalogue, counts, and mirrors (P89D-10, P89D-14). The beacon never blocks navigation; errors
are swallowed. `begin_checkout` fires once per checkout page view; `add_to_cart` after a successful add.

### 6.3 Test mode: `?sp_test=` handled in `proxy.ts` next to `?preview=` (strip param, set cookie, `no-referrer`).

## 7. Product feeds (part A; `App\Domain\Feeds\*`)

### 7.1 OAuth: `POST …/{provider}/oauth/start` (`product_feeds` required) → `authorize_url` (Meta: Facebook Login for
Business config id; Google: scopes `content` (Merchant API) and `siteverification`, `access_type=offline`,
`prompt=consent`); callback `GET /api/v1/integrations/oauth/{provider}/callback` (P89D-26) → row `setup_required` with
tokens → 303 to `/integrations/{provider}?oauth=success`.
### 7.2 Account: `GET …/accounts` (Meta: businesses' catalogs; Google: Merchant Center accounts), `PUT …/account` →
`connected`, first full sync (`connect`).
### 7.3 Drivers: `FeedDriver` (`upsertItems`, `deleteItems`, `fetchStatuses`, `accounts`, `claimWebsite`) —
`MetaCatalogDriver`, `GoogleMerchantDriver`, `FakeFeedDriver`.
### 7.4 Sync (P89D-29): `SyncCatalog` job (`TenantAware`, queue `feeds`): build items (P89D-27/28), content hash, send
changed in batches, delete excluded/removed, then fetch statuses (Meta batch status / Google product statuses) into
`review_status` + `issues`; run row counters. "Sync now" = `manual` run (P89D-59).
### 7.5 Read: `GET …/feed` (`FeedOverview`), `…/items` (filters, `counts`), `…/sync-runs`.
### 7.6 Website claim (P89D-32): `POST …/claim-website`, `website_claimed = true` on success; failure 422
`website_claim_failed` with `details.step` (`token`, `verify`, `claim`).

## 8. Integrations page (part A WEB; part B adds Nagad + AI)
Routes `/integrations/meta-pixel`, `/integrations/ga4`, `/integrations/tiktok`, `/integrations/gtm`,
`/integrations/meta-catalog`, `/integrations/google-merchant` (Figma routes; map to provider values), part B
`/integrations/payments/nagad`, `/integrations/claude`, `/integrations/ai-photos`. Shell from `28:2152` / `31:5120`.
Tabs: pixels Overview · Event log · Test & verify (GA4 "Events" table = stats; Settings content folded into Overview,
Q365); feeds Overview · Products · Sync history · Settings; AI Overview · History · Settings. Connect flow = TikTok
`2133:53731` three steps for every pixel. Disconnect dialog `2135:55831` everywhere. Empty/loading/error from
`148:34032`. Stack below `lg`; mobile list `2136:1866`.

## 9. Nagad (part B; `App\Domain\Payments\Gateways\NagadGateway`)

### 9.1 Account: `PUT /stores/{store}/payment-gateways/nagad` with `NagadCredentialsInput` (P89D-44); presenter adds
`capabilities`, `callback_url` (= the API return URL base for the merchant's onboarding papers).
### 9.2 Keys: PEM parsed and validated on save (RSA, ≥ 2048 bits; private key must decrypt a self-test); stored only in
`credentials`; hint = merchant ID last 4; `merchant_number` validated as a BD mobile.
### 9.3 Checkout: `initiate` = initialize + complete → `redirect_url` (Nagad `callBackUrl`); return
`/payments/return/nagad/{payment}` (signed) → `complete()` = Verify Payment (P89D-46); `query()` = Verify by
`payment_ref_id` (stored on the payment as provider reference). Timestamps `Asia/Dhaka` `YmdHis`, challenge 40 hex.
### 9.4 Webhook (P89D-47). ### 9.5 Refund (P89D-48). ### 9.6 Storefront: method label "Nagad", icon from the theme's
payment badges; `StorefrontCommerce.payment_methods` includes `nagad` when connected and enabled. Sandbox base URL
`https` only (`SafeHttpClient`); if the sandbox is http-only, certification runs on staging with
`NAGAD_SANDBOX_ALLOW_HTTP=true` (refused in production by a boot check).

## 10. AI credits (part B; `App\Domain\Ai\Credits\*`)

### 10.1 `GET /billing/ai-credits` → `AiCreditsSummary` (allowance limit/used/remaining/resets_at, bonus, available, costs).
### 10.2 `AiCreditCharger::charge(generation, cost)`: lock account → `remaining = limit − used(period)`; `remaining ≥
cost` → consume allowance; else `bonus ≥ cost` → consume bonus; else 402 `ai_credits_exhausted` (a request is paid
wholly from one source, as P89A-3). `refund(generation)`: one `refund` row with the same source; bonus balance restored
for bonus.
### 10.3 Ledger `GET /billing/ai-credits/ledger` — newest first, 50, cursor, `filter[type]`.
### 10.4 Admin: `GET /admin/tenants/{tenant}/ai-credits` (+ `/ledger`) `view_merchants`; `POST …/adjust`
`manage_billing` (P89D-35). ADMIN shows an "AI credits" card on the merchant detail page (allowance this month, bonus,
Adjust dialog like the 8.9a SMS credits dialog).

## 11. AI tools (part B; `App\Domain\Ai\*`, queue `ai`)

### 11.1 Turning on: `PUT /integrations/ai_writer|ai_photos` with settings → `connected` ("On"); disconnect = Off.
### 11.2 Writer: `POST /stores/{store}/ai/product-descriptions` (`ProductDescriptionInput`; `product_id` of this store or
`name` required) → idempotency check → charge 1 (§10.2) + generation `queued` (one transaction) → 202 →
`GenerateProductDescription` job → `ProductDescriptionWriter` (driver `anthropic` | `fake`) per P89D-36–38 → output
sanitized (P89D-53) → `succeeded`; error → `failed` + refund. Audit `ai.description_generated` (product id, language,
variants; never the text).
### 11.3 Photos: `POST /stores/{store}/ai/photo-edits` (P89D-57) → charge 2 → `EditProductPhoto` job → `PhotoEditor`
driver → result media `ai_photo` → `succeeded` (+ `check_edges`). `apply` / `undo` per P89D-58 (product image
order kept; `products.edit`; audit). Pruning: `ai:prune` daily (originals after 30 days unless referenced, unapplied
results after 7 days, outputs after 90 days).
### 11.4 History: `GET /ai/generations` (filters), `GET /ai/generations/{generation}`.

## 12. Jobs and schedule
`tracking:dispatch-due` (every minute), `tracking:prune` (daily), `feeds:sync` (hourly), `feeds:sync-deltas` (every 5
min), `integrations:health` (daily 03:00 Dhaka: token expiry, attention), `ai:prune` (daily). All tenant jobs
`TenantAware`; sweeps on `pgsql_admin` with `// cross-tenant: <reason>` and dispatch per tenant. Queues `tracking`,
`feeds`, `ai` added to Horizon config with conservative concurrency (tracking 5, feeds 2, ai 3).

## 13. API surface and errors (openapi 1.27.0 binding)

### 13.1 Merchant (`routes/integrations.php`, `routes/ai.php` + include lines; merchant group; `{store}` scoped)
| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/stores/{store}/integrations` | `integrations.manage\|marketing.manage` (AI rows: + `products.edit`) | §4.1 |
| GET · PUT · PATCH | `/stores/{store}/integrations/{provider}` | GET read · PUT/PATCH `integrations.manage` | §4.1–§4.2 |
| POST | `…/{provider}/disconnect` · `/verify` | `integrations.manage` · read | §4.5–§4.6 |
| POST | `…/{provider}/test-event` · `/test-mode` | `integrations.manage` | §5.8, tracking only |
| GET | `…/{provider}/events` · `/stats` | read | §5.6–§5.7 |
| POST | `…/{provider}/oauth/start` | `integrations.manage` | §7.1, feeds only |
| GET · PUT | `…/{provider}/accounts` · `/account` | `integrations.manage` | §7.2 |
| GET | `…/{provider}/feed` · `/sync-runs` · `/items` | read | §7.5 |
| POST | `…/{provider}/sync` · `/claim-website` (google_merchant) | `integrations.manage` | §7.4, §7.6 |
| GET | `/integrations/oauth/{provider}/callback` | public, signed state | §7.1 |
| POST | `/storefront/tracking/events` | storefront key | §6.2 |
| PUT … | `/stores/{store}/payment-gateways/nagad` (+ existing PATCH/DELETE/test-payment) | 5b | §9 |
| GET · POST | `/payments/return/nagad/{payment}` · `/webhooks/nagad/{route_key}` | public | §9.3–§9.4 |
| GET | `/billing/ai-credits` · `/billing/ai-credits/ledger` | §10 | |
| POST | `/stores/{store}/ai/product-descriptions` · `/ai/photo-edits` | `products.edit` | 202, Idempotency-Key |
| GET | `/stores/{store}/ai/generations` · `/{generation}` | `products.edit` | §11.4 |
| POST | `/stores/{store}/ai/photo-edits/{generation}/apply` · `/undo` | `products.edit` | §11.3 |
| GET · POST | `/admin/tenants/{tenant}/ai-credits` (+ `/ledger`, `/adjust`) | `view_merchants` · `manage_billing` | §10.4 |

### 13.2 Error codes (new)
`integration_id_invalid`, `integration_code_pasted` (422, details `{field}`), `integration_credentials_invalid`,
`integration_not_connected`, `integration_setup_required` (422/409), `integration_endpoint_blocked` (422),
`confirmation_mismatch` (422, shared with 8.9b), `store_not_live` (409), `feed_sync_in_progress` (409),
`oauth_state_invalid` (callback reason), `website_claim_failed` (422, details `{step}`), `tracking_test_failed`,
`ai_credits_exhausted` (402, `AiCreditsExhaustedDetails`), `ai_integration_off` (409), `ai_generation_not_applicable`
(409), `ai_credits_insufficient` (422, admin), `gateway_refund_unsupported` (422). Existing: `validation_failed`,
`revision_conflict`, `feature_not_in_plan`, `provider_unavailable`, `idempotency_key_mismatch`,
`impersonation_read_only`, `rate_limited`, `not_found`.

## 14. Audit and security

### 14.1 Audit actions — `INTEGRATION_AUDIT_ACTIONS` (types). Meta holds field names, hints, ids and counts; never
tokens, keys, hashed customer data, AI text or provider payloads.

### 14.2 Security checklist (S330–S349; each has a test)
- **S330** isolation: integrations, events, stats, contexts, runs, items, generations of another tenant/store → 404;
  RLS on all nine tables; `assertTenantIsolation` + `assertStoreIsolation` (integrations, events, items, generations),
  `assertTenantIsolation` (AI credits); ids in bodies (`product_id`, `media_id`, `category_ids`, `variant_id` in the
  beacon) resolved within the store.
- **S331** rule 7: no setting accepts markup (`integration_code_pasted`); storefront static test — tracking components
  insert only validated IDs; no `dangerouslySetInnerHTML` with integration data; GTM web container impossible to configure.
- **S332** secrets: tokens, API secrets, OAuth tokens, Nagad keys never in responses, logs, audit, exceptions, job
  payloads, event-log rows or Playwright traces (static + log-scan tests); hints only; encrypted at rest; key rotation
  command covers `store_integrations.credentials`.
- **S333** storefront render data: `StorefrontConfig.tracking` contains only the allowed fields; null for draft and
  preview; no test code or tagging URL.
- **S334** SSRF: GTM URL rules (https, 443, no IP literal, no local names, public resolution, pin, no redirects) on save
  and send; DNS-rebind test; every other host comes from config.
- **S335** beacon: storefront key required; shopper IP limiter; ≤ 20 events; browser prices ignored; unknown ids
  dropped; draft store 404; consent respected (no mirror without consent when waiting).
- **S336** dedupe and idempotency: one server event per (integration, event_id, channel) under replays and races
  (Postgres race test with the same order confirmed twice).
- **S337** privacy: hashing formats per provider; raw email/phone never in `tracking_events`; payload nulled when
  final; IP/UA pruned per P89D-18; no tracking context stored for stores without tracking.
- **S338** auth failures: 401 → stop, flag, email once; no retry storm.
- **S339** OAuth: state signed, bound, single-use, 10-min expiry; code exchange server-side; redirect only to the merchant
  app origin; tokens encrypted; revoke on disconnect.
- **S340** feeds: only included, published products; links on the primary host; provider text escaped; feed of store A
  never contains store B items.
- **S341** permissions: route map O/A/S/C; impersonation 403 on writes; plan 402 on gated writes; staff cannot configure.
- **S342** Nagad (rule 8): paid only after Verify with amount, currency and order id match; callback/webhook bodies are
  triggers; signed return URLs; duplicate callbacks → one transition; keys never logged.
- **S343** AI credits: allowance then bonus; never below 0 (CHECK + lock); consume/refund once per generation; 20 parallel
  requests with credits for 10 → exactly 10 charged (Postgres race); failures refunded.
- **S344** AI data: request payload contains only P89D-38 fields (driver contract test); no customer/order data.
- **S345** AI output: sanitized HTML only; caps enforced; never auto-saved; refusal handled.
- **S346** photos: source must be this store's product image; sniffed MIME, size caps; results private until applied;
  presets only; originals pruned on schedule.
- **S347** admin AI adjust: `manage_billing`, idempotent, reason, audited, cross-tenant marker.
- **S348** abuse limits (P89D-59) on generate, verify, test, sync-now, beacon, callback.
- **S349** opt-in: a store with nothing connected renders byte-identical storefront HTML (no consent bar, no scripts)
  and stores no tracking context.

## 15. ARCH and types (owner ARCH — done in this change)
openapi **1.27.0** (§13; changelog notes the jump from 1.25.0). `packages/types`: integrations block (providers, kinds,
statuses, attention, ID patterns + `looksLikePastedCode`, event names map, settings per provider, credentials map,
`StoreIntegration`, `IntegrationSummary`, check, test, log, stats, `StorefrontTrackingConfig`, beacon + checkout context,
`TRACKING_SCRIPT_HOSTS`, feed types, AI credits + generations, errors, audit actions); edits: `FeatureKey` +
`product_feeds`, `server_side_tagging`; `LimitKey` + `ai_credits_per_month`; `GatewayProvider` / `PaymentMethod` +
`nagad`; `PaymentGatewayAccount.capabilities?`, `callback_url?`; `NagadCredentialsInput`; `StorefrontConfig.tracking?`;
`CheckoutInput.tracking?`. `packages/api-client`: `integrations.*` (+ `tracking.*`, `feeds.*`), `ai.*`,
`billing.aiCredits.*`, `storefront.tracking.events`, `admin.aiCredits.*`, queries `trackingEventQuery`,
`catalogItemQuery`, `aiGenerationQuery`, `aiCreditLedgerQuery`; tests `phase8-9d.test.ts`.
**Known compile breaks for builders** (first commit of each): WEB `src/__tests__/phase7.fixtures.ts` (new limit and
feature keys); SF `lib/payments.ts`, `app/(store)/cart/page.tsx`, `themes/modern-commerce/commerce/checkout-form.tsx`,
`themes/modern-commerce/footer.tsx` (`nagad` entries in `Record<PaymentMethod, …>`); WEB `payments/gateways.ts` if it
keys by `GatewayProvider`. Super-admin compiles unchanged.

## 16. Test requirements
**API (Pest)** groups `integrations`, `tracking`, `feeds`, `nagad`, `ai` (+ `rls`, `security`, `race`): every §13 route
(happy, validation, authz matrix, impersonation, plan, isolation); ID validation + pasted-code vectors; credential merge
and hints; verify per provider with fakes (`Http::fake`); purchase trigger matrix (placed/confirmed/delivered,
cancelled, POS excluded), refund rules, consent matrix, hashing vectors (incl. Meta digits-only phone), retry schedule +
lease + auth stop + attention + email once; GTM guard + rebind; beacon pricing and counting; retention prune; OAuth state
(tamper, expiry, reuse), token refresh, account choice, sync full/delta/manual, inclusion/exclusion, deletes, issues,
attention, website claim steps, disconnect; Nagad initialize/complete/verify with recorded fixtures (signature and
encryption with test keys), mismatch vectors, webhook trigger, refunds unsupported, reconcile; AI charge order,
exhaustion, idempotent replay, refund on failure/refusal, sanitizer, apply/undo, prune; Anthropic driver contract test
(payload fields, model from config, no temperature/thinking, fallbacks beta) with the SDK's HTTP mocked; S330–S349.
**Web (Vitest)**: list groups/chips/plan badges; pixel connect steps with pasted-code error; "Replace" secret field;
event log filters + polling in test mode; feed OAuth return handling, account chooser, items/issues, sync now; disconnect
dialog typing; Nagad page with greyed capabilities; AI writer modal (queued → variants → fill editor), credits
exhausted state, photos before/after + apply/undo; admin AI credits card + adjust dialog (ADMIN).
**SF (Vitest)**: loaders render only for valid IDs and live mode; consent bar gating; beacon batching; checkout context
from cookies; site-verification meta; test-mode param → cookie; byte-identical output with no config (S349).
**QA (Playwright)** `phase8-9d-a.spec.ts` (fakes): connect Meta pixel with a pasted snippet (error) then the ID; storefront
shows the tag; place + confirm an order → event log shows `purchase` delivered once; test mode link; GA4 Replace secret;
GTM blocked URL; feed connect (fake OAuth) → items + an issue → Needs attention → disconnect typed; `phase8-9d-b.spec.ts`:
Nagad fake checkout paid only after verify; AI writer fills the editor and spends 1 credit; exhausted credits; photo apply
+ undo; admin grants bonus credits; 390 px screenshots of the list and one detail page.

## 16.1 File ownership

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: `app/Domain/Integrations/**` (registry, settings DTOs, `PublicEndpointGuard`, OAuth, presenters, policies, requests, health), `app/Domain/Tracking/**`, `app/Domain/Feeds/**`, `app/Domain/Ai/**`, `app/Domain/Payments/Gateways/NagadGateway.php` + gateway registration, presenter capabilities, return/webhook routes, `Sms/Providers/SmsEndpointGuard.php` (delegate), listeners in Orders/Payments/Catalog/Inventory (hook lines only), checkout context write, storefront config presenter (`tracking`), `Billing/Feature.php`, `Limit.php`, `PlanSeeder.php`, `Media/MediaPurpose.php`, `routes/integrations.php`, `routes/ai.php` + include lines, migrations `2026_12_15_*`, `config/{tracking,feeds,ai}.php`, `config/payments.php` (nagad), `resources/ai/**`, mail views, `RlsTables`, `rls-emergency-off.sql`, `composer.json/lock` (`anthropic-ai/sdk`), console schedule, Horizon queues, tests |
| **WEB** | `apps/merchant-dashboard/**`: `src/integrations/**` (list groups, pixel, GTM, feed, AI pages, disconnect dialog), `src/payments/**` (Nagad), product editor "Write with AI" + photo tools, `App.tsx` routes, fixtures/tests |
| **SF** | `apps/storefront/**`: `components/tracking/**`, consent bar, `app/api/t/route.ts`, `lib/tracking-*.ts`, store layout mount + metadata, `proxy.ts` (`sp_test`), checkout tracking context, Nagad labels/icons, tests |
| **ADMIN** | `apps/super-admin/**`: merchant detail "AI credits" card + adjust dialog + ledger (part B only) |
| **ARCH** | `docs/**` except `docs/reviews/**`, TESTING.md; `packages/types/**`, `packages/api-client/**` (done) |
| **QA** | `tests/e2e/**` (`phase8-9d-*.spec.ts`), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-9d-*.md` |
Shared-read: re-read `routes/api.php`, `PaymentService.php`, `OrderService.php`, `ProductService.php`,
`InventoryService.php`, the store layout and `proxy.ts` before each Edit.

## 16.2 Order of work
1. ARCH: types + client + openapi (done), this file, ADR 0030, docs.
2. **Part A** — API: migrations `000100`–`000600` + RLS → registry + settings + credentials → tracking drivers,
   listeners, delivery, beacon, log/stats/test → `PublicEndpointGuard` → feeds OAuth, drivers, sync, claim → plans.
   WEB: list groups → pixel pages → GTM → feed pages. SF: config + loaders + consent + beacon + checkout context +
   meta + test mode. QA gate A.
3. **Part B** — API: migrations `000700`–`001000` → Nagad driver + routes → AI credits → writer (fake, then Anthropic) →
   photos (fake). WEB: Nagad page → AI writer → AI photos. SF: Nagad method. ADMIN: AI credits card. QA gate B.

## 17. Acceptance criteria
1. A shop that connects nothing sees no change (storefront HTML identical, no tracking rows); all existing tests pass
   with fixture/enum additions only.
2. Pixels accept IDs and tokens only; pasted code is refused; the storefront loads only Storeplix templates; GTM web
   containers cannot be configured.
3. A confirmed order produces exactly one server purchase per connected tracker, hashed and deduplicated, retried up to
   5 times in 24 h, visible in the event log; refunds reach GA4/GTM; consent is respected.
4. Feeds connect by OAuth, sync hourly with price/stock deltas inside 15 minutes, show item issues and Needs attention,
   claim the website without pasted code, and disconnect with a typed confirmation.
5. Shoppers can pay with Nagad; an order is paid only after server-side verification; unsupported features are greyed.
6. Members write descriptions with Claude (model from config) and edit photos with presets; credits come from the plan
   allowance then bonus, are charged once, refunded on failure; staff can grant bonus credits.
7. S330–S349 pass; Figma `2132:53511`, `2133:53731`, `2133:54292`, `2134:64916`, `2134:65506`, `2135:55626`,
   `2134:66100`, `2135:55033`, `2134:67228`, `2136:1866` match with §18 differences; loading/empty/error; 390 px usable.
8. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`), Playwright `phase8-9d-*` green;
   `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes.

## 18. Figma notes for the PO
- GA4 API secret "Show" → **Replace**; every secret shows `••••` + last 4.
- GTM "Web containers aren't supported" card stays (by design); no web container field exists.
- Meta "Test events": "Place a test order" step is hidden (no test orders, Q339); "Deduplicated" means our browser and
  server copies share an event id.
- TikTok "Events we'll send": PlaceAnOrder row hidden; purchase = CompletePayment from the server.
- Pixel "Events" and "Settings" tabs: Overview + Event log + Test & verify (Q365).
- Google Merchant Center uses the Merchant API (Q346); the "Content API" label is not shown.
- AI photos: provider select shows only "Storeplix AI" (OpenAI / Gemini later, Q364); "Auto-edit new uploads" and
  "Edit photos in bulk" hidden (Q367); card "Coming soon" in production until an image provider is chosen (Q358).
- Nagad: Pre-authorise advance, Agreement checkout and Remember number greyed "Not offered by Nagad yet"; Refunds shows
  "Refund in the Nagad portal" until certified.
- Consent bar (not drawn) appears only for shops that turn on "Wait for cookie consent"; it uses existing tokens.

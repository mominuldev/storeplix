# Development Roadmap

Phases are sequential; tasks within a phase may run in parallel by owner. Each task is done only when its acceptance
criteria (AC) and the Definition of Done (CLAUDE.md) are met. Figma ids refer to `docs/design/FIGMA-INDEX.md`.
Owners: **ARCH** architecture/docs · **API** Laravel · **WEB** React SPAs + packages · **SF** Next.js storefront · **QA** CI/infra/E2E.

## Phase 0 — Architecture ✅ (this document set)
| # | Task | Owner | AC |
|---|---|---|---|
| 0.1 | CLAUDE.md, architecture docs, ADR 0001–0010 | ARCH | Files exist, consistent with AGENT-CONTRACTS |
| 0.2 | API conventions + openapi.yaml (Phase 1) | ARCH | YAML parses; matches `packages/types` |
| 0.3 | Open questions logged | ARCH | OPEN-QUESTIONS.md reviewed by PO |

## Phase 1 — Foundation
| # | Task | Owner | AC |
|---|---|---|---|
| 1.1 | Laravel skeleton, Postgres/Redis config, envelope exception handler, `/health` | API | `GET /api/v1/health` returns contract shape; 404/500 use error envelope |
| 1.2 | Tenancy core: `TenantContext`, `TenantScope`, `BelongsToTenant`, `ResolveMerchantTenant`, `ResolveStorefrontTenant`, job middleware, `TenantCache`, `TenantStorage` | API | Unit tests: scope fail-closed, auto-fill, mismatch rejected; job context restored |
| 1.3 | Migrations: users, tenants, tenant_users, stores, store_domains, store_settings, themes, store_themes, media | API | Composite FKs and unique constraints per DATABASE-DESIGN; `migrate:fresh --seed` works |
| 1.4 | Auth: register/login/logout/me (Sanctum) + rate limit | API | Contract responses; 422/401/429 tests |
| 1.5 | `GET /storefront/config` with host+key validation | API | 200 for `demo.localhost`; 401 bad key; 404 unknown host |
| 1.6 | Dev seed per contract | API | demo user can log in; both demo hosts resolve |
| 1.7 | `@storeplix/config` (tsconfig, eslint, Tailwind preset from Figma Foundations 127:19, 128:131, 128:221) | WEB | Tokens match FIGMA-INDEX core tokens |
| 1.8 | `@storeplix/api-client` (fetch wrapper, envelope unwrapping, ApiError class, Bearer + X-Tenant-Id) | WEB | Unit tests for success/error/401 |
| 1.9 | `@storeplix/ui` base: Button, Input, Card, Badge, Spinner, EmptyState (Components page 2:3) | WEB | Visual match to Figma components |
| 1.10 | Merchant SPA shell: login/register pages, auth state, protected layout (Onboarding 43:13544 sign-in screens) | WEB | Can register/login against API at :8000; logout clears token |
| 1.11 | Super-admin shell: login + empty dashboard (Platform Admin 5:189) | WEB | Runs on :5174 |
| 1.12 | Storefront skeleton: host middleware, `lib/api.ts`, config fetch, `classic` theme stub, not-found page | SF | `demo.localhost:3000` renders store name + primary color from API; unknown host → 404 |
| 1.13 | Docker Compose (postgres, redis, minio, mailpit, api), CI (lint, typecheck, test, build) | QA | `docker compose up` + all apps talk; CI green on main |
| 1.14 | Cross-tenant test harness `assertTenantIsolation` | API/QA | Used by at least store/domain tests |

## Phase 1.1 — PO decisions D1–D4 (AGENT-CONTRACTS "Phase 1.1 contract additions")
Onboarding screens are Figma page `43:13544` (ids below). Only the screens listed here are built now; the rest are
mapped to later phases and must be omitted or shown disabled. Don't fake them.
| # | Task | Owner | AC |
|---|---|---|---|
| 1.1.1 | Store scoping plumbing (one store per tenant kept: `UNIQUE(stores.tenant_id)`): `(tenant_id, id)` unique on stores, `StoreContext` + `BelongsToStore` + `store` middleware | API | Foreign `{store}` → 404; second store → 409 `store_limit_reached` |
| 1.1.2 | `GET /stores`, `POST /stores` (name your shop) + platform subdomain row | API | Slug regex/reserved/global unique; store created `draft` |
| 1.1.3 | Sign up 01 `46:8583` / M1 `53:758`; sign in L1 `57:911` / L5 `58:1132` | WEB | Matches Figma desktop + mobile |
| 1.1.4 | Forgot password L3 `57:1198` (UI) + `POST /auth/forgot-password` stub → always 202 | WEB/API | Same response for known/unknown email; throttled |
| 1.1.5 | Post-login routing: 0 tenants with a store → Name your shop 03 `48:7869` / M3 `53:885`; 1 → open; > 1 memberships → Choose a shop L4 `58:957` (picks the tenant); tenant switcher kept, no store switcher | WEB | Query keys `[tenantId, storeId, …]` |
| 1.1.6 | Coming soon for draft stores + preview token flow (STOREFRONT-ENGINE §4.1) | API/SF/WEB | SECURITY T21/T22 tests pass; preview banner shown |
| 1.1.7 | Token expiry 7 days, `expires_at`, prune schedule; SPA 401/expiry logout to sessionStorage | API/WEB | Expired token → 401 → login with "session expired" message |

## Phase 2 — SaaS foundation (tenants, stores, onboarding, roles)
Binding API/type contract: `docs/development/PHASE-2-CONTRACT.md` (tasks 2.1, 2.3, 2.5–2.9; 2.4 blocked on Q16).
| # | Task | Owner | AC |
|---|---|---|---|
| 2.1 | Extend store creation (business category, country, currency) + real forgot/reset password email | API/WEB | Reset token 60 min single-use; audit row |
| 2.2 | Tenant switcher (memberships from `/auth/me`) | API/WEB | User with 2 tenants switches; query cache keyed by tenant + store |
| 2.3 | Staff invites + roles owner/admin/staff (ADR 0005 matrix) | API/WEB | Policies tested per role; Staff & roles basic list (89:26676) |
| 2.4 | **Phone OTP**: SMS provider driver (`SmsGateway` interface), Verify phone 02 `46:8705` / M2 `53:831`, SMS sign-in L2 `57:1050`. **Blocked on OPEN-QUESTIONS Q16 (SMS provider)** | API/WEB | OTP 6 digits, 5-min TTL, hashed, 5 attempts, resend 60 s, per-phone + per-IP limits |
| 2.9 | Onboarding checklist shell (steps 04–08 as Checklist items `45:8102`, enabled as their phases land) | WEB | Resumable; incomplete steps link to the right screen |
| 2.5 | Store settings API + Settings screens (60:11161, 148:33261 Account) | API/WEB | Validation + audit log rows |
| 2.6 | Media upload pipeline (ADR 0009) | API | MIME sniffing, size caps, tenant path, variants job |
| 2.7 | Plans table + trial subscription on tenant creation (no payment yet) | API | 14-day trial row; FeatureGate helper with tests |
| 2.8 | Audit log writer + viewer endpoint | API | Security-relevant actions logged |

## Phase 3 — Storefront engine
| # | Task | Owner | AC |
|---|---|---|---|
| 3.1 | Theme registry, Zod schemas, JSON Schema export, CI sync check | SF/API | Invalid config → 422 on save, fallback on render |
| 3.2 | Theme config API: get/put draft, publish, preview token | API | Draft vs published separation tested |
| 3.3 | `modern-commerce` ("Gallery") theme 1.1: layout + 10 home section types per Storefront 1:9207 / 2:6 (PHASE-3-CONTRACT §4.3) | SF | Matches Figma desktop + mobile; Lighthouse mobile ≥ 90 |
| 3.4 | Theme editor UI (Online store **V3** 2028:44400, see PHASE-3-CONTRACT) with live preview iframe | WEB | Edit → preview updates; publish revalidates storefront in < 5 s |
| 3.8 | Onboarding 04 Pick a theme `48:8119` / M4 `54:810` | WEB | Selection writes `store_themes`; preview link works |
| 3.5 | Revalidation endpoint + Laravel listener | API/SF | Tag revalidation test |
| 3.6 | Pages + navigation API/UI | API/WEB/SF | Custom page renders; sanitized HTML |
| 3.7 | SEO: metadata, sitemap, robots, JSON-LD, canonical | SF | Validators pass (Rich Results test fixtures) |

## Phase 4 — Merchant dashboard (catalog & ops UI) ✅
Binding API/type contract: `docs/development/PHASE-4-CONTRACT.md` (4.7 is a strictly ordered sub-step that ships last, §7.6).
**Done 2026-11-22:** QA verdict PASS (`docs/reviews/phase-4-qa.md`, no Critical/High/Medium findings); committed as
`a0633f4`. All tasks 4.1–4.9 shipped, 4.7 as cookie sessions only (Bearer removed).
| # | Task | Owner | AC |
|---|---|---|---|
| 4.1 ✅ | Categories CRUD | API/WEB | Tree depth ≤ 3; isolation tests |
| 4.2 ✅ | Products + variants + images CRUD (Products 60:8983) | API/WEB | Simple/variable, SKU uniqueness per tenant, images ordered |
| 4.3 ✅ | Inventory list + adjustments + movements ledger (Inventory 26:2146, single location) | API/WEB | Atomic adjustments, ledger rows |
| 4.4 ✅ | CSV product import/export (queued) | API/WEB | 5 000 rows < 2 min; formula-injection safe |
| 4.5 ✅ | Customers list/detail (61:12478) | API/WEB | Search by phone/email |
| 4.9 ✅ | Onboarding 05 Add first products `50:312` / M5 `54:941` (quick-add + CSV) | WEB | Product created in active store |
| 4.6 ✅ | Dashboard home KPIs (26:2144) — read models only | API/WEB | Empty/loading/error states (148:34032) |
| 4.7 ✅ | Migrate SPA auth to cookie-based Sanctum (ADR 0005) | API/WEB | Token no longer in JS storage; contract updated |
| 4.8 ✅ | Mobile merchant layouts (2:5) | WEB | Key screens responsive per Figma |

## Phase 5 — Commerce (cart, checkout, orders, payments, shipping)
Binding contracts: `docs/development/PHASE-5-CONTRACT.md` (5a) and `docs/development/PHASE-5B-CONTRACT.md` (5b).
**Status 2026-11-22:** 5a shipped; all five 5b increments built and QA-gated (5b-2/5b-3 on fake drivers only) and
**merged to `main`** (PR #1, `phase-5b-online-money`, merged 2026-11-22 with CI green on every job, including `api-rls`
and `api-documents`). Phase 5 closes after the two remaining blockers under "5b" below (sandbox certification, small WEB
gaps); Phase 6 started from `main` @ 7ad4a05 in parallel, since neither blocker touches domains. Split into two build cycles (P5-1, Q31 accepted by the PO
2026-11-22); see "Phase 5 cycles" below the table. The AC column is the original roadmap AC; where 5a narrows it
(e.g. "merge on login", stock "reservation" → commitment), the contract wins.
| # | Task | Owner | AC |
|---|---|---|---|
| 5.1 | Storefront catalog APIs (products, categories, search, availability) | API/SF | PLP/PDP render; cost never exposed |
| 5.2 | Cart API + cart UI | API/SF | Token cookie; prices recomputed; merge on login |
| 5.3 | Shipping methods (inside/outside Dhaka, free-over) | API/WEB | Rules unit-tested |
| 5.4 | Coupons (Marketing 61:12479 — coupons only) | API/WEB | Usage limits enforced transactionally |
| 5.5 | Checkout (idempotent, stock reservation, COD) | API/SF | Concurrency test no oversell; replay returns same order |
| 5.6 | Payment abstraction + bKash + SSLCommerz drivers + webhooks | API | Forged redirect/amount/replay tests pass |
| 5.7 | Orders list/detail/actions, status history (41:12363, 41:12364) | API/WEB | State machine enforced; refunds |
| 5.8 | Courier abstraction + Pathao/Steadfast/RedX (Integrations 32:5329, 32:5330; Shipments 41:12365) | API/WEB | Consignment create + status sync job |
| 5.9 | Invoice & label templates (44:16156) — JSON-configured PDFs | API/WEB | Printable A4 invoice + label |
| 5.10 | Enable Postgres RLS (MULTI-TENANCY §9) | API/QA | Isolation suite passes with RLS on |
| 5.11 | Transactional email/SMS (order confirmation) | API | Tenant-branded; queued |
| 5.12 | Onboarding 06 Delivery `50:604` (shipping methods + courier connect cards `45:8086`) and 07 Get paid `52:564` (COD/bKash/SSLCommerz connect) | WEB/API | Uses 5.3/5.6/5.8 APIs |
| 5.13 | Onboarding 08 You're live `52:765`: publish store (draft → active) with go-live checklist | API/WEB | Publish revalidates host; Coming soon disappears; platform URL shown |

### Phase 5 cycles
**5a — Sell with cash on delivery** ✅ (PHASE-5-CONTRACT §0–§15, binding; built on branch `phase-5-commerce`, QA review
`docs/reviews/phase-5a-qa.md`; shipped to `main`, which 5b branched from at `ffc3bf0`):
| Task | 5a scope |
|---|---|
| 5.1 | Storefront catalog API + PDP `/products/{slug}`, PLP `/c/{slug}`, search, categories, availability (no cost/SKU/exact stock) |
| 5.2 | Server-side guest cart (token in `sp_cart`, sha256 at rest), coupon preview, free-delivery progress. "Merge on login" moves to whenever accounts ship (Q14) |
| 5.3 | Shipping **zones** (districts/thanas, one charge and delivery time each, undeletable "Outside Dhaka" fallback), store-wide free-delivery threshold, pickup locations; BD geo dataset `GET /geo/bd` |
| 5.4 | Coupons: percentage (cap), fixed, free delivery; usage enforced in the checkout transaction |
| 5.5 | Idempotent COD checkout: stock **commitment** (`inventories.committed`), price-change guard, order numbers |
| 5.7 | Orders: list/detail, manual orders, edits (contact/address/note/tags), state machine, manual shipping details, COD tracking, **manual** refunds |
| 5.11 | Order SMS (REVE, Bangla default) + shopper/merchant email, per-event toggles, monthly SMS allowance |
| 5.12 (part) | Onboarding 06 delivery charges + pickup address; 07 cash on delivery. Courier and gateway connect cards shown disabled |
| 5.13 | Launch checklist, `POST /stores/{store}/publish`, onboarding 08 "You're live" |

**5b — Online money and couriers.** Binding contract: `docs/development/PHASE-5B-CONTRACT.md` (2026-11-22; PO
accepted the Q45–Q63 defaults the same day). Branch `phase-5b-online-money`. Built in five increments, each with its
own QA gate (`docs/reviews/phase-5b-*-qa.md`). Status on 2026-11-22:
| Increment | Task | 5b scope | Status |
|---|---|---|---|
| 5b-1 Isolation | 5.10 + limiter | **Postgres RLS first**: `storeplix_app` without BYPASSRLS, `FORCE ROW LEVEL SECURITY` on every tenant table (52 after 5b-3), definer functions / `pgsql_admin` for pre-tenant paths, GUC lifecycle, CI job `api-rls`; per-shopper `storefront` limit (300/min per host + IP, 3 000/min per host) | ✅ **Built and QA-gated** (`phase-5b-1-qa.md`: PASS; F-M1 keyless-client limiter and F-L2 `tenant_users` policy split fixed afterwards) |
| 5b-2 Payments | 5.6, 5.12 (07) | bKash Tokenized Checkout + SSLCommerz (merchant-owned credentials), `pending_payment` with 30-min hold, advance delivery charge at checkout, payment links (2 h default), signed returns + IPN, gateway refunds, Settings → Payments, onboarding 07 | ✅ **Built and QA-gated on the fake gateway** (`phase-5b-2-qa.md`, 18/18 e2e; F-2 exchange-link amount resolved by the PO decision of 2026-11-22, OPEN-QUESTIONS Q65). ⏳ **Sandbox certification pending accounts** (contract §16) |
| 5b-3 Couriers | 5.8, 5.12 (06) | Steadfast, Pathao, RedX drivers; single + bulk booking, signed webhooks + 15-min poll, Shipments list/detail, courier connect/manage, onboarding 06, `/track` courier status | ✅ **Built and QA-gated on the fake courier** (`phase-5b-3-qa.md`; its open H-1 `/track` status and M-1 390 px overflow are fixed in `e95393f`). ⏳ **Certification against courier test accounts pending** (contract §16) |
| 5b-4 Documents | 5.9 | A4 invoice, 80 mm receipt, A5 two-up, packing slip, 4×6 label PDFs (Gotenberg 9.1.0, Bangla shaping), JSON templates, Invoices & labels page, VAT display + BIN | ✅ **Built and QA-gated** (`phase-5b-4-5b-5-qa.md`: pass, real Gotenberg, 100 labels in 1.3 s) |
| 5b-5 Order changes | 5.7 (rest) | Edit items (re-commit, re-price), post-delivery returns and exchanges (RT-n), restock after courier return. Customer accounts / cart merge not in 5b (Q58) | ✅ **Built and QA-gated** (`phase-5b-4-5b-5-qa.md`: pass) |

**Remaining blockers for closing Phase 5b** (open: 1 and 4; done: 2, 3, 6; 5 per its note):
1. **Sandbox / test-account certification** (contract §13 "sandbox certification", §16), each run with
   `phase5b.sandbox.spec.ts` and a public HTTPS tunnel (`PUBLIC_API_URL`), replacing the docs-based fixtures
   (`"_source": "docs"`) with recordings and resolving every **VERIFY** point:
   - bKash: sandbox `app_key`, `app_secret`, `username`, `password` and the **live base URL** (from bKash PGW support);
   - SSLCommerz: sandbox `store_id` / `store_passwd` (self-serve); partial refund support (Q48);
   - Steadfast: a merchant account with API access. **Steadfast documents no sandbox** (one base URL for both modes,
     `config/couriers.php`), so certification means real test parcels on a live account that are cancelled in the
     Steadfast panel (needs a PO decision, OPEN-QUESTIONS Q68);
   - Pathao: sandbox client credentials + test store; RedX: API access token and webhook docs (RedX is poll-only until
     its webhook is verified).
2. ~~CI not yet run on GitHub~~ **Done 2026-11-22:** PR #1 ran the edited `e2e.yml`, `api-documents`, `api-rls` and
   the RLS-on race loops green on GitHub.
3. ~~QA open items (OPEN-QUESTIONS Q66, Q67)~~: resolved 2026-11-22 (unique e2e shopper IPs; full API suite green as
   the app role with RLS on).
4. **WEB gaps found by ARCH** (small): courier detail built as a dialog without the event log, recent shipments
   and "This month" (FIGMA-INDEX Phase 5b); QA 5b-4/5 L-1 (Edit items name truncation at 390 px). Fixed since: the
   dashboard "Book N parcels" / "N delivery problems" tasks, the percent-advance preview (floors like the API), and
   Steadfast connections are live-only (no sandbox exists).
5. **ARCH follow-ups** (contract §18): DATABASE-DESIGN §5.2, FIGMA-INDEX, this roadmap and OPEN-QUESTIONS are done;
   API-CONVENTIONS (§4.0 codes, limiter values, webhook paths), SECURITY.md (T1/T5 updates, T28, T29) and
   MULTI-TENANCY §9 (as built) are being updated in parallel; the deployment runbook (DB roles, Gotenberg, egress IP
   for SSLCommerz live refunds) is still to write.
6. ~~Merge of `phase-5b-online-money` to `main`~~ **Done 2026-11-22** (PR #1, CI green).

## Phase 6 — Custom domains
Binding contract: `docs/development/PHASE-6-CONTRACT.md` (2026-11-22; branch `phase-6-custom-domains` from `main` @
7ad4a05; openapi 1.7.0). One build cycle on fake drivers (`DOMAINS_FAKE`) and one QA gate
(`docs/reviews/phase-6-qa.md`), then certification against a real Cloudflare for SaaS staging zone (contract §13,
OPEN-QUESTIONS Q69) before the phase closes. PO defaults pending: Q69–Q76. Out of scope: buying domains, DNS/email
hosting, apex proxying, Caddy deployment, Cloudflare webhooks (Q74), downgrade enforcement (Phase 7), admin domain
screens (Phase 8.1), slug change.
| # | Task | Owner | AC |
|---|---|---|---|
| 6.1 | Domain add/verify API + state machine + jobs | API | DOMAIN-INFRASTRUCTURE §7 and PHASE-6 §10 tests; lifecycle on fakes reaches `active` by the scheduler alone |
| 6.2 | Cloudflare for SaaS integration (custom hostnames, SSL polling; poll-only, Q74) | API/QA | Fakes + fixtures in CI; **post-build:** staging domain goes `active` end-to-end with a real certificate |
| 6.3 | Domain UI with DNS instructions (V3 Domains `2042:47403`, composed states from 60:11061 / 148:34032) | WEB | Status badges per state, per-record DNS status, re-check, make primary, remove; 390 px |
| 6.4 | Primary domain redirects + canonical | SF/API | Platform subdomain permanently redirects to the custom primary (308 for pages, 301 for robots/sitemap; amended from "301", PHASE-6 P6-15); canonical on the primary |
| 6.5 | `ask` endpoint (Caddy fallback / allowlist) | API | `GET /internal/domains/allowed` returns 200 only for `verified`/`ssl_provisioning`/`active` hosts of non-suspended stores |

## Phase 7 — Monetization
Binding contract: `docs/development/PHASE-7-CONTRACT.md` (2026-11-23; branch `phase-7-monetization` from `main` @
1b9843f; openapi 1.8.0; ADR 0008 amended). One build cycle on fake drivers (`BILLING_FAKE`) and one QA gate
(`docs/reviews/phase-7-qa.md`), then certification against the platform's own bKash/SSLCommerz sandbox accounts
(contract §13, OPEN-QUESTIONS Q90). PO accepted the defaults Q77–Q89 on 2026-11-23; Q90 (platform gateway accounts) open. **SF has no Phase 7 work** (non-payment drops to
Free, Q77). Out of scope: auto-debit (Q83), SMS credit packs and domain purchases (Q84), Money & COD and Product
performance reports (Q85), super-admin billing screens (8.1), refunds of platform payments through the API.
| # | Task | Owner | AC |
|---|---|---|---|
| 7.1 | Plans/limits enforcement across modules (contract §2) | API | 402 `plan_limit_reached` / `feature_not_in_plan` with `upgrade_plan` for every enforced row of §2.1; downgrade deletes nothing; custom domains above the plan detached after the grace |
| 7.2 | Invoices + renewal payment via platform bKash/SSLCommerz (ADR 0008 as amended) | API/WEB | Paid (verified) invoice extends period; past_due → expired → Free flow; proration; late/duplicate payments |
| 7.3 | Billing UI: Settings → Plan & billing `60:16361` (**amended** from "Account 148:33261", which is the profile page) + banner `148:35383` | WEB | Plan compare (monthly/yearly), upgrade/downgrade with quote, pay, invoice history with PDF; 390 px |
| 7.4 | Reports: Sales `60:11864`, Profit `60:12262`, Delivery `60:12660` (section 60:11810) | API/WEB | Matches order data; store (tenant) timezone; Profit Growth + O A |

## Phase 8 — Super admin, analytics, extended modules
One contract per task, each with its own build cycle and QA gate. **8.1** contract: `docs/development/PHASE-8-1-CONTRACT.md`
(draft 2026-11-23 for PO review; branch `phase-8-super-admin`; openapi 1.9.0; ADR 0015; defaults Q91–Q102). The admin
Figma (`5:189`) also designs 8.2 metrics (MRR, GMV, health), risk, support and settings screens; 8.1 hides them.
**8.2** contract: `docs/development/PHASE-8-2-CONTRACT.md` (accepted 2026-11-23; branch
`feat/phase-8-2-analytics`; openapi 1.10.0; ADR 0016; Q103–Q112 defaults accepted): nightly snapshot tables, dashboard KPIs,
Revenue reports `39:12705`, merchant MRR/GMV/last-active. Deferred from 8.2: health score (Q105), Integration health and
incidents (Q106, → 9.1), analytics export (Q109).
**8.3** contract: `docs/development/PHASE-8-3-CONTRACT.md` (accepted 2026-11-23; branch `feat/phase-8-3-roles`;
openapi 1.11.0; ADR 0017; Q113–Q125 defaults accepted): granular permission catalogue, system + custom roles,
`perm:` route enforcement with an O/A/S parity test, Staff & roles UI (`60:15365`, `90:26915`, `90:26879`). Deferred
from 8.3: warehouse access per role (Q119), per-person overrides (Q120), invite by phone (Q121), ownership transfer (Q123).
**8.4** contract: `docs/development/PHASE-8-4-CONTRACT.md` (accepted 2026-11-24; branch
`feat/phase-8-4-developer-api`; openapi 1.12.0; ADR 0018; Q126–Q137 defaults accepted): tenant-level API keys (`sp_live_`,
sha256 at rest, 7 scopes, non-delegation, new permission `developers.manage`) for an `/api/v1/external` namespace
(120 req/min per key), store-scoped outbound webhooks (10 events, HMAC-SHA256 `X-Storeplix-Signature`, 7 attempts over
≈ 20.6 h, auto-disable after 72 h, SSRF-safe sender with fake driver), Developer page `144:40726`; Growth-gated
(`api_webhooks`). Deferred from 8.4: test-mode keys (Q127), customer/shipment write scopes (Q128), Postman collection
(Q134), super-admin views (Q136), OAuth apps, per-key IP allowlists.
**8.5** contract: `docs/development/PHASE-8-5-CONTRACT.md` (accepted 2026-11-24; QA re-gate PASS; branch
`feat/phase-8-5-campaigns`; openapi 1.13.0; ADR 0019; Q138–Q151 defaults accepted): store-scoped SMS + email campaigns
(predefined segments, merge fields, test send, schedule/send now/cancel, quiet hours), per-channel address suppression
with an opt-out link on every message (storefront `/u/{code}`, RFC 8058 one-click), opt-out re-checked at send time,
new allowances `campaign_sms_per_month` / `campaign_emails_per_month`, 7-day attribution, Marketing overview
`66:19179` and composer `70:19774`. Out: WhatsApp, SMS credit balance/top-up (Q84), abandoned cart + Automations (8.6).
**8.6** contract: `docs/development/PHASE-8-6-CONTRACT.md` (accepted 2026-11-24; QA gate PASS; branch
`feat/phase-8-6-automations`; openapi 1.14.0; ADR 0020; Q152–Q166 defaults accepted): fixed recipe catalogue (Win back
unfinished orders, Thank-you message, Tag VIP buyers, Handle returns, Low stock alert), triggers from the 8.4 emit points,
idempotent runs with a per-step run log, checkout phone capture + abandoned-checkout recovery (2 messages, cart-restore
link, exit on order, attribution), messages under the 8.5 consent/suppression/quiet-hours rules and shared allowance,
`sms_automation` enforced; Automations `140:30336`, editor `141:30622`, Abandoned cart recovery `71:20614`. Out: WhatsApp,
risky-order holds and courier success rate (8.8), auto-book courier (Q62), COD payout close (Q49), reviews.
**8.7** contract: `docs/development/PHASE-8-7-CONTRACT.md` (accepted 2026-11-24; branch `feat/phase-8-7-expenses`;
openapi 1.15.0; ADR 0021; Q167–Q182 defaults accepted, Q183 currency lock): expenses ledger (six fixed categories,
private re-encoded receipts with 5-minute signed links, monthly repeat, CSV export), new permission `expenses.manage`,
Profit & loss gains Ad spend + Other expenses by expense date (`profit_before_expenses_amount` kept), store currency
locked after the first order or expense; Expenses `144:41614`. Out: custom categories, budgets, ad-account import,
OCR, amortization, supplier bills (8.8).
**8.8a** contract: `docs/development/PHASE-8-8-CONTRACT.md` (accepted 2026-11-24; branch
`feat/phase-8-8-fake-order-guard`; openapi 1.16.0; ADR 0022; Q184–Q199 defaults accepted): fake-order guard from this
shop's own orders, shipments and returns only (no courier lookups, no cross-shop data); one risk tier (good / careful /
risky / new) everywhere, replacing the 8.5 risk class; one explained check per order; storefront COD orders held for a
call (`orders.guard_hold` flag, no new status) or asked for the delivery charge in advance through the existing payment
link; confirm/booking refused while held; blocklist + repeat returners, per-phone daily COD limit, duplicates, checkout
OTP for numbers new to the shop (fail open); new permission `fraud.manage`; `fake_order_guard` enforced; Fake order
guard `39:11233`, order/customer risk UI. Out: cross-shop network and super-admin Risk network (Q23), Steadfast/RedX/
Pathao records (Q185), VPN rule (Q190), CAPTCHA, call-outcome log, holds webhooks, advance rules by order total (Q192).
**8.8b** contract: `docs/development/PHASE-8-8B-CONTRACT.md` (accepted 2026-11-24; branch
`feat/phase-8-8b-suppliers-pos`; openapi 1.17.0; ADR 0023; Q200–Q214 defaults accepted): suppliers (KPIs, detail panel,
archive, CSV import), purchase orders draft → ordered → partially received → received / closed / cancelled with
per-store `PO-{n}`, multiple receipts per PO with damaged pieces excluded, stock in through `InventoryService`,
weighted-average landed cost written to the variant on every receipt, supplier payments (advances, part payments,
owed/overdue), PO PDF + WhatsApp link, quick purchase, reorder suggestions, inventory INCOMING column; new permission
`purchasing.manage`, new plan feature `purchasing` (Starter, Growth); purchases never enter expenses or Profit & loss;
removes the 8.8a `CustomerRisk` alias; Purchase orders `35:5619`, New PO `35:6210`, Receive `36:6607`, Suppliers
`153:35999`. Out: locations, transfers, stock count, POS, Inbox (8.8c+), approval, email sending, supplier claims,
returns to supplier, FIFO, landed-cost revaluation, VAT registers (Q214).
**8.8c** contract: `docs/development/PHASE-8-8C-CONTRACT.md` (accepted 2026-11-24; ADR 0024; Q215–Q230 defaults
accepted), two PRs: **part A** `feat/phase-8-8c-locations` (openapi 1.18.0; **merged, PR #17**) — `locations` (warehouse/shop, ≤ 10, one
default = the online location, archive when empty), per-location `inventories` rows and ledger with a forward-only
backfill to "Main warehouse", order lines remember their location (release/ship/restock there), every stock reader
classified online / total / location with a parity test, inventory location selector `11:842` + Warehouses tab,
product editor "+ n at other locations", "Receive at" on POs (cost stays one weighted average over all locations),
`stock.low` per location, `multi_warehouse` enforced for a 2nd location; **part B**
`feat/phase-8-8c-transfers-counts` (openapi 1.19.0; **merged, PR #18**) — transfers `TR-{n}` (draft → in transit →
received / cancelled, stock out on send and in on receive, short units written off, send ≤ source available,
`Idempotency-Key` on send/receive) `153:34425` and stock counts (one open per location, scan/set, delta at count,
finish & adjust, cancel) `153:35246`; four RLS tables (87), limiter `stock-write`, SECURITY T41 (S187–S194), ADR 0024
part B addendum. Out: POS,
Inbox (8.8d), transfer approval, multi-location online selling / split fulfilment, shop pickup, per-person warehouse
access (Q119), lock sales while counting, stock-loss expense, camera scanning (Q230).
**8.8d** contract: `docs/development/PHASE-8-8D-CONTRACT.md` (accepted 2026-11-25; branch `feat/phase-8-8d-pos`;
openapi 1.21.0; ADR 0025; Q232 — POS first, Inbox later; Q233–Q256 defaults accepted), two PRs, **part A merged (PR #20); part B in progress** (`feat/phase-8-8d-pos-b`): **part A** sell — registers (≤ 10, at an 8.8c location), open /
close register with counted float, cash check, variance tolerance and Z-report, catalog + barcode lookup, customer by
phone, coupon, cash / bKash / card / split as manual payments bound to the session, every till sale an order
(`created_via pos`, `walk_in`, delivered + paid at once) with stock out at the register location (`pos_sale` ledger
reason), browser-printed 80 mm receipt + SMS receipt, new permission `pos.sell`, `pos` enforced; **part B** held sales
(no stock reservation), sales history with KPIs, returns at the till refunded from the drawer. Figma page `22:1736`
(`25:581`, `22:1737`, `22:1905`, `22:2073`, `22:2241`, `22:2409`, `27:754`, `25:829`). Out: Inbox and AI integrations
(Q1), offline mode, hardware integration (drawer kick, silent printing), void with manager PIN, one-step exchange,
manual discounts, paid in / out, per-person register / location access (Q119, Q248), held-sale stock reservation (Q242, Q256).
**8.8e** contract: `docs/development/PHASE-8-8E-CONTRACT.md` (**contract accepted 2026-11-28**; branch `feat/phase-8-8e-inbox`, stacked on 8.9a + 8.9b; openapi 1.25.0; ADR 0028; Q287–Q302 defaults accepted, Q299 provider open, Q303/Q304 defaults in effect): PO scope — **own channels only**: website chat widget (name + mobile verified by an SMS code, 90-day chat session cookie, unverified fallback when SMS is unavailable), order-page Messages on `/track` and thank-you (order access token), email replies (platform inbound domain, per-store + HMAC-signed reply addresses, signed provider webhook, `fake` + `mailgun` drivers); one Inbox `/inbox` with one conversation per contact per channel thread, Open / Pending / Closed with reopen to the assignee, one assignee (emailed), staff-only internal notes, JPG/PNG/PDF ≤ 5 MB private attachments, team-shared saved replies with merge tags and `/`, per-member unread + sidebar badge, polling with ETag/304, reply SMS (`inbox_reply`) through the 8.9a charger with a magic link, new permission `inbox.manage` (O/A/S), no plan gate, channels off until turned on, 24-month retention; 8 RLS tables (103), SECURITY T45 (S234–S247). Out: Messenger / WhatsApp / Instagram and AI "Order from chat" (→ 8.8f), customer accounts, @mention and missed-message notifications, typing, websockets (Q305).
**8.9a** contract: `docs/development/PHASE-8-9A-CONTRACT.md` (accepted 2026-11-28; branch `feat/phase-8-9a-sms`;
openapi 1.23.0; ADR 0026; Q257–Q272 defaults accepted), one PR: `SmsCharger` (allowance first, then SMS credits —
1 credit = 1 part — else skipped with a log row) used by every shop-paid sender (order SMS, payment links, checkout OTP,
POS receipt, campaigns, automations, test SMS); append-only credit ledger; credit packs 1,000 / 5,000 / 10,000 bought
by the owner as platform billing invoices `sms_credits` (credits after server-verified payment); per-store bn/en
templates (defaults = today's texts); masked sender IDs with a private trade licence, reviewed under `manage_domains`
(prefix dropped when approved); 90-day SMS log with masked phones and no OTP text; low-credit alert; admin credit
adjustments; four RLS tables (95), SECURITY T43 (S208–S219). Out: delivery reports, merchant-own gateway,
promotional sender IDs, credit expiry/refunds, auto top-up, editable OTP text and quiet hours, WhatsApp (Q272); help
center and other 8.9 integrations.
**8.9b** contract: `docs/development/PHASE-8-9B-CONTRACT.md` (accepted 2026-11-28; branch `feat/phase-8-9b-sms-provider`; openapi 1.24.0; ADR 0027; Q273–Q286 defaults accepted), one PR after the 8.9a API: `sms_providers` registry (REVE + generic HTTP drivers, encrypted write-only credentials, env REVE as bootstrap), `SmsGateway` becomes a router (routes shop / registration / billing / security / promotional; primary → failover; breaker after 3 failures or a timeout, back after 5 min; platform SMS retried 30 min, codes 5 min), test / typed-name activate / test-then-swap rotate / remove (never the primary), 15-minute balance + low-balance alert, nine platform message types with bn/en templates (three locked code texts unchanged) wired only at existing events, promotional broadcasts with per-recipient rows, link opt-out per user, weekly cap 2 and 9 AM–9 PM Dhaka, platform SMS log + masked CSV; all `manage_settings`; SECURITY T44 (S220–S233). Out: native SSL Wireless / Alpha SMS / BulkSMSBD drivers, delivery reports, SMS two-step and sign-in alerts, offer / win-back automations, Announcements SMS channel (Q286).
**8.9c** contract: `docs/development/PHASE-8-9C-CONTRACT.md` (**contract accepted 2026-11-28**; branch `feat/phase-8-9c-help-center`, stacked on 8.9a + 8.9b + 8.8e; openapi 1.26.0; ADR 0029; Q306–Q323 and Q327–Q329 defaults accepted, Q324–Q326 defaults in effect): platform help content (7 platform tables, no RLS: categories, articles with en/bn translations holding a draft and a published snapshot, slug redirects, platform help images, feedback, daily views), `HelpArticleDoc` rich-text JSON (RichTextDoc + image + callout) validated on write and rendered by one shared component, Postgres FTS (`simple`) + trigram search with a sqlite fallback, one helpful vote per member per article; merchant tickets on 3 RLS tables (106) with `support.manage` (Owner, Admin), optional related order (`orders.view`), private `support_attachment` files ≤ 10 MB, open → awaiting merchant ⇄ awaiting support → resolved → closed (auto after 7 days), CSAT within 14 days; super-admin `/help-articles` (`manage_help_content`: SA, support) and `/support` (`manage_support`: SA, support, billing) with internal notes, assignment, SLA timestamps and an audited limited order card; emails both sides; SECURITY T46 (S248–S261). Out: live chat, call / WhatsApp / hotline, status page, videos, AI answers, What's new, plan-targeted articles, SLA targets, macros, reply by email (Q327–Q329).
**8.9d** contract: `docs/development/PHASE-8-9D-CONTRACT.md` (**contract accepted 2026-11-28**; branch `feat/phase-8-9d-integrations`, stacked on 8.9a + 8.9b + the 8.8e contract; openapi 1.27.0 (1.26.0 reserved for the Help center contract); ADR 0030; Q330–Q369 defaults accepted, Q346 Google Merchant API and Q358 image provider open, Q363/Q364/Q367 record only), two parts: **A** — `store_integrations` registry (typed settings, write-only encrypted credentials), Meta Pixel + Conversions API, GA4 + Measurement Protocol, TikTok Pixel + Events API and GTM **server container only** (web container rejected, rule 7) with IDs only and Storeplix-rendered base tags, server-side purchase on confirmation and GA4/GTM refunds deduplicated by event id with SHA-256 customer data, consent bar, queued delivery (5 attempts / 24 h), event log, Test & verify; Facebook & Instagram catalog and Google Merchant Center feeds by OAuth (hourly full sync, 15-minute price/stock deltas, item issues, Needs attention, website claim via a Storeplix meta tag); **B** — Nagad as the third gateway (server-side Verify, untrusted callback/webhook triggers, capabilities greyed), shared AI credits (plan allowance Free 20 / Starter 300 / Growth 1,500 + staff bonus, idempotent ledger), Claude product description writer (model id configurable, default `claude-opus-5-5`) and AI product photos (fake image driver). Nine RLS tables, SECURITY T47 (S330–S349). Out: Mailchimp, OpenAI/Gemini, EPS/aamarPay/PayStation, test orders, AI credit packs (Q363–Q367).
| # | Task | Owner | AC |
|---|---|---|---|
| 8.1 | Super-admin: tenants, stores, domains, subscriptions, impersonation (5:189); platform staff with TOTP, suspension, audit log | API/WEB/SF | Read-only impersonation audited; PHASE-8-1 §14 |
| 8.2 | Platform analytics (GMV, MRR, churn): dashboard `15:123`, Revenue reports `39:12705`, merchant metrics | API/WEB | Nightly aggregates; PHASE-8-2 §14 |
| 8.3 | Custom roles & permissions (89:26676): 23 code-defined keys, system + custom roles, Growth-gated, non-delegation | API/WEB | Granular permissions enforced; PHASE-8-3 §13 |
| 8.4 | Developer API keys + outbound webhooks (144:40725): scoped `sp_live_` keys, `/external` API, signed webhooks with retries, Growth-gated | API/WEB | HMAC signatures; retries; PHASE-8-4 §13 |
| 8.5 | Marketing campaigns SMS/email (61:12479): segments, schedule, opt-out link + suppression checked at send time, allowances, attribution | API/WEB/SF | Opt-out respected; PHASE-8-5 §14 |
| 8.6 | Automations (140:30335) + abandoned cart recovery (71:20614): 5 recipes, run log, checkout recovery | API/WEB/SF | Trigger → action runs logged; PHASE-8-6 §16 |
| 8.7 | Expenses (144:41613) + profit report: six categories, private receipts, monthly repeat, Ad spend + Other expenses in Profit & loss, `expenses.manage`, store currency lock | API/WEB | Expenses recorded with receipts reduce net profit in Profit & loss; every changed number is traceable; the store currency locks once the store has an order or an expense; PHASE-8-7 §16 |
| 8.8a | Fake-order guard (39:11233, section 41:12365): own-shop record and tiers, order checks with hold / advance, blocklist + repeat returners, daily COD limit, duplicates, checkout OTP, `fraud.manage`, `fake_order_guard` enforced | API/WEB/SF | Every new COD order of a guarded store gets one explained risk check; risky orders are held or asked for an advance before anyone can book a courier; blocked and over-limit numbers can't place COD orders; new numbers verify by OTP; nothing about a shopper comes from another shop; PHASE-8-8 §16 |
| 8.8b | Suppliers + purchase orders (35:5619, 35:6210, 36:6607, 153:35999): suppliers, POs, receiving with damaged, weighted-average landed cost, supplier payments/owed, PO PDF + WhatsApp, quick purchase, reorder suggestions, `purchasing.manage`, plan `purchasing` | API/WEB | Merchant records suppliers, sends POs, receives in one or more deliveries; variant cost = weighted-average landed cost; owed = received value − payments; no purchase in Profit & loss; PHASE-8-8B §16 |
| 8.8c | Locations + per-location stock (part A: 11:589 selector 11:842, Warehouses 11:808, Receive at 35:6644/36:6615/36:7118), stock transfers (part B: 153:34425) and stock count (part B: 153:35246); `multi_warehouse` enforced. Part A ✅ merged (PR #17); part B ✅ merged (PR #18) | API/WEB | A merchant keeps stock in more than one place, sees how much is where, moves stock between places with a transfer that takes it out on send and puts it in on receive, and corrects stock with a count; online orders keep selling from one chosen location; a single-location shop sees no change; PHASE-8-8C §16 |
| 8.8d | POS (page 22:1736: open register 25:581, sale 22:1737, variant picker 22:1905, payment 22:2073, sale complete 22:2241, held sales 22:2409, sales history 27:754, close register 25:829; overview 26:2147): registers + cash sessions, till sales as orders, stock out at the register location, receipts, held sales, history, returns at the till, `pos.sell`, `pos` enforced. Contract accepted 2026-11-25 (Q233–Q256 defaults accepted); part A ✅ merged (PR #20); part B in progress (`feat/phase-8-8d-pos-b`). Inbox (141:48129) later (Q232) | API/WEB | A shop opens a register with a counted float, sells with cash/bKash/card/split, prints or texts a receipt, parks and resumes sales, takes returns at the till and closes with an explained cash difference; every till sale is an order in Orders, reports and Profit & loss; stock leaves the register's location through the ledger; PHASE-8-8D §16 |
| 8.8e | Inbox on own channels (section 141:48129; inbox 2118:51165, assign 2121:51432, closed 2121:51977, loading 2122:51964, error 2122:52543, caught up 2122:53073, first run 2123:52602, saved replies 2123:52877; mobile 2124:1335, 2124:1509; storefront widget 2125:9509, 2125:9736, 2125:10004, 2126:10484, order Messages 2126:10642): website chat (SMS-verified), order messages, email replies; assign, open/pending/closed, internal notes, attachments, saved replies, unread badge, reply SMS, `inbox.manage`. **Contract accepted 2026-11-28** (Q287–Q302 defaults accepted; `feat/phase-8-8e-inbox`) ✅ merged to main 2026-11-28 | API/WEB/SF | A shop turns on website chat, order messages and email replies; shoppers reach it from the widget, their order page and by replying to an email; staff with the Inbox permission read, reply, note, attach, assign, mark pending and close in one Inbox; shoppers get an SMS when the shop replies; nothing changes for a shop that turns nothing on; PHASE-8-8E §17 |
| 8.8f | Inbox external channels + AI "Order from chat" (141:48130 AI order draft, 166:35920 order created, 167:36176 Instagram comment, 172:37079 WhatsApp chat, 168:36454 connect channels): Messenger, WhatsApp, Instagram on the 8.8e conversation model; AI order drafting → `orders.source = 'inbox'` | API/WEB | Scoped after PO confirms (OPEN-QUESTIONS Q287, Q305; Meta app review, WhatsApp Business provider and AI provider choices) |
| 8.9a | SMS integration (Integrations › Messaging › SMS: overview 31:5120, templates 2075:50213, sender ID 2075:50625, SMS log 2075:51037, buy credits 2075:51449; mobile 2081:1197, 2081:1561; admin sender-ID requests 2087:7872): SMS credits after the monthly allowance (packs bought as platform billing invoices `sms_credits`), per-store bn/en templates, masked sender ID requests reviewed by staff, 90-day SMS log, test SMS, low-credit alert, admin credit adjustments. Contract accepted 2026-11-28 (Q257–Q272 defaults accepted); in progress (`feat/phase-8-9a-sms`) ✅ merged to main 2026-11-28 | API/WEB/ADMIN | A merchant sees how SMS are paid and how they went, edits order SMS texts in Bangla and English, requests their own sender ID, and buys credits that keep SMS going after the allowance; staff review sender IDs and adjust credits; a shop that does none of this sees no change; PHASE-8-9A §17 |
| 8.9b | Platform SMS provider (super-admin `/settings/sms`: provider 2098:8460 + not configured 2111:9331, configure drawer 2112:9494 → 2113:10237, activate 2114:10581, remove 2114:10634, manage 2114:10202, message types 2098:8963, template editor 2098:9466, broadcasts 2098:9969 + confirm 2103:9134, SMS log 2098:10472): providers in the DB (REVE + generic HTTP; others "Coming soon"), primary + failover with automatic failover, write-only credentials with test-then-swap rotation, typed-name activation, gateway balance + low-balance alert, platform message types (codes locked; welcome, invoice issued, payment received, payment due or failed, plan expiring; bn/en templates, toggles), promotional broadcasts (audience, 9 AM–9 PM Dhaka, estimate, typed count, weekly cap 2, link opt-out), platform SMS log + CSV; merchant Account opt-out switch and `/s/{code}` page. Replaces Figma card 46:7167. **Contract accepted 2026-11-28** (Q273–Q286 defaults accepted; `feat/phase-8-9b-sms-provider`; API after the 8.9a API merges) ✅ merged to main 2026-11-28 | API/ADMIN/WEB | Staff run the platform gateway (primary + failover, rotatable write-only keys, watched balance, automatic failover), choose and word platform SMS to merchants, send opt-out-able broadcasts within quiet hours and a weekly cap, and see every platform SMS in one log; nothing merchants or shoppers receive changes until staff act; PHASE-8-9B §17 |
| 8.9c | Help center (section 71:21271: home 71:21272, search 2130:463, article 71:21665, my tickets 71:22058, new ticket 75:23121, ticket thread 71:22844, states 2130:965; mobile 2131:1440, 2132:55211; super admin help articles 2134:10410, article editor 2134:66712, support tickets 39:15432): platform-authored guides in English + বাংলা (one slug, English fallback with a note), categories, Postgres search, "Was this helpful?" (one vote per member), related; merchant support tickets (`support.manage`, optional related order, private JPG/PNG/PDF ≤ 10 MB, statuses open / awaiting merchant / awaiting support / resolved / closed, CSAT); super-admin editor (draft / publish / schedule / archive, sanitized rich-text JSON) and support queue (assign, internal notes, SLA timestamps, audited related-order card); `manage_help_content`, `manage_support`; email notifications. **Contract accepted 2026-11-28** (Q306–Q323, Q327–Q329 defaults accepted; Q324–Q326 defaults in effect; `feat/phase-8-9c-help-center`) ✅ merged to main 2026-11-28 | API/WEB/ADMIN | A merchant finds a guide by topic or search in English or বাংলা, says whether it helped and opens a ticket with an optional order and files; staff publish guides, see feedback and answer tickets from one queue with notes and assignment; both sides are emailed on replies; nothing changes for a merchant who never opens Help; PHASE-8-9C §17 |
| 8.9d | Integrations — tracking, product feeds, Nagad, AI (section 32:5331: GA4 2132:53511, TikTok connect 2133:53731, GTM server 2133:54292, Meta test events 2134:64916, Meta catalog 2134:65506 + disconnect 2135:55626, Google Merchant 2134:66100, AI photos 2135:55033, Nagad 2134:67228, mobile list 2136:1866; existing Meta CAPI 28:2152, Claude 31:5788): pixels + server events (IDs only, GTM server only), product feeds by OAuth, Nagad gateway, Claude description writer, AI photos, shared AI credits. **Contract accepted 2026-11-28** (Q330–Q369; part A tracking + feeds, part B Nagad + AI; `feat/phase-8-9d-integrations`) ✅ part A (tracking + feeds) merged to main 2026-11-28; part B (Nagad, AI credits, writer, photos) built on `feat/phase-8-9d-integrations-b` 2026-11-28 (API/WEB/SF/ADMIN; openapi 1.27.1 adds the signed AI photo download); QA gates A and B (Playwright) pending | API/WEB/SF/ADMIN | A shop connects trackers with IDs and tokens only and each confirmed order reaches them once from the server, hashed and deduplicated; products sync to Meta and Google hourly with price/stock changes within 15 min and item errors shown; shoppers pay with Nagad, verified server-side; members write descriptions and clean photos from one AI credit pool; nothing changes for a shop that connects nothing; PHASE-8-9D §17 |
| 8.9 | Remaining integrations (Mailchimp sync, OpenAI/Gemini, EPS/aamarPay/PayStation) | WEB/API | Later; Help center split out as 8.9c, tracking/feeds/Nagad/AI as 8.9d |

## Phase 9 — Production readiness
| # | Task | Owner | AC |
|---|---|---|---|
| 9.1 | Observability: centralized logs, Sentry, metrics dashboards, alerts | QA | Alert on 5xx rate, queue wait, DB CPU |
| 9.2 | Backups PITR + restore drill | QA | Documented restore < 1 h |
| 9.3 | Load test (k6): 200 rps storefront, 50 checkouts/min | QA | p95 < 500 ms API, no errors |
| 9.4 | Security: external pentest, dependency audit, CSP hardening | QA/ARCH | No high findings open |
| 9.5 | Read replica, audit log partitioning, Redis ISR cache handler | API/QA | — |
| 9.6 | Runbooks in `docs/deployment/` | ARCH/QA | On-call can deploy/rollback from doc |

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
| # | Task | Owner | AC |
|---|---|---|---|
| 8.1 | Super-admin: tenants, stores, domains, subscriptions, impersonation (5:189); platform staff with TOTP, suspension, audit log | API/WEB/SF | Read-only impersonation audited; PHASE-8-1 §14 |
| 8.2 | Platform analytics (GMV, MRR, churn): dashboard `15:123`, Revenue reports `39:12705`, merchant metrics | API/WEB | Nightly aggregates; PHASE-8-2 §14 |
| 8.3 | Custom roles & permissions (89:26676): 23 code-defined keys, system + custom roles, Growth-gated, non-delegation | API/WEB | Granular permissions enforced; PHASE-8-3 §13 |
| 8.4 | Developer API keys + outbound webhooks (144:40725) | API/WEB | HMAC signatures; retries |
| 8.5 | Marketing campaigns SMS/email (61:12479) | API/WEB | Opt-out respected |
| 8.6 | Automations (140:30335) | API/WEB | Trigger → action runs logged |
| 8.7 | Expenses (144:41613) + profit report | API/WEB | — |
| 8.8 | Inbox (141:48129), POS (26:2147, page 22:1736), multi-location/suppliers/POs/transfers, fake-order guard | API/WEB | Scoped after PO confirms (OPEN-QUESTIONS Q1) |
| 8.9 | Help center (71:21271), Payments/tracking/messaging/AI integrations (32:5331) | WEB/API | Scoped after PO confirms |

## Phase 9 — Production readiness
| # | Task | Owner | AC |
|---|---|---|---|
| 9.1 | Observability: centralized logs, Sentry, metrics dashboards, alerts | QA | Alert on 5xx rate, queue wait, DB CPU |
| 9.2 | Backups PITR + restore drill | QA | Documented restore < 1 h |
| 9.3 | Load test (k6): 200 rps storefront, 50 checkouts/min | QA | p95 < 500 ms API, no errors |
| 9.4 | Security: external pentest, dependency audit, CSP hardening | QA/ARCH | No high findings open |
| 9.5 | Read replica, audit log partitioning, Redis ISR cache handler | API/QA | — |
| 9.6 | Runbooks in `docs/deployment/` | ARCH/QA | On-call can deploy/rollback from doc |

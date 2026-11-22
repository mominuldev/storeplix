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

## Phase 4 — Merchant dashboard (catalog & ops UI)
Binding API/type contract: `docs/development/PHASE-4-CONTRACT.md` (4.7 is a strictly ordered sub-step that ships last, §7.6).
| # | Task | Owner | AC |
|---|---|---|---|
| 4.1 | Categories CRUD | API/WEB | Tree depth ≤ 3; isolation tests |
| 4.2 | Products + variants + images CRUD (Products 60:8983) | API/WEB | Simple/variable, SKU uniqueness per tenant, images ordered |
| 4.3 | Inventory list + adjustments + movements ledger (Inventory 26:2146, single location) | API/WEB | Atomic adjustments, ledger rows |
| 4.4 | CSV product import/export (queued) | API/WEB | 5 000 rows < 2 min; formula-injection safe |
| 4.5 | Customers list/detail (61:12478) | API/WEB | Search by phone/email |
| 4.9 | Onboarding 05 Add first products `50:312` / M5 `54:941` (quick-add + CSV) | WEB | Product created in active store |
| 4.6 | Dashboard home KPIs (26:2144) — read models only | API/WEB | Empty/loading/error states (148:34032) |
| 4.7 | Migrate SPA auth to cookie-based Sanctum (ADR 0005) | API/WEB | Token no longer in JS storage; contract updated |
| 4.8 | Mobile merchant layouts (2:5) | WEB | Key screens responsive per Figma |

## Phase 5 — Commerce (cart, checkout, orders, payments, shipping)
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

## Phase 6 — Custom domains
| # | Task | Owner | AC |
|---|---|---|---|
| 6.1 | Domain add/verify API + state machine + jobs | API | DOMAIN-INFRASTRUCTURE §7 tests |
| 6.2 | Cloudflare for SaaS integration (custom hostnames, SSL polling/webhooks) | API/QA | Staging domain goes `active` end-to-end |
| 6.3 | Domain UI with DNS instructions (Online store 60:11061 domain frames) | WEB | Status badges per state, re-check button |
| 6.4 | Primary domain redirects + canonical | SF | Platform subdomain 301 → custom domain |
| 6.5 | `ask` endpoint (Caddy fallback / allowlist) | API | Returns 200 only for routable hosts |

## Phase 7 — Monetization
| # | Task | Owner | AC |
|---|---|---|---|
| 7.1 | Plans/limits enforcement across modules | API | 402 `plan_limit_reached` tests |
| 7.2 | Invoices + renewal payment via platform bKash/SSLCommerz (ADR 0008) | API/WEB | Paid invoice extends period; past_due → expired flow |
| 7.3 | Billing UI (Account 148:33261) | WEB | Plan compare, upgrade, invoice history |
| 7.4 | Reports: sales/profit/delivery (60:11810) | API/WEB | Matches order data; tenant timezone |

## Phase 8 — Super admin, analytics, extended modules
| # | Task | Owner | AC |
|---|---|---|---|
| 8.1 | Super-admin: tenants, stores, domains, subscriptions, impersonation (5:189) | API/WEB | Read-only impersonation audited |
| 8.2 | Platform analytics (GMV, MRR, churn) | API/WEB | Nightly aggregates |
| 8.3 | Custom roles & permissions (89:26676) | API/WEB | Granular permissions enforced |
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

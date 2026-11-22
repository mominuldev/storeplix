# Security

Status: Accepted (Phase 0). Applies to all apps. Every control below has a named owner area and a required test.

## 1. Assets
Tenant business data (orders, customers' PII — names, phones, addresses), merchant credentials (passwords,
tokens, payment-gateway keys, courier keys), money flows (order totals, payment status, SaaS billing),
domain-to-store mapping, platform admin access, availability of storefronts.

## 2. Actors & trust boundaries
| Actor | Entry point | Trust |
|---|---|---|
| Anonymous shopper | Storefront (any host) → Next.js → API storefront endpoints | Untrusted |
| Merchant user (owner/admin/staff) | Merchant SPA → `/api/v1/stores…` and tenant routes with Bearer + `X-Tenant-Id` | Authenticated, scoped to memberships, role-limited |
| Platform admin | Super-admin SPA → `/api/v1/admin` | Privileged; MFA required; IP/Access-restricted |
| Storefront server | API with `X-Storefront-Key` | Trusted service, but host claim still validated |
| Payment / courier / Cloudflare | Webhooks → `/api/v1/webhooks/{provider}` | Untrusted until signature verified |
| Malicious merchant | Their own tenant + theme config + uploads | Assume hostile towards other tenants and shoppers |

## 3. Threat model (STRIDE, prioritized)
| # | Threat | Control | Required test |
|---|---|---|---|
| T1 | Cross-tenant (and cross-store) read/write via guessed/foreign ULID (IDOR) | `BelongsToTenant` global scope (fail-closed), `BelongsToStore` scope, `{store}` bound through tenant scope → 404, tenant/store-scoped `exists` rules, composite FKs, RLS (Phase 5, tenant-level) | `assertTenantIsolation` + `assertStoreIsolation` per resource; foreign-reference 422; RLS raw-SQL test |
| T2 | Tenant spoofing via `X-Tenant-Id` | Membership lookup each request; non-member → 403 `tenant_forbidden` | User of A with header B → 403 |
| T3 | Host-header spoofing to read another store | Host validated against `store_domains`; key required; Nginx strips `X-Forwarded-Host` | Forged host/no key → 401/404 |
| T4 | Domain takeover (claim someone else's domain / dangling CNAME) | TXT ownership proof, global unique hostname, daily recheck → `expired`, CF hostname removed on delete | DOMAIN-INFRASTRUCTURE §7 |
| T5 | Payment manipulation (tampered amount, fake success redirect, replayed webhook) | Amount computed server-side from DB; order paid only after provider `verify` API call or signed webhook; amount+currency+order ref must match; `webhook_events` unique `(provider,event_id)`; idempotency keys. **5b** (PHASE-5-CONTRACT §16.2): 5a has no online payments (COD and manual refund records only) | Redirect with `status=success` but provider says failed → order stays unpaid; amount mismatch → reject; replayed webhook → no double effect |
| T6 | Price/discount tampering at checkout | Client sends only variant ids + qty + coupon code; totals recomputed; coupon rules enforced in transaction (Phase 5a: PHASE-5-CONTRACT §10 S1, S3) | Posting `price` field ignored; expired coupon → 422; `CheckoutPriceTampering` (S1) |
| T7 | Stock race / overselling | Atomic conditional UPDATE reservation in DB transaction. Phase 5a: `InventoryService::commit` adds to `inventories.committed` under `FOR UPDATE` in `variant_id` order, conditional on `on_hand − committed ≥ q`, all-or-nothing (PHASE-5-CONTRACT §7, §10 S2; ADR 0011) | Concurrent checkout test (parallel requests) never over-reserves; S2 race and mixed-cart deadlock tests on Postgres (`perf` group) |
| T8 | Stored XSS via product description, theme config, pages | Rich text sanitized server-side (HTMLPurifier allowlist) on save; React escaping; no `dangerouslySetInnerHTML` except sanitized fields; theme config schema forbids `javascript:`/`data:` URLs; CSP | Script payload saved → stripped; CSP header present |
| T9 | Account takeover | argon2id; login throttle 5/min per email+IP; token expiry 7 days (`SANCTUM_EXPIRATION`=10080, D3; `expires_at` returned, SPA logs out proactively and on any 401); revoke on password change; optional TOTP for merchants, mandatory for platform admins; password reset tokens 60 min single use | Throttle test; token revoked after password change |
| T10 | Privilege escalation inside tenant (staff → owner) | Policies on every action; role changes only by owner; owner uniqueness constraint | Staff cannot change roles/billing/domains/payment credentials |
| T11 | Merchant token reaching admin APIs | Admin routes require `platform_role`; separate ability `admin:*` on tokens issued at admin login | Merchant token on `/admin/*` → 403 |
| T12 | Malicious uploads (polyglot, SVG XSS, huge files) | MIME sniff allowlist (jpeg, png, webp, gif, avif; csv for import); SVG rejected (or sanitized for logos only); max 5 MB images / 10 MB CSV; re-encode images; random keys; served from separate CDN host with `Content-Disposition` & `X-Content-Type-Options: nosniff` | Upload `.php` renamed `.jpg` → 422; SVG with script → rejected |
| T13 | CSV import injection / formula injection on export | Exports and error reports prefix cells starting `= + - @`, TAB, CR (and full-width ＝＋－＠, also after leading spaces) with `'`; import strips one such `'` on read; import validated row-by-row in tenant-aware job; descriptions become RichTextDoc text (HTML stripped) (PHASE-4-CONTRACT §5.6) | Export + error-report test for every trigger character |
| T14 | SSRF (webhook URLs, image-by-URL import, DNS checks) | Outbound HTTP via `SafeHttpClient`: https only, resolve and block private/link-local/metadata IP ranges, 5 s timeout, no redirects to blocked ranges | Webhook URL `http://169.254.169.254` → 422 |
| T15 | Secrets leakage | Env/secret manager only; `encrypted` casts for gateway credentials; never in API responses/logs (log redaction processor); `.env` gitignored; gitleaks in CI | Resource test asserts credentials absent |
| T16 | Brute force / scraping / DoS | Rate limits (API-CONVENTIONS §8), Cloudflare WAF + bot rules, checkout CAPTCHA (Turnstile) after anomaly, fake-order guard (Phase 8) | Throttle returns 429 with `Retry-After` |
| T17 | CSRF | Phase 4.7: SPAs use Sanctum cookie sessions **same-origin** (`app.`/`admin.` proxy `/api` + `/sanctum` to Laravel): host-only `__Host-sp_session` (HttpOnly, Secure, SameSite=Lax), `XSRF-TOKEN` → `X-XSRF-TOKEN` on every write (else 419 `csrf_token_mismatch`); stateful domains are an exact list without storefront hosts; no credentialed CORS. Storefront Server Actions have Next.js origin check; cart cookie `SameSite=Lax` | Write without CSRF header → 419; storefront origin not stateful; cookie flags asserted |
| T18 | Repudiation | `audit_logs` (append-only role) for auth, role, domain, payment-credential, refund, theme publish, admin impersonation | Action writes audit row |
| T19 | Queue/job cross-tenant leak | Tenant job middleware; context reset; assert empty at job start | Job isolation test |
| T21 | Preview-token abuse: leaked/forged token exposes an unpublished store; token replayed against another store; token cached and served to the public | HMAC with a dedicated secret, 60-min TTL, bound to `store_id` (checked against the store resolved from host); issued only to authenticated members of that store's tenant; token removed from URL by a redirect into an httpOnly `sp_preview` cookie; preview fetches and responses `no-store`, never in the shared tag cache; invalid token silently treated as a public visitor | Forged/expired token → Coming soon; token for store A on host B → Coming soon; non-member can't mint (404); preview response has `Cache-Control: private, no-store`; a public request right after a preview request doesn't get preview content |
| T22 | Draft store content leaking before launch (search engines, caches) | Coming soon only (no catalog), `noindex`, `robots.txt Disallow: /`, empty sitemap, `no-store` | Draft host: catalog endpoints 404, robots disallow, sitemap empty |
| T23 | Account enumeration via forgot-password | `POST /auth/forgot-password` always returns 202 with the same body and similar timing; throttled by the `auth` limiter | Known and unknown email → identical 202 |
| T24 | Bulk import abuse (zip bombs, huge/malformed CSV, queue flooding) | CSV only, ≤ 10 MB, archive/binary magic bytes rejected, never decompressed, UTF-8 check, streaming parser, row/column/cell/line limits, one active import per store (DB partial unique), `merchant-bulk` throttle, job timeout, private tenant-prefixed storage (PHASE-4-CONTRACT §5.1) | Upload rejection tests; 5 000-row perf test |
| T25 | Customer PII bulk exfiltration | Customer import/export owner/admin only; exports queued, private, 5-min signed URLs, expire in 24 h, audited `customer.exported`; logs carry no row values | Staff export → 403; audit row; expired export unreadable |
| T26 | Shopper order enumeration: guessing order numbers (sequential `GS-1042`) to read other shoppers' orders, names, phones or addresses without accounts (PHASE-5-CONTRACT §10 S8) | Thank-you page only through a 32-byte confirmation token (sha256 at rest, 24 h, httpOnly `sp_order` cookie, never in a URL); `POST /storefront/orders/track` needs order number **and** phone (POST so phones stay out of URLs and logs); a wrong pair returns the same 404 `not_found` body as an unknown number; `order-track` limiter 10/min per store host + shopper IP; tracking view minimised (status timeline, items, totals, district and thana only, no street address or email); all responses `private, no-store` | Wrong phone → identical 404 to an unknown number; 11th track request/min → 429; tracking view has no street/email; expired confirmation token → 404 (`CommerceSecurityTest::test_order_tracking_enumeration`; e2e `phase5.security`) |
| T27 | Checkout abuse and SMS cost: scripted fake COD orders that lock stock and trigger paid order SMS; SMS/email template injection; duplicate SMS on job retry (§10 S9, S13) | `checkout` limiter: 10/min per store host + shopper IP and 5 per 10 min per store host + normalised phone; cart caps (qty 1–99, ≤ 50 lines); adding to the cart reserves nothing; checkout refused on draft stores (409 `store_not_live`); fixed SMS templates, variables stripped of control characters and truncated (name ≤ 40, shop ≤ 40); monthly `sms_per_month` plan allowance (over the cap: SMS skipped + timeline note, the order is still accepted); at most one SMS per (order, event), deduplicated under the order row lock by the `notification` rows in `order_events` (as built; the contract draft said an `sms_messages` lookup); `sms_messages` stores the template name, never the body. Fake-order guard and checkout CAPTCHA stay Phase 8 / T16 | 11th checkout/min from one IP → 429; 6th per phone in 10 min → 429; draft store → 409; name with newlines/URLs renders as one truncated line; allowance exhausted → SMS skipped + note; job retry → one `sms_messages` row (`test_checkout_spam_limits`, `NotificationsTest`) |
| T20 | SQL injection | Eloquent/bindings only; arch test bans `DB::raw`/`whereRaw` with variables outside allowlisted files | Arch test |

## 4. Baseline controls
- **Transport:** HTTPS only, HSTS (`max-age=31536000; includeSubDomains` on platform domain; not preload for custom domains).
- **Headers:** API: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, no CORS except
  `app.`, `admin.` origins (exact list, credentials false). Storefront CSP:
  `default-src 'self'; img-src 'self' https://cdn.storeplix.com data:; script-src 'self' 'nonce-…' <payment SDK hosts>; frame-ancestors 'self' https://app.storeplix.com` (editor preview).
  SPAs: strict CSP, `frame-ancestors 'none'`.
- **Session (SPA):** until Phase 4.7, Sanctum token in `sessionStorage`. From 4.7: httpOnly host-only session cookie on the
  SPA origin (same-origin API proxy), absolute 7-day expiry (D3), no token in JS storage; on 401 the SPA clears
  local state and redirects to `/login` ("Your session expired, please sign in again"). See PHASE-4-CONTRACT §7.
- **Authorization:** Policies per model; `Gate::before` only for `super_admin` inside admin routes. Permission matrix
  (owner/admin/staff) in ADR 0005.
- **Validation:** Form Requests; `tenant_id`, `status` of money objects, `total_amount` never mass-assignable.
- **Admin impersonation:** read-only by default, time-boxed 30 min, banner in UI, audit-logged with reason.
- **Dependencies:** Dependabot/Renovate, `composer audit` and `pnpm audit --prod` in CI (fail on high).
- **Backups:** encrypted PITR; restore drill quarterly; backups in separate account/bucket.
- **Data protection:** customer PII export/delete endpoints per tenant (Phase 8); logs exclude PII bodies.
- **Incident response:** Sentry alerts → on-call; runbook in `docs/deployment/` (Phase 9).

## 5. Security test suite (CI-blocking)
`tests/Feature/Security/` (Pest): TenantIsolation (all resources), TenantHeaderSpoofing, StorefrontHostSpoofing, PreviewTokenForgery, DraftStoreExposure, ForgotPasswordEnumeration, TokenExpiry,
DomainOwnershipBypass, PaymentRedirectForgery, PaymentAmountMismatch, WebhookSignatureInvalid, WebhookReplay,
CheckoutPriceTampering, ConcurrentStockReservation, RoleEscalation, Phase 5a `tests/Feature/Commerce/CommerceSecurityTest` (S1, S2–S5, S8, S9, S11, S15, S17; race tests Postgres-only), MerchantTokenOnAdminApi, UploadValidation,
SsrfGuard, MassAssignment, RateLimit. Arch tests: tenant trait coverage, no `withoutGlobalScope` outside allowlist,
no raw SQL with variables, no `env()` outside config. Frontend: ESLint `react/no-danger` error.
Phase 9: external pentest before public launch.

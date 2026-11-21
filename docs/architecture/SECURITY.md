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
| T5 | Payment manipulation (tampered amount, fake success redirect, replayed webhook) | Amount computed server-side from DB; order paid only after provider `verify` API call or signed webhook; amount+currency+order ref must match; `webhook_events` unique `(provider,event_id)`; idempotency keys | Redirect with `status=success` but provider says failed → order stays unpaid; amount mismatch → reject; replayed webhook → no double effect |
| T6 | Price/discount tampering at checkout | Client sends only variant ids + qty + coupon code; totals recomputed; coupon rules enforced in transaction | Posting `price` field ignored; expired coupon → 422 |
| T7 | Stock race / overselling | Atomic conditional UPDATE reservation in DB transaction | Concurrent checkout test (parallel requests) never over-reserves |
| T8 | Stored XSS via product description, theme config, pages | Rich text sanitized server-side (HTMLPurifier allowlist) on save; React escaping; no `dangerouslySetInnerHTML` except sanitized fields; theme config schema forbids `javascript:`/`data:` URLs; CSP | Script payload saved → stripped; CSP header present |
| T9 | Account takeover | argon2id; login throttle 5/min per email+IP; token expiry 7 days (`SANCTUM_EXPIRATION`=10080, D3; `expires_at` returned, SPA logs out proactively and on any 401); revoke on password change; optional TOTP for merchants, mandatory for platform admins; password reset tokens 60 min single use | Throttle test; token revoked after password change |
| T10 | Privilege escalation inside tenant (staff → owner) | Policies on every action; role changes only by owner; owner uniqueness constraint | Staff cannot change roles/billing/domains/payment credentials |
| T11 | Merchant token reaching admin APIs | Admin routes require `platform_role`; separate ability `admin:*` on tokens issued at admin login | Merchant token on `/admin/*` → 403 |
| T12 | Malicious uploads (polyglot, SVG XSS, huge files) | MIME sniff allowlist (jpeg, png, webp, gif, avif; csv for import); SVG rejected (or sanitized for logos only); max 5 MB images / 10 MB CSV; re-encode images; random keys; served from separate CDN host with `Content-Disposition` & `X-Content-Type-Options: nosniff` | Upload `.php` renamed `.jpg` → 422; SVG with script → rejected |
| T13 | CSV import injection / formula injection on export | Exports prefix cells starting `= + - @` with `'`; import validated row-by-row in tenant-aware job | Export test |
| T14 | SSRF (webhook URLs, image-by-URL import, DNS checks) | Outbound HTTP via `SafeHttpClient`: https only, resolve and block private/link-local/metadata IP ranges, 5 s timeout, no redirects to blocked ranges | Webhook URL `http://169.254.169.254` → 422 |
| T15 | Secrets leakage | Env/secret manager only; `encrypted` casts for gateway credentials; never in API responses/logs (log redaction processor); `.env` gitignored; gitleaks in CI | Resource test asserts credentials absent |
| T16 | Brute force / scraping / DoS | Rate limits (API-CONVENTIONS §8), Cloudflare WAF + bot rules, checkout CAPTCHA (Turnstile) after anomaly, fake-order guard (Phase 8) | Throttle returns 429 with `Retry-After` |
| T17 | CSRF | Bearer tokens in Authorization header (no cookies auth) for SPAs → not CSRF-able; storefront Server Actions have Next.js origin check; cart cookie `SameSite=Lax` | — |
| T18 | Repudiation | `audit_logs` (append-only role) for auth, role, domain, payment-credential, refund, theme publish, admin impersonation | Action writes audit row |
| T19 | Queue/job cross-tenant leak | Tenant job middleware; context reset; assert empty at job start | Job isolation test |
| T21 | Preview-token abuse: leaked/forged token exposes an unpublished store; token replayed against another store; token cached and served to the public | HMAC with a dedicated secret, 60-min TTL, bound to `store_id` (checked against the store resolved from host); issued only to authenticated members of that store's tenant; token removed from URL by a redirect into an httpOnly `sp_preview` cookie; preview fetches and responses `no-store`, never in the shared tag cache; invalid token silently treated as a public visitor | Forged/expired token → Coming soon; token for store A on host B → Coming soon; non-member can't mint (404); preview response has `Cache-Control: private, no-store`; a public request right after a preview request doesn't get preview content |
| T22 | Draft store content leaking before launch (search engines, caches) | Coming soon only (no catalog), `noindex`, `robots.txt Disallow: /`, empty sitemap, `no-store` | Draft host: catalog endpoints 404, robots disallow, sitemap empty |
| T23 | Account enumeration via forgot-password | `POST /auth/forgot-password` always returns 202 with the same body and similar timing; throttled by the `auth` limiter | Known and unknown email → identical 202 |
| T20 | SQL injection | Eloquent/bindings only; arch test bans `DB::raw`/`whereRaw` with variables outside allowlisted files | Arch test |

## 4. Baseline controls
- **Transport:** HTTPS only, HSTS (`max-age=31536000; includeSubDomains` on platform domain; not preload for custom domains).
- **Headers:** API: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, no CORS except
  `app.`, `admin.` origins (exact list, credentials false). Storefront CSP:
  `default-src 'self'; img-src 'self' https://cdn.storeplix.com data:; script-src 'self' 'nonce-…' <payment SDK hosts>; frame-ancestors 'self' https://app.storeplix.com` (editor preview).
  SPAs: strict CSP, `frame-ancestors 'none'`.
- **Token storage (SPA):** Sanctum token in `sessionStorage` (never `localStorage`), expiring after 7 days (D3); on 401 the SPA
  clears the session and redirects to `/login` ("Your session expired, please sign in again"). ADR 0005 plans
  migration to httpOnly cookie SPA auth on a shared parent domain in Phase 4.
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
CheckoutPriceTampering, ConcurrentStockReservation, RoleEscalation, MerchantTokenOnAdminApi, UploadValidation,
SsrfGuard, MassAssignment, RateLimit. Arch tests: tenant trait coverage, no `withoutGlobalScope` outside allowlist,
no raw SQL with variables, no `env()` outside config. Frontend: ESLint `react/no-danger` error.
Phase 9: external pentest before public launch.

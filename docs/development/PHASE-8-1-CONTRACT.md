# Phase 8.1 contract: Super admin (binding for API, WEB, SF, QA)

Status: **Draft for PO review**, 2026-11-23. Branch `phase-8-super-admin` (from `phase-7-monetization` @ b94e18c; it
rebases onto `main` once PR #4 is merged). Roadmap task 8.1. Tasks 8.2–8.9 are **not** in this contract.

Everything in AGENT-CONTRACTS.md, PHASE-2/3/4/5/5B/6/7-CONTRACT.md and docs/api/API-CONVENTIONS.md still applies
(envelope, snake_case, ULIDs, cookie sessions, idempotency, foreign-id rules, paisa, RLS rules, fake-driver pattern).
Where this file changes an earlier rule it says **"amends …"**.
Machine-readable spec: `docs/api/openapi.yaml` **v1.9.0** (2026-11-23; lint-clean, no new warnings). ADRs: **0015**
(new: platform staff, admin surface, read-only impersonation), 0012 (RLS: the admin API is the "future `/admin/*`" of
MULTI-TENANCY §9.5), 0005 (merchant auth, unchanged), 0008 (billing ops actions). Product defaults: OPEN-QUESTIONS
**Q91–Q102** (proposed defaults; in effect until the PO answers).

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-1-qa.md`). No external provider, so no certification run.

| Area | Owner | Ships |
|---|---|---|
| **Platform staff and sign-in** | API / WEB | `users.platform_role`; separate admin sign-in surface with mandatory TOTP (Figma `44:4707`, `44:4784`); staff list, invite, role change and disable (Team & roles `39:12019`, Invite `45:9344`) with a **fixed** permission matrix |
| **Merchants** (tenants + their one store) | API / WEB | List with status tabs, search and filters (`32:5527`); merchant detail with Overview, Billing, Domains, Staff and Audit log tabs (`33:4851`); global search (top bar) |
| **Suspend / reactivate** | API / WEB / SF | Suspend dialog (`45:8866`), reactivate (composed); the storefront shows "temporarily unavailable" for a suspended shop on every host |
| **Subscriptions and invoices** | API / WEB | Billing list (`34:859`, invoice table only), invoice drawer (`36:1598`), change plan (`45:4989`), extend trial/period, mark paid, void, resend: the Phase 7 ops commands (PHASE-7 §4.4) become shared Actions behind both the commands and the admin API |
| **Domains** | API / WEB | Platform-wide custom domains table (Settings → Domains & SSL `45:8156`, table only): re-check, suspend, reinstate |
| **Read-only impersonation** | API / WEB | Reason dialog (composed) → the real merchant dashboard in a read-only, 15-minute, audited session with the amber banner (`44:15709`) |
| **Audit log** | API / WEB | Platform-wide audit log with filters and an "Impersonations only" toggle (`39:16118`, without the hash chain) |
| **Overview** | API / WEB | A minimal dashboard: counts that need no analytics pipeline and a "Needs attention" box (subset of `15:123`) |

**Storefront (SF):** one change: a suspended shop renders the "temporarily unavailable" page (§7.4) instead of "Store not
found".

**Out of scope** (hide, never fake; each has a row in §1.1): every metric that needs cross-tenant aggregation or a
revenue model: MRR, ARR, ARPA, GMV, AOV, orders 30d, churn, trial → paid, plan mix over time, health score, "last
active" (**8.2**); Revenue reports, Integration health, incidents (**8.2**); Risk network, fraud flags, appeals (**8.8**
fake-order guard); Support tickets and Announcements (**8.9**); Themes & templates, theme editor (later); Plans & pricing
editor and "Schedule migration" (Q98); dunning settings, failed-payment retry queue, "Retry now", "Send reminder"
(Q97); refunds of platform payments (Q89 stays); Add merchant wizard (Q99); bulk actions on the merchants list; Export
CSV; internal notes; the merchant-detail Orders and Integrations tabs; custom platform roles, "New role", "Save
permissions"; IP allowlist UI, active sessions list, security keys, "trust this device"; audit hash chain and
before/after diffs (Q100); data deletion 90 days after suspension (Q15, Phase 9); every Platform settings tab other than
the domains table.

### Conventions in this file
- **Platform roles** (P8-2): `super_admin`, `billing`, `support`, `read_only`. "SA / BI / SU / RO" in tables.
  "Staff" in this file means **platform staff** (Storeplix employees), never a merchant's staff role, unless it says
  "merchant staff".
- `T` = `X-Tenant-Id` (merchant API only; the admin API never reads it).
- **Foreign and unknown ids** on `/admin/*` → 404 `not_found`. There is no "other tenant" for the admin API, but every
  `{invoice}`, `{domain}`, `{member}` nested under `{tenant}` must belong to that tenant, else 404.
- **Reason:** every admin write takes `reason` (string, 5–500 chars, trimmed) and stores it in the audit row. Missing
  → 422 `validation_failed`. **As built:** `POST /admin/invoices/{invoice}/resend` and `POST /admin/domains/{domain}/recheck`
  take no body (no reason), and `POST /admin/tenants/{tenant}/impersonations` writes its audit row at ticket consume (P8-11).
- **Money** is integer paisa with `currency: "BDT"`; dates are UTC ISO 8601; the UI shows them in Asia/Dhaka.

### Standing rules for every agent
- Browser checks: Playwright only (never the Claude in Chrome extension or the user's Chrome).
- Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>` or commit. Touch only owned files (§14).
- New dependencies: at least 14 days old, pinned exactly. API: one TOTP library (`pragmarx/google2fa` or equivalent)
  and a QR SVG renderer (`bacon/bacon-qr-code`); WEB: none.
- Postgres (Docker, role init script) for API work; RLS on (`TENANCY_RLS=true`, app role + admin role) for every admin
  and impersonation test.

---

## 0. Summary and goals

1. Storeplix staff sign in to `admin.storeplix.com` with a password **and** a TOTP code, on a session that can't be
   used against the merchant API, and a merchant session can't be used against the admin API.
2. Staff can find any shop by name, slug, owner email or phone, domain or invoice number; see its owner, members,
   store, plan, invoices, domains and audit history; and act on it (change plan, extend, mark paid, void, suspend,
   reactivate, domain actions) with a reason that lands in the audit log, within a fixed per-role permission matrix.
3. Support can look at a shop **exactly as the owner sees it**, read-only, for at most 15 minutes, with a reason; the
   merchant sees the visit in their own Activity log.
4. Suspending a shop takes the merchant dashboard and every storefront host offline in one action and is fully
   reversible.
5. Cross-tenant reads happen only in the admin API, only on the admin database role, and an arch test keeps them there.

---

## 1. Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| P8-1 | **Two session surfaces.** Every session carries `surface` (`merchant` \| `admin` \| `impersonation`) in the session payload, set at login. `POST /auth/login` (exists) → `merchant`; `POST /admin/auth/login` → `admin` (only after the TOTP step); the impersonation ticket → `impersonation`. Middleware `surface:admin` on `/admin/*` (except the two pre-auth login routes) and `surface:merchant,impersonation` on the existing `tenant` routes; a mismatch → **403 `forbidden`** and nothing else changes. `/auth/me`, `/auth/logout` accept every surface. **Amends** AGENT-CONTRACTS / ADR 0005: the merchant API refuses an `admin` session. | In production the two SPAs have different origins and host-only `__Host-` cookies, but locally `localhost:5173` and `:5174` share one cookie jar (cookies ignore ports), and a staff member may also own a shop. The surface makes "merchant token on `/admin/*`" (SECURITY T11) impossible by construction instead of by cookie scope. |
| P8-2 | **Fixed platform roles** (Figma `39:12019` matrix, minus "Engineering", whose only rows are themes and integrations, not built): `users.platform_role` ∈ `super_admin`, `billing`, `support`, `read_only`, null = not staff. Permissions are an enum `PlatformPermission` with a hard-coded matrix (§2.1); the matrix screen is **read-only** in 8.1. **Amends** DATABASE-DESIGN (`super_admin`/`support`/`finance` → these four). | A fixed matrix is testable as one dataset; editing roles is a security feature on its own (Q96). |
| P8-3 | **Staff accounts are ordinary `users` rows** with `platform_role` set. Sign-in on the admin surface requires `platform_role` not null, `platform_disabled_at` null, an email in `ADMIN_EMAIL_DOMAINS` (default `storeplix.com`; empty in local/testing = any), and TOTP. A staff member's merchant memberships are untouched and are only usable on the merchant surface. Bootstrap: `php artisan platform:grant {email} {role} --reason=` (creates nothing; the user must exist) and `platform:revoke {email} --reason=`. | No second user table, no second password reset flow. A command is the only way to create the first super admin and the break-glass path if the UI is locked out. |
| P8-4 | **TOTP is mandatory** for every staff sign-in (Figma `44:4784`, "Require 2FA" on). RFC 6238, SHA-1, 6 digits, 30 s, ±1 step; the secret is stored encrypted (`encrypted` cast, app key); a used step is remembered for 90 s (replay). First sign-in without a secret → enrolment (QR + manual key, confirm with a code) and **10 single-use recovery codes** shown once (stored hashed). 5 failed codes → that pending login is dropped and the account is locked for 15 min (`platform_locked_until`). "Trust this device" and security keys: out (Q93). | Impersonation and mark-paid on every shop is the most powerful access in the system. The Figma sign-in already designs the 2FA step and the lockout copy. |
| P8-5 | **Admin session lifetime**: idle 30 min (Figma security card), absolute 12 h (Figma "keep me signed in 12 h" becomes the hard cap, no checkbox). Implemented by the existing `EnforceAbsoluteSessionExpiry` with a per-surface limit and a `last_seen` idle check for `admin` only. | Shorter than the merchant 7-day session; same mechanism. |
| P8-6 | **Admin reads use the admin DB role.** Every `/admin/*` read lives in `app/Domain/Admin/**` and queries through `Model::withoutTenancy()` / `PlatformDb` (→ `pgsql_admin`, `BYPASSRLS`, MULTI-TENANCY §9.5). `RlsBypassArchTest` gains `app/Domain/Admin/` in its allowlist; nothing else changes there. Every such query is marked `// cross-tenant: admin <screen>`. | MULTI-TENANCY §9.5 already reserves `pgsql_admin` for "future `/admin/*`". One directory, one test. |
| P8-7 | **Admin writes to tenant data run as the tenant.** An admin action loads the target tenant id on `pgsql_admin`, then runs the **same domain Action** the ops commands use inside `TenantContext::run($tenantId)` on the app connection (RLS on, policies apply). PHASE-7 §4.4 commands and PHASE-6 `domains:suspend` / `domains:reinstate` are refactored into Actions (`App\Domain\Billing\Ops\{MarkInvoicePaid, VoidInvoice, ExtendSubscription, CompPlanChange, ResendInvoice}`, `App\Domain\Domains\Ops\{SuspendDomain, ReinstateDomain}`) with the commands as thin callers, **behaviour-preserving** (existing command tests unchanged and green). | One code path per business rule; writes never bypass RLS `WITH CHECK`. |
| P8-8 | **Audit actor for staff.** `AuditLogger` gains `actor_type: 'platform_user'` (actor id = the staff user id) and `meta.platform_role`. Admin writes put the **target tenant id** on the row (so it appears in the merchant's Activity log, Figma merchant audit) unless the event is platform-only (staff management, sign-in), which keeps `tenant_id` null. The merchant Activity log shows a platform actor as **"Store Plix support"**, never the staff member's name or email. | Merchants should see that Storeplix acted on their shop; staff identities stay internal. |
| P8-9 | **Read-only impersonation by ticket** (ADR 0015). `POST /admin/tenants/{tenant}/impersonations {reason, ticket_ref?}` (SA SU) creates a `platform_impersonations` row and returns a **single-use ticket** (32 random bytes, stored as SHA-256, valid 60 s) and `url = {MERCHANT_APP_URL}/impersonate#ticket=…` (fragment: never sent to a server or logged). The merchant SPA posts it to `POST /auth/impersonation`, which **regenerates the session** on the merchant origin as **the staff user** with `surface: impersonation`, `impersonation_id`, and absolute expiry `started_at + 15 min` (Figma security card; not extendable). The staff user never becomes the merchant user; no merchant password or token is used. | Acting as the staff user keeps every log honest; the ticket keeps the admin session cookie off the merchant origin; a fragment keeps the ticket out of access logs. |
| P8-10 | **What an impersonation session can do.** `ResolveTenant` accepts exactly the impersonated tenant (from the row, not `tenant_users`; any other `X-Tenant-Id` → 403 `forbidden`), with **effective role `owner`** so every read the owner has is visible (incl. costs and billing). Middleware `ReadOnlyImpersonation` (global on `api`) answers **403 `impersonation_read_only`** to every method other than `GET`/`HEAD`/`OPTIONS`, except `POST /auth/logout` and `DELETE /auth/impersonation`. GET routes with side effects are listed and blocked explicitly (`GET /billing/payments/{payment}` provider query → served from the DB without the query; dev routes → 403). A suspended tenant can be impersonated (support needs to see it). `/auth/me` returns the staff user, `tenants: [{id, name, role: "owner"}]` for that tenant only, and `meta.impersonation {id, tenant_id, tenant_name, owner_name, reason, expires_at}`. | "Read-only" enforced in one middleware, not in each controller; the side-effect GET list is short and tested. |
| P8-11 | **Impersonation audit.** `admin.impersonation_started` (tenant row; meta `reason`, `ticket_ref`, `expires_at`) when the ticket is consumed; `admin.impersonation_ended` (meta `ended_by: staff \| expiry \| revoked`, `request_count`) when it ends: `DELETE /auth/impersonation`, expiry noticed on the next request or by the hourly `admin:close-impersonations`, or `POST /admin/impersonations/{id}/revoke` (SA). Every request increments `request_count` and sets `last_request_at` (one `UPDATE … SET request_count = request_count + 1`). Per-request path logging: Q92. An unconsumed ticket expires silently (row `status: expired`, no tenant audit row). | Start/end on the merchant's own log; a counter is enough to spot an unusual session without logging every read. |
| P8-12 | **Suspension = tenant + store.** `POST /admin/tenants/{tenant}/suspend {reason_code, reason, notify}` (SA, and SU per Q94 default no) sets `tenants.status = suspended`, `tenants.suspended_at`, `suspension_reason_code`, and the store's `status = suspended` with `stores.status_before_suspension` (draft/active). Effects: merchant API → 403 `tenant_suspended` (exists; dashboard shows the suspended screen §8.6); every storefront host (platform and custom) → the "temporarily unavailable" page, HTTP 503 + `Retry-After: 86400`, `noindex` (Figma suspend dialog); checkout, cart and storefront order endpoints → 404 `store_not_found` as for an unknown host; **money already in flight still settles** (payment webhooks/returns and courier webhooks resolve by account/route key, not by host, and keep working); billing jobs keep running; custom domains keep their status (not detached). `reactivate {reason, notify}` restores both statuses. Reason codes from the dialog: `unpaid`, `fraud`, `terms_violation`, `merchant_request`, `other`. Confirmation by typing the shop name is client-side only. | Matches the Figma "What happens" list except "orders paused" (no such state; new orders simply can't be placed) and "deleted after 90 days" (Q15, Phase 9). Settling in-flight money avoids orphaned captured payments. |
| P8-13 | **Admin change plan** (`45:4989`): `effective: "now"` = **comp change** (PHASE-7 `billing:change-plan`: plan and interval applied immediately, no invoice, the open invoice of the tenant is voided `superseded`, period dates kept; from Free a new period of one interval starts now); `effective: "next_renewal"` = writes `scheduled_change` exactly as a merchant downgrade would. "Charge today" with proration is **out**: staff who want the merchant to pay use "now" only after a manual payment, or ask the merchant to upgrade (Q95). The dialog shows the quote's warnings (PHASE-7 §8.2 `BillingQuote.warnings`) from `POST /admin/tenants/{tenant}/billing/quote`. | Reuses the Phase 7 state machine without a second invoice-issuing path. |
| P8-14 | **Extend** (`Extend trial` button): `POST /admin/tenants/{tenant}/subscription/extend {days 1–90, reason}` = PHASE-7 `billing:extend` (moves `trial_ends_at` while trialing, else `current_period_end`; in `past_due` moves `grace_ends_at` instead). The button reads "Extend trial" while trialing, "Extend period" otherwise. | Same action as the command; one button. |
| P8-15 | **Mark paid / void / resend** (not designed; added to the invoice drawer `36:1598` as a "More" menu, §8.4): mark paid = PHASE-7 `billing:mark-paid` (`provider: manual`, `reference` required here, `Idempotency-Key` required); void = `billing:void` (open invoices only); resend = re-sends the invoice email to the owner (rate-limited 3/hour per invoice). "Refund" stays hidden (Q89). | Ops already need these; the drawer is where staff look at the invoice. |
| P8-16 | **Platform staff management** (`39:12019`, `45:9344`): SA only. Invite by email (must match `ADMIN_EMAIL_DOMAINS`) + role → `platform_invitations` row, single-use token (SHA-256 stored), 7 days, email with `{ADMIN_APP_URL}/accept-invite#token=…`. Accept page: name + password for a new user, or password confirmation for an existing user with that email; then the TOTP enrolment of P8-4. Change role, disable (sets `platform_disabled_at`, kills that user's admin sessions), re-enable, revoke invitation, reset 2FA (clears the secret; enrolment on next sign-in). An SA can't disable, demote or reset themself, and the **last active SA** can't be disabled or demoted (409 `last_super_admin`). | The screen is designed and an artisan-only team is unmanageable past two people. The last-SA rule prevents lock-out; the command is the break glass. |
| P8-17 | **Global search** (top bar "Find a shop, owner phone, domain or invoice"): `GET /admin/search?q=` (≥ 2 chars) returns up to 5 tenants, 5 domains, 5 invoices; exact match on ULID, invoice number (`SP-…`), hostname; prefix/`ILIKE` on shop name, store slug, owner email, owner phone (digits only, `+88` stripped). | Staff mostly arrive with one of these four identifiers from a support message. |
| P8-18 | **Overview without analytics.** `GET /admin/overview` returns only what a `count(*)` per status can answer: shops by tenant status, subscriptions by status and plan (paying = active non-Free), past-due count and amount, open invoices, custom domains by status (failing = `dns_failing` + `ssl_failed` + `verification_failed`), active impersonations, the 10 newest shops. Every KPI the Figma dashboard shows that isn't in this list is hidden until 8.2. | The page can't be empty in 8.1, and fake numbers are banned. |
| P8-19 | **Admin rate limits and IP allowlist.** Limiter `admin-login`: 5/min per email + IP and 20/min per IP; `admin`: 120/min per staff user; `admin-write`: 30/min per staff user. `ADMIN_IP_ALLOWLIST` (comma-separated CIDRs, empty = off) is enforced on every `/admin/*` route and on `POST /auth/impersonation` (403 `forbidden`, audit `admin.ip_blocked` once per IP per hour). The Figma toggle is shown read-only from config. | Cheap protection for the most powerful surface. |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q91–Q102; proposed defaults in effect until answered)

| Q | Question | Proposed default |
|---|---|---|
| Q91 | Platform roles: Figma shows five (incl. Engineering) and a "New role" editor | Four fixed roles (P8-2); Engineering and custom roles when themes/integrations admin exists |
| Q92 | Log every page a staff member opens while impersonating? | No; start/end audit rows + request counter (P8-11). Per-request logging is a table write per GET |
| Q93 | 2FA options | TOTP + recovery codes only; no "trust this device", no security keys (P8-4) |
| Q94 | May Support suspend shops? (Figma matrix row "suspend") | No; Super admin only. Support can impersonate |
| Q95 | Admin "Change plan → Now (prorate) → Charge today" | Not built; "Now" is a comp change with no charge (P8-13) |
| Q96 | Editable permission matrix | Read-only in 8.1 (P8-2) |
| Q97 | Dunning settings, retry queue, "Retry now", "Send reminder" (`34:859`, `33:4851`) | Not built; Phase 7 has no auto-debit (Q83), so there is nothing to retry. Renewal reminders stay automatic |
| Q98 | Plans & pricing editor, "Schedule migration" (`35:1193`) | Not built; plan prices stay in `PlanSeeder` + a migration |
| Q99 | "Add merchant" wizard (`46:6071`) incl. WooCommerce import and welcome SMS | Not built; merchants sign up themselves |
| Q100 | Hash-chained audit log with "Verify chain" and before/after diffs (`39:16118`) | Not built; `audit_logs` is already append-only at the DB level (T18). Phase 9.4 |
| Q101 | Suspended storefront: "temporarily unavailable" (Figma) or "Store not found" | Figma: 503 "temporarily unavailable" page, no shop name or reason shown (P8-12) |
| Q102 | Notify the owner on suspend / reactivate / staff plan changes | Email the owner when the dialog's "Notify" is checked (default checked); no SMS in 8.1 |

---

## 2. Permissions

### 2.1 Platform permission matrix (`PlatformPermission`, one dataset row per cell in `AdminPermissionTest`)

| Permission | Endpoints | SA | BI | SU | RO |
|---|---|---|---|---|---|
| `view_merchants` | overview, search, tenants list/detail, members, domains list, invoices list/detail/pdf, audit log | ✓ | ✓ | ✓ | ✓ |
| `impersonate` | create impersonation | ✓ | | ✓ | |
| `manage_billing` | quote, change plan, extend, mark paid, void, resend | ✓ | ✓ | | |
| `manage_domains` | domain re-check | ✓ | | ✓ | |
| `suspend` | suspend / reactivate tenant, suspend / reinstate domain, revoke an impersonation | ✓ | | | |
| `manage_team` | staff list (read: all roles), invite, change role, disable, reset 2FA | ✓ | | | |

Staff list and the read-only matrix are readable by every role (`view_merchants`); writes need `manage_team`. A missing
permission → 403 `forbidden`; the UI hides the action.

### 2.2 Merchant side
No merchant permission changes. In an impersonation session the effective role is `owner` for reads (P8-10) and every
write is refused before the permission check.

---

## 3. Sign-in and sessions (owner API, WEB)

### 3.1 Admin sign-in flow
1. `POST /admin/auth/login {email, password}` (CSRF as today). Wrong credentials, a non-staff user, a disabled or locked
   staff user, or an email outside `ADMIN_EMAIL_DOMAINS` → the **same** 422 `validation_failed` on `email`
   ("These credentials do not match our records.") and audit `admin.login_failed` (platform row, meta `email_hash`
   only). Success → **200** `{ step: "totp" | "enroll", login_token, expires_at }`; no session is created yet.
   `login_token` = 32 random bytes, SHA-256 in cache for 5 min, bound to the user and IP.
2. `step: enroll` → `GET /admin/auth/enroll?login_token=` answers `{ otpauth_uri, qr_svg, secret }` once per token;
   `POST /admin/auth/enroll {login_token, code}` stores the secret and answers `{ recovery_codes: string[10] }` plus
   the session (step 4).
3. `POST /admin/auth/totp {login_token, code}` (6 digits) **or** `{login_token, recovery_code}` (10 chars, single use).
   Wrong → 422 `invalid_totp` with `details.attempts_left`; the 5th failure drops the token, sets
   `platform_locked_until = now + 15 min` and audits `admin.locked`.
4. Success → `session()->regenerate()`, `surface: admin`, absolute and idle expiry (P8-5), audit `admin.login`
   (platform row), **200** `AdminSession {user: PlatformUser, session_expires_at}`.
- `GET /admin/auth/me` → 200 `AdminSession` (refreshes idle), 401 when signed out or expired.
- `POST /admin/auth/logout` → 204.
- Recovery codes used: `meta.recovery_codes_left` on `AdminSession`; the UI warns under 3.

### 3.2 Merchant side changes
- `POST /auth/login`, registration and invitation accept set `surface: merchant` (existing sessions without a surface
  are treated as `merchant`; no forced logout on deploy).
- `POST /auth/impersonation {ticket}` (guest or any session; CSRF; `ADMIN_IP_ALLOWLIST`; limiter 10/min per IP) →
  ticket unknown, used, expired, or the row not `pending` → 404 `not_found` (same body for all). The staff user must
  still be active staff with `impersonate`. Success: regenerate session (any current session on that origin is
  replaced), `surface: impersonation`, row → `active`, `started_at`, `expires_at = started_at + 15 min`, audit
  `admin.impersonation_started`; **200** `{user, impersonation: Impersonation, session_expires_at}`.
- `DELETE /auth/impersonation` → ends the row (`ended_by: staff`), logs out, **204**. The SPA then closes the tab or
  shows "Impersonation ended" with a link back to the admin app.
- On expiry or revoke the next request answers **401 `impersonation_ended`**, the session is invalidated, and the SPA
  shows the same "ended" screen (not the login page).

---

## 4. Suspension, domains, billing actions (owner API)

### 4.1 Tenant suspension (P8-12)
- `TenantSuspension` Action: in one transaction on the app connection inside `TenantContext::run`: tenant row (platform
  table, updated on `pgsql_admin` in the same request, see below), store row, audit `tenant.suspended` (tenant row,
  meta `reason_code`, `reason`, `notify`). The tenant row update and the store update are two connections, so the
  order is: store first (RLS, app role), then tenant; reactivate in the reverse order. A crash between them leaves a
  store suspended under an active tenant, which `admin:check-suspensions` (hourly) reports and fixes from the tenant
  status (the tenant status is the source of truth).
- `sp_resolve_host` (definer, **amends** MULTI-TENANCY §9.4 B1) returns `(tenant_id, store_id, suspended boolean)`
  for active domains of draft/active **and** suspended stores; `PreTenantLookup::resolveHost` passes the flag on.
  `ResolveStorefront` with `suspended = true`: `GET /storefront/config` → **200** `StorefrontSuspended`
  (`{availability: "suspended"}` and nothing else: no name, theme or contact); every other storefront endpoint → 404
  `store_not_found`.
- Cache busts: tenant cache, storefront config cache and the storefront ISR tag for every host of the store.
- Reactivate on a tenant whose store was `draft` before → `draft` (Coming soon page again).
- Suspending twice → 409 `invalid_state_transition`; reactivating an active tenant → same.

### 4.2 Domains (P8-7)
- `POST /admin/domains/{domain}/recheck` = the merchant re-check Action (PHASE-6) run as the tenant, **ignoring** the
  merchant's re-check cooldown but subject to `admin-write`. Plan gate still applies (a `plan_limit` row on Free → 402
  shown to staff as "Not included in the shop's plan").
- `suspend {reason}` / `reinstate {reason}` = the refactored `domains:suspend` / `domains:reinstate` Actions.

### 4.3 Billing (P8-13 – P8-15)
Each endpoint calls the Phase 7 Action as the tenant. Audit actions keep the names Phase 7 actually writes
(`billing.manual_payment`, `billing.invoice_voided`, `billing.period_extended`, `subscription.plan_changed` with
`meta.kind: comp`, `subscription.change_scheduled`) plus `billing.invoice_resent`, with the platform actor (P8-8).
**As built:** mark paid accepts an `open` or `void` invoice (late payment, as the command) and answers 409
`invoice_not_open` only for `paid`; change-plan idempotency is a 24 h cache record (no invoice row exists for a comp
change); the comp change of P8-13 (void the open invoice, keep the period) is the staff variant of `CompPlanChange`, the
`billing:change-plan` command keeps its Phase 7 behaviour. Emails to the owner follow the Phase 7 templates; a comp change sends "Your plan changed to
{plan}" when `notify` is true.

### 4.4 Jobs and commands
- `admin:close-impersonations` (every 5 min): `active` rows past `expires_at` → `ended` (`ended_by: expiry`) + audit;
  `pending` rows older than 60 s → `expired`.
- `admin:check-suspensions` (hourly): store/tenant suspension mismatches → fix + log warning.
- `platform:grant`, `platform:revoke`, `platform:reset-2fa {email} --reason=` (break glass; audit `actor_type: system`,
  `--force` in production).

---

## 5. Data (migrations, owner API) — prefix `2026_09_01_`, forward-only

### 5.1 New and changed tables

**`users`** (platform table): `platform_role varchar(16) null CHECK IN ('super_admin','billing','support','read_only')`,
`platform_disabled_at timestamptz null`, `platform_locked_until timestamptz null`, `totp_secret text null`
(encrypted), `totp_confirmed_at timestamptz null`, `totp_last_step bigint null`, `platform_invited_by char(26) null`.
Partial index `(platform_role) WHERE platform_role IS NOT NULL`.

**`platform_recovery_codes`** (platform): `id`, `user_id` FK cascade, `code_hash char(64)`, `used_at timestamptz null`,
`created_at`. Unique `(user_id, code_hash)`.

**`platform_invitations`** (platform): `id`, `email citext`, `role varchar(16)`, `token_hash char(64) unique`,
`invited_by` FK users, `expires_at`, `accepted_at null`, `revoked_at null`, timestamps. Partial unique `(email) WHERE
accepted_at IS NULL AND revoked_at IS NULL`.

**`platform_impersonations`** (platform; **no `tenant_id` column on purpose**, so it is not a tenant table under RLS
and the app role can read it during an impersonated request): `id`, `staff_user_id` FK users, `target_tenant_id` FK
tenants cascade, `reason varchar(500)`, `ticket_ref varchar(64) null`, `ticket_hash char(64) unique`, `status
varchar(16)` (`pending`, `active`, `ended`, `expired`), `ticket_expires_at`, `started_at null`, `expires_at null`,
`ended_at null`, `ended_by varchar(16) null` (`staff`, `expiry`, `revoked`), `request_count int default 0`,
`last_request_at null`, `ip varchar(45)`, `user_agent varchar(255)`, timestamps. Index `(target_tenant_id,
created_at)`, `(status, expires_at)`. Added to `RlsTables::PLATFORM`.

**`tenants`**: `suspended_at timestamptz null`, `suspension_reason_code varchar(32) null`, `suspended_by char(26) null`.
CHECK `status IN ('active','suspended')`.

**`stores`**: `status_before_suspension varchar(16) null CHECK IN ('draft','active')`.

**`audit_logs`**: new CHECK `actor_type IN ('user','system','platform_user')` (none exists today).
New index `(action, created_at)` and `(actor_id, created_at)` for the admin filters.

**`sessions`**: unchanged (the surface lives in the payload). Admin "kill sessions" on disable deletes rows by
`user_id` **whose payload surface is admin**, so the user's merchant sessions survive.

### 5.2 Bypass paths
- `app/Domain/Admin/**` (P8-6), added to the `RlsBypassArchTest` allowlist and MULTI-TENANCY §9.5.
- `sp_resolve_host` gains the `suspended` column (§4.1); the function is replaced in the same migration with the same
  owner, grants and `search_path`.
- The impersonation lookup reads `platform_impersonations` (platform table) on the app connection; no definer needed.

---

## 6. API endpoints (owner API)

All `/admin/*` routes: `auth:sanctum` (session guard) + `surface:admin` + `platform` (active staff, not locked) +
`platform.ip` (allowlist) + limiter `admin`, writes also `admin-write`; reads on `pgsql_admin` (P8-6). Lists use offset
pagination (`page`, `per_page` ≤ 100, `PaginationMeta`). `Cache-Control: private, no-store` on every admin response.

### 6.0 New error codes (add to API-CONVENTIONS §3)
| HTTP | code | When |
|---|---|---|
| 403 | `impersonation_read_only` | any write in an impersonation session |
| 401 | `impersonation_ended` | request after the impersonation expired or was revoked |
| 422 | `invalid_totp` | wrong or replayed TOTP / recovery code (`details.attempts_left`) |
| 409 | `last_super_admin` | disabling or demoting the last active super admin |
| 409 | `staff_self_action` | an SA disabling, demoting or resetting 2FA of themself |
Reused: `forbidden`, `not_found`, `validation_failed`, `invalid_state_transition`, `invoice_not_open`,
`plan_unchanged`, `plan_unavailable`, `idempotency_key_*`, `rate_limited`, `tenant_suspended`.

### 6.1 Auth (admin)
| Method & path | Body | Success |
|---|---|---|
| `POST /admin/auth/login` | `{email, password}` | 200 `AdminLoginStep` |
| `GET /admin/auth/enroll` | `?login_token` | 200 `TotpEnrollment` |
| `POST /admin/auth/enroll` | `{login_token, code}` | 200 `AdminSession` + `{recovery_codes}` |
| `POST /admin/auth/totp` | `{login_token, code}` or `{login_token, recovery_code}` | 200 `AdminSession` |
| `GET /admin/auth/me` | — | 200 `AdminSession` |
| `POST /admin/auth/logout` | — | 204 |
| `GET /admin/invitations/{token}` (guest) | — | 200 `{email, role, existing_user: boolean}`; 404 unknown/used/expired |
| `POST /admin/invitations/{token}/accept` (guest) | `{name?, password, password_confirmation?}` | 200 `AdminLoginStep` (`step: enroll`) |

### 6.2 Merchants (all `view_merchants` unless noted)
| Method & path | Query / body | Success |
|---|---|---|
| `GET /admin/overview` | — | 200 `AdminOverview` (P8-18) |
| `GET /admin/search` | `q` | 200 `AdminSearchResult` |
| `GET /admin/tenants` | `filter[status]` (`active`,`trial`,`past_due`,`suspended`; tab counts in `meta.counts`), `filter[plan]`, `filter[q]`, `filter[created_from\|to]`, `sort` (`-created_at` default, `name`, `-current_period_end`) | 200 `AdminTenantSummary[]`, `meta: PaginationMeta & {counts}` |
| `GET /admin/tenants/{tenant}` | — | 200 `AdminTenant` (tenant, store, owner, subscription, usage vs limits from `FeatureGate`, domain count, member count, open invoice) |
| `GET /admin/tenants/{tenant}/members` | — | 200 `AdminTenantMember[]` (name, email, phone, role, joined, pending invitations) |
| `GET /admin/tenants/{tenant}/domains` | — | 200 `AdminDomain[]` |
| `GET /admin/tenants/{tenant}/invoices` | `page`, `filter[status]` | 200 `AdminInvoiceSummary[]` |
| `GET /admin/tenants/{tenant}/audit-logs` | as §6.5 | 200 `AdminAuditEntry[]` |
| `POST /admin/tenants/{tenant}/suspend` (`suspend`) | `{reason_code, reason, notify}` | 200 `AdminTenant` |
| `POST /admin/tenants/{tenant}/reactivate` (`suspend`) | `{reason, notify}` | 200 `AdminTenant` |

"Trial" tab = subscription `trialing`; "Paying" (Figma) = `filter[status]=paying` (active, non-Free plan); "All".

### 6.3 Billing
| Method & path | Perm | Body | Success |
|---|---|---|---|
| `GET /admin/invoices` | view | `filter[status]` (`open`,`paid`,`void`), `filter[provider]`, `filter[q]` (number, shop), `filter[from\|to]` | 200 `AdminInvoiceSummary[]` |
| `GET /admin/invoices/{invoice}` | view | — | 200 `AdminInvoice` (Phase 7 `BillingInvoice` + tenant name/slug + payments with provider reference) |
| `GET /admin/invoices/{invoice}/pdf` | view | — | as PHASE-7 §6.1 pdf |
| `POST /admin/invoices/{invoice}/mark-paid` | billing | `{reference, reason}`; `Idempotency-Key` | 200 `AdminInvoice`; 409 `invoice_not_open` |
| `POST /admin/invoices/{invoice}/void` | billing | `{reason}` | 200; 409 `invoice_not_open` |
| `POST /admin/invoices/{invoice}/resend` | billing | — | 202 |
| `POST /admin/tenants/{tenant}/billing/quote` | billing | `{plan_code, interval, effective}` | 200 `BillingQuote` (no side effects) |
| `POST /admin/tenants/{tenant}/billing/change-plan` | billing | `{plan_code, interval, effective: "now"\|"next_renewal", reason, notify}`; `Idempotency-Key` | 200 `Subscription`; 409 `plan_unchanged`; 422 `plan_unavailable` |
| `POST /admin/tenants/{tenant}/subscription/extend` | billing | `{days, reason}` | 200 `Subscription` |

### 6.4 Domains
| Method & path | Perm | Query / body | Success |
|---|---|---|---|
| `GET /admin/domains` | view | `filter[state]` (`all`, `dns_pending`, `ssl_failing`, `active`, `suspended`, `expired`), `filter[q]` | 200 `AdminDomain[]` (hostname, shop, status, failure code, dns/ssl state, last checked) |
| `POST /admin/domains/{domain}/recheck` | domains | — | 202 `AdminDomain` |
| `POST /admin/domains/{domain}/suspend` | suspend | `{reason}` | 200 |
| `POST /admin/domains/{domain}/reinstate` | suspend | `{reason}` | 200 |

"Expiring ≤ 14 d" chip: hidden (certificates are managed by Cloudflare/Caddy; no expiry is stored).

### 6.5 Audit log, impersonations, team
| Method & path | Perm | Query / body | Success |
|---|---|---|---|
| `GET /admin/audit-logs` | view | `filter[tenant]`, `filter[actor]` (user id), `filter[actor_type]`, `filter[action]` (prefix, e.g. `billing.`), `filter[from\|to]`, `filter[impersonation]=1`; cursor pagination (`cursor`, `per_page` ≤ 100) | 200 `AdminAuditEntry[]` (actor name/email for staff and users, tenant name, action, subject, IP, user agent, reason, meta) |
| `POST /admin/tenants/{tenant}/impersonations` | impersonate | `{reason, ticket_ref?}` | 201 `ImpersonationTicket {id, url, ticket_expires_at}` |
| `GET /admin/impersonations` | view | `filter[status]`, `filter[staff]`, `filter[tenant]` | 200 `Impersonation[]` |
| `POST /admin/impersonations/{id}/revoke` | suspend | `{reason}` | 200 `Impersonation` |
| `GET /admin/team` | view | `filter[status]` (`active`,`invited`,`disabled`), `filter[role]`, `filter[q]` | 200 `PlatformStaff[]`, `meta: {counts, matrix: PlatformRoleMatrix, security: {totp_required: true, ip_allowlist_enabled, session_idle_minutes: 30, impersonation_minutes: 15}}` |
| `POST /admin/team/invitations` | team | `{email, role}` | 201 `PlatformInvitation` |
| `DELETE /admin/team/invitations/{id}` | team | — | 204 |
| `PATCH /admin/team/members/{user}` | team | `{role, reason}` | 200 `PlatformStaff` |
| `POST /admin/team/members/{user}/disable` \| `/enable` \| `/reset-2fa` | team | `{reason}` | 200 `PlatformStaff` |

### 6.6 Merchant API additions
| Method & path | Body | Success |
|---|---|---|
| `POST /auth/impersonation` | `{ticket}` | 200 `{user, impersonation, session_expires_at}` |
| `DELETE /auth/impersonation` | — | 204 |
| `GET /auth/me` (exists) | — | + `meta.impersonation` (null outside impersonation) |
| `GET /storefront/config` (exists) | — | may answer `StorefrontSuspended` (§4.1) |

---

## 7. Apps

### 7.1 Super admin SPA (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`, page `5:189`
| Route | Frame | Build |
|---|---|---|
| `/login`, 2FA, enrol, recovery | `44:4707`, `44:4784` | Email + password, then 6-digit code; enrol screen (composed from `44:4784`: QR, manual key, code, then recovery codes with Copy/Download .txt and "I saved them"); lockout copy as designed. No "keep me signed in" checkbox, no security key, no trust-device. Left panel: product copy only (uptime/GMV hidden) |
| `/accept-invite` | composed from `45:9344` + sign-in | Name, password, then enrolment |
| `/` Dashboard | `15:123` subset | Range tabs hidden; KPI tiles **Active shops (paying vs free)** only; "Needs attention" box (past due, failing domains, active impersonations); "New merchants" list (shop, domain, plan, status, created). Every other tile/chart hidden |
| `/merchants` | `32:5527` | Header counts without MRR; tabs All / Paying / Trial / Past due / Suspended with counts; search; Plan and Signed-up filters (District, Health, More filters hidden); columns Shop, Owner, Plan, Status, Signed up (MRR, Orders 30d, GMV 30d, Health, Last active hidden); no checkboxes / bulk bar, no Export, no Add merchant; row menu: Open, Impersonate |
| `/merchants/:id` | `33:4851` | Header + actions Change plan, Extend trial/period, Suspend ↔ Reactivate, Impersonate (per permission). KPI tiles: hidden except **Lifetime paid** (sum of paid invoices). Past-due banner without Send reminder / Retry now. Tabs: **Overview** (usage vs limits without SMS credits, recent invoices, subscription card, audit excerpt), **Billing** (invoices table + drawer), **Domains** (composed from the domains table), **Staff · N** (members), **Audit log**. Orders, Integrations, Notes tabs hidden |
| dialogs | `45:4989`, `45:8866`, composed | Change plan (effective Now/At next renewal, reason, notify; no "Charge today"); Suspend (as designed, reason codes, type-to-confirm, "data kept 90 days" line removed); Reactivate and Impersonate reason dialogs composed from the Suspend/Change-plan dialog pattern (reason textarea, optional ticket ref, "Read-only · 15 minutes · audited" note) |
| `/billing` | `34:859` | Invoice table only: tabs All / Open / Paid / Void (Figma Failed/Retrying/Refunded → hidden), search, Method filter; KPI row, retry queue and dunning settings hidden |
| invoice drawer | `36:1598` | As designed minus Refund; "More" menu: Mark paid (reference + reason), Void (reason), Resend |
| `/domains` | `45:8156` (table) | Lives as its own sidebar item under Operations ("Domains") instead of Platform settings; chips All / DNS pending / SSL failing / Suspended; columns Domain, Shop, DNS, SSL, Status, Last checked; row menu Re-check, Suspend/Reinstate |
| `/team` | `39:12019`, `45:9344` | Staff table and tabs, read-only matrix (four roles), security card read-only from `meta.security`, invite modal; 2FA column = enrolled yes/no; Active sessions hidden; New role / Save permissions hidden |
| `/audit-log` | `39:16118` | Filters and columns as designed + "Impersonations only"; expanded row shows event id, IP, user agent, reason, `meta` JSON with Copy JSON. "Kept 2 years · hash-chained", Verify chain, Export CSV, before/after diff hidden |
| `/impersonations` | composed from the audit table | Active and recent sessions, Revoke (SA) |
| top bar | `15:123` | Global search with grouped results (P8-17); "Impersonate shop" opens a shop picker → the reason dialog; bell hidden |
| nav | `15:2` | Items not built in 8.1 (Revenue reports, Integration health, Risk network, Support tickets, Announcements, Plans & features, Themes & templates, Platform settings) are **removed** from the sidebar (no placeholder pages in production) |

Every screen ships empty / loading / error states from Figma section `148:34032` (the admin page has none). 1280 px is
the design width; the app must stay usable at 1024 px. No 390 px requirement for the admin app.

### 7.2 Merchant dashboard (owner WEB)
- `/impersonate` route: reads the ticket from `location.hash`, clears the hash with `history.replaceState`, calls
  `POST /auth/impersonation`, then routes to `/`. Errors: "This link has expired. Start again from Store Plix admin."
- **Impersonation frame** (`44:15709`): amber border around the app and the top banner "You are viewing {shop} as
  {owner} (owner) · Reason: {reason} · Read-only · mm:ss left · Exit impersonation". Countdown from
  `meta.impersonation.expires_at`; at 0 or on 401 `impersonation_ended` → "Impersonation ended" screen.
- Writes are not hidden one by one: a global mutation error handler shows the toast "Read-only support session.
  Changes are disabled." for 403 `impersonation_read_only`. Primary create buttons on list pages are disabled when
  `meta.impersonation` is set (one `useReadOnly()` hook in the shared layout).
- **Suspended shop screen** for 403 `tenant_suspended` (composed from `148:34032` error state): "Your shop is
  suspended", "Contact Store Plix support", Sign out. Today this error has no screen.
- Activity log shows `actor_type: platform_user` as "Store Plix support".

### 7.3 Storefront (owner SF)
- Config answer `availability === "suspended"` (`StorefrontSuspended`) → render a bare "This store is temporarily unavailable" page (no theme, no
  shop name, `noindex`, HTTP 503, `Retry-After: 86400`, `Cache-Control: no-store`) on every route, like the draft
  Coming soon page. Copy and layout from the Coming soon page with different text.

---

## 8. Appendix A — `packages/types` additions (orchestrator writes them from openapi 1.9.0; additive)

`PlatformRole`, `PlatformPermission`, `PlatformUser {id, name, email, platform_role, totp_enrolled, recovery_codes_left}`,
`AdminLoginStep {step: 'totp' | 'enroll', login_token, expires_at}`, `TotpEnrollment {otpauth_uri, qr_svg, secret}`,
`AdminSession {user: PlatformUser, session_expires_at}`, `AdminOverview`, `AdminSearchResult {tenants, domains,
invoices}`, `AdminTenantSummary`, `AdminTenant`, `AdminTenantMember`, `AdminDomain`, `AdminInvoiceSummary`,
`AdminInvoice`, `AdminAuditEntry`, `Impersonation`, `ImpersonationTicket`, `PlatformStaff`, `PlatformInvitation`,
`PlatformRoleMatrix`, `SuspensionReasonCode`, `AdminChangePlanInput`, `AdminSuspendInput`; `MeResponse.meta.impersonation`;
`getStorefrontConfig` answers `StorefrontConfig | StorefrontSuspended`; `AuditActorType` gains `'platform_user'`. Field lists are fixed in
openapi 1.9.0; `packages/api-client` gets an `admin` namespace.

---

## 9. Security checklist (Phase 8.1; numbering continues S53–S66; each has a test in §10)

| # | Threat | Control | Test |
|---|---|---|---|
| S67 | **Merchant session on admin API** (T11) | `surface:admin` + active `platform_role` on every `/admin/*` | Merchant session (also for a user who has `platform_role`) → 403 on every admin route (route-list dataset) |
| S68 | **Admin session on merchant API** | `surface:merchant,impersonation` on `tenant` routes | Admin session + valid `X-Tenant-Id` of the staff user's own shop → 403 |
| S69 | **Password-only staff takeover** | TOTP mandatory, replay window, lockout, recovery codes hashed and single use | No session before TOTP; same code twice → 422; 5 failures → locked 15 min; used recovery code → 422 |
| S70 | **Staff enumeration** | Identical 422 for wrong password / non-staff / disabled / wrong domain; constant-time hash check (`CredentialVerifier`) | Four cases, identical bodies |
| S71 | **Impersonation writes** | `ReadOnlyImpersonation` before routing to controllers; side-effect GET list | Dataset over every non-GET merchant route → 403 `impersonation_read_only`, DB unchanged; `GET /billing/payments/{id}` makes no provider call |
| S72 | **Impersonation scope creep** | Tenant from the row only; any other `X-Tenant-Id` → 403; staff's own memberships hidden | Impersonating A with `X-Tenant-Id: B` (staff owns B) → 403 |
| S73 | **Ticket theft / replay** | 60 s, single use, hashed, fragment URL, regenerate session, allowlist | Second use → 404; expired → 404; ticket not in any server log line (log capture) |
| S74 | **Overlong / orphaned impersonation** | Absolute 15 min, revoke, close job, disabled staff → session ends | Clock + 16 min → 401 `impersonation_ended`; revoke → next request 401; disabling the staff user ends their impersonations |
| S75 | **Privilege inside the admin** | `PlatformPermission` matrix | Dataset: every admin write × four roles → 200/201/202 or 403 exactly per §2.1 |
| S76 | **Unaccountable admin action** | Reason required; audit with platform actor on the tenant row | Every admin write without reason → 422; with reason → one audit row with `actor_type: platform_user`, `meta.reason` |
| S77 | **Cross-tenant reads leaking outside admin** (T1) | `pgsql_admin` only in `app/Domain/Admin/**` + existing allowlist | `RlsBypassArchTest`; admin routes resolve on `pgsql_admin`, impersonation on `pgsql` with RLS (rls group) |
| S78 | **Admin writes bypassing RLS** | Actions run as the tenant on the app role (P8-7) | With RLS on, mark-paid / suspend / recheck succeed and an Action given a mismatched tenant id fails `WITH CHECK` |
| S79 | **Lock-out / self-escalation** | Last-SA and self-action rules; `platform:grant` audit | Demote last SA → 409; SA demotes self → 409; BI calls team write → 403 |
| S80 | **Suspended shop still selling** | `sp_resolve_host` flag; storefront endpoints 404; config `StorefrontSuspended` | Suspended: cart/checkout → 404 `store_not_found`; config → `{availability: "suspended"}`; payment webhook for an in-flight payment still settles |
| S81 | **Staff identity exposed to merchants** | Merchant audit resource maps platform actors to "Store Plix support" | Merchant `GET /audit-logs` for an admin action has no staff name/email/id |
| S82 | **CSRF / cross-origin on admin** | Sanctum stateful domains per origin, CSRF on every POST incl. login and impersonation consume | POST without CSRF → 419 |

SECURITY.md gets **T32 "Platform staff misuse and admin takeover"** (S67–S82) and T11 points to it.

---

## 10. Test requirements

### API (Pest; groups `admin`, `impersonation`; security items also in `security`; RLS cases also in `rls`)
- `AdminPermissionTest`: dataset over every `/admin/*` route × {guest, merchant session, admin session per role,
  disabled staff, locked staff} → expected status (S67, S75).
- `AdminLoginTest`: TOTP happy path, enrolment, recovery codes, replay, lockout, enumeration (S69, S70), idle and
  absolute expiry, `ADMIN_EMAIL_DOMAINS`, `ADMIN_IP_ALLOWLIST`.
- `ImpersonationTest`: ticket lifecycle, session regeneration, `/auth/me` shape, every non-GET merchant route refused
  (generated from the route list, so a new route is covered automatically), side-effect GET list, scope (S72), expiry,
  revoke, request counter, audit rows (start/end on the tenant), suspended tenant viewable.
- `SuspensionTest`: suspend/reactivate (draft and active stores), merchant 403, storefront config `suspended`, cart and
  checkout 404, in-flight bKash/SSLCommerz webhook settles, courier webhook still updates, cache busts, double suspend
  409, `admin:check-suspensions` repair.
- `AdminBillingTest`: each action = the Phase 7 command result (shared fixtures), reason/idempotency, permissions;
  Phase 7 command tests **unchanged** and green after the refactor.
- `AdminReadsTest`: filters, tab counts, search matching rules, pagination, 404 for nested foreign ids, admin reads
  run on `pgsql_admin` (assert connection name) and see every tenant with RLS on.
- `TeamTest`: invite/accept (new and existing user), revoke, role change, disable kills admin sessions only,
  last-SA and self rules, `platform:*` commands.
- `MerchantAuditActorTest` (S81).

### Web (Vitest + Testing Library)
- super-admin: login + TOTP + enrolment flows, permission-hidden actions per role, each dialog's validation (reason,
  type-to-confirm), merchants list filters → query string, invoice drawer menu, empty/loading/error states.
- merchant-dashboard: `/impersonate` hash handling, banner + countdown, read-only toast, ended screen, suspended screen.
- storefront: suspended config → unavailable page with 503 status and `noindex`.

### QA (Playwright, `tests/e2e/specs/phase8.*.spec.ts`)
- `phase8.admin-auth`: a seeded super admin (fixed TOTP secret in the e2e seeder, codes computed in the spec) signs
  in; wrong code; lockout; merchant session rejected on admin routes.
- `phase8.merchants`: find a fresh shop by owner phone, open detail, extend trial, change plan now (comp), mark an open
  invoice paid, void, see each in the shop's audit tab **and** in the merchant's Activity log as "Store Plix support".
- `phase8.impersonation`: start with a reason → merchant dashboard with banner, read pages incl. orders and billing,
  a create button disabled, a forced POST → toast, Exit → ended screen; revoke from admin ends a second session.
- `phase8.suspension`: suspend → merchant dashboard suspended screen, storefront 503 page on the platform host,
  checkout refused; reactivate → storefront back.
- `phase8.team`: invite → accept (enrolment) → sign in as Billing → Suspend hidden and API 403.

---

## 11. Configuration
`ADMIN_APP_URL` (new; invitation links; `http://localhost:5174` locally), `ADMIN_EMAIL_DOMAINS`
(default `storeplix.com`; empty in local/testing), `ADMIN_IP_ALLOWLIST` (empty), `ADMIN_SESSION_IDLE_MINUTES` (30),
`ADMIN_SESSION_ABSOLUTE_HOURS` (12), `IMPERSONATION_MINUTES` (15, max 15 enforced in code),
`IMPERSONATION_TICKET_SECONDS` (60). Sanctum stateful domains already list both SPAs. Compose: `queue` unchanged; the
scheduler gains `admin:close-impersonations` and `admin:check-suspensions`. RUNBOOK §11: first super admin
(`platform:grant`), break-glass 2FA reset, revoking a staff member, suspension procedure.

---

## 12. File ownership for Phase 8.1

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: migrations §5, `app/Domain/Admin/**` (new), `app/Domain/Identity/**` (surfaces, TOTP, impersonation consume), `app/Domain/Tenancy/**` (`ResolveTenant`, `ResolveStorefront`, `PreTenantLookup`, `sp_resolve_host`, arch-test allowlist, `AuditLogger` actor type), the Billing/Domains Action refactor (P8-7, behaviour-preserving), routes, limiters, schedule, mail, e2e seeder for the staff user |
| **WEB** | `apps/super-admin/**` (§7.1), `apps/merchant-dashboard/**` (§7.2), `packages/api-client/**` (`admin` namespace, impersonation), `packages/ui/**` (status pill variants, drawer, data table additions if missing) |
| **SF** | `apps/storefront/**` (§7.3 only) |
| **QA** | `tests/e2e/**`, `.github/**`, `docker-compose.yml`, `infrastructure/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-1-qa.md`, `docs/deployment/RUNBOOK.md` §11 |
| **Orchestrator** | `packages/types` (§8, from openapi 1.9.0) |
| **ARCH** | This file, `openapi.yaml` 1.9.0, ADR 0015, DATABASE-DESIGN (§5), API-CONVENTIONS (§6.0), SECURITY (T32, T11), MULTI-TENANCY (§9.4 B1, §9.5 admin), OPEN-QUESTIONS Q91–Q102, FIGMA-INDEX (admin frame ids), roadmap |

---

## 13. Order of work
1. **ARCH:** openapi 1.9.0 + ADR 0015 + doc amendments; PO reviews §1.1. Orchestrator: types.
2. **API:** migrations + surfaces + admin sign-in/TOTP (unblocks WEB login) → admin reads (overview, tenants, search,
   invoices, domains, audit) → Action refactor with Phase 6/7 command tests green → admin writes → suspension +
   `sp_resolve_host` → impersonation → team/invitations → commands and jobs.
3. **WEB:** super-admin shell, login and reads against mocks from day one; merchant-dashboard impersonation frame and
   suspended screen in parallel; then against the API.
4. **SF:** suspended page (small; after `StorefrontSuspended` lands in types).
5. **QA:** e2e seeder hooks, `phase8.*` specs, CI groups `admin` and `impersonation` (sqlite, Postgres, `api-rls`),
   RUNBOOK §11 → QA gate `docs/reviews/phase-8-1-qa.md`.

---

## 14. Acceptance criteria
1. A staff member can't get an admin session without password **and** TOTP; a merchant session never works on
   `/admin/*` and an admin session never works on merchant routes (S67–S70).
2. Every §2.1 cell holds in the permission dataset; every admin write needs a reason and leaves one audit row with the
   platform actor, visible to the merchant as "Store Plix support".
3. Staff find a shop by name, slug, owner email/phone, domain or invoice number and see its owner, members, store,
   plan, usage, invoices, domains and audit history; every number shown comes from real data (nothing from §Out of
   scope is rendered).
4. Impersonation shows the real merchant dashboard for the chosen shop only, refuses every write, ends after 15 minutes
   or on exit/revoke, and is audited at start and end on the shop's log (S71–S74).
5. Suspend takes the merchant dashboard and every storefront host offline (503 page) while in-flight payments still
   settle; reactivate restores the previous store status (S80).
6. Change plan, extend, mark paid, void, resend, domain re-check/suspend/reinstate behave exactly like the Phase 6/7
   commands, whose tests pass unchanged.
7. Admin reads run on `pgsql_admin` only from `app/Domain/Admin/**`; with RLS on, every `admin`, `impersonation`, `rls`
   and `security` test passes as the app + admin roles.
8. Screens match the Figma frames listed in §7 with the documented omissions, with empty/loading/error states; 1024 px
   usable.
9. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`), Playwright `phase8.*` are green;
   `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes for 1.9.0.

# Phase 6 contract: Custom domains (binding for API, WEB, SF, QA)

Status: **Binding for Phase 6** from 2026-11-22. Branch `phase-6-custom-domains` (from `main` @ 7ad4a05: Phase 5b
merged as PR #1, CI green including `api-rls` and `api-documents`). Roadmap tasks 6.1–6.5.

Everything in AGENT-CONTRACTS.md, PHASE-2/3/4/5/5B-CONTRACT.md and docs/api/API-CONVENTIONS.md still applies
(envelope, snake_case, ULIDs, roles, cookie sessions, foreign-id rules, RLS rules, storefront headers, fake-driver
pattern). Where this file changes an earlier rule it says **"amends …"**.
Machine-readable spec: `docs/api/openapi.yaml` **v1.7.0**. Design: `docs/architecture/DOMAIN-INFRASTRUCTURE.md`
(refined by this contract, same date) and ADR 0003. Product defaults: OPEN-QUESTIONS **Q69–Q76** (pending PO).

### Scope

One build cycle, one QA gate, then a **certification run against a real Cloudflare staging zone** (§13) before the
phase closes. Everything is built and tested on fake drivers first, exactly like 5b-2/5b-3.

| Task | Owner | Ships |
|---|---|---|
| **6.1** Domain API + state machine + jobs | API | Add/list/show/re-check/make primary/remove, hostname normalisation (IDN, PSL), DoH verification (TXT ownership + CNAME routing), state machine, `domains:check` scheduler, reclaim of stale hostnames, plan gate, audit, merchant emails, definer functions |
| **6.2** Cloudflare for SaaS | API (+ QA certification) | `CustomHostnameProvider` with `cloudflare` and `fake` drivers, SSL polling, provider cleanup, orphan reconcile. Poll-only (no Cloudflare webhook in Phase 6, Q74) |
| **6.3** Domains UI | WEB | Online store → Domains (V3 `2042:47403`): list, connect dialog, DNS records with copy and live status, re-check, make primary, remove; plan/limit states; staff read-only |
| **6.4** Primary-domain redirects + canonical | SF (+ API field) | Every non-primary host of a store whose primary is a custom domain permanently redirects to the primary (same path + query); canonical/sitemap/robots on the primary |
| **6.5** `ask` endpoint | API | `GET /internal/domains/allowed?domain=` for a future Caddy on-demand TLS / allowlist checks |

**Out of scope** (hide, never fake): buying domains (`2042:48250`), DNS hosting, email/MX forwarding, Domain Connect
"connect automatically", apex proxying / static anycast IPs for apex A records (Q4, Q75), Caddy deployment (only the
`ask` endpoint is built), a Cloudflare webhook receiver (Q74), plan billing UI and downgrade enforcement (Phase 7,
Q71), platform-admin domain screens (Phase 8.1; Phase 6 gives ops artisan commands only), store slug change and its
90-day platform redirect (no slug-change endpoint exists yet; Phase 8), wildcard hostnames, more than one store per
tenant.

### Conventions in this file
- `T` = `X-Tenant-Id`. O / A / S = owner / admin / staff. Domain writes need the existing
  `Permission::ManageDomains` (O A); reads are `Operate` (O A S).
- **Foreign ids:** a `{domain}` of another tenant or store → 404 `not_found`. Never 403.
- **"VERIFY against staging"** marks a Cloudflare (or DNS) detail that the public docs don't settle. The driver keeps
  each such detail in one method, and §13 certification resolves it. **"default, pending PO"** marks a product
  decision listed in §1.1 and OPEN-QUESTIONS Q69–Q76.
- Hostnames are always stored and compared in **lowercase ASCII (punycode)** without a trailing dot.

### Standing rules for every agent
- Browser checks: Playwright only (never the Claude in Chrome extension or the user's Chrome).
- Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>` or commit. Touch only owned files (§14).
- New dependencies: at least 14 days old, pinned exactly.
- Postgres (Docker, role init script) for API work; RLS on (`TENANCY_RLS=true`, app role) when running the domain
  tests that touch definer functions. Not the Homebrew Postgres.
- CI never calls Cloudflare or a public DoH resolver. Real calls only in the manual certification run (§13).

---

## 0. Summary and goals

1. A merchant on a plan with `custom_domain` adds `shop.acme.com`, sees two DNS records (TXT for ownership, CNAME for
   routing) with copy buttons and a live per-record status, and the domain moves on its own:
   `pending_verification → verified → ssl_provisioning → active`. No support ticket, no manual step on our side.
2. Ownership is decided by DNS, never first-come: a hostname held by another store that never proved it (or lost it)
   can be reclaimed after 7 days (Q73).
3. When the merchant makes the custom domain primary, `demo.storeplix.com/anything` and every other host of the store
   permanently redirect to `https://shop.acme.com/anything`; canonical URLs, sitemap and robots use the primary.
4. Domains keep being checked: missing records for 7 days → `expired` (unroutable, Cloudflare hostname removed);
   removing the domain removes the Cloudflare hostname. The store never loses its platform subdomain.
5. Every external dependency is behind an interface with a fake, so the whole flow runs in CI and e2e; certification
   against a real Cloudflare zone is a listed blocker (§13), like 5b §16.

---

## 1. Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| P6-1 | **Two records, both required, both kept.** TXT `_storeplix-verify.{host}` = `sp-verify={token}` (ownership) and CNAME `{host}` → `DOMAINS_CNAME_TARGET` (default `customers.{PLATFORM_DOMAIN}`; routing). Token = 32 random bytes, base32 lowercase without padding (52 chars), generated on add, never rotated, stored plain (it is published in DNS anyway). Both records are re-checked daily while `active` (Q72) | Ownership proof that survives a domain sale; the CNAME alone proves routing, not control |
| P6-2 | **DNS checks use DNS-over-HTTPS only**, two fixed resolvers from config (`https://cloudflare-dns.com/dns-query` and `https://dns.google/resolve`, JSON API, 3 s timeout each, run concurrently through `SafeHttpClient`). Per record: both resolvers agree on a match → `ok`; both say no record → `missing`; any other combination of answers → `mismatch`; either resolver times out / SERVFAIL / non-2xx → the whole check is **inconclusive** (no state change, `failure_code: dns_error`, normal cadence). The merchant's hostname is only ever a query parameter; the API never connects to it | No SSRF surface; no cached or poisoned single answer; transient resolver errors never fail a domain |
| P6-3 | **Routing match.** CNAME: any CNAME in the answer chain for `{host}` equals the target (lowercase, trailing dot stripped). **Apex / flattened** (no CNAME in the answer): pass when the host's A set is non-empty and ⊆ the target's A set, and its AAAA set (if any) ⊆ the target's AAAA set, both resolved through the same two resolvers (VERIFY against staging that flattened answers equal the target's addresses). A host proxied by the merchant's own Cloudflare (orange cloud) fails with `cname_mismatch`; the UI tells them to switch it to "DNS only" | Q4/Q75: apex works only with CNAME flattening / ALIAS; no IPs to hand out |
| P6-4 | **Normalisation** (`Domains\HostnameInput::normalize`, one place): trim; reject anything containing `/`, `:`, `@`, `*`, whitespace or a scheme (the WEB form strips `https://` and a trailing `/` before sending); lowercase; strip one trailing dot; IDN → ASCII with `idn_to_ascii(…, IDNA_NONTRANSITIONAL_TO_ASCII \| IDNA_CHECK_BIDI \| IDNA_CHECK_CONTEXTJ, INTL_IDNA_VARIANT_UTS46)` (intl is in the image and CI); then the existing `HostNormalizer` label rules; ≤ 253 chars; ≥ 2 labels; not an IP literal; last label not all digits. **Public Suffix List** (`jeremykendall/php-domain-parser`, exact version pin, PSL snapshot committed at `apps/api/resources/data/public_suffix_list.dat`, refreshed by `php artisan domains:update-psl`, ICANN + private sections): the host must have a registrable domain and must not itself be a public suffix. `display_hostname` = `idn_to_utf8` of the stored value | One canonical form for the unique index, the resolver cache and `X-Storefront-Host` |
| P6-5 | **Blocked hosts** → 422 `domain_reserved`: `PLATFORM_DOMAIN` and every subdomain of it, `storeplix.com` and its subdomains, the CNAME target, plus `config('domains.reserved_suffixes')`. → 422 `domain_invalid`: special-use TLDs `localhost`, `local`, `localdomain`, `internal`, `intranet`, `lan`, `home`, `corp`, `test`, `example`, `invalid`, `onion`, `arpa`, `alt`. **Exception:** with `DOMAINS_FAKE=true` (never production) hosts ending in `.localhost` are accepted and skip the PSL check, so e2e can browse them (Chromium resolves `*.localhost`) | Platform hosts can't be claimed; e2e still needs a real browsable custom host |
| P6-6 | **Global uniqueness and reclaim** (default, pending PO, Q73). `U(hostname)` across all tenants (exists). On add, `sp_domain_claim_state(host)` (definer, §3.2) tells whether another row holds the host. Taken → 422 `domain_taken`, **unless** that row is `verification_failed` or `expired` and its `status_changed_at` is more than `DOMAINS_RECLAIM_AFTER_DAYS` (7) ago: then the old row is **released first** (inside `TenantContext::run(oldTenant)`, outside any transaction: row deleted, provider hostname deleted by job, audit `domain.released` with system actor in the old tenant, email to the old owner) and the new row is created. The newcomer still has to prove TXT. A `23505` on `store_domains.hostname` → 422 `domain_taken` | Ownership is decided by DNS, not by who typed it first; stale claims can't block a real owner |
| P6-7 | **Plan gate** (as far as Phase 6 enforces; full enforcement Phase 7). Add a custom domain: `FeatureGate::assertAllows(custom_domain)` → 402 `feature_not_in_plan`; then new limit `custom_domains` = number of `type = custom` rows of the store in any status, `assertWithin` → 402 `plan_limit_reached`. Seed: Free 0 (feature off), Starter **2**, Growth **5** (default, pending PO, Q70). Making a **custom** domain primary also needs the feature (402). Nothing else is gated: after a downgrade existing domains keep serving and can be re-checked, removed and demoted (Q71) | Uses what exists (FeatureGate, `custom_domain` feature already seeded on Starter+); 14-day Starter trial lets every new shop try it |
| P6-8 | **One primary per store, always routable.** DB: partial `U(store_id) WHERE is_primary` and CHECK `NOT is_primary OR status = 'active'`. Make primary: only an `active` row (custom or platform), else 409 `domain_not_active`. In one transaction, locking the store row: old primary `false`, then new `true` (the CHECKs are immediate, so a fallback writes in this order: old primary `false` → slug platform row `true` → status change). **Automatic fallback:** when the primary custom domain is removed, or leaves `active` (expired, suspended, SSL lost), the primary moves in the same transaction to the store's **slug platform row** (`{slug}.{PLATFORM_DOMAIN}`), audit `domain.primary_changed` (system actor, reason), email. It does **not** move back by itself when the domain recovers (default, pending PO, Q76) | The shop is never left without a working canonical host |
| P6-9 | **Platform rows** (`type = platform`): always `active`, never in the state machine, never deletable (409 `platform_domain_locked`), re-check → 409 `platform_domain_locked`. They stay routable when not primary and redirect to a custom primary (P6-15) | Old links and the dashboard's platform URL keep working |
| P6-10 | **State machine as built** (one class `Domains\DomainStateMachine`, §4). Platform rows are refused. Every transition is a conditional `UPDATE … WHERE id = ? AND status = ?` under a `Cache::lock("domain:{id}")` (30 s), sets `status_changed_at`, writes `audit_logs` `domain.status_changed` (`{from, to, failure_code}`), and fires `DomainStatusChanged` (emails, P6-19). Affected rows = 0 → someone else already moved it; reload and stop | Jobs, re-checks and ops commands can race safely |
| P6-11 | **Provider hostnames are created only after our own TXT + CNAME proof** (`verified`), with `ssl.method = http`, `type = dv`, `min_tls_version = 1.2` (VERIFY). So Cloudflare never bills for, or issues certificates to, an unproven hostname. HTTP DCV works because the CNAME is already in place (VERIFY for flattened apex). Create is idempotent: a duplicate-hostname error from Cloudflare (VERIFY the error code) → look it up by hostname and adopt it if no other row references it | Cost and abuse control; retries are safe |
| P6-12 | **Cloudflare for SaaS, poll-only** (Q74). No Cloudflare notification webhook in Phase 6; `domains:check` polls `ssl_provisioning` rows (2 min for the first hour, then 15 min) and checks `active` rows daily. A webhook can short-circuit polling later without changing the state machine | Webhook auth/payload not verifiable without an account; polling is cheap at our volume |
| P6-13 | **External drivers behind interfaces, fakes for everything** (mirrors P5B-29). `CustomHostnameProvider` (`cloudflare` \| `fake`) and `DnsResolver` (`doh` consensus \| `fake`). `DOMAINS_FAKE=true` binds both fakes (local, testing, e2e); the API **refuses to boot** with `DOMAINS_FAKE=true` and `APP_ENV=production`, and in production also when `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ZONE_ID` is empty. Testing-only dev endpoints drive the fakes (§5.4) | CI and e2e run end to end with no Cloudflare account |
| P6-14 | **Removal.** `DELETE` deletes the row at once (it stops routing immediately; resolver cache forgotten, storefront revalidated), then `DeleteProviderHostnameJob(provider_hostname_id)` removes the Cloudflare hostname (404 = done; 5 tries with backoff). A store/tenant cascade delete goes through the same observer. `domains:reconcile-provider` (daily) deletes Cloudflare hostnames older than 1 h that no row references (orphans), `--dry-run` supported | No paid or routable leftovers; dangling hostnames are found even after a crash |
| P6-15 | **Redirect rule (6.4).** The API decides and returns `store.redirect_host` in `StorefrontConfig`: = the primary hostname when the request host ≠ the primary, the request is not a valid preview, **and** either the primary is a custom domain or the request host is a custom domain; else `null`. So a non-primary custom host (e.g. the apex next to a `www` primary) always redirects, while platform hosts never redirect to a platform primary (`demo.localhost` keeps working in dev and e2e). The storefront issues a **permanent redirect** to `{origin(primary)}{path}{query}` for page requests (Next.js `permanentRedirect` = **308**) and **301** from the `robots.txt` / `sitemap.xml` handlers; `/api/*` route handlers and Server Action POSTs are never redirected. Amends roadmap 6.4 AC "301" to "permanent redirect (308 for pages, 301 for robots/sitemap)" | Search engines treat 308 like 301 for GET; the storefront has no per-host data before the config fetch, and the config is already cached per host |
| P6-16 | **Cache and revalidation reuse the 3.5 mechanism.** A `StoreDomain` save that changes `status`, `is_primary` or `hostname`, a create, or a delete: (a) `StoreDomainObserver` forgets `domain:{host}` (old and new host) in the resolver cache; (b) `StorefrontRevalidationObserver` dispatches `RevalidateStorefront` for the store (it already posts **all** store hosts plus removed ones to the storefront, which expires `store:{host}`). **Amends** both observers: saves that only touch check bookkeeping (`last_checked_at`, `next_check_at`, `last_check`, counters, provider status) trigger neither | A primary change refreshes every host's config (new `primary_host`/`redirect_host`) within seconds; the per-minute checker doesn't spam revalidations |
| P6-17 | **`ask` endpoint (6.5)** `GET /api/v1/internal/domains/allowed?domain={host}&key={DOMAINS_ASK_KEY}`. No tenant context: `sp_domain_allowed(host)` (definer) is true for a row with status `verified`, `ssl_provisioning` or `active` (custom) or `active` (platform) of a non-suspended store. 200 `{data:{allowed:true}}` or 404 `domain_not_allowed` (also for malformed or unknown hosts; byte-identical bodies). Key missing/wrong (constant-time compare; empty config → always 401) → 401 `unauthenticated`. Throttle `domains-ask` 1 200/min per IP. Not exposed through the public Nginx (RUNBOOK §9). The key is a query parameter because Caddy's `ask` can't send headers; it is never logged (log the path only) | Matches DOMAIN-INFRASTRUCTURE §2: a certificate may be issued before the domain is `active`, never before ownership is proven |
| P6-18 | **Suspension.** Domain-level: `php artisan domains:suspend {hostname} --reason=` (any custom state → `suspended`, provider hostname kept, unroutable at once) and `domains:reinstate {hostname}` (runs a check now: pass → `active` if the provider hostname is active, else `ssl_provisioning`; fail → `pending_verification` with a fresh 72 h window). Store-level suspension (`stores.status = suspended`) is unchanged: the resolver and `sp_domain_allowed` already exclude the store; domain rows are not touched. No merchant endpoint can leave `suspended` | Ops can stop phishing/abuse on one host without touching the store |
| P6-19 | **Merchant emails** (owner only, default pending PO, Q76; queued; existing mail layout): domain live (`active`), DNS records missing on an active domain (once per failure streak: "fix within 7 days"), verification failed (72 h / SSL 24 h), expired, primary moved back to the platform subdomain, hostname released to another store (old owner) | The domain changes state while nobody watches the dashboard |
| P6-20 | **Audit** (`audit_logs`, existing writer): `domain.added`, `domain.removed`, `domain.primary_changed` (`{from, to, reason}`), `domain.status_changed` (system actor for jobs), `domain.recheck_requested` (user), `domain.released` (system, old tenant), `domain.suspended` / `domain.reinstated` (system, `{reason}`). Never the verification token | Who connected, moved or lost a host |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q69–Q76; defaults in effect until answered)

| # | Question | Default |
|---|---|---|
| Q69 | Cloudflare account for SaaS: who provides the zone, plan and API token, and a staging zone + test domain for certification? | Built on fakes; certification blocked until the PO provides §13 items |
| Q70 | Custom domains per plan | Free 0, Starter 2 (e.g. apex + www), Growth 5; every custom row counts, in any status |
| Q71 | Shop downgraded (trial ends) with a connected domain | Phase 6: it keeps working; only adding domains and making a custom domain primary are blocked. Phase 7 decides a grace period |
| Q72 | Must the TXT record stay after verification? | Yes; TXT and CNAME are re-checked daily; 7 days missing → `expired` |
| Q73 | Another shop holds the hostname but never proved it | Reclaimable when that row is `verification_failed` or `expired` for more than 7 days; old owner emailed |
| Q74 | Cloudflare webhooks or polling | Polling only in Phase 6 |
| Q75 | Apex domains (refines Q4) | Accepted when the merchant's DNS supports CNAME flattening / ALIAS; UI recommends `www` as primary and adding the apex too; no A-record IPs offered |
| Q76 | Domain emails and primary fallback | Emails to the owner only; primary falls back to the platform subdomain automatically and does not move back by itself |

---

## 2. State machine and checks (owner API)

### 2.1 Transitions (custom rows only; `DomainStateMachine::TRANSITIONS`)

| From | To | Trigger | Side effects |
|---|---|---|---|
| (new) | `pending_verification` | add | `verification_started_at = now`, `next_check_at = now` (job dispatched at once) |
| `pending_verification` | `verified` | check: TXT ok **and** routing ok | `verified_at`; provider create in the same job (→ next row) |
| `verified` | `ssl_provisioning` | provider create/adopt succeeded | `provider_hostname_id`, `provider`, `ssl_status` |
| `pending_verification` | `verification_failed` | a failing or inconclusive check after `verification_started_at + 72 h` | `failure_code: verification_timeout` (or the last record failure), email |
| `ssl_provisioning` | `active` | provider hostname `active` **and** SSL `active` | `activated_at`; email "is live" |
| `ssl_provisioning` / `verified` | `verification_failed` | provider reports a final failure (blocked, moved, DCV/issuance timed out) or not active 24 h after entering `ssl_provisioning` | provider hostname deleted (job); `failure_code` `ssl_validation_failed` \| `ssl_timeout` \| `provider_blocked` |
| `verification_failed`, `expired` | `pending_verification` | merchant re-check | new 72 h window, failure fields cleared, check runs now |
| `active` | `expired` | latest check failing and `first_failed_at ≤ now − 7 days` | provider hostname deleted; primary fallback (P6-8); email |
| any custom state | `suspended` | `domains:suspend` | primary fallback; provider hostname kept |
| `suspended` | `active` \| `ssl_provisioning` \| `pending_verification` | `domains:reinstate` (P6-18) | — |
| any custom state | (deleted) | merchant remove | P6-14 |

Anything else → `InvalidDomainTransition` (unit-tested matrix; e.g. `pending_verification → active` is illegal).
`active` with a failing check stays `active` (still routable) while `first_failed_at` is less than 7 days old; a
passing check clears `first_failed_at`. An inconclusive check changes nothing.

### 2.2 Check cadence (`next_check_at`, set by every check)

| Status | Next check |
|---|---|
| `pending_verification` | checks 1–3 after +1, +5, +15 min; then every 30 min until the 72 h deadline |
| `verified` | provider create retry +2, +5, +15, +30 min, then every 30 min (provider errors); 24 h cap → `verification_failed` |
| `ssl_provisioning` | every 2 min for the first hour, then every 15 min until 24 h |
| `active` | every 24 h (± 60 min jitter); every 6 h while `first_failed_at` is set |
| `verification_failed`, `expired`, `suspended` | `null` (no polling; re-check or ops command only) |

`domains:check` (scheduler, every minute, `withoutOverlapping`): discovery on `pgsql_admin` (`// cross-tenant: due
domain checks`) selects up to 500 rows with `next_check_at <= now()` ordered by `next_check_at`, then dispatches one
`CheckDomainJob(domain_id)` per row (`TenantAware`, `ShouldBeUnique` by id for 5 min, queue `domains`, 3 tries,
timeout 60 s). The job reloads the row in its tenant, takes the lock, and runs the check for its status. The
re-check endpoint runs the same check synchronously (DNS ≤ 2 × 3 s in parallel; provider call ≤ 10 s) and returns the
updated row.

### 2.3 What one check does
- `pending_verification`: DNS check (TXT at `_storeplix-verify.{host}`: any TXT string, quote-stripped and joined,
  equals `sp-verify={token}`; routing per P6-3). Stores observations in `last_check` (§3.1).
- `verified`: provider `create` (or `findByHostname` + adopt).
- `ssl_provisioning`: provider `get`; map statuses (§5.2).
- `active`: DNS check **and** provider `get` (hostname or SSL not active counts as a failed check, code
  `ssl_lost` / `provider_moved`).
- Every check: `last_checked_at`, `check_attempts++`, `failure_code`/`failure_message` (sanitised, ≤ 255, provider
  text stripped of URLs and ids), `next_check_at`.

### 2.4 Failure codes (`DomainFailureCode`, stable strings)
`txt_missing`, `txt_mismatch`, `cname_missing`, `cname_mismatch`, `dns_error`, `verification_timeout`,
`provider_error`, `provider_blocked`, `provider_moved`, `ssl_validation_failed`, `ssl_timeout`, `ssl_lost`,
`suspended`. The UI maps each to copy (§8).

---

## 3. Data (migrations, owner API) — prefix `2026_07_01_`, forward-only

### 3.1 `000100_extend_store_domains`
`store_domains` already exists (Phase 1: `id`, `tenant_id`, `store_id`, `hostname` U, `type`, `status`,
`is_primary`, `verification_token`, `verified_at`, timestamps; RLS forced since 5b-1). Changes:
- **Add:** `display_hostname varchar(253) null` (Unicode form, informational only); `verification_started_at`,
  `status_changed_at`, `activated_at`, `last_checked_at`, `next_check_at`, `first_failed_at timestamptz null`;
  `check_attempts int not null default 0`; `failure_code varchar(48) null`; `failure_message varchar(255) null`;
  `last_check jsonb null` (`{checked_at, outcome: ok|fail|inconclusive, records: {ownership: {status, found[≤5]},
  routing: {status, found[≤5], mode: cname|flattened}}, resolvers: {cloudflare: ok|error, google: ok|error}}`;
  `found` values truncated to 255 chars); `provider varchar(16) null` CHECK IN (`cloudflare`,`fake`);
  `provider_hostname_id varchar(64) null`; `provider_status varchar(32) null`, `ssl_status varchar(32) null` (raw
  provider values, for support); `created_by` FK users nullOnDelete.
- **Convert** `verified_at`, `created_at`, `updated_at` to `timestamptz` (`USING col AT TIME ZONE 'UTC'`) if they are
  `timestamp without time zone` (pgsql only).
- **Data fix before constraints:** every store has exactly one primary (if none, the slug platform row; if several,
  keep the platform slug row); platform rows `status = 'active'`; existing custom rows (none expected) without a
  token get one; `status_changed_at = updated_at`; `hostname = lower(hostname)`.
- **Constraints:** CHECK `type IN ('platform','custom')`; CHECK `status IN (DomainStatus…)`; CHECK
  `type = 'custom' OR status = 'active'`; CHECK `NOT is_primary OR status = 'active'`; CHECK
  `type = 'platform' OR verification_token IS NOT NULL`; CHECK `hostname = lower(hostname) AND length(hostname) <= 253`;
  partial **`U(store_id) WHERE is_primary`**; `U(tenant_id, id)`, `U(tenant_id, store_id, id)` (DATABASE-DESIGN
  convention); partial `U(provider_hostname_id) WHERE provider_hostname_id IS NOT NULL`;
  `IX(next_check_at) WHERE next_check_at IS NOT NULL` (platform scheduler index; deliberately not tenant-led, read
  only through `pgsql_admin`); `IX(tenant_id, store_id, type)`.
- `StoreDomain` model: `$fillable` stays minimal; status/timestamps/provider fields are written only by
  `DomainStateMachine`/`DomainChecker` (never from input). `verification_token` stays `$hidden` and appears only through
  `DomainPresenter::dnsRecords()`.

### 3.2 `000200_domain_definer_functions` (pgsql only; no-op on sqlite)
Same pattern as MULTI-TENANCY §9.4 (owner-owned, `SECURITY DEFINER`, `SET search_path = public, pg_temp`,
`REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO storeplix_app`); `down()` drops these two only.

| Function | Returns | Caller (pre-tenant path) |
|---|---|---|
| `sp_domain_claim_state(p_host text)` | `(tenant_id text, store_id text, domain_id text, status text, status_changed_at timestamptz)` or no row | `PreTenantLookup::domainClaimState` — add-domain uniqueness and reclaim (**B17**) |
| `sp_domain_allowed(p_host text)` | `boolean` (P6-17) | `PreTenantLookup::domainAllowed` — `ask` endpoint (**B18**) |

With RLS off, the PHP methods fall back to `withoutTenancy()` queries (allowlisted in `Domain/Tenancy`).
`sp_resolve_host` is unchanged (still `status = 'active'` only).

### 3.3 Plans and limits (`000300_add_custom_domains_limit`)
`Limit::CustomDomains = 'custom_domains'`; `PlanSeeder` limits: free `0`, starter `2`, growth `5` (Q70); data
migration sets the key on existing plan rows. `FeatureGate::usage(CustomDomains)` = custom rows of the tenant's store.

### 3.4 Other bypass paths (enumerated; MULTI-TENANCY §9 gets them after acceptance)
| # | Path | Mechanism |
|---|---|---|
| B17 | Add-domain claim check | `sp_domain_claim_state` |
| B18 | `GET /internal/domains/allowed` | `sp_domain_allowed` |
| B19 | `domains:check`, `domains:reconcile-provider`, `domains:suspend`, `domains:reinstate`, `domains:update-psl` | discovery on `pgsql_admin`; per-row work inside `TenantContext::run()` on `pgsql` (or a tenant-aware job) |
| B20 | Release of a stale row of another tenant (P6-6) | `TenantContext::run(oldTenant)` outside any transaction, with ids from B17 |
| B21 | `/dev/domains/*` (testing only) | `DevDomainLookup` like `DevShipmentLookup` (null in production or without `DOMAINS_FAKE`) |

New code (suggested layout): `app/Domain/Domains/` — `Models` (reuse `Stores\Models\StoreDomain`), `HostnameInput`,
`DomainService` (add, remove, makePrimary, recheck, release), `DomainStateMachine`, `DomainChecker`,
`Dns\{DnsResolver, DohResolver, ConsensusResolver, FakeDnsResolver, DnsAnswer}`,
`Providers\{CustomHostnameProvider, CloudflareCustomHostnames, FakeCustomHostnames, ProviderHostname}`,
`Jobs\{CheckDomainJob, DeleteProviderHostnameJob}`, `Console\{CheckDomains, ReconcileProviderHostnames, SuspendDomain,
ReinstateDomain, UpdatePublicSuffixList}`, `Http\{DomainController, DomainAskController, DevDomainController}`,
`Http\Requests\AddDomainRequest`, `Http\Resources\DomainResource` (+ `DomainPresenter`), `Mail\DomainStatusMail`,
`Policies\StoreDomainPolicy`, `DomainsServiceProvider` (bindings, boot checks, schedule, limiters).

---

## 4. API endpoints (owner API)

### 4.0 New error codes (add to API-CONVENTIONS §3)
| HTTP | code | When |
|---|---|---|
| 422 | `domain_invalid` | not a usable public hostname: syntax, scheme/path/port, IP literal, single label, a public suffix itself, special-use TLD, invalid IDN (`details.hostname`) |
| 422 | `domain_reserved` | the platform domain or a subdomain of it, `storeplix.com`, the CNAME target, a configured reserved suffix |
| 422 | `domain_taken` | the hostname is already on this store or held by another store (and not reclaimable, P6-6) |
| 409 | `domain_not_active` | make primary a domain that isn't `active` |
| 409 | `platform_domain_locked` | remove or re-check a platform subdomain |
| 404 | `domain_not_allowed` | `ask` endpoint: host not allowed (also unknown or malformed) |
Reused: `feature_not_in_plan`, `plan_limit_reached` (402, P6-7), `invalid_state_transition` (409: re-check a
`suspended` domain), `not_found`, `forbidden`, `rate_limited`, `unauthenticated` (ask key), `validation_failed`
(missing `hostname`, > 300 chars before normalisation).

### 4.1 Merchant domains (`auth` + `tenant` + `store`; reads O A S `Operate`, writes O A `ManageDomains`)
| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /stores/{store}/domains` | — | 200 `StoreDomain[]` (platform rows first, then custom by `created_at`); `meta: DomainListMeta` `{ cname_target, txt_prefix: "_storeplix-verify", can_add, feature_enabled, limit: {used, max} }` | 404 |
| `POST /stores/{store}/domains` | `AddDomainInput` `{ hostname }` | 201 `StoreDomain` (`pending_verification`, `dns_records` filled, first check queued); audit `domain.added` | 402; 403; 404; 422 `domain_invalid` \| `domain_reserved` \| `domain_taken` \| `validation_failed`; 429 |
| `GET /stores/{store}/domains/{domain}` | — | 200 `StoreDomain` | 404 |
| `POST /stores/{store}/domains/{domain}/verify` (re-check) | — | 200 `StoreDomain` after a synchronous check (§2.2); from `verification_failed`/`expired` first moves to `pending_verification`; audit `domain.recheck_requested` | 403; 404; 409 `platform_domain_locked` \| `invalid_state_transition` (suspended); 429 (in-code: 6/min and 30/hour per domain) |
| `POST /stores/{store}/domains/{domain}/primary` | — | 200 `StoreDomain[]` (whole list, two rows changed); audit `domain.primary_changed` | 402 (custom domain without the feature); 403; 404; 409 `domain_not_active` |
| `DELETE /stores/{store}/domains/{domain}` | — | 204; primary fallback when it was primary (P6-8); audit `domain.removed` | 403; 404; 409 `platform_domain_locked` |

Named limiter `domains` (POST/DELETE above): 30/min per tenant + user. The re-check never answers 502: a provider or
resolver error is recorded on the row (`failure_code: provider_error | dns_error`) and returned with 200.

### 4.2 Storefront (amends `GET /storefront/config`, additive)
`StorefrontConfig.store` gains **`redirect_host: string | null`** (P6-15). `primary_host` (exists) stays the canonical
host. `redirect_host` is computed per request host and preview flag, so it lives in the same per-host cached payload.

### 4.3 Internal (6.5)
| Method & path | Auth | Answers |
|---|---|---|
| `GET /internal/domains/allowed?domain={host}&key={key}` | `key` = `DOMAINS_ASK_KEY` (hash_equals; empty config → 401) | 200 `{data:{allowed:true}}`; 404 `domain_not_allowed`; 401 `unauthenticated`; 429. `Cache-Control: no-store`. No tenant header, no session, no CSRF |

### 4.4 Testing-only dev endpoints (not in openapi; API-CONVENTIONS §10.3 rules)
Registered only outside production and answering 404 unless `DOMAINS_FAKE=true`:
- `POST /dev/domains/{domain}/dns` `{ ownership: correct|wrong|missing, routing: correct|wrong|missing|flattened }` —
  writes fake DNS answers for that host.
- `POST /dev/domains/{domain}/provider` `{ hostname_status: pending|active|blocked|moved, ssl_status: pending|active|failed }`
  — sets the fake provider state (the next check reads it).
- `POST /dev/domains/{domain}/age` `{ hours: 1..400 }` — moves `verification_started_at`, `status_changed_at`,
  `first_failed_at` back (72 h / 24 h / 7 d / reclaim paths in e2e).
Throttle 60/min. Each answers 200 `StoreDomain` (after running a check when `?check=1`).

---

## 5. External providers (owner API) — public documentation, checked 2026-11-22

### 5.1 DNS over HTTPS (JSON)
`GET https://cloudflare-dns.com/dns-query?name={name}&type={TXT|CNAME|A|AAAA}` with `Accept: application/dns-json`;
`GET https://dns.google/resolve?name={name}&type=…`. Response `{Status, Answer?: [{name, type, TTL, data}]}`;
`Status` 0 = NOERROR, 3 = NXDOMAIN (→ missing), 2 = SERVFAIL (→ inconclusive). TXT `data` is quoted, possibly split
into several quoted strings: strip quotes, join. Types: 1 A, 5 CNAME, 16 TXT, 28 AAAA. Endpoints come from config
only (`domains.doh`), never from input; `SafeHttpClient` (https, no redirects), 3 s timeout, no retries inside a check.
The routing check for a CNAME asks `type=CNAME` first; an empty answer falls back to A/AAAA (flattened mode, P6-3).

### 5.2 Cloudflare for SaaS (Custom Hostnames API v4)
Base `https://api.cloudflare.com/client/v4` (config), `Authorization: Bearer {CLOUDFLARE_API_TOKEN}` (token scoped to
the SaaS zone with SSL and Certificates edit permission — **VERIFY** exact permission name), zone `CLOUDFLARE_ZONE_ID`.
10 s connect / 20 s total, no redirects, logs carry ids and status codes only.

| Method | Call | Notes |
|---|---|---|
| `create(host)` | `POST /zones/{zone}/custom_hostnames` `{hostname, ssl:{method:"http", type:"dv", settings:{min_tls_version:"1.2"}}}` | `result.id`, `result.status`, `result.ssl.status`. Duplicate → error (code **VERIFY**) → `findByHostname` |
| `findByHostname(host)` | `GET /zones/{zone}/custom_hostnames?hostname={host}` | exact match on `result[].hostname` |
| `get(id)` | `GET /zones/{zone}/custom_hostnames/{id}` | `status`, `ssl.status`, `verification_errors[]`, `ssl.validation_errors[]` |
| `delete(id)` | `DELETE /zones/{zone}/custom_hostnames/{id}` | 404 → already gone |
| `list(page)` | `GET /zones/{zone}/custom_hostnames?page=&per_page=50` | reconcile only |

Status mapping (`ProviderHostname`; unknown values → `pending`, logged once — **VERIFY** the full lists):
hostname `active` → active; `pending`, `pending_*`, `test_*`, `active_redeploying` → pending; `blocked`,
`pending_blocked` → blocked (`provider_blocked`); `moved` → moved (`provider_moved`); `deleted`, `pending_deletion` →
gone. SSL `active` → active; `initializing`, `pending_validation`, `pending_issuance`, `pending_deployment`,
`staging_*`, `holding_deployment`, `backup_issued` → pending; `validation_timed_out`, `issuance_timed_out`,
`deployment_timed_out`, `initializing_timed_out`, `expired`, `deleted`, `inactive`, `deactivating` → failed.
Cloudflare-side setup (fallback origin, the CNAME target record, origin certificate, Nginx host handling) is ops work
in RUNBOOK §9, not code.

### 5.3 Fake drivers
- `FakeDnsResolver`: answers from the cache store under `fake-dns:{name}:{type}` (written by `/dev/domains/{id}/dns`
  or tests); missing key → NXDOMAIN. `Http::fake` fixtures of both DoH APIs drive `DohResolver` tests
  (`tests/Fixtures/domains/doh/*.json`, `"_source": "docs"`).
- `FakeCustomHostnames`: in-cache hostnames with ids `fake_{ulid}`; default lifecycle `pending` → `active` on the
  second `get` (`DOMAINS_FAKE_SSL_POLLS`, default 1); hostnames starting with `fail-ssl.` end `validation_timed_out`;
  state can be set by `/dev/domains/{id}/provider`. Fixtures `tests/Fixtures/domains/cloudflare/*.json` (`"_source":
  "docs"`, replaced by staging recordings during certification) drive `CloudflareCustomHostnames` with `Http::fake`.

---

## 6. § Types (`packages/types/src/index.ts`, applied by ARCH in this change, additive)

```ts
// ==================== Phase 6: custom domains (PHASE-6-CONTRACT §6) ====================
export type DomainType = 'platform' | 'custom';
export type DomainFailureCode =
  | 'txt_missing' | 'txt_mismatch' | 'cname_missing' | 'cname_mismatch' | 'dns_error' | 'verification_timeout'
  | 'provider_error' | 'provider_blocked' | 'provider_moved' | 'ssl_validation_failed' | 'ssl_timeout' | 'ssl_lost'
  | 'suspended';
export type DnsRecordStatus = 'pending' | 'ok' | 'missing' | 'mismatch';
export interface DomainDnsRecord {
  purpose: 'ownership' | 'routing'; type: 'TXT' | 'CNAME';
  name: string; name_relative: string; value: string;
  status: DnsRecordStatus; found: string[];
}
export type DomainSslStatus = 'none' | 'pending' | 'active' | 'failed';
export interface StoreDomain {
  id: string; hostname: string; display_hostname: string; type: DomainType; status: DomainStatus;
  is_primary: boolean; is_apex: boolean; routable: boolean;
  dns_records: DomainDnsRecord[]; ssl_status: DomainSslStatus;
  verification_started_at: string | null; verified_at: string | null; activated_at: string | null;
  status_changed_at: string | null; last_checked_at: string | null; next_check_at: string | null;
  deadline_at: string | null; failure_code: DomainFailureCode | null; failure_message: string | null;
  can_recheck: boolean; can_make_primary: boolean; can_remove: boolean;
  created_at: string; updated_at: string;
}
export interface AddDomainInput { hostname: string }
export interface DomainListMeta {
  cname_target: string; txt_prefix: string; can_add: boolean; feature_enabled: boolean;
  limit: { used: number; max: number | null };
}
// LimitKey gains 'custom_domains'; ROLE_CAN gains manage_domains: ['owner','admin'];
// StorefrontConfig.store gains redirect_host?: string | null.
```
Field rules: `dns_records` is `[]` for platform rows; `name_relative` is relative to the registrable domain (`@` for
the apex, `_storeplix-verify` / `_storeplix-verify.shop`, `shop`); `routable` = `status === 'active'` and the store is
not suspended; `deadline_at` = the 72 h / 24 h / 7-day deadline that applies now, else null; the `can_*` flags already
include role, type, status and plan (staff → all false). Nothing in the resource exposes provider ids, raw provider
statuses or `last_check.resolvers`.

---

## 7. Storefront (owner SF) — 6.4

| Item | Behaviour |
|---|---|
| Redirect | `(store)/layout.tsx` (via one helper, e.g. `lib/primary-host.ts`): when `config.store.redirect_host` is set and the request is GET/HEAD, `permanentRedirect(originForHost(redirect_host) + path + search)` (308). The proxy writes the request path + query into an internal request header (overwriting any client value) so server components can rebuild the URL. `robots.txt` and `sitemap.xml` handlers return **301** to the same path on the primary. `/api/*` handlers and Server Actions are not redirected |
| Preview | A valid preview never redirects (the API returns `redirect_host: null`); the editor iframe keeps working on whatever host the preview link used |
| Canonical | Unchanged mechanism (`canonicalOrigin` = `primary_host`) on every page, product, category and page route; JSON-LD `url` and `og:url` use the same origin |
| robots / sitemap | Served for real only on the primary (others redirect); `Sitemap:` line and every `<loc>` use the primary origin (exists) |
| Unknown or not-yet-active hosts | Unchanged: the API answers 404 → branded "Store not found" page, `noindex`, no tenant data, cache-control as today. A custom host in `pending_verification`/`verified`/`ssl_provisioning`/`expired`/`suspended` is "unknown" |
| Revalidation | Nothing new: `/api/revalidate` already expires `store:{host}` for every host Laravel sends (P6-16) |
| Cookies | `sp_cart`, `sp_order`, `sp_preview` are host-only: a shopper moved by the redirect starts a new cart. Accepted; the dashboard warns the merchant before switching primary (§8) |
| Schema | `StorefrontConfigSchema` gains `redirect_host` (normalised host or null; invalid → null, never a redirect to an unparsable value) |

---

## 8. Dashboard (owner WEB) — 6.3, Figma file `2W1wMKN79hhcr1czQS63oN`

Frames: V3 **Domains `2042:47403`** (primary; listed as out of scope for Phase 3 in FIGMA-INDEX, in scope now).
ARCH has **not** opened it: WEB pulls `get_metadata` for `2042:47403` first (section id only, never the page),
builds from it, and reports the child frame ids for FIGMA-INDEX. Where V3 has no state (DNS records detail, failed,
expired, plan-locked, mobile), compose from the V1 domain frames inside Online store `60:11061` and States
`148:34032` (`148:35302`, `148:35336`, `148:35352`). **Buy a domain `2042:48250` is not built**: hide every "Buy" CTA.
`packages/ui` components and tokens only.

| Screen | Build |
|---|---|
| Online store → **Domains** `/online-store/domains` (new nav item in the Online store sub-nav) | Card per domain: display hostname (and punycode in small text when different), type ("Storeplix address" for platform), status badge, "Primary" badge, last checked "2 min ago", actions menu (Make primary, Check now, View DNS records, Remove). Header CTA **Connect a domain** (O A, `meta.can_add`); limit line "1 of 2 custom domains" |
| Connect dialog | Hostname input (strip `http(s)://`, path and trailing `/` client-side; Zod: non-empty, ≤ 253 after strip), helper "Use a subdomain like www.yourshop.com"; apex hint when the entered host is a registrable domain (no PSL in the browser: "looks like an apex" = exactly two labels, or three with a known BD second level `com.bd`, `net.bd`, `org.bd`, `edu.bd`, `gov.bd`, `ac.bd`) recommending to add `www` too. Errors map from `domain_invalid` / `domain_reserved` / `domain_taken` / 402 to inline copy |
| DNS records panel (dialog or detail route `/online-store/domains/:id`) | Step rail **Add records → Checking DNS → Securing (SSL) → Live**; table Type / Name (toggle FQDN ↔ relative `name_relative`) / Value with Copy buttons and per-record status (✓ ok, ✗ missing, ≠ mismatch with "We found: …"); deadline text from `deadline_at` ("We'll keep checking for 2 days 14 h"); **Check now** (disabled with countdown after a 429 using `retry_after`); failure copy per `failure_code`; tips: DNS changes can take up to an hour, "Turn off the Cloudflare proxy (DNS only)" on `cname_mismatch`, apex note "Your DNS provider must support CNAME flattening / ALIAS" |
| Status badges | `pending_verification` "Waiting for DNS" (warning), `verified` and `ssl_provisioning` "Securing" (info), `active` "Connected" (success), `verification_failed` "Failed" (danger), `expired` "Disconnected" (danger), `suspended` "Suspended" (danger); platform rows "Connected" |
| Make primary | Confirm dialog: "Visitors to every other address will be sent to {host}. Shoppers with an open cart on the old address will need to add items again." → `POST …/primary`; on success invalidate domains, the current store and every query that shows the store URL |
| Remove | Confirm (type the hostname for a primary or active domain); primary fallback message "Your shop will use {slug}.storeplix.com again" |
| Polling | While any row is `pending_verification`, `verified` or `ssl_provisioning`: `refetchInterval` 15 s while the tab is visible; stop otherwise |
| Plan states | `meta.feature_enabled = false`: upgrade card (link to the existing plan page), no Connect CTA; limit reached: CTA disabled with "Your plan allows N custom domains" |
| Roles | Staff: read-only (records visible, no Connect/Check/Primary/Remove) |
| States | Loading, empty (only the platform address: "Connect your own domain"), error with retry — from `148:34032` |
| Mobile 390 px | Cards stack; DNS table becomes one card per record with Copy buttons; no horizontal scroll |

Also: Online store Overview "Domain" card and the onboarding 08 / launch URL show `store.primary_domain` (already the
source) — verify they update after a primary change. Query keys `[tenantId, storeId, 'domains']`,
`[tenantId, storeId, 'domain', id]`; api-client methods `listDomains`, `addDomain`, `getDomain`, `recheckDomain`,
`makeDomainPrimary`, `removeDomain`. `PlanPage` gets a label for the new `custom_domains` limit (the types change
makes `Record<LimitKey, string>` require it).

---

## 9. Security checklist (Phase 6; numbering continues 5b S19–S39; each has a test in §10)

| # | Threat | Control | Test |
|---|---|---|---|
| S40 | **Domain takeover / claiming someone else's host** (T4, T30) | TXT token per row; global unique hostname; reclaim only of stale unproven/expired rows (P6-6); provider hostname created only after proof | Another tenant's `active` host → 422 `domain_taken`; token of another domain in TXT → `txt_mismatch`; reclaim of a 6-day-old failed row → 422, 8-day-old → released + new row |
| S41 | **Dangling custom hostnames** | Daily re-check → `expired` → provider delete; delete on remove/cascade; `domains:reconcile-provider` | Expiry deletes the provider hostname; cascade store delete enqueues the provider delete; reconcile deletes an orphan |
| S42 | **Unproven host served or issued a certificate** (T3) | Resolver serves `active` only; `ask` allows only `verified`/`ssl_provisioning`/`active`; storefront host still needs key + lookup | Storefront config for a `pending_verification` / `verified` / `expired` / `suspended` host → 404; `ask` for pending → 404 |
| S43 | **SSRF through DNS checks** (T14) | DoH endpoints from config only; hostname is a query parameter; no connection to merchant hosts; `SafeHttpClient` | Hostnames `169.254.169.254`, `127.0.0.1`, `localhost`, `metadata.google.internal` → 422 before any HTTP; Http::fake asserts only the two DoH hosts and Cloudflare are called |
| S44 | **Reserved / platform hosts** | P6-5 lists; PSL | `x.storeplix.com`, `PLATFORM_DOMAIN`, CNAME target, `co.uk`, `com.bd`, `shop` → 422 |
| S45 | **Homograph / IDN tricks** | UTS46 non-transitional + BIDI/CONTEXTJ checks; punycode stored; UI shows both forms | `ѕhop.com` (Cyrillic) stored as `xn--…` and displayed with punycode; invalid punycode → 422 |
| S46 | **Open redirect via `redirect_host`** | Value comes only from the DB primary; storefront validates it as a host and builds the URL from its own origin helper | Request with forged `?next=` / `X-Forwarded-Host` never changes the target; `redirect_host` with a path or scheme in the payload → ignored |
| S47 | **Privilege** (T10) | `ManageDomains` O A; staff read-only | Staff add/verify/primary/remove → 403 |
| S48 | **Cross-tenant / cross-store** (T1) | Route binding, `BelongsToTenant`/`BelongsToStore`, RLS | `assertTenantIsolation` + `assertStoreIsolation` on every domain route → 404 |
| S49 | **`ask` endpoint abuse** | Shared key, constant-time compare, identical 404 bodies, per-IP limit, internal network only, key never logged | No key → 401; unknown vs pending host → byte-identical 404; 1 201st request/min → 429; log scan has no key |
| S50 | **Provider credential leakage** (T15) | `CLOUDFLARE_API_TOKEN` env/secret manager only; never in responses, logs, `last_check` or audit | Log scan after a fake Cloudflare run has no token; resource key-set test |
| S51 | **Mass assignment** | `AddDomainInput` maps `hostname` only | Posting `status`, `is_primary`, `type`, `verification_token`, `provider_hostname_id` has no effect |
| S52 | **Check flooding / cost** | Per-domain re-check limit; `domains` limiter; provider calls only from `verified` on | 7th re-check in a minute → 429 with `retry_after`; no provider call for `pending_verification` rows |

SECURITY.md gets **T30 "Custom domain abuse"** (this change) and T4 points to it.

---

## 10. Test requirements

### API (Pest; group `domains`, security items also in `security`; definer functions in `rls` on Postgres)
- **Unit:** `HostnameInput` (table-driven: case, trailing dot, IDN → punycode, invalid punycode, IPv4/IPv6, ports,
  schemes, paths, wildcards, single label, public suffixes incl. `com.bd`, reserved suffixes, `.localhost` only with
  fake); `DomainStateMachine` full matrix (every allowed and a sample of illegal transitions, conditional update race:
  two transitions from one state → one wins); `ConsensusResolver` (agree ok, agree missing, disagree → mismatch, one
  error → inconclusive, TXT chunk joining, CNAME chain, flattened subset/superset); cadence (`next_check_at` per §2.2
  with a frozen clock); Cloudflare status mapping (data-driven over every listed value + an unknown one).
- **Feature (endpoints):** happy path for each route; validation and every §4.0 code; plan gate (Free → 402
  `feature_not_in_plan`, Starter third custom domain → 402 `plan_limit_reached`, trial → allowed); roles (S47);
  `assertTenantIsolation` / `assertStoreIsolation` on list/show/verify/primary/delete (S48); primary rules (only
  active, demote + promote atomic, partial unique holds under concurrent requests on Postgres `race`, fallback on
  delete and on expiry/suspend); platform row locked; re-check from failed/expired resets the window; 429 shape.
- **Jobs and commands:** `domains:check` discovery (due rows only, one job per row, RLS on); full lifecycle on fakes
  `pending → verified → ssl_provisioning → active`; 72 h timeout; SSL 24 h timeout deletes the provider hostname;
  active failing 7 days → expired + fallback + provider delete + emails; inconclusive never fails; reclaim (S40);
  `DeleteProviderHostnameJob` 404 = success; reconcile deletes orphans only (and honours `--dry-run`);
  suspend/reinstate; provider create idempotency (duplicate → adopt).
- **Revalidation/cache:** status/primary/hostname changes dispatch exactly one `RevalidateStorefront` with all hosts +
  removed host; bookkeeping-only saves dispatch none; resolver cache forgotten for old and new hosts.
- **Storefront config:** `redirect_host` matrix (platform primary → null on every platform host, set on an active
  non-primary custom host; custom primary → set on platform hosts and on non-primary custom hosts; null on the primary;
  null with a valid preview); a non-active custom host → 404 (S42).
- **`ask`:** S49 plus allowed statuses matrix and suspended store → 404; works with RLS on (`api-rls`).
- **Drivers:** `CloudflareCustomHostnames` and `DohResolver` against `Http::fake` fixtures (success, duplicate,
  404 on delete, 5xx/timeout → `provider_error`/inconclusive, auth error → `provider_error` with an ops log).
- **Security group:** S40–S52.
- **Boot checks:** `DOMAINS_FAKE=true` in production refuses; missing Cloudflare config in production refuses.

### Storefront (Vitest)
Config schema with/without `redirect_host`; redirect helper builds `{origin}{path}{search}` for `.localhost`/`.test`
(http + port) and real hosts (https); no redirect for preview, `/api/*`, POST; robots/sitemap 301 on non-primary;
invalid `redirect_host` → no redirect; proxy overwrites a client-supplied path header.

### Dashboard (Vitest + Testing Library)
Hostname strip/validation; apex hint; record table statuses and copy; failure copy per code; polling starts/stops by
status; 429 countdown; make-primary and remove confirms; plan-locked and limit states; staff read-only; empty,
loading, error states; 390 px layout of the records card.

### QA (Playwright, `tests/e2e/specs/phase6.*.spec.ts`, fake drivers)
- **domains:** register a **fresh merchant + store** (never the shared demo store: a custom primary would redirect
  every other spec); Chromium launched with `--host-resolver-rules="MAP *.storeplix.test 127.0.0.1"` (or the
  existing equivalent) for the platform host. Add `shop-{random}.localhost` → "Waiting for DNS" with two records →
  dev `dns` correct → Check now → "Securing" → dev `provider` active → Check now → "Connected" → Make primary →
  `GET http://{slug}.storeplix.test:3000/products/x?ref=1` answers **308** to
  `http://shop-{random}.localhost:3000/products/x?ref=1`; the primary page has `<link rel="canonical">` on the
  custom host; `robots.txt` on the platform host → 301. Remove the domain → the platform host serves 200 again.
- **domains-failures:** wrong TXT shows "≠ mismatch, we found …"; `age 73` → "Failed" → Check now → back to waiting;
  expiry path (`age` on an active domain with dev DNS missing) → "Disconnected" and primary fallback.
- **domains-security:** staff sees records but no actions; another tenant's domain id → 404 page; `ask` endpoint
  with/without key (request fixture).
- **mobile:** Domains page and records card at 390 px.
- **certification (manual dispatch only, never in CI):** `phase6.cloudflare.spec.ts` with `DOMAINS_FAKE=false`,
  real token/zone from the environment and a PO-provided test hostname; records fixtures (§13).

---

## 11. Configuration

| Key | Where | Notes |
|---|---|---|
| `DOMAINS_FAKE` | env | `true` in local/testing/e2e (compose default, CI e2e); boot refuses in production |
| `DOMAINS_CNAME_TARGET` | env → `config/domains.php` | default `customers.{PLATFORM_DOMAIN}` |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` | env (secret manager in prod) | required in production; never logged |
| `CLOUDFLARE_API_BASE` | config | `https://api.cloudflare.com/client/v4` |
| `domains.doh` | config (not env) | `cloudflare: https://cloudflare-dns.com/dns-query`, `google: https://dns.google/resolve`, timeout 3 s |
| `DOMAINS_ASK_KEY` | env (secret) | 32+ random chars; empty → `ask` always 401 |
| `DOMAINS_VERIFY_WINDOW_HOURS` (72), `DOMAINS_SSL_WINDOW_HOURS` (24), `DOMAINS_EXPIRE_AFTER_DAYS` (7), `DOMAINS_RECLAIM_AFTER_DAYS` (7), `DOMAINS_FAKE_SSL_POLLS` (1) | config | |
| `domains.reserved_suffixes` | config | `storeplix.com` + platform domain + target (always added in code) |
| Queue `domains` | worker `queue-domains` (`--queue=domains --tries=3 --timeout=90`) | compose + RUNBOOK §1 |
| Scheduler | `domains:check` every minute; `domains:reconcile-provider` daily 03:30 Asia/Dhaka (cloudflare driver only) | |

Storefront and dashboard need no new env.

---

## 12. Infrastructure prerequisites (owner QA unless noted)
1. Compose: `DOMAINS_FAKE=true`, `DOMAINS_ASK_KEY` (dev value), worker `queue-domains`; CI `e2e.yml` the same env.
2. CI: no new job; the `domains` group runs in `api-sqlite`/`api-postgres`, the definer-function and `ask` tests in
   `api-rls`.
3. `apps/api` composer: `jeremykendall/php-domain-parser` exact pin (≥ 14 days old) + committed PSL snapshot (API).
4. RUNBOOK **§9 Custom domains (Cloudflare for SaaS)** (owner QA, ARCH reviews): enable Cloudflare for SaaS on the
   zone; create the proxied fallback-origin record and set it as fallback origin; create `customers.{domain}` CNAME to
   it; origin certificate / Nginx `server_name` handling so custom `Host` headers reach the storefront only from
   Cloudflare IPs (DOMAIN-INFRASTRUCTURE §5); API token scope; `DOMAINS_*` env; the internal-only route for
   `/api/v1/internal/*`; reconcile command and how to read its output; how to suspend a domain.

---

## 13. Certification and accounts the PO must provide (post-build blocker, like 5b §16)

| For | What | Blocks |
|---|---|---|
| Cloudflare zone with **Cloudflare for SaaS** enabled (staging; can be the production zone with a staging fallback origin) | zone id; API token scoped to that zone (custom hostnames edit + read); fallback origin reachable from Cloudflare (staging storefront) | 6.2 certification, roadmap AC "staging domain goes `active` end-to-end" |
| A test domain the team controls | DNS access to add TXT + CNAME (and one apex with CNAME flattening if Q75 apex support is to be certified) | same |
| PO answers | Q69–Q76 (defaults in effect) | none |

Certification run (`phase6.cloudflare.spec.ts`, manual dispatch): subdomain lifecycle to `active` with a real
certificate (TLS handshake check on `https://{host}`), primary redirect through Cloudflare, removal deletes the
custom hostname, apex with flattening (if available), every **VERIFY** in §1/§5 resolved and recorded in this file,
fixtures re-recorded with `"_source": "staging-YYYY-MM-DD"`.

---

## 14. File ownership for Phase 6

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: migrations §3, `app/Domain/Domains/**`, `StoreDomain` model changes, `PreTenantLookup` (B17/B18), `DevDomainLookup`, `Feature`/`Limit`/`FeatureGate`/`PlanSeeder` (custom_domains), observers (P6-16), `StorefrontConfigResource` (`redirect_host`), routes, limiters, schedule, boot checks, mail, fixtures, composer dep + PSL file, `DemoSeeder` unchanged (no custom domain in the demo store) |
| **WEB** | `apps/merchant-dashboard/**` (§8), `packages/api-client/**` (domain methods), `packages/ui/**` (DNS record row / CopyField reuse, status badge variants) |
| **SF** | `apps/storefront/**` (§7) |
| **QA** | `tests/e2e/**`, `.github/**`, `docker-compose.yml`, `infrastructure/**`, `docs/development/TESTING.md`, `docs/reviews/phase-6-qa.md`, **and `docs/deployment/RUNBOOK.md` §9 only** |
| **ARCH** | Done with this contract: this file, `openapi.yaml` 1.7.0, `packages/types` (§6, delegated this phase), DOMAIN-INFRASTRUCTURE, DATABASE-DESIGN, API-CONVENTIONS, SECURITY (T30), OPEN-QUESTIONS Q69–Q76, roadmap. After acceptance: MULTI-TENANCY §9.4 (B17–B21 as built), FIGMA-INDEX (Domains frames from WEB's report) |

---

## 15. Order of work
1. Types and openapi are in this change; WEB and SF can mock against 1.7.0 immediately.
2. **API:** migrations + definer functions + `HostnameInput` + state machine + fakes → endpoints → `domains:check`
   and jobs → `redirect_host` → `ask` → Cloudflare driver with fixtures → emails/audit. SF needs only `redirect_host`
   (small; can land first behind the existing schema's optional field).
3. **WEB** (Domains page) and **SF** (redirect) in parallel against mocks, then against the API on fakes.
4. **QA:** compose/CI env, `phase6.*` specs, RUNBOOK §9 → QA gate `docs/reviews/phase-6-qa.md`.
5. **Certification** (§13) when the PO provides the zone; Phase 6 closes after it.

---

## 16. Acceptance criteria
1. On fakes: a Starter merchant adds a subdomain, sees TXT + CNAME with per-record status, and it reaches `active`
   by the scheduler alone and by "Check now"; failure, 72 h timeout, SSL timeout, expiry and re-check paths behave as
   §2; Free → 402; third domain on Starter → 402.
2. A `pending_verification`, `expired` or `suspended` host never serves store data; `ask` answers 200 only for
   `verified`, `ssl_provisioning`, `active` hosts of non-suspended stores.
3. Making a custom domain primary makes every other host of the store permanently redirect (308 pages, 301
   robots/sitemap) to the same path on the primary within one revalidation cycle; canonical, sitemap and robots use
   the primary; removing or losing the primary falls back to the platform subdomain and the redirect stops.
4. Removing a domain, expiry and SSL failure delete the provider hostname; reconcile finds orphans.
5. Another tenant's or store's domain ids → 404 everywhere; staff are read-only; S40–S52 tests pass, including the
   `rls` and `race` ones on Postgres.
6. Domains UI matches Figma `2042:47403` (+ composed states), works at 390 px, and has empty/loading/error states.
7. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`), Playwright `phase6.*` are green;
   `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes for 1.7.0.
8. **Post-build:** the certification run (§13) puts a real hostname `active` through Cloudflare with a valid
   certificate and resolves every VERIFY.

# QA gate: Phase 6 (custom domains)

Date: 2026-11-22 · Branch `phase-6-custom-domains` @ 7ad4a05 + the uncommitted Phase 6 working tree (API, WEB, SF
agents still finishing while this gate ran) · Contract PHASE-6-CONTRACT §9, §10 (QA), §11, §12. Reviewer: QA.

**Verdict: pass on fake drivers, with one High finding (H-1) to fix before merge.** The whole merchant flow works end
to end in a real browser on Postgres with RLS on: add → DNS records → verified → SSL → active → make primary → platform
hosts 308 to the custom host → expiry fallback → remove. Tenant isolation, definer functions, the `ask` endpoint and
the primary-race test pass with RLS on. H-1 is a design gap in the reclaim rule that lets a squatter hold any hostname
forever. The Cloudflare certification run (contract §13) is still a blocker for closing the phase and was not attempted
(no zone or token, Q69).

## 1. What ran

| Check | Environment | Result |
|---|---|---|
| `php artisan test --group=domains` | sqlite in-memory | 128 passed, 4 skipped (the RLS tests skip without Postgres, as designed) |
| `--group=domains --exclude-group perf,race` | Docker Postgres 16, `storeplix_app`, `TENANCY_RLS=true`, fresh DB `storeplix_qa6_test` | 130 / 131. The 1 failure (`test_cadence_is_recorded_on_every_check`: Postgres jsonb reorders `last_check.resolvers`) was already changed to `assertEqualsCanonicalizing` by the API agent after the run; `last_check` is never in a response |
| `--group=rls` | same | 31 / 31 (incl. `DomainsRlsTest`: definer functions, cross-tenant claim/allowed, reclaim + discovery) |
| `test_concurrent_make_primary_keeps_one_primary` (race) | same, own process | 1 / 1 |
| Playwright `phase6.domains` (new, 11 tests) | API `artisan serve` :8200 (Postgres, RLS on, `DOMAINS_FAKE=true`, own Redis queue + worker on `domains,default,…`), dashboard :5283, storefront :3000 | **11 / 11** (after fixing my own spec's expectations: §3) |
| Full Playwright suite (regression) | same stack | 110 passed, 5 failed, 3 skipped, 8 did not run (serial followers of failures). None of the 5 is Phase 6: §5 |

A first full run lost Chromium mid-run (the `~/Library/Caches/ms-playwright` directory was deleted by another process:
"Target crashed", then "Executable doesn't exist" for 17 specs). Chromium was reinstalled and the suite re-run; the
numbers above are from the clean re-run.

Not run: the CI workflows themselves (no push), the `api-sqlite` `domains` step with the PSL guard (checked by hand:
the snapshot has both section markers), the certification spec `phase6.cloudflare.spec.ts` (not written; needs §13).

## 2. Findings

| # | Sev | Area | Finding | Repro / evidence | Suggested fix |
|---|---|---|---|---|---|
| H-1 | **High** | API (P6-6, S40, Q73) | **A squatter can block any hostname forever without ever proving it.** Reclaim requires the holding row to be `verification_failed`/`expired` with `status_changed_at` older than 7 days. "Check now" on a failed row moves it back to `pending_verification` and resets `verification_started_at` *and* `status_changed_at` (`DomainService::recheck` → `DomainStateMachine::transition`). Re-checking once every < 10 days (72 h window + 7 days) keeps the claim alive indefinitely; any free-trial tenant can do it for 2 hosts per account, more with throwaway accounts. The real owner gets 422 `domain_taken` forever. | `apps/api/app/Domain/Domains/DomainService.php:159-180` (recheck resets the window), `:209` (`reclaimable`). Tenant A adds `shop.victim.com`, never publishes TXT; after the 72 h → `verification_failed`, A presses Check now every 9 days. Tenant B `POST /domains {hostname: shop.victim.com}` → 422 `domain_taken`, always | Base reclaim on proof, not on the status clock: e.g. a row that has **never** been verified (`verified_at IS NULL`) and was added (`created_at`) more than 72 h + 7 days ago is reclaimable regardless of re-checks; or let a newcomer whose own TXT token is live in DNS take the hostname from an unproven holder. Add an S40 test for the re-check loop. PO decision Q73 |
| M-1 | Medium | API (P6-8) | **Lock-order inversion → possible deadlock (500).** `remove()` locks the removed row `FOR UPDATE`, then `fallBackToPlatform()` locks the store row. `makePrimary()` locks the store row, then updates every `is_primary` row of the store (including the row `remove()` holds). Removing the primary while making another domain primary at the same moment deadlocks; Postgres aborts one with 40P01 and the client gets 500. | `DomainService.php:95-100` (row lock, then store lock via fallback) vs `:132-140` (store lock, then all `is_primary` rows); `DomainStateMachine.php:123` | Lock the store row first in `remove()` (same order as `makePrimary`), or catch 40P01 and retry once. Add to the `race` test |
| M-2 | Medium (fixed by QA) | Infra (P6-17, S49) | The `ask` key travels in the query string; the reference Nginx would have written it to the access log (default format logs `$request`), and `/api/v1/internal/*` was reachable from the public API server block. | `infrastructure/nginx/conf.d/api.conf` before this gate | **Fixed**: `location ^~ /api/v1/internal/` with `access_log off` and an allowlist of loopback + RFC 1918 ranges (`deny all` otherwise); RUNBOOK §9.4 says the public LB must not route it and no LB/APM may log its query. `nginx -t` passes |
| L-1 | Low | API (P6-6) | Release happens before the newcomer's row is inserted (outside a transaction by design, B20). If the insert then fails (plan limit race, 23505), the old owner has already lost the row and been emailed. | `DomainService.php` `add()` → `release()` before the insert | Run the limit check and a dry insert-ability check before `release()`, or accept and document |
| L-2 | Low | API (P6-7) | `FeatureGate::assertWithin(CustomDomains)` is not serialised: two concurrent adds on a Starter shop with 1 domain can both pass and create 3 custom rows. | `DomainService.php:48` | Same advisory-lock pattern as the Phase 4 plan-limit race (`test_plan_limit_race`) |
| L-3 | Low | WEB | A 429 on Remove (limiter `domains` 30/min) leaves the dialog open with the generic toast "We couldn't remove this domain. Try again." — no `retry_after`, no hint. Hit for real by the e2e spec (≈ 30 domain writes in a minute). Same for Make primary. | `online-store/domains/DomainsPage.tsx` RemoveDomainDialog / MakePrimaryDialog `onError` | Map `rate_limited` to "Too many changes, try again in N s" using `retry_after`, as the Check-now button already does |
| L-4 | Low | API (P6-16) | A revalidation job processed by a worker without `STOREFRONT_REVALIDATE_URL` only logs `storefront.revalidate_skipped` at **info**; after a primary change the old hosts keep redirecting to the old primary until the storefront's 60 s config TTL. Seen in this gate (a foreign worker on the shared DB queue took the job); production would hide a misconfigured worker the same way. | `RevalidateStorefront::handle` | Log at warning when `APP_ENV` is not local/testing |
| I-1 | Info | SF | The 308 keeps path + query, but Next re-encodes the query (`?next=https://evil.example/` → `?next=https%3A%2F%2Fevil.example%2F`). Semantically identical; the target origin is always the primary (S46 holds). The spec compares decoded parameters. | `phase6.domains` "make primary" test | none |

Reviewed and found sound (no finding):
- **Tenant isolation.** `StoreDomain` uses `BelongsToTenant`; domain routes sit in the `scopeBindings()` store group, so
  another store's/tenant's `{domain}` is 404 (verified live: every route + dashboard detail → 404/"Domain not found").
  Cross-tenant paths are only `withoutTenancy()` with `// cross-tenant:` markers (`CheckDomains`,
  `DomainPlatformLookup`) and the two definer functions. `sp_domain_claim_state` / `sp_domain_allowed` are `SECURITY
  DEFINER`, `search_path = public, pg_temp`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE` to `storeplix_app` only
  (`2026_07_01_000200`); `sp_domain_allowed` excludes suspended stores and unproven custom rows. Release of another
  tenant's row runs inside `TenantContext::run(oldTenant)`.
- **SSRF.** DoH endpoints come from `config('domains.doh')` only (not env, not input), `SafeHttpClient::assertSafeBaseUrl`,
  https, no redirects, 3 s; the merchant hostname is only a `name=` query parameter; the API never connects to it.
  `HostnameInput` rejects `127.0.0.1`, `169.254.169.254`, `localhost`, `metadata.google.internal`, ports, paths,
  userinfo, wildcards and special-use TLDs before any HTTP (verified live: all 422 `domain_invalid`).
- **Takeover rules.** TXT token per row (52-char base32, never rotated, hidden from the model); provider hostname only
  after TXT + CNAME proof (`provision()` only from `verified`); a duplicate at Cloudflare is adopted only if no row
  references it (unique index → never adopt); `DeleteProviderHostnameJob` and reconcile re-check references on the
  platform connection, so an adopted hostname isn't deleted by the old owner's job. Another tenant's active host → 422
  `domain_taken` (verified live). `*.localhost` accepted only with `DOMAINS_FAKE` outside production.
- **Redirect loops.** The API returns `redirect_host = null` on the primary and for previews; the storefront also refuses
  a target equal to the request host, any value with a scheme/port/path, and `//`/`/\` paths; `/api/*` and non-GET/HEAD
  never redirect. A primary is always `active` (CHECK) and falls back to the slug platform row in the same transaction
  when it leaves `active` or is removed (verified live: expiry and removal both stop the redirect). Platform hosts never
  redirect to a platform primary.
- **Secrets.** The Cloudflare driver logs action/status only; `ask` compares with `hash_equals`, empty key → 401; the
  dev server log shows the `ask` path without the query.

## 3. QA deliverables (this gate)

- `docker-compose.yml`: `DOMAINS_FAKE` (default `true`), `DOMAINS_ASK_KEY` (dev value), `DOMAINS_CNAME_TARGET`
  (set explicitly to `customers.${PLATFORM_DOMAIN}` so an empty env never reaches config), `DOMAINS_FAKE_SSL_POLLS`,
  empty `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID`; new worker **`queue-domains`**
  (`--queue=domains --tries=3 --timeout=90`); header notes for the scheduler entries. `docker compose config` passes.
- `infrastructure/docker/.env.example`: the Phase 6 block. `infrastructure/nginx/conf.d/api.conf`: M-2.
- `.github/workflows/e2e.yml`: `DOMAINS_FAKE=true` + `DOMAINS_ASK_KEY` in the stack `.env` and the Playwright env.
- `.github/workflows/ci.yml`: `api` job step "domains group + PSL snapshot" (fails when
  `resources/data/public_suffix_list.dat` is missing or lacks the ICANN/PRIVATE markers, or the group is empty);
  `api-postgres` step "domains (postgres)"; `api-rls` step "domains (RLS on)"; `test_concurrent_make_primary_keeps_one_primary`
  added to both race loops (`api-perf`, `api-rls`). Composer cache keys hash `composer.lock`, so the new pinned
  `jeremykendall/php-domain-parser` 6.4.0 (2025-04-26, needs only `ext-filter`; `intl` is already in every PHP job)
  invalidates the cache once and nothing else changes.
- `tests/e2e/specs/phase6.domains.spec.ts` (11 tests) + `tests/e2e/support/domains.ts` (`devDns`, `devProvider`,
  `devAge`, `ask`, `storefrontGet` with an explicit `Host` header so `{slug}.storeplix.test` needs no resolver rule,
  UI selectors one per helper). Fresh throwaway shop on Starter; never the demo store. Spec corrections made while
  running it (my expectations, not product bugs): a non-primary *custom* host redirects to the platform primary
  (P6-15); the 72 h failure code may be `verification_timeout`; Next re-encodes the query (I-1); the spec waits out one
  429 from the `domains` limiter.
- `docs/deployment/RUNBOOK.md` §9 (Cloudflare for SaaS setup, env, processes/schedule, `ask` + Caddy note, operating,
  staging certification with VERIFY items, rollback). `docs/development/TESTING.md`: `phase6.domains` row + run notes.

## 4. Open items for other owners

- **ARCH:** RUNBOOK §1 (process table) and §6 (schedule) need `queue-domains`, `domains:check`,
  `domains:reconcile-provider` rows (I own §9 only; §9.3 lists them). OPEN-QUESTIONS Q73 needs H-1's answer.
- **Certification (§13):** blocked on Q69 (zone, token, test domain). `phase6.cloudflare.spec.ts` to be written then.

## 5. Regression failures outside Phase 6 (not caused by this phase)

| Spec | Cause |
|---|---|
| `phase2.auth-flows` invite | Environment: the invite link uses `MERCHANT_APP_URL` (:5173); this gate's dashboard ran on :5283 (5173/5183 held by other processes) |
| `phase3.theme-editor` | Environment: the shared storefront's `STOREFRONT_EDITOR_ORIGINS` doesn't include :5283, so the preview iframe is refused |
| `phase4.dashboard` API shape | Spec drift since 5b-3: `orders` now also has `shipments`; the spec still expects 4 keys. Dashboard code untouched by Phase 6 |
| `phase4.mobile` dashboard | 399 px > 390 px: the KPI row ("Active products" / "Low stock" cards) overflows at 390 px. Dashboard code untouched by Phase 6; pre-existing |
| `phase5b.couriers` connect | `PUT …/couriers/steadfast {mode: 'sandbox'}` → 422 `validation_failed`, spec expects `credentials_invalid` (Steadfast has no sandbox; the spec's own helper uses `live`). No courier file changed in Phase 6 |

## Fixes after this gate (2026-11-22, not re-gated by QA)
- **H-1 fixed:** reclaim eligibility uses `store_domains.unproven_since` (migration `2026_07_01_000400`), set when a row
  first fails/expires and cleared only when TXT is proven again; "Check now" no longer resets it. Test: squatter
  re-checks daily for 8 days, real owner then reclaims.
- **M-1 fixed:** store row locked first in `remove()` and `makePrimary()`; race test
  `test_concurrent_remove_and_make_primary_do_not_deadlock` added to both CI race loops.
- **L-1 / L-2 fixed:** plan limit checked before release and again under the store-row lock on insert.
- **L-3 fixed:** Remove / Make primary map 429 to "Too many changes. Try again in N seconds."
- Open: L-4 (revalidation-skipped log level), Cloudflare staging certification (Q69), PO answers Q69–Q76.

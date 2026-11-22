# Phase 5b-1 QA Review (Isolation: Postgres RLS + per-shopper storefront limit)

- Date: 2026-11-22 (+06)
- Branch: `phase-5b-online-money` @ `77163eb`. 5b-1 commits: `066cfc6` (RLS, limiter, CI), `aa6bf06` (test helper,
  user GUC in `ResolveTenant`), `77163eb` (SF forwards the shopper IP on per-visitor calls).
- Spec: `docs/development/PHASE-5B-CONTRACT.md` §1.A, §2, §12 (S19–S21, S37), §13 (RLS), §19 step 2, §20.1–2;
  `docs/adr/0012-postgres-row-level-security.md`.
- **Mode: code + CI-log review with targeted reasoning. No live attack.** Docker was down; the Homebrew Postgres
  belongs to another project and was not touched. Everything that needs Postgres is taken from CI:
  run **45005886709** (`aa6bf06`) and run **45006340428** (`77163eb`, head of the branch). Both are green in every job.

**Verdict: PASS for the 5b-1 gate.** No Critical or High findings. There are 1 Medium, 7 Low and 6 Info findings.

- Isolation holds at the database. All 40 tables with a `tenant_id` column are in `RlsTables::TENANT` and have a
  forced policy with USING and WITH CHECK. The app role can't bypass RLS. Every pre-tenant path goes through an
  ids-only `SECURITY DEFINER` function or through `pgsql_admin` from console code. The GUC is reset at every request and
  job boundary.
- CI proves §20.1 on Postgres 16 as `storeplix_app` with `TENANCY_RLS=true`:
  - rls 23/23, with 0 skipped;
  - tenancy 91/91 and security 161/161;
  - all 7 race tests;
  - checkout p95 52.5 ms.
- **F-M1 should be fixed before any 5b-2 code merges.** A client that skips the storefront and sends no key still
  draws on the shop's shared host bucket, so one internet client can rate-limit a whole shop. This behaviour dates
  from 5a, but S37 exists to stop exactly this. The fix is a few lines in the limiter.

## 0. Declared deviations (API agent): verdicts

| # | Deviation | Verdict |
|---|---|---|
| 1 | `sms_messages` SELECT also shows null-tenant rows when no tenant is set | **Accept.** Postgres applies SELECT policies to an UPDATE's `WHERE`. Without this, `SendSms` (`Sms/Jobs/SendSms.php:29`, no tenant: OTPs only, since `OtpService::send` is never given a tenant) couldn't update the status. A pre-tenant session therefore sees phone + purpose + status of OTP SMS. The OTP itself is never stored (template name only), and the same phones are already readable in `users`, a platform table. **ARCH:** amend the §2.3 table: the SELECT policy equals the UPDATE policy. |
| 2 | The 5b tables get policies in their own later migrations | **Accept.** It is what P5B-5 says ("every 5b table is created with RLS in its own migration"). `RlsCoverageTest` and the CI catalogue step fail on any `tenant_id` table without forced RLS, so a miss can't slip through. Same for `sp_route_key_owner()`: a SQL function body is validated when it's created, so the function ships with its tables in 5b-2/5b-3. |
| 3 | GUC cast to `bpchar` | **Accept, correct.** With `char(26)` columns, `tenant_id = text` would cast the column and lose the `(tenant_id, …)` indexes. Not proven by an `EXPLAIN` test (see §4). |
| 4 | The tenant-switch guard fires only A → B, and only with RLS on | **Accept, with F-L1.** null → A inside a transaction is needed: registration and invitation accept open their transaction inside `run()`. With RLS off there is no GUC to desync. But a rollback can still desync the GUC on the A → null → B path, or by reverting a null → A set (fail-closed). |
| 5 | With RLS off, the old paths run unchanged | **Accept.** sqlite, local dev and the emergency rollback need it. Both branches run in CI: `api-postgres` runs as the owner with the old paths, `api-rls` as the app role with the definer functions and the reroute. |
| 6 | A missing client IP is only a debug log line | **Change requested (F-L5).** The contract asks for a `storefront.client_ip_missing` counter. A `debug` line is invisible at the usual production log levels, and a storefront deployed without `TRUSTED_PROXY=true` turns the per-IP limit off silently. |

## 1. Command results

| Command | Result |
|---|---|
| `php artisan test` (local, sqlite) | **PASS**: 418 tests (387 passed, **31 skipped** = the Postgres-only `rls` tests, race tests, perf), 24 414 assertions, 37 s. `--parallel` isn't available (no paratest), so it ran serially |
| `vendor/bin/pint --test` | **PASS** |
| `pnpm -r typecheck` | **PASS** |
| `pnpm -r lint` | **PASS**: 0 errors, 25 warnings (all merchant-dashboard, pre-existing kinds: `react-hooks/incompatible-library`, `react-refresh/only-export-components`) |
| `pnpm -r test` | **PASS**: 803 tests. merchant-dashboard 223, storefront 335 (incl. the new `preview-client-ip.test.ts`), themes 125, api-client 74, ui 39, super-admin 6, config 1 |
| CI 45006340428 `api (RLS on, app role, postgres)` | **PASS** (`77163eb`). Catalogue check "tenant tables: 40", no unforced table, no table owned by anyone other than `storeplix_owner`. `rls: tests=23 skipped=0`, `tenancy: tests=91 skipped=0`, `security: tests=161 skipped=0`, 7/7 race tests `tests=1 skipped=0`, `[perf] checkout 10 lines × 50 runs: p50 44.1 ms, p95 52.5 ms, max 60.8 ms` |
| CI 45006340428 other jobs | sqlite, `api-postgres` (owner), `api-perf`, web, themes: all green |
| CI 45005886709 | Green; same counts, p95 57 ms |

## 2. Acceptance criteria §20.1–2

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 20.1a | tenancy, security, rls and race suites pass on Postgres in CI, as `storeplix_app` with `TENANCY_RLS=true` | **PASS (CI)** | Run 45006340428, job `api-rls`: 23 / 91 / 161 / 7 races, none skipped. The run-group guard fails on an empty group or (strict) any skip |
| 20.1b | Raw SQL as the app role can't read, insert, update or delete another tenant's rows | **PASS (CI + review)** | `RlsRawSqlTest`: GUC A sees only A; unset sees 0 in every `RlsTables::TENANT` table; cross-tenant insert 42501; update/delete 0 rows; `audit_logs` update 42501. The policy SQL (`RlsPolicies.php:50-86`) was reviewed. Caveat: `tenant_users` DELETE (F-L2) |
| 20.1c | Every table with `tenant_id` has a forced policy | **PASS** | Independently checked: the tables created in the 50 migrations minus `RlsTables::PLATFORM` = exactly `RlsTables::TENANT` (40), and no `Schema::table` adds a `tenant_id`. Also `RlsCoverageTest` and the CI catalogue step ("tenant tables: 40") |
| 20.1d | The policy migration rolls back cleanly | **PASS, with a caveat (F-L4)** | `down()` was reviewed: it drops policies, `NO FORCE`, `DISABLE`, drops functions and re-grants `audit_logs`. CI ran the rollback, but it rolled back the **whole batch** (every migration), not `--step=1`, and the state after rollback isn't asserted |
| 20.1e | checkout p95 < 300 ms with RLS on | **PASS (CI)** | 52.5 ms (40 ms without RLS in 5a) |
| 20.2 | One shopper IP is limited at 300/min while other shoppers on the same store still get 200 | **PASS (local + CI)** | `StorefrontLimiterTest`: per-IP 429 while another IP gets 200; host limit; no header → host only; spoofed header without the key ignored; IPv6 /64 shared. Defaults 300 / 3 000. The SF forwards the IP on availability, cart, checkout, confirmation, track and every preview/no-store call (`commerce-api.ts:91-124,142-147`, `config-request.ts:38-42`); public cached calls never carry it. Caveat F-M1 |

## 3. Findings

### Medium

**F-M1: any client can exhaust a shop's storefront host bucket without the storefront key (S37 bypass).**
`apps/api/app/Providers/AppServiceProvider.php:70-83`; middleware order in `bootstrap/app.php:47-49`; the test that
encodes the behaviour is `tests/Feature/Storefront/StorefrontLimiterTest.php:63-69` ("throttled per host only").

- **Why it happens.**
  - `throttle:storefront` runs **before** `ResolveStorefront`. `ResolveStorefront` sits just before
    `SubstituteBindings` in the priority list, after `ThrottleRequests`.
  - The limiter keys the host bucket on the raw `X-Storefront-Host` header.
  - A request with no key (or a wrong one) gets no per-IP limit, but still hits `sf:{host}` and only then gets a 401.
  - `/api/` is publicly proxied (`infrastructure/nginx/conf.d/spa.conf:26`) and doesn't strip that header.
- **Repro (reasoned; matches the test).**
  1. Send `for i in $(seq 3001); do curl -s -o /dev/null -H 'X-Storefront-Host: victim.storeplix.app' https://<dashboard-host>/api/v1/storefront/config; done`
     from one machine: about 50 req/s, 3 000 × 401.
  2. For the rest of the minute, every real shopper of `victim` gets 429 on config, PDP, cart and checkout.
  3. Random hosts also write one Redis key each.
- **Impact.** One unauthenticated client can deny service to any shop. 5a had the same shape (host-only, 1 200/min).
  5b-1 adds the per-IP limit but doesn't close this path, and in 5b-2 the checkout carries money.
- **Fix (API).** In the `storefront` limiter, when the key isn't valid, return only
  `Limit::perMinute(N)->by('sf-nokey:'.$request->ip())` and don't touch the host bucket. Optionally, also skip the host
  bucket for hosts the resolver doesn't know. Change the test so that 13 keyless requests leave the real shopper at 200.

### Low

**F-L1: a transaction rollback can desync `app.tenant_id` from the `TenantContext`.**
`app/Domain/Tenancy/Database/RlsSession.php:57-68`, `TenantContext.php:26-48,91-105`.

- **Why it happens.** `set_config(…, false)` is transactional: a ROLLBACK, or a rollback to a savepoint, restores the
  value from before the transaction. The guard only refuses A → B. Two sequences escape it:
  - **Leak, needs an unusual flow.** Context A, `BEGIN`, `clear()` ('' set), `set(B)` (from null, allowed), `ROLLBACK`.
    The GUC is back to **A** while the context is **B**. App-layer scopes still filter on B, but raw `DB::table()` reads
    then see A's rows. No current code path does this.
  - **Fail-closed functional bug.** Context null, `BEGIN`, `set(A)` (not `run`), `ROLLBACK`. The GUC is '' while the
    context is A, so later queries return nothing.
- **Fix.** Listen to `Illuminate\Database\Events\TransactionRolledBack` on the app connection and re-apply
  `TenantContext::id()` plus the user. That is one listener, and it closes the whole class. Add a lifecycle test for
  the A → null → B + rollback sequence.

**F-L2: the `tenant_users` policy lets the app role DELETE the current user's memberships in other tenants.**
`app/Domain/Tenancy/Database/RlsPolicies.php:55-59`.

- **Why it happens.** `FOR ALL … USING (tenant_id = T OR user_id = U)`. For DELETE only USING applies, so under
  GUC tenant A + user U a raw or unscoped delete can remove U's membership rows in tenant B. That includes B's owner
  row if U owns B. UPDATE is blocked by WITH CHECK (unless the row is moved to A, which the app layer forbids).
- **Contract.** The policy is exactly as written in §2.3, so this is a spec-level gap.
- **Impact.** Limited to the acting user's own rows, and it needs an app bug.
- **Fix (ARCH + API).** Split the policy:
  - `FOR SELECT USING (tenant_id = T OR user_id = U)`;
  - `FOR INSERT/UPDATE/DELETE USING/WITH CHECK (tenant_id = T)`.

**F-L3: a misconfigured `pgsql_admin` silently disables every platform job.**
`config/database.php:122-134`, `RlsSession.php:113-125`.

- **Why it happens.** `DB_ADMIN_USERNAME` falls back to `DB_USERNAME`. With `TENANCY_RLS=true`, the boot check verifies
  only that the app user isn't the owner. If the admin user is left unset, it becomes `storeplix_app`, and every
  `withoutTenancy()` query in console code sees 0 rows without any error.
  - `subscriptions:end-trials`: trials never end (billing).
  - `orders:expire-confirmation-tokens`, `carts:prune`, `data:expire-exports`: nothing is pruned or expired.
- **Coverage today.** `RlsCoverageTest:99-105` catches this only in CI, not in production.
- **Fix.** Extend the boot check, or add an `about`/health check: with RLS on, the admin connection must be a
  `BYPASSRLS` role, checked lazily on its first `ConnectionEstablished`.

**F-L4: the CI "rollback is reversible" step doesn't test what §20.1 says.** `.github/workflows/ci.yml:486-489`.

- **Why it happens.** After `migrate:fresh --seed`, every migration is in batch 1. `migrate:rollback` without `--step=1`
  therefore drops the **whole schema**: the policy migration's `down()` runs first and does succeed, then every table
  is dropped. The state after the policy rollback is never inspected: no policies, `relrowsecurity = false`, functions
  gone, `audit_logs` UPDATE/DELETE re-granted, app still working.
- **Fix (QA, next round).** Use `migrate:rollback --step=1 --database=pgsql_owner`, run catalogue assertions, then
  `migrate`. Ideally also run `rls-emergency-off.sql` once against a scratch DB, with the same assertions.

**F-L5: the per-IP limit can turn off silently (deviation 6).** `AppServiceProvider.php:78`,
`apps/storefront/.env.example:10` (`TRUSTED_PROXY=false`), `apps/storefront/lib/commerce-request.ts:87-94`.

- **Why it happens.** Without `TRUSTED_PROXY=true`, the SF never sends `X-Storefront-Client-Ip`. Every shopper call then
  counts against the host bucket only (3 000/min), so one shopper can again exhaust a shop. The only signal is a
  `Log::debug` line on every keyless or headerless request: noise in dev, invisible in prod.
- **Compose.** Sets `TRUSTED_PROXY: "true"` (`docker-compose.yml:291`). The production runbook must too.
- **Fix.** Emit a counter or a sampled `info`/`warning` (e.g. at most once a minute per host), and put
  `TRUSTED_PROXY=true` in the deployment checklist.

**F-L6: emergency-off and `down()` drop the definer functions while the app may still call them.**
`database/sql/rls-emergency-off.sql:180-185`; migration `down()`, `…enable_row_level_security.php:68-72`.

- **Why it happens.** The documented order is "run the SQL, then set `TENANCY_RLS=false` and restart". Between the two,
  every storefront request (`sp_resolve_host`), the store-slug check and the invitation flow fail with "function does
  not exist": a full storefront outage during an incident. The functions are harmless with RLS off: they still return
  the same ids.
- **Fix.** Have the emergency script keep the functions (and `app_current_*`) and only drop policies, `NO FORCE` and
  `DISABLE`. Optional: the script doesn't need to re-widen `audit_logs` (UPDATE/DELETE) either. Keep the full drop in
  `down()`, but flip `TENANCY_RLS=false` **before** the rollback in the runbook.

**F-L7: nothing tests that the emergency-off script's table list matches `RlsTables::TENANT`.**
`database/sql/rls-emergency-off.sql:10`.

- **Why it matters.** The file hard-codes 40 tables, and the 5b-2…5b-5 tables will be added to `RlsTables::TENANT` in
  their own migrations. If someone forgets the SQL file, the emergency switch leaves those tables forced, and they go
  empty for the app once `TENANCY_RLS=false`.
- **Fix.** Add a sqlite-safe unit test that parses the script's `DROP POLICY … ON "x"` table names and compares them
  with `RlsTables::TENANT`, or generate the script with an artisan command.

### Info

- **I-1: the arch test is broader than it looks.** `tests/Feature/Tenancy/Rls/RlsBypassArchTest.php:20-35`.
  - It allowlists **all** of `app/Domain/Tenancy/`, which includes request middleware (`ResolveTenant`), so a bypass
    added there wouldn't be flagged. Today only `PreTenantLookup` (with RLS off) and `PlatformDb` use it.
  - The regex doesn't look for `pgsql_owner` / `tenancy.owner_connection`, `setConnection(` or `::on(`. A grep of
    `app/`, `routes/` and `database/seeders/` found no such use outside the allowlist.
  - Suggest narrowing the Tenancy allowlist to `Support/` and `Concerns/`/`Scopes/`, and adding the owner-connection
    patterns.
- **I-2: owner and admin passwords reach the web process.** `docker-compose.yml:55-58` gives `DB_OWNER_*` and
  `DB_ADMIN_*` to every API service, web included. No request path uses them, but an RCE in web gets BYPASSRLS
  credentials. For production, give owner credentials only to the migrate job, and admin credentials only to the
  scheduler and platform workers.
- **I-3: residual platform tables.** These tables have no `tenant_id` and no RLS, as the contract specifies, so the app
  role can read and write them across tenants:
  - `users`, including password hashes and phones;
  - `tenants`, including `status`;
  - `personal_access_tokens`, `sessions`.

  A raw-SQL bug can still reach them. Candidate for a later hardening: e.g. a `tenants` policy on
  `id = app_current_tenant() OR id IN (memberships)`.
- **I-4: `01-roles.sql` doesn't `REVOKE CREATE ON SCHEMA public FROM PUBLIC`.** That is fine on PG 15+ (CI and compose
  use 16), where `public` is owned by `pg_database_owner`, which the script makes `storeplix_owner`. On PG ≤ 14 the app
  role could create objects. Add the revoke for safety; it's idempotent.
- **I-5: definer-function signatures.** `sp_invitation_by_token(text)` and `sp_payment_owner(text)` take `text`, not
  `char(64)`/`char(26)` as in §2.3. With the explicit `::bpchar` cast the index is still used and the behaviour is the
  same. ARCH: align §2.3.
- **I-6: definer functions reviewed against abuse.** All 4 are `SECURITY DEFINER`, `SET search_path = public, pg_temp`,
  `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE` to the app role only, return ids or a boolean, and use exact-match lookups
  with no `LIKE` and no ranges. As SQL definer functions they are never inlined.
  - `sp_resolve_host` and `sp_store_slug_taken` reveal only what the public storefront and subdomains already reveal.
  - `sp_invitation_by_token` needs the sha256 of a 40-character random token.
  - `sp_payment_owner` needs a payment ULID.

  None of them can enumerate stores, tokens or payments beyond guessing exact keys.

### Verified with no finding

- **GUC lifecycle.**
  - `ResetDatabaseTenant` is global middleware [0] (arch test).
  - `ResolveTenant` and `ResolveStorefront` `clear()` in `finally`.
  - `run()` restores in `finally`.
  - The queue worker calls `forgetScopedInstances()` **before** each job (`Worker.php:268`), so `JobProcessing` →
    `reset()` writes ''.
  - `JobProcessed`/`JobFailed`/`JobExceptionOccurred` reset too; `sync` jobs keep the caller's state on purpose.
  - Every reconnect path dispatches `ConnectionEstablished` (`DatabaseManager::connection`/`reconnect`/`connectUsing`),
    and the listener re-applies the context and user.
  - No Octane, no persistent PDO, no PgBouncer.
  - The scheduler runs commands as separate processes on `pgsql_admin`. Commands that write
    (`ProvisionShippingDefaults`, `EnsureStoreContent`) re-load the store on `pgsql` inside `run()`, so relation
    writes don't inherit the admin connection.
  - `dispatchAfterResponse` (`OtpService:86`) runs after `clear()`, with a null tenant (deviation 1).
- **Roles and grants.**
  - `01-roles.sql`: app `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, not a member of owner or admin (asserted by
    the script). Default privileges are DML only, with no TRUNCATE, REFERENCES or TRIGGER.
  - The migration re-grants DML on existing tables and revokes `UPDATE, DELETE ON audit_logs` from the app role.
    `audit_logs` has only SELECT and INSERT policies.
  - CI asserts that the app role owns no table and that every table is owned by `storeplix_owner`.
- **Limiter key derivation.**
  - The client IP is trusted only with `hash_equals` on the key, and `FILTER_VALIDATE_IP` is applied.
  - IPv6 is keyed by `inet_ntop(first 8 bytes)` + `/64`; IPv4-mapped addresses are keyed by the v4 address.
  - The SF takes the shopper IP only behind `TRUSTED_PROXY`, from the first XFF entry. Nginx **overwrites** XFF with
    `$remote_addr` (`storefront.conf:15`) and blanks `X-Storefront-Key`/`-Host`, so a shopper can't spoof another
    shopper's IP.
  - Public cached calls never carry the IP (`config-request.ts:38-44`, `catalogCache`), so a cached body can't key on
    one visitor.
- **B3–B6.**
  - Registration writes the membership + audit row inside `run($tenant)`.
  - Invitations: definer → `run()` → the transaction opens inside `run()`.
  - Slug: closure rule via the definer, and 23505 on the slug → 422.
  - `StoreObserver` and `StoreProvisioner` use scoped queries inside `run()`.

## 4. What was verified only by CI, and what not at all

**CI only** (the code was read, but nothing ran locally because Postgres was unavailable):

- every `rls`-group test: raw-SQL probes, coverage, definer functions, lifecycle (worker job A → B, reconnect, switch
  guard), boot check, bypass paths;
- the whole `tenancy` and `security` groups under RLS;
- the 7 race tests under RLS;
- checkout p95;
- policy-migration up, and the full-batch rollback;
- the roles script on a fresh database.

**Not verified at all:**

- `EXPLAIN` of the orders list keeps an index scan (§2.8): there is no test. The p95 budget passes, but on a tiny
  dataset.
- `migrate:rollback --step=1` on its own, and the state it leaves (F-L4).
- `rls-emergency-off.sql` was never executed anywhere (F-L6, F-L7).
- A real queue worker on Redis with RLS: CI uses `QUEUE_CONNECTION=sync`, and the lifecycle test uses the `database`
  driver.
- Compose with RLS end to end (Docker down): `queue:work` containers, `schedule:work`, and the existing-volume path.
- The SF → API per-IP limit end to end through nginx (only unit-tested on each side).
- Production deployment settings: `TRUSTED_PROXY`, and credential separation per process (I-2).

## 5. Open items (noted, not fixed)

- **`.github/workflows/e2e.yml:29`** runs `docker compose exec -T api php artisan migrate --seed --force`. Compose now
  connects as `storeplix_app`, which can't create tables: `public` is owned by `storeplix_owner` and the app role has no
  CREATE. So the e2e job will fail at **migrate**, not just at seed. It needs `--database=pgsql_owner`. The user is
  deciding; the file was not edited.
- **Existing local Docker volumes** need the roles script re-run. Tables created before 5b-1 are owned by the
  `storeplix` superuser, so the owner role can't alter them for the policy migration. `TESTING.md` §2d already
  documents this: re-run `01-roles.sql`, and in practice recreate the volume.
- **ARCH:**
  - amend §2.3 for deviations 1 and 3 and I-5;
  - split the `tenant_users` policy (F-L2);
  - SECURITY.md T1/T16 follow-ups once F-M1 is fixed.

# Deployment runbook (API, Phase 5b)

Status: first version, 2026-11-22, written against the Phase 5b build (`phase-5b-online-money`: 5b-1 RLS, 5b-2
payments, 5b-3 couriers, 5b-4 documents, 5b-5 order changes). Hosting model: ADR 0010 (containers on VMs, one image
for web, workers and scheduler). Sources: PHASE-5B-CONTRACT §2, §15, §17; ADR 0012 (RLS), 0007 (payments),
0013 (couriers), 0014 (documents); MULTI-TENANCY §9; SECURITY.md; `docker-compose.yml` (the local reference stack).

No real secret belongs in this file or in the repo. Every value shown as `<…>` comes from the secret manager.
Every default in `docker-compose.yml` and `infrastructure/docker/.env.example` is DEV-ONLY and public, including the
committed `INTEGRATION_CREDENTIALS_KEY` and the role passwords equal to the role names.

---

## 1. Processes

One API image, several process types. Every process gets the same app env (§4) except for the DB credentials (§2.4).

| Process | Command | Replicas | Notes |
|---|---|---|---|
| `api` (web) | php-fpm behind Nginx | 2+ | DB role `storeplix_app` |
| `queue` | `php artisan queue:work redis --queue=default,media --tries=3 --timeout=90 --sleep=1` | 1+ | Short jobs: media, storefront revalidation, payment sweeps (`payments:*` per-tenant jobs), courier sync per account, booking reconcile, "Sync now" |
| `queue-bulk` | `php artisan queue:work redis --queue=bulk --tries=1 --timeout=310 --sleep=1 --memory=512` | 1 | CSV import/export (300 s jobs) and shipment batches (`RunBulkBooking`, up to 500 parcels) |
| `queue-notifications` | `php artisan queue:work redis --queue=notifications --tries=3 --backoff=10,60 --timeout=60 --sleep=1` | 1 | Shopper SMS/email, merchant email incl. `payment.mismatch`, late-payment refund and refund-failed alerts. Without it no order SMS or email is ever sent |
| `queue-documents` | `php artisan queue:work redis --queue=documents --tries=2 --timeout=150 --sleep=1 --memory=512` | 1 per Gotenberg | Invoice/label rendering (`RenderDocument`: `$timeout` 120 s, `$tries` 2). Needs Gotenberg (§5) |
| `queue-domains` | `php artisan queue:work redis --queue=domains --tries=3 --timeout=90 --sleep=1` | 1 | Custom-domain DNS checks and Cloudflare custom-hostname calls (`CheckDomainJob`, `DeleteProviderHostnameJob`; §9). Without it a domain only moves on "Check now" |
| `queue-webhooks` | `php artisan queue:work redis --queue=webhooks --tries=5 --backoff=10,60,300 --timeout=60 --sleep=1` | 1+ | SSLCommerz IPN verification, bKash notifications, courier webhook events (each re-queried with the provider before any effect) |
| `scheduler` | `php artisan schedule:work` (or cron `* * * * * php artisan schedule:run`) | **exactly 1** | §6. DB role `storeplix_admin` for discovery |
| `gotenberg` | `gotenberg --api-enable-basic-auth --api-timeout=120s` | 1 per API node pool | Internal only (§5) |
| migrate job | `php artisan migrate --force --database=pgsql_owner` | one-off per deploy | DB role `storeplix_owner` (§3) |

- `REDIS_QUEUE_RETRY_AFTER` must stay above the longest worker timeout: **360** (bulk is 310 s). Otherwise Redis hands a
  running bulk job to a second worker.
- ADR 0010 mentions Horizon. If Horizon replaces plain `queue:work`, keep one supervisor per row above with the same
  queues, tries, backoff, timeout and memory.
- `composer dev` mirrors these workers locally but has no `webhooks` worker; the compose stack has all of them.

---

## 2. Database roles and the RLS switch

Background: MULTI-TENANCY §9, ADR 0012. Three roles, created **outside** migrations:

| Role | Attributes | Who uses it |
|---|---|---|
| `storeplix_owner` | `LOGIN NOSUPERUSER BYPASSRLS`; owns the database, schema `public`, every table and function | the migrate job only |
| `storeplix_app` | `LOGIN NOSUPERUSER NOBYPASSRLS`; owns nothing; DML only | web and every queue worker |
| `storeplix_admin` | `LOGIN NOSUPERUSER BYPASSRLS`; DML only | scheduler, console commands (`withoutTenancy()` → `pgsql_admin`) |

### 2.1 Prerequisites
- Postgres **16** (CI and compose; the roles script relies on PG 15+ where `public` is owned by `pg_database_owner`).
- A superuser, or a role that may create roles with `BYPASSRLS` and change the database owner. On a managed service,
  check before the change window that its admin role can (a) `CREATE ROLE … BYPASSRLS`, (b) `ALTER DATABASE … OWNER TO
  storeplix_owner`. If it can't, stop and decide with ARCH; don't give the app role extra rights to work around it.
- **Connection pooling: PgBouncer off, or in session mode.** The tenant is held in session settings (`app.tenant_id`,
  `app.user_id`); transaction pooling would hand one request's settings to another client. No persistent PDO, no
  Octane (not tested with RLS).
- A fresh backup / a PITR marker taken right before the change.

### 2.2 Create the roles
Run `infrastructure/docker/postgres/initdb/01-roles.sql` with `psql` (it uses psql meta-commands) against the
production database. Passwords come from the secret manager through env vars, so they never appear on the command line
or in shell history:

```bash
export STOREPLIX_OWNER_PASSWORD='<from secret manager>'
export STOREPLIX_APP_PASSWORD='<from secret manager>'
export STOREPLIX_ADMIN_PASSWORD='<from secret manager>'
psql -v ON_ERROR_STOP=1 -h <db-host> -U <superuser> -d <database> \
  -f infrastructure/docker/postgres/initdb/01-roles.sql
unset STOREPLIX_OWNER_PASSWORD STOREPLIX_APP_PASSWORD STOREPLIX_ADMIN_PASSWORD
```

The script is idempotent (re-running re-applies attributes and passwords: this is also how passwords are rotated) and
works on the database it is connected to: run it once per database. It aborts if `storeplix_app` could bypass RLS or
is a member of the owner/admin role. If the variables are missing it falls back to DEV-ONLY passwords equal to the role
names: never let that happen in production (check that all three exports are set first).

**Existing database created by another user** (anything migrated before 5b-1): the tables belong to that user, so the
owner role can't alter them for the policy migration. As a superuser, in that database:

```sql
REASSIGN OWNED BY <previous_app_user> TO storeplix_owner;   -- tables, sequences, functions, extensions' objects
```
Then re-run `01-roles.sql` (default privileges) and continue with §2.3. Check afterwards that no table is owned by
anyone else (§2.5, query 2).

### 2.3 The switch (order matters, P5B-6)
Each step is reversible on its own.

1. **Code first, RLS off.** Deploy the 5b build with `TENANCY_RLS=false` and the app still on its previous DB user.
   With RLS off all three connections may point at one user; nothing changes in behaviour.
2. **Migrate as the owner** (§3): `php artisan migrate --force --database=pgsql_owner`. This creates the GUC helpers,
   the definer functions and the policies (`TO storeplix_app`) and re-grants DML. The running app connects as a user
   the policies don't target (or one that bypasses them), so there is still no effect.
3. **Switch the app user** on every process at once, with a rolling restart of web, all workers and the scheduler:

   ```
   DB_USERNAME=storeplix_app          DB_PASSWORD=<app password>
   DB_OWNER_USERNAME=storeplix_owner  (password only on the migrate job)
   DB_ADMIN_USERNAME=storeplix_admin  (password only on scheduler/console)
   TENANCY_RLS=true
   ```
   The API refuses to boot (`RlsMisconfiguredException`) when `TENANCY_RLS=true` and the app user equals the owner
   user, the admin user equals the app user (e.g. `DB_ADMIN_USERNAME` left unset), or the app role turns out to be a
   superuser/`BYPASSRLS` on connect. A refused boot is the safe failure: fix the env, don't turn RLS off.
4. **Verify** (§2.5) and run the smoke tests (§8).

### 2.4 Which process gets which credentials
The boot checks compare **user names** only, so every process needs `DB_USERNAME`, `DB_OWNER_USERNAME` and
`DB_ADMIN_USERNAME` set. Give passwords only where a connection is opened (QA 5b-1 I-2; compose gives all of them to
every container, which is acceptable only locally):

| Process | `DB_PASSWORD` (app) | `DB_ADMIN_PASSWORD` | `DB_OWNER_PASSWORD` |
|---|---|---|---|
| web, queue workers | yes | no | no |
| scheduler, ops console (`php artisan …`) | yes | yes | no |
| migrate job, seeders | yes | no | yes |

No request path or tenant job opens `pgsql_admin` (enforced by `RlsBypassArchTest`); console commands and the
scheduler's discovery queries do. Ops work that needs cross-tenant reads runs as a console command, not through tinker
as the app role (the app role sees nothing without a tenant).

### 2.5 Verification queries (as a superuser or `storeplix_owner`)
```sql
-- 1. Roles: app must be f/f; owner and admin must have rolbypassrls = t and rolsuper = f.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'storeplix\_%' ORDER BY 1;

-- 2. Every table owned by storeplix_owner (expect no rows).
SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'storeplix_owner';

-- 3. Every table with tenant_id has RLS enabled AND forced with a policy (expect no rows; 52 tenant tables today).
SELECT DISTINCT c.relname
  FROM information_schema.columns col
  JOIN pg_class c ON c.relname = col.table_name AND c.relkind IN ('r','p')
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = col.table_schema
 WHERE col.table_schema = 'public' AND col.column_name = 'tenant_id'
   AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));

-- 4. Definer functions exist.
SELECT proname, prosecdef FROM pg_proc
 WHERE proname IN ('sp_resolve_host','sp_invitation_by_token','sp_store_slug_taken','sp_payment_owner','sp_route_key_owner');
```
And as `storeplix_app` without a tenant: `SELECT count(*) FROM orders;` must return **0**.

---

## 3. Migrations

- Always as the owner: `php artisan migrate --force --database=pgsql_owner`. The app role can't create or alter
  tables (it owns nothing and has no `CREATE` on `public`); `migrate` as the app user fails.
- Seeders (staging/demo only): `php artisan db:seed --force --database=pgsql_owner`.
- Every 5b migration that creates a tenant table enables forced RLS for it in the same migration
  (`RlsPolicies::enable`). Migrations are forward-only once merged (CLAUDE.md) and must stay backward compatible with
  the running release (ADR 0010 deploy order: migrate, then rolling restart).
- Phase 5b migrations live from `2026_06_01_000100_enable_row_level_security` on (payment gateway accounts 000200,
  courier accounts 000700, shipments columns 000800, …).

---

## 4. Environment and secrets

### 4.1 Must be set for production

| Key | Value | Notes |
|---|---|---|
| `APP_ENV` | `production` | Turns on the production refusals below; `/api/v1/dev/*` routes are not registered |
| `APP_KEY` | secret manager | Also signs payment return URLs (26 h) and document downloads: rotating it invalidates the ones in flight |
| `DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE` | `pgsql`, … | `DB_SSLMODE` as the provider requires |
| `DB_USERNAME` / `DB_PASSWORD` | `storeplix_app` / secret | §2.4 |
| `DB_OWNER_USERNAME` / `DB_OWNER_PASSWORD` | `storeplix_owner` / secret (migrate job only) | |
| `DB_ADMIN_USERNAME` / `DB_ADMIN_PASSWORD` | `storeplix_admin` / secret (scheduler/console only) | |
| `TENANCY_RLS` | `true` | Default in code is `false`; boot checks in §2.3 |
| `INTEGRATION_CREDENTIALS_KEY` | 32 random bytes, base64, from the secret manager | Encrypts merchant gateway/courier credentials and courier webhook secrets (AES-256-GCM), separate from `APP_KEY`. Unset in production → the first use throws. Never the dev key from compose. Generate: `php -r "echo 'base64:'.base64_encode(random_bytes(32)), PHP_EOL;"` (or `openssl rand -base64 32`) |
| `INTEGRATION_CREDENTIALS_PREVIOUS_KEYS` | empty | Only during a rotation (§4.2) |
| `PAYMENTS_FAKE` | **`false`** | `true` with `APP_ENV=production` → the API refuses to boot |
| `COURIERS_FAKE` | **`false`** | same |
| `PUBLIC_API_URL` | `https://api.<platform domain>` | Base of the signed payment return URLs, the SSLCommerz IPN URL and the courier webhook URLs shown to merchants (`{PUBLIC_API_URL}/api/v1/webhooks/{provider}/{route_key}`). Falls back to `APP_URL`. Changing it later breaks every webhook URL merchants pasted into Steadfast/Pathao panels |
| `BKASH_LIVE_BASE_URL` | from bKash (not public) | No default: bKash live mode stays unavailable until it is set. Sandbox default `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout` |
| `SSLCOMMERZ_LIVE_BASE_URL` | default `https://securepay.sslcommerz.com` | Sandbox `https://sandbox.sslcommerz.com` |
| `STEADFAST_BASE_URL`, `PATHAO_LIVE_BASE_URL`, `REDX_LIVE_BASE_URL` | defaults in `config/couriers.php` | Merchant input never sets a host |
| `DOCUMENTS_DRIVER` | **`gotenberg`** | The code default is `html` (stores HTML, no PDF): production must set it |
| `GOTENBERG_URL` | internal URL, e.g. `http://gotenberg:3000` | Never a public URL |
| `GOTENBERG_USERNAME` / `GOTENBERG_PASSWORD` | secret, equal to the Gotenberg service's basic auth | If unset the client sends no auth |
| `GOTENBERG_TIMEOUT` | `30` | Client timeout per render request |
| `PRIVATE_DISK` | shared object storage (S3-compatible), not `local` | Documents are written by `queue-documents` and served by web; exports likewise |
| `QUEUE_CONNECTION` / `REDIS_QUEUE_RETRY_AFTER` | `redis` / `360` | §1 |
| `TRUSTED_PROXIES` | the exact load-balancer / Nginx ranges | The `webhooks` (300/min per IP), `payment-returns` (60/min per IP) and other per-IP limiters key on the client IP; wrong proxies put every visitor in one bucket |
| `THROTTLE_STOREFRONT_PER_IP` / `_PER_HOST` | `300` / `3000` (defaults) | Per-shopper storefront limit (S37) |
| `PAYMENT_HOLD_MINUTES`, `PAYMENT_LINK_DEFAULT_MINUTES`, `COURIER_SYNC_MINUTES`, `COURIER_SYNC_BATCH` | 30, 120, 15, 100 (defaults) | |

Storefront (Next.js): `TRUSTED_PROXY=true` behind Nginx (Nginx overwrites `X-Forwarded-For`), otherwise it never sends
`X-Storefront-Client-Ip`, the per-shopper limit is off and the API logs `storefront.client_ip_missing` (once per host
per 5 min). `STOREFRONT_API_KEY` is shared by API and storefront only.

Per-store merchant secrets (gateway and courier credentials, webhook secrets) are **never** in env: they are entered
in the dashboard and stored encrypted in `payment_gateway_accounts` / `courier_accounts`.

### 4.2 Rotating `INTEGRATION_CREDENTIALS_KEY`
1. Generate a new key in the secret manager.
2. Set `INTEGRATION_CREDENTIALS_PREVIOUS_KEYS=<old key>` (comma-separated if several) and
   `INTEGRATION_CREDENTIALS_KEY=<new key>` on **every** process; rolling restart. Values encrypted with the old key
   still decrypt; new writes use the new key.
3. On the scheduler/console host (needs the admin connection):
   `php artisan integrations:rotate-key --dry-run` (counts only), then `php artisan integrations:rotate-key`. It
   re-encrypts `payment_gateway_accounts.credentials`, `courier_accounts.credentials` and
   `courier_accounts.webhook_secret_encrypted`, skips values already on the new key, prints counts and ids only, and
   reports rows no configured key can decrypt.
4. When it reports nothing left on old keys, remove `INTEGRATION_CREDENTIALS_PREVIOUS_KEYS` and restart.

Never drop the old key before step 3 finishes: rows still on it become unreadable and those merchants must reconnect.

### 4.3 Provider-side registrations
- **SSLCommerz live refunds** need the platform's public **egress IP** registered with SSLCommerz (per merchant
  account, through SSLCommerz merchant support). Keep outbound traffic on a stable egress IP (NAT gateway / fixed
  address); a changed IP breaks live refunds until re-registered. A provider refusal surfaces as 422
  `gateway_refund_rejected` and the merchant records a manual refund.
- **bKash** live credentials and the live base URL come from the bKash PGW integration team. The bKash notification
  (`/webhooks/bkash/{route_key}`) is optional; `payments:reconcile` covers it.
- **Couriers:** merchants paste the webhook URL and secret shown in the dashboard into the Steadfast or Pathao panel.
  RedX runs on polling only (its webhook route answers 404 until verified).

---

## 5. Gotenberg (documents)

- Image pinned by tag **and** digest, at least 14 days old when pinned. Current pin (compose):
  `gotenberg/gotenberg:9.1.0@sha256:150c1dec38ccb51905f6bd29442706668f2442fb5d290d9eb234708dc054dd1a`.
- Command: `gotenberg --api-enable-basic-auth --api-timeout=120s`; env `GOTENBERG_API_BASIC_AUTH_USERNAME` /
  `GOTENBERG_API_BASIC_AUTH_PASSWORD` (same values as the API's `GOTENBERG_USERNAME` / `GOTENBERG_PASSWORD`).
- **Internal network only, no published port.** Only `queue-documents` talks to it. Memory limit 1 GB; healthcheck
  `GET /health`. One Gotenberg per API node pool; the API sends fonts and inlined images with each request, so Chromium
  needs no network.
- Check after deploy: `/health` is healthy; a convert request without credentials → 401 (CI `api-documents` asserts the
  same); generate one label in the dashboard and download it.
- Not configured (QA 5b-4/5 L-3): Gotenberg's Chromium JavaScript switch and URL deny-list. The HTML carries no script
  or URL (tested), so this is optional hardening.
- If Gotenberg is down, `RenderDocument` retries once and the document ends `failed`; the rest of the API is
  unaffected. Emergency fallback: `DOCUMENTS_DRIVER=html` stores printable HTML instead of PDF.

---

## 6. Scheduler and scheduled commands

Exactly one scheduler process (`schedule:work`). Commands find work on `pgsql_admin` and dispatch one tenant-aware job
per tenant/account (on `default`), so the `queue` worker must be running too. `withoutOverlapping()` needs the shared
Redis cache.

| Command | Schedule | Purpose |
|---|---|---|
| `payments:expire` | every minute, no overlap | Pending online payments past the 30-min hold: query the provider; paid → apply, else cancel charge and order (`payment_timeout`), release stock |
| `payment-links:expire` | every minute, no overlap | Expire payment links; cancel the order when `cancel_if_unpaid` |
| `payments:reconcile` | every 5 min, no overlap | Query pending online payments older than 2 min (covers lost IPNs and bKash without IPN) |
| `payments:refund-status` | every 10 min, no overlap | Poll SSLCommerz refunds still `processing` |
| `couriers:sync` | every 15 min, no overlap | One job per courier account with non-final shipments (batch ≤ 100) |
| `couriers:reconcile-bookings` | every 2 min, no overlap | Bookings with an unknown outcome (timeout) looked up by our invoice; `booking_failed` after 10 min |
| `domains:check` | every minute, no overlap | Dispatch DNS / SSL checks for domains that are due (pending verification, SSL provisioning, active re-checks); drives the 72 h / 7-day transitions (§9) |
| `domains:reconcile-provider` | daily 03:30 Asia/Dhaka, no overlap | Compare our custom hostnames with Cloudflare; clean up orphans (§9) |
| `documents:prune` | hourly | Delete generated documents after 24 h |
| `webhooks:prune` | daily | Delete `webhook_events` older than 90 days |
| `idempotency:prune` | hourly | |
| `data:expire-exports` | hourly | |
| `sanctum:prune-expired --hours=24` | daily | |
| `subscriptions:end-trials` | daily | |
| `data:prune-imports` | daily | |
| `carts:prune` | daily | |
| `orders:expire-confirmation-tokens` | daily | |

Without the scheduler unpaid holds never expire, links never expire and a lost IPN is never reconciled. The `payments:*`,
`payment-links:expire`, `couriers:sync` and `couriers:reconcile-bookings` take `--sync` to run the per-tenant jobs inline during an incident.

Not scheduled (run by hand): `integrations:rotate-key`, `shipping:provision-defaults`, `stores:ensure-content`.
`couriers:fake-advance` is for fake couriers only.

---

## 7. Rollback

### 7.1 Application release
Roll back to the previous image (ADR 0010). Migrations are forward-only and backward compatible, so the previous
release runs on the new schema. Don't roll back migrations in production except for the RLS case below.

### 7.2 RLS: back to app-level isolation only
Use when RLS causes an outage (e.g. a path that sees no rows). Data is not touched.

**Option A, quickest (no code change):** switch the app back to a bypassing user: set `TENANCY_RLS=false` and point
`DB_USERNAME`/`DB_PASSWORD` at `storeplix_owner` (with `TENANCY_RLS=false` the boot checks are off); rolling restart.
Policies stay in place but the owner bypasses them. The web process then holds DDL rights: keep this short. Return
with §2.3 step 3.

**Option B, emergency switch-off script (policies removed):**
1. As `storeplix_owner` (or a superuser):
   ```bash
   psql -v ON_ERROR_STOP=1 -h <db-host> -U storeplix_owner -d <database> -f apps/api/database/sql/rls-emergency-off.sql
   ```
   One transaction: drops every policy, `NO FORCE` + `DISABLE ROW LEVEL SECURITY` on every table of
   `RlsTables::TENANT`, re-grants `UPDATE, DELETE ON audit_logs` to the app role. **The definer functions and GUC
   helpers stay**, so the running app (`TENANCY_RLS=true`) keeps resolving storefront hosts; there is no outage
   between the script and the config change.
2. Set `TENANCY_RLS=false` and restart web, workers and the scheduler at a calm moment. The app may keep connecting as
   `storeplix_app`: without policies the role sees every row, and isolation is app-level only (`BelongsToTenant`).
3. Note the incident: `audit_logs` is no longer append-only at the DB level until RLS is back.

**Re-enable** after the fix:
1. `php artisan tenancy:rls-enable` (defaults to `--database=pgsql_owner`). In one transaction it re-applies ENABLE +
   FORCE RLS and every policy to each table in `RlsTables::TENANT` (idempotent: `RlsPolicies::enable()` drops and
   recreates), and re-revokes `UPDATE, DELETE ON audit_logs` from `storeplix_app`. Data and definer functions are
   untouched. Tested by `RlsReEnableTest` (group `rls`).
2. Set `TENANCY_RLS=true` and restart web, workers and the scheduler; verify with §2.5.
- Do **not** use `migrate:rollback` in production for this: later 5b migrations sit on top of
  `2026_06_01_000100`, so `--step=1` would undo the newest migration instead, and rolling back to `000100` (what CI
  does with `--step=<count>`) drops every 5b table and its data.

Option A is the preferred first move in an incident; it keeps the policies, so re-enabling is only the env switch back.

### 7.3 Payments and couriers
- A gateway or courier outage needs no rollback: checkout falls back to COD where enabled; merchants can disable a
  gateway (`PATCH enabled`) or book parcels manually.
- Never switch `PAYMENTS_FAKE`/`COURIERS_FAKE` on in production (the API refuses to boot).
- A wrong `INTEGRATION_CREDENTIALS_KEY` deploy: put the previous key back (or into `_PREVIOUS_KEYS`); nothing is
  rewritten until `integrations:rotate-key` runs.

### 7.4 Documents
`DOCUMENTS_DRIVER=html` on web and `queue-documents` keeps printing working (HTML instead of PDF) while Gotenberg is
fixed.

---

## 8. Post-deploy checks

1. `GET /api/v1/health` → 200 on every web node.
2. Logs: no `RlsMisconfiguredException`, no `storefront.client_ip_missing` warnings, no `PAYMENTS_FAKE`/`COURIERS_FAKE`
   refusal.
3. §2.5 queries clean.
4. A storefront page of a live store renders (host resolution through `sp_resolve_host`); merchant login and the
   order list load (tenant GUC set).
5. `php artisan schedule:list` on the scheduler host shows the §6 commands; queue depth per queue stays near zero.
6. Gotenberg: one label renders and downloads (§5).
7. Staging only: a sandbox payment and a fake-courier booking end to end (`tests/e2e` `phase5b.*`).

---

## 9. Custom domains (Cloudflare for SaaS, Phase 6)

Sources: PHASE-6-CONTRACT §1 (P6-1, P6-11–P6-18), §5.2, §11–§13; DOMAIN-INFRASTRUCTURE; ADR 0003. Owner: QA (ARCH
reviews). Everything marked **VERIFY** is a Cloudflare detail the public docs don't settle; the §13 certification run
resolves it and records the answer in PHASE-6-CONTRACT. Until then treat those lines as the expected setup, not a fact.

How it fits together: a merchant points `shop.acme.com` at `customers.storeplix.com` (CNAME) and publishes a TXT
`_storeplix-verify.shop.acme.com`. Our checker proves both over DNS-over-HTTPS, then creates a Cloudflare custom
hostname (`ssl.method=http`, DV). Cloudflare issues the certificate and proxies the visitor to the **fallback origin**
(our Nginx → Next.js storefront) with the merchant's `Host`. The storefront resolves the store from that host through
the API (`sp_resolve_host`, `active` rows only).

### 9.1 One-time Cloudflare setup (per environment: staging zone first)
1. **Zone.** The platform zone (`storeplix.com`; staging may be a separate zone or the same zone with a staging fallback
   origin, §13). Plan with Cloudflare for SaaS available (VERIFY the custom-hostname quota of the plan against Q70:
   2–5 per paying shop).
2. **Enable Cloudflare for SaaS**: dashboard → zone → SSL/TLS → Custom Hostnames → enable (VERIFY the exact menu path;
   it has moved between dashboard versions).
3. **Fallback origin record.** Create `customers.storeplix.com` as a **proxied** (orange cloud) DNS record pointing at
   the storefront origin (A/AAAA to the load balancer, or CNAME to its hostname). Then set it as the fallback origin:
   dashboard Custom Hostnames → Fallback Origin → `customers.storeplix.com`, or
   `PUT /zones/{zone_id}/custom_hostnames/fallback_origin` `{"origin":"customers.storeplix.com"}`. Wait until the
   fallback origin status is `active`. `customers.storeplix.com` is also `DOMAINS_CNAME_TARGET` (contract default
   `customers.{PLATFORM_DOMAIN}`), so one record is both the merchants' CNAME target and the fallback origin. If ops
   prefers a separate origin record (e.g. `fallback-origin.storeplix.com`), keep `customers.storeplix.com` as a proxied
   CNAME to it; `DOMAINS_CNAME_TARGET` stays `customers.storeplix.com` either way.
4. **SSL mode Full (strict)** for the zone, with a Cloudflare **Origin CA certificate** on the origin Nginx covering
   `customers.storeplix.com` and `*.storeplix.com`. Custom hostnames reach the origin with SNI/Host = the merchant's
   hostname (VERIFY: whether the origin sees the custom hostname or the fallback origin as SNI; Nginx must serve the
   Origin CA certificate as `default_server` either way).
5. **Origin Nginx** (DOMAIN-INFRASTRUCTURE §5): the storefront server block is the `default_server` (any `Host`), and
   accepts traffic **only from Cloudflare IP ranges** (`allow` the published IPv4/IPv6 lists, `deny all`; refresh the
   lists from `https://www.cloudflare.com/ips-v4` / `ips-v6` on every deploy). `set_real_ip_from` the same ranges with
   `real_ip_header CF-Connecting-IP`, so `X-Forwarded-For` (and the storefront's per-shopper limiter, S37) sees the
   shopper, not Cloudflare. Keep the existing rules: `X-Forwarded-Host` overwritten with `$host`, `X-Storefront-*`
   request headers blanked.
6. **API token** (Cloudflare → My Profile → API Tokens → Create custom token):
   - Permissions: **Zone → SSL and Certificates → Edit** (custom hostnames create/read/delete live under it) — VERIFY;
     add **Zone → Zone → Read** only if certification shows list calls need it. Nothing else (no DNS edit, no account
     permissions).
   - Zone resources: **Include → Specific zone → the SaaS zone** only.
   - Client IP filtering: the API/worker egress IPs if they are static. TTL: none, rotated yearly (§9.6).
   - Store it in the secret manager as `CLOUDFLARE_API_TOKEN`; the zone id (zone overview page) as `CLOUDFLARE_ZONE_ID`.

### 9.2 Environment (web, every queue worker, scheduler)
| Key | Production | Notes |
|---|---|---|
| `DOMAINS_FAKE` | **`false`** | `true` with `APP_ENV=production` → the API refuses to boot (P6-13) |
| `CLOUDFLARE_API_TOKEN` | secret manager | Required in production (boot refuses when empty). Never logged, never in a response, `last_check` or audit |
| `CLOUDFLARE_ZONE_ID` | the SaaS zone id | Required in production |
| `CLOUDFLARE_API_BASE` | default `https://api.cloudflare.com/client/v4` | config only |
| `DOMAINS_CNAME_TARGET` | `customers.storeplix.com` | Shown to merchants; changing it later breaks every merchant's CNAME |
| `DOMAINS_ASK_KEY` | 32+ random chars, secret manager (`openssl rand -hex 32`) | Empty → the `ask` endpoint always answers 401 |
| `DOMAINS_VERIFY_WINDOW_HOURS` / `_SSL_WINDOW_HOURS` / `_EXPIRE_AFTER_DAYS` / `_RECLAIM_AFTER_DAYS` | 72 / 24 / 7 / 7 (defaults) | |
| `PLATFORM_DOMAIN` | `storeplix.com` | Its subdomains are reserved (P6-5) |

DoH resolvers (`domains.doh`: `https://cloudflare-dns.com/dns-query`, `https://dns.google/resolve`) are config, not env:
the API and `queue-domains` hosts need outbound HTTPS to both and to `api.cloudflare.com`. Nothing else is called;
the API never connects to a merchant's hostname.

### 9.3 Processes and schedule
| Process / command | Schedule | Notes |
|---|---|---|
| `queue-domains`: `php artisan queue:work redis --queue=domains --tries=3 --timeout=90 --sleep=1` | worker, 1+ | `CheckDomainJob` (60 s job timeout), `DeleteProviderHostnameJob` (5 tries with backoff). Add it to the §1 process list |
| `domains:check` | scheduler, every minute, no overlap | Discovery on `pgsql_admin` (≤ 500 due rows), one job per row on `domains` |
| `domains:reconcile-provider` | scheduler, daily 03:30 Asia/Dhaka (cloudflare driver only) | Deletes Cloudflare custom hostnames older than 1 h that no row references. `--dry-run` lists them only |
| `domains:suspend {hostname} --reason=` / `domains:reinstate {hostname}` | by hand | §9.5 |
| `domains:update-psl` | by hand, monthly | Refreshes `apps/api/resources/data/public_suffix_list.dat`; commit the result (CI never downloads it) |

**Reading the reconcile output:** each line is a provider hostname id + hostname + created time + the action
(`deleted`, `would delete` with `--dry-run`, or `kept: referenced`). A non-zero orphan count every day means removals
are not reaching Cloudflare: check `queue-domains` and failed `DeleteProviderHostnameJob` rows (`php artisan
queue:failed`). **After any database restore** run `domains:reconcile-provider --dry-run` first: a restored DB may lack
rows that still have live, paying merchants on Cloudflare.

### 9.4 The `ask` endpoint (6.5, future Caddy on-demand TLS)
`GET /api/v1/internal/domains/allowed?domain={host}&key={DOMAINS_ASK_KEY}` → 200 `{data:{allowed:true}}` for a
`verified` / `ssl_provisioning` / `active` custom host or an `active` platform host of a non-suspended store; 404
`domain_not_allowed` (unknown, pending, malformed, suspended — byte-identical bodies); 401 without the right key; 429
above 1 200/min per IP. Phase 6 does **not** deploy Caddy; Cloudflare issues certificates. The endpoint exists so a
later Caddy (or an allowlist check) can ask before issuing:
```
{
  on_demand_tls {
    ask http://<internal-api-host>:8000/api/v1/internal/domains/allowed?key=<DOMAINS_ASK_KEY>
  }
}
```
(Caddy appends `domain=`; VERIFY the exact Caddy version's `ask` semantics when Caddy is adopted.)
- **Internal network only.** The public load balancer / Nginx must not route `/api/v1/internal/*` (answer 404 there).
  The reference `infrastructure/nginx/conf.d/api.conf` allows the location only from loopback and RFC 1918 ranges.
- **The key is in the query string**, so no access log may record it: the reference Nginx location has
  `access_log off`; any LB or APM in front must drop the query for this path. Laravel logs the path only.
- Smoke test from an internal host: no key → 401; `domain=unknown.example` → 404; the platform subdomain of a live
  shop → 200.

### 9.5 Operating
- **Suspend one hostname** (phishing, abuse, legal): `php artisan domains:suspend shop.acme.com --reason="ticket 123"`.
  The host stops routing at once (resolver cache forgotten, storefront revalidated); if it was primary the store falls
  back to its platform subdomain; the Cloudflare hostname is kept (so a reinstate is quick). Merchants cannot undo it.
  `php artisan domains:reinstate shop.acme.com` re-checks DNS now. Suspending the whole store (`stores.status`) needs no
  domain command.
- **A merchant says "stuck on Securing"**: `ssl_provisioning` polls every 2 min for 1 h then every 15 min, and fails
  after 24 h (`ssl_timeout`). Look at the Cloudflare dashboard custom hostname (certificate validation errors) — the
  usual cause is a CAA record on the merchant's domain that excludes Cloudflare's CAs, or the merchant's own Cloudflare
  proxy (orange cloud) in front of the CNAME (`cname_mismatch`: tell them to switch it to "DNS only").
- **Apex domains** work only with CNAME flattening / ALIAS at the merchant's DNS (Q75); no A-record IPs are handed out.

### 9.6 Staging certification (PHASE-6-CONTRACT §13; blocker for closing Phase 6)
Needs from the PO (Q69): the staging zone with Cloudflare for SaaS, its zone id, a token per §9.1.6, a fallback
origin reachable from Cloudflare (the staging storefront), and a test domain with DNS access (plus one apex with CNAME
flattening if Q75 is to be certified).
1. Staging API, `queue-domains` and scheduler with `DOMAINS_FAKE=false`, `CLOUDFLARE_*` set, `APP_ENV=staging`.
2. Boot check: start once with `CLOUDFLARE_ZONE_ID` empty and `APP_ENV=production` on a scratch container → refuses.
3. As a Starter test shop add `cert-{date}.<test domain>`; publish the TXT and CNAME shown in the dashboard; wait.
   Expected: `pending_verification → verified → ssl_provisioning → active` without "Check now". Record each transition
   time and the raw Cloudflare `status` / `ssl.status` sequence (VERIFY the status lists in contract §5.2).
4. `curl -vI https://cert-….<test domain>/` → valid certificate for that host (issuer, SAN), 200 from the storefront.
5. Make it primary → `https://<slug>.staging-platform-domain/x?y=1` answers 308 to `https://cert-…/x?y=1`.
6. Duplicate create: add the same hostname to a second test shop after releasing it (reclaim path) → the driver
   adopts / reports the duplicate (VERIFY the Cloudflare error code).
7. Remove the domain → the custom hostname disappears from Cloudflare within one `queue-domains` run (dashboard / `GET
   /zones/{zone}/custom_hostnames?hostname=`).
8. Create a hostname by hand in the dashboard, wait > 1 h, run `domains:reconcile-provider --dry-run` (listed) then
   without `--dry-run` (deleted).
9. Apex with flattening (if available): A set ⊆ the target's A set passes (VERIFY P6-3).
10. Re-record `apps/api/tests/Fixtures/domains/cloudflare/*.json` with `"_source": "staging-YYYY-MM-DD"` (ids and the
    token redacted), resolve every VERIFY in the contract, and run `tests/e2e/specs/phase6.cloudflare.spec.ts`
    (manual dispatch only) once it exists.

### 9.7 Rollback
- **Application rollback** (previous image): the Phase 6 migrations are additive; the previous release ignores the new
  columns. Existing custom hostnames keep routing through Cloudflare (the old resolver serves `active` rows), but
  nothing checks them any more: re-deploy Phase 6 within days, or run `domains:suspend` on hosts that must stop.
- **Stop new connections without a deploy**: there is no runtime flag; remove `custom_domain` from the plans
  (`plan_features`) — adding a domain then answers 402, existing domains keep working (Q71).
- **Cloudflare misconfiguration** (fallback origin wrong, token revoked): domains in `ssl_provisioning` time out after
  24 h, `active` ones keep serving while Cloudflare still has them. Fix the token/fallback origin first; then merchants
  press "Check now" (failed rows go back to `pending_verification` with a fresh 72 h window).
- **Never** set `DOMAINS_FAKE=true` in production (refused at boot) and never run `domains:reconcile-provider` without
  `--dry-run` right after a database restore (§9.3).
- **Leaving Cloudflare for SaaS**: delete custom hostnames only through the app (remove / reconcile), never by disabling
  the feature on the zone while merchants still point at `customers.storeplix.com`: every custom domain would go dark
  at once.

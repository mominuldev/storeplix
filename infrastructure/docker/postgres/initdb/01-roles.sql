-- Store Plix: database roles for Postgres row-level security (PHASE-5B-CONTRACT §2.1, ADR 0012).
--
-- Runs as a SUPERUSER with psql (it uses psql meta-commands, not plain SQL):
--   * docker compose: mounted into /docker-entrypoint-initdb.d, runs once on a fresh volume.
--   * existing volume: docker compose exec postgres psql -U storeplix -d storeplix -f /docker-entrypoint-initdb.d/01-roles.sql
--   * CI (api-rls):    psql -v ON_ERROR_STOP=1 -v owner_pw=… -v app_pw=… -v admin_pw=… -v db=storeplix_rls_test -f 01-roles.sql
--   * production:      the runbook in docs/deployment/ (real passwords via -v, never the dev defaults).
--
-- Idempotent: roles are created when missing and their attributes/passwords are (re)applied every run, so it
-- can be re-run, and run once per database (database ownership and default privileges are per database).
--
-- Roles:
--   storeplix_owner  owns the database + schema objects, runs migrations/seeders. BYPASSRLS.
--   storeplix_app    web + queue workers. NOSUPERUSER NOBYPASSRLS, owns nothing, DML only. RLS applies.
--   storeplix_admin  platform jobs, scheduler, console, future /admin/*. BYPASSRLS, DML only.
--
-- Variables (psql -v name=value). When missing: the env var named below, then a DEV-ONLY default.
--   owner_pw  STOREPLIX_OWNER_PASSWORD  (default storeplix_owner)
--   app_pw    STOREPLIX_APP_PASSWORD    (default storeplix_app)
--   admin_pw  STOREPLIX_ADMIN_PASSWORD  (default storeplix_admin)
--   db        (default: the database psql is connected to)

\set ON_ERROR_STOP on

\if :{?owner_pw}
\else
  \getenv owner_pw STOREPLIX_OWNER_PASSWORD
\endif
\if :{?owner_pw}
\else
  \set owner_pw storeplix_owner
\endif

\if :{?app_pw}
\else
  \getenv app_pw STOREPLIX_APP_PASSWORD
\endif
\if :{?app_pw}
\else
  \set app_pw storeplix_app
\endif

\if :{?admin_pw}
\else
  \getenv admin_pw STOREPLIX_ADMIN_PASSWORD
\endif
\if :{?admin_pw}
\else
  \set admin_pw storeplix_admin
\endif

\if :{?db}
\else
  SELECT current_database() AS db \gset
\endif

-- ---------------------------------------------------------------------------------------------------------
-- Roles (created once; attributes enforced on every run)
-- ---------------------------------------------------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeplix_owner') AS create_owner,
       NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeplix_app')   AS create_app,
       NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeplix_admin') AS create_admin \gset

\if :create_owner
  CREATE ROLE storeplix_owner;
\endif
\if :create_app
  CREATE ROLE storeplix_app;
\endif
\if :create_admin
  CREATE ROLE storeplix_admin;
\endif

ALTER ROLE storeplix_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
ALTER ROLE storeplix_app   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE storeplix_admin LOGIN PASSWORD :'admin_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;

-- ---------------------------------------------------------------------------------------------------------
-- Database ownership and privileges
-- ---------------------------------------------------------------------------------------------------------
-- Owning the database makes storeplix_owner the owner of schema `public` (Postgres 15+: pg_database_owner),
-- so it can create tables and the trusted pg_trgm extension (Phase 4 migration).
ALTER DATABASE :"db" OWNER TO storeplix_owner;
GRANT CONNECT ON DATABASE :"db" TO storeplix_app, storeplix_admin;

GRANT USAGE ON SCHEMA public TO storeplix_app, storeplix_admin;

-- Every table/sequence the owner creates from now on (i.e. every migration) is usable by app and admin.
ALTER DEFAULT PRIVILEGES FOR ROLE storeplix_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO storeplix_app, storeplix_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE storeplix_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO storeplix_app, storeplix_admin;
-- Not granted on purpose: TRUNCATE, REFERENCES, TRIGGER, CREATE. Existing (pre-5b) tables and the audit_logs
-- UPDATE/DELETE revoke are handled by the policy migration (§2.1), not here.

-- ---------------------------------------------------------------------------------------------------------
-- Sanity: the app role must never be able to bypass RLS (ADR 0012).
-- ---------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeplix_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'storeplix_app must be NOSUPERUSER NOBYPASSRLS';
  END IF;
  IF pg_has_role('storeplix_app', 'storeplix_owner', 'MEMBER')
     OR pg_has_role('storeplix_app', 'storeplix_admin', 'MEMBER') THEN
    RAISE EXCEPTION 'storeplix_app must not be a member of storeplix_owner or storeplix_admin';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('storeplix_owner', 'storeplix_admin') AND rolsuper) THEN
    RAISE EXCEPTION 'storeplix_owner and storeplix_admin must be NOSUPERUSER';
  END IF;
END
$$;

SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
  FROM pg_roles WHERE rolname LIKE 'storeplix\_%' ORDER BY rolname;

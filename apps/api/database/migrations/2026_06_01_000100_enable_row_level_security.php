<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use App\Domain\Tenancy\Database\RlsTables;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Phase 5b-1 (PHASE-5B-CONTRACT §2.3, ADR 0012): Postgres row-level security on every tenant table.
 *
 * - helper functions app_current_tenant() / app_current_user() (GUCs app.tenant_id / app.user_id; '' = unset);
 * - ENABLE + FORCE RLS and the tenant policy on every table in RlsTables::TENANT (special policies for
 *   tenant_users, audit_logs, sms_messages);
 * - SECURITY DEFINER lookups for the pre-tenant request paths (ids only);
 * - grants for storeplix_app / storeplix_admin when the roles exist (01-roles.sql), audit_logs append-only.
 *
 * Run as the schema owner (`--database=pgsql_owner`). A no-op on sqlite. Rollback (or
 * database/sql/rls-emergency-off.sql) drops the policies; the functions stay (QA 5b-1 F-L6).
 */
return new class extends Migration
{
    private const DEFINER_FUNCTIONS = [
        'sp_resolve_host(text)',
        'sp_invitation_by_token(text)',
        'sp_store_slug_taken(text)',
        'sp_payment_owner(text)',
    ];

    public function up(): void
    {
        $db = DB::connection();

        if ($db->getDriverName() !== 'pgsql') {
            return;
        }

        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text LANGUAGE sql STABLE
              AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '') $$
            SQL);
        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION app_current_user() RETURNS text LANGUAGE sql STABLE
              AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$
            SQL);

        $target = RlsPolicies::target($db);
        foreach (RlsTables::TENANT as $table) {
            // Tables of later increments (5b-4 / 5b-5 …) are listed in TENANT too; their own migrations enable RLS.
            if (Schema::hasTable($table)) {
                RlsPolicies::enable($db, $table, $target);
            }
        }

        $this->createDefinerFunctions($db);
        $this->grant($db);
    }

    public function down(): void
    {
        $db = DB::connection();

        if ($db->getDriverName() !== 'pgsql') {
            return;
        }

        foreach (RlsTables::TENANT as $table) {
            if (Schema::hasTable($table)) {
                RlsPolicies::disable($db, $table);
            }
        }

        // QA 5b-1 F-L6: the definer functions and GUC helpers stay. A running app (TENANCY_RLS=true) still calls
        // sp_resolve_host() & co.; dropping them would take every storefront down until a config change + restart.
        // They are harmless without policies, and up() replaces them (CREATE OR REPLACE).

        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('GRANT UPDATE, DELETE ON audit_logs TO '.RlsPolicies::APP_ROLE);
        }
    }

    /** §2.3: owned by the migrating role (storeplix_owner, BYPASSRLS), fixed search_path, ids only. */
    private function createDefinerFunctions(ConnectionInterface $db): void
    {
        // B1 StorefrontResolver: an ACTIVE domain of a non-suspended store.
        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_resolve_host(p_host text)
              RETURNS TABLE (tenant_id text, store_id text)
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT d.tenant_id::text, d.store_id::text
                FROM store_domains d
                JOIN stores s ON s.id = d.store_id AND s.tenant_id = d.tenant_id
               WHERE d.hostname = p_host AND d.status = 'active' AND s.status <> 'suspended'
               LIMIT 1
            $$
            SQL);

        // B4 invitation show/accept: sha256 token hash → invitation + tenant (usability is checked in the tenant).
        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_invitation_by_token(p_hash text)
              RETURNS TABLE (invitation_id text, tenant_id text)
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT i.id::text, i.tenant_id::text FROM staff_invitations i WHERE i.token_hash = p_hash::bpchar LIMIT 1
            $$
            SQL);

        // B5 / P5B-8: slugs are unique across tenants; under RLS Rule::unique would only see the current tenant.
        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_store_slug_taken(p_slug text)
              RETURNS boolean
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT EXISTS (SELECT 1 FROM stores s WHERE s.slug = p_slug)
            $$
            SQL);

        // B13 (used from 5b-2): signed payment-return URL → owning tenant/store.
        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_payment_owner(p_payment text)
              RETURNS TABLE (tenant_id text, store_id text)
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT p.tenant_id::text, p.store_id::text FROM payments p WHERE p.id = p_payment::bpchar LIMIT 1
            $$
            SQL);
        // sp_route_key_owner() (B12) ships with payment_gateway_accounts / courier_accounts in 5b-2 / 5b-3: a SQL
        // function body is validated at creation, so it can't reference tables that don't exist yet.

        $app = RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE);
        foreach (self::DEFINER_FUNCTIONS as $function) {
            $db->statement("REVOKE ALL ON FUNCTION {$function} FROM PUBLIC");
            if ($app) {
                $db->statement("GRANT EXECUTE ON FUNCTION {$function} TO ".RlsPolicies::APP_ROLE);
            }
        }
    }

    /** §2.1: pre-5b tables were created before the default privileges existed; audit_logs is append-only. */
    private function grant(ConnectionInterface $db): void
    {
        foreach ([RlsPolicies::APP_ROLE, RlsPolicies::ADMIN_ROLE] as $role) {
            if (! RlsPolicies::roleExists($db, $role)) {
                continue;
            }
            $db->statement("GRANT USAGE ON SCHEMA public TO {$role}");
            $db->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {$role}");
            $db->statement("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {$role}");
        }

        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('REVOKE UPDATE, DELETE ON audit_logs FROM '.RlsPolicies::APP_ROLE);
        }
    }
};

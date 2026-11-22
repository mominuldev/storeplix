<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-6-CONTRACT §3.2: SECURITY DEFINER lookups for the two pre-tenant domain paths (MULTI-TENANCY §9.4 pattern:
 * owned by the migrating role, fixed search_path, not executable by PUBLIC, granted to storeplix_app).
 *  - B17 sp_domain_claim_state(host): who holds a hostname (add-domain uniqueness and reclaim, P6-6);
 *  - B18 sp_domain_allowed(host): may a certificate be issued for it (`ask` endpoint, P6-17).
 * Postgres only (a no-op on sqlite, where PreTenantLookup falls back to its scope opt-out).
 */
return new class extends Migration
{
    private const FUNCTIONS = ['sp_domain_claim_state(text)', 'sp_domain_allowed(text)'];

    public function up(): void
    {
        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }

        // 000400 changes the result type; a re-run after `migrate:fresh` (functions survive dropped tables) must drop it.
        $db->statement('DROP FUNCTION IF EXISTS sp_domain_claim_state(text)');
        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_domain_claim_state(p_host text)
              RETURNS TABLE (tenant_id text, store_id text, domain_id text, status text, status_changed_at timestamptz)
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT d.tenant_id::text, d.store_id::text, d.id::text, d.status::text, d.status_changed_at
                FROM store_domains d
               WHERE d.hostname = p_host
               LIMIT 1
            $$
            SQL);

        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_domain_allowed(p_host text)
              RETURNS boolean
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT EXISTS (
                SELECT 1
                  FROM store_domains d
                  JOIN stores s ON s.id = d.store_id AND s.tenant_id = d.tenant_id
                 WHERE d.hostname = p_host
                   AND s.status <> 'suspended'
                   AND (d.status = 'active' OR (d.type = 'custom' AND d.status IN ('verified', 'ssl_provisioning')))
              )
            $$
            SQL);

        $app = RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE);
        foreach (self::FUNCTIONS as $function) {
            $db->statement("REVOKE ALL ON FUNCTION {$function} FROM PUBLIC");
            if ($app) {
                $db->statement("GRANT EXECUTE ON FUNCTION {$function} TO ".RlsPolicies::APP_ROLE);
            }
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        foreach (self::FUNCTIONS as $function) {
            DB::statement("DROP FUNCTION IF EXISTS {$function}");
        }
    }
};

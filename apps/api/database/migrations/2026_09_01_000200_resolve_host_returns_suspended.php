<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-1 §4.1 / §5.2 (amends MULTI-TENANCY §9.4 B1): `sp_resolve_host` also returns active domains of SUSPENDED
 * stores, with a `suspended` flag, so every storefront host of a suspended shop answers "temporarily unavailable"
 * instead of "store not found". The return type changes, so the function is dropped and re-created with the same
 * owner (the migrating role), SECURITY DEFINER, `search_path` and grants as 2026_06_01_000100.
 */
return new class extends Migration
{
    public function up(): void
    {
        $this->replace(<<<'SQL'
            CREATE FUNCTION sp_resolve_host(p_host text)
              RETURNS TABLE (tenant_id text, store_id text, suspended boolean)
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT d.tenant_id::text, d.store_id::text, (s.status = 'suspended')
                FROM store_domains d
                JOIN stores s ON s.id = d.store_id AND s.tenant_id = d.tenant_id
               WHERE d.hostname = p_host AND d.status = 'active'
               LIMIT 1
            $$
            SQL);
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); down() restores the Phase 5b definition for local rollbacks only.
        $this->replace(<<<'SQL'
            CREATE FUNCTION sp_resolve_host(p_host text)
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
    }

    private function replace(string $create): void
    {
        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }

        $db->transaction(function () use ($db, $create): void {
            $db->statement('DROP FUNCTION IF EXISTS sp_resolve_host(text)');
            $db->statement($create);
            $db->statement('REVOKE ALL ON FUNCTION sp_resolve_host(text) FROM PUBLIC');
            if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
                $db->statement('GRANT EXECUTE ON FUNCTION sp_resolve_host(text) TO '.RlsPolicies::APP_ROLE);
            }
        });
    }
};

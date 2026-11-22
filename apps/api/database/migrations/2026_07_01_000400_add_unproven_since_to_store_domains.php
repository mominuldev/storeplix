<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Phase 6 QA H-1 (P6-6 / Q73): the reclaim clock must not be reset by a merchant re-check. `unproven_since` is set the
 * first time a row enters `verification_failed` or `expired` and is cleared only when ownership (TXT) is proven again
 * (→ `verified`, or a reinstate that passes DNS). sp_domain_claim_state() also returns it (DROP + CREATE: the result
 * type changes). A separate migration because 000100/000200 may already be applied in dev databases.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('store_domains', function (Blueprint $table) {
            $table->timestampTz('unproven_since')->nullable();
        });
        DB::table('store_domains')->whereIn('status', ['verification_failed', 'expired'])
            ->update(['unproven_since' => DB::raw('status_changed_at')]);

        $this->claimFunction(withUnproven: true);
    }

    public function down(): void
    {
        $this->claimFunction(withUnproven: false);
        Schema::table('store_domains', function (Blueprint $table) {
            $table->dropColumn('unproven_since');
        });
    }

    private function claimFunction(bool $withUnproven): void
    {
        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }
        $extraType = $withUnproven ? ', unproven_since timestamptz' : '';
        $extraCol = $withUnproven ? ', d.unproven_since' : '';
        $db->statement('DROP FUNCTION IF EXISTS sp_domain_claim_state(text)');
        $db->statement(<<<SQL
            CREATE FUNCTION sp_domain_claim_state(p_host text)
              RETURNS TABLE (tenant_id text, store_id text, domain_id text, status text, status_changed_at timestamptz{$extraType})
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS \$\$
              SELECT d.tenant_id::text, d.store_id::text, d.id::text, d.status::text, d.status_changed_at{$extraCol}
                FROM store_domains d
               WHERE d.hostname = p_host
               LIMIT 1
            \$\$
            SQL);
        $db->statement('REVOKE ALL ON FUNCTION sp_domain_claim_state(text) FROM PUBLIC');
        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('GRANT EXECUTE ON FUNCTION sp_domain_claim_state(text) TO '.RlsPolicies::APP_ROLE);
        }
    }
};

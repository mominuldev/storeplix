<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-7-CONTRACT §5.1 000500 (MULTI-TENANCY §9.4 pattern): `sp_billing_payment_owner(payment)` → the owning tenant of
 * a billing payment, for the billing return URL (B22) and the platform SSLCommerz IPN (B23). Ids only. Postgres only.
 */
return new class extends Migration
{
    private const FUNCTION = 'sp_billing_payment_owner(text)';

    public function up(): void
    {
        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }

        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_billing_payment_owner(p_payment text)
              RETURNS TABLE (tenant_id text)
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT p.tenant_id::text FROM billing_payments p WHERE p.id = p_payment LIMIT 1
            $$
            SQL);

        $db->statement('REVOKE ALL ON FUNCTION '.self::FUNCTION.' FROM PUBLIC');
        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('GRANT EXECUTE ON FUNCTION '.self::FUNCTION.' TO '.RlsPolicies::APP_ROLE);
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('DROP FUNCTION IF EXISTS '.self::FUNCTION);
        }
    }
};

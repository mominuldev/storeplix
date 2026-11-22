<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * QA 5b-1 F-L2: tenant_users had one FOR ALL policy (tenant OR current user), so the app could update or delete the
 * current user's memberships in OTHER tenants. Re-creates the policies: SELECT by tenant or user, INSERT / UPDATE /
 * DELETE only in the current tenant (RlsPolicies::enable). Fresh databases already get the split from 000100.
 * Postgres only.
 */
return new class extends Migration
{
    public function up(): void
    {
        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }
        RlsPolicies::enable($db, 'tenant_users');
    }

    public function down(): void
    {
        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }
        // Back to the single 000100 policy shape.
        foreach (RlsPolicies::NAMES['tenant_users'] as $name) {
            $db->statement("DROP POLICY IF EXISTS {$name} ON \"tenant_users\"");
        }
        $target = RlsPolicies::target($db);
        $db->statement("CREATE POLICY tenant_users_membership ON \"tenant_users\" FOR ALL TO {$target}
            USING (tenant_id = ".RlsPolicies::TENANT.' OR user_id = '.RlsPolicies::USER.')
            WITH CHECK (tenant_id = '.RlsPolicies::TENANT.')');
    }
};

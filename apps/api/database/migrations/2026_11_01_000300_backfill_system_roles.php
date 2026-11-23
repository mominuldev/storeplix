<?php

declare(strict_types=1);

use App\Domain\Staff\Roles\SystemRoles;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-3-CONTRACT §5.2 000300: per tenant, create the three system roles if missing and set `role_id` from `role`
 * on every membership and on ALL invitations (open, accepted, revoked). Idempotent (re-running changes nothing),
 * chunked by tenant, on the migrating connection (storeplix_owner under RLS, which bypasses the policies).
 */
return new class extends Migration
{
    public function up(): void
    {
        $db = DB::connection();

        $db->table('tenants')->orderBy('id')->select('id')->chunk(200, function ($tenants) use ($db) {
            foreach ($tenants as $tenant) {
                $db->transaction(function () use ($db, $tenant) {
                    $ids = SystemRoles::ensure((string) $tenant->id, $db);
                    foreach (['tenant_users', 'staff_invitations'] as $table) {
                        foreach ($ids as $key => $roleId) {
                            $db->table($table)->where('tenant_id', $tenant->id)->where('role', $key)->whereNull('role_id')
                                ->update(['role_id' => $roleId]);
                        }
                    }
                });
            }
        });
    }

    public function down(): void
    {
        // forward-only data step: the 000200 rollback drops the columns
    }
};

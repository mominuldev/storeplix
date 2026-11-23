<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-3-CONTRACT §5.2 000400: `role_id` NOT NULL on memberships and invitations with the composite FK
 * (tenant_id, role_id) → roles(tenant_id, id) ON DELETE RESTRICT, plus the (tenant_id, role_id) indexes.
 *
 * sqlite (local dev / CI unit job) gets the indexes only: altering NOT NULL or adding a FK there rebuilds the table
 * and would drop the partial unique index tenant_users_one_owner. The invariant is also enforced by the models
 * (RoleKindSync) and RoleService; Postgres (CI api-postgres / api-rls, production) enforces it in the schema.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tenant_users', function (Blueprint $table) {
            $table->index(['tenant_id', 'role_id']);
        });
        Schema::table('staff_invitations', function (Blueprint $table) {
            $table->index(['tenant_id', 'role_id']);
        });

        if (DB::getDriverName() !== 'pgsql') {
            return;
        }

        foreach (['tenant_users', 'staff_invitations'] as $table) {
            DB::statement("ALTER TABLE {$table} ALTER COLUMN role_id SET NOT NULL");
            DB::statement("ALTER TABLE {$table} ADD CONSTRAINT {$table}_role_foreign FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE RESTRICT");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            foreach (['tenant_users', 'staff_invitations'] as $table) {
                DB::statement("ALTER TABLE {$table} DROP CONSTRAINT IF EXISTS {$table}_role_foreign");
                DB::statement("ALTER TABLE {$table} ALTER COLUMN role_id DROP NOT NULL");
            }
        }
        Schema::table('staff_invitations', function (Blueprint $table) {
            $table->dropIndex(['tenant_id', 'role_id']);
        });
        Schema::table('tenant_users', function (Blueprint $table) {
            $table->dropIndex(['tenant_id', 'role_id']);
        });
    }
};

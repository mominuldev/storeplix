<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-3-CONTRACT §5.2 000200: `role_id` on memberships and invitations (nullable until the 000300 backfill;
 * 000400 makes it NOT NULL with the composite FK). `tenant_users.role` becomes the denormalised kind
 * owner|admin|staff|custom (P83-3); `staff_invitations.role` accepts admin|staff|custom (app rule).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tenant_users', function (Blueprint $table) {
            $table->char('role_id', 26)->nullable();
        });
        Schema::table('staff_invitations', function (Blueprint $table) {
            $table->char('role_id', 26)->nullable();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE tenant_users DROP CONSTRAINT IF EXISTS tenant_users_role_check');
            DB::statement("ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_role_check CHECK (role IN ('owner','admin','staff','custom'))");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE tenant_users DROP CONSTRAINT IF EXISTS tenant_users_role_check');
        }
        Schema::table('staff_invitations', function (Blueprint $table) {
            $table->dropColumn('role_id');
        });
        Schema::table('tenant_users', function (Blueprint $table) {
            $table->dropColumn('role_id');
        });
    }
};

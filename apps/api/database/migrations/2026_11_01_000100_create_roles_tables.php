<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-3-CONTRACT §5.1 000100 (ADR 0017): tenant roles and the permission keys of custom roles.
 *  - `roles`: three system rows per tenant (key owner|admin|staff, is_system) + custom roles (key null).
 *    U(tenant_id, id) is the composite FK target; U(tenant_id, key) for system keys; names unique per tenant
 *    case-insensitively.
 *  - `role_permissions`: PK (tenant_id, role_id, permission); custom roles only (P83-2).
 * Both are tenant tables with the special member-read RLS policy (RlsPolicies, RlsTables::SPECIAL).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('roles', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->string('key', 16)->nullable();
            $table->string('name', 40);
            $table->string('description', 200)->nullable();
            $table->boolean('is_system')->default(false);
            $table->integer('revision')->default(1);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
        });
        DB::statement('CREATE UNIQUE INDEX roles_tenant_key_unique ON roles (tenant_id, key) WHERE key IS NOT NULL');
        DB::statement('CREATE UNIQUE INDEX roles_tenant_name_unique ON roles (tenant_id, lower(name))');

        Schema::create('role_permissions', function (Blueprint $table) {
            $table->ulid('tenant_id');
            $table->ulid('role_id');
            $table->string('permission', 48);
            $table->timestampTz('created_at')->nullable();

            $table->primary(['tenant_id', 'role_id', 'permission']);
            $table->foreign('tenant_id')->references('id')->on('tenants')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'role_id'])->references(['tenant_id', 'id'])->on('roles')->cascadeOnDelete();
        });

        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }

        $db->statement("ALTER TABLE roles ADD CONSTRAINT roles_key_check CHECK (key IN ('owner','admin','staff'))");
        $db->statement('ALTER TABLE roles ADD CONSTRAINT roles_system_check CHECK (is_system = (key IS NOT NULL))');
        $db->statement('ALTER TABLE roles ADD CONSTRAINT roles_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 40)');
        $db->statement('ALTER TABLE roles ADD CONSTRAINT roles_revision_check CHECK (revision >= 1)');
        $db->statement("ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_permission_check CHECK (permission ~ '^[a-z]+\\.[a-z_]+$')");

        RlsPolicies::enable($db, 'roles');
        RlsPolicies::enable($db, 'role_permissions');
    }

    public function down(): void
    {
        Schema::dropIfExists('role_permissions');
        Schema::dropIfExists('roles');
    }
};

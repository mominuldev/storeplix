<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-1-CONTRACT §5.1: platform staff columns on users (P8-2 – P8-4), recovery codes, staff invitations (P8-16),
 * impersonation sessions (P8-9 – P8-11; no `tenant_id` column on purpose: a platform table outside tenant RLS),
 * suspension columns on tenants/stores (P8-12) and the audit actor type `platform_user` (P8-8).
 * `sp_resolve_host` changes in 000200 (owner API-2).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('platform_role', 16)->nullable();
            $table->timestampTz('platform_disabled_at')->nullable();
            $table->timestampTz('platform_locked_until')->nullable();
            $table->text('totp_secret')->nullable();
            $table->timestampTz('totp_confirmed_at')->nullable();
            $table->bigInteger('totp_last_step')->nullable();
            $table->char('platform_invited_by', 26)->nullable();
        });

        Schema::create('platform_recovery_codes', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->char('code_hash', 64);
            $table->timestampTz('used_at')->nullable();
            $table->timestampTz('created_at')->useCurrent();
            $table->unique(['user_id', 'code_hash']);
        });

        Schema::create('platform_invitations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('email'); // stored lower-cased
            $table->string('role', 16);
            $table->char('token_hash', 64)->unique();
            $table->foreignUlid('invited_by')->constrained('users')->restrictOnDelete();
            $table->timestampTz('expires_at');
            $table->timestampTz('accepted_at')->nullable();
            $table->timestampTz('revoked_at')->nullable();
            $table->timestampsTz();
        });

        Schema::create('platform_impersonations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('staff_user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('target_tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->string('reason', 500);
            $table->string('ticket_ref', 64)->nullable();
            $table->char('ticket_hash', 64)->unique();
            $table->string('status', 16)->default('pending');
            $table->timestampTz('ticket_expires_at');
            $table->timestampTz('started_at')->nullable();
            $table->timestampTz('expires_at')->nullable();
            $table->timestampTz('ended_at')->nullable();
            $table->string('ended_by', 16)->nullable();
            $table->integer('request_count')->default(0);
            $table->timestampTz('last_request_at')->nullable();
            $table->string('ip', 45)->nullable();
            $table->string('user_agent', 255)->nullable();
            $table->timestampsTz();
            $table->index(['target_tenant_id', 'created_at']);
            $table->index(['status', 'expires_at']);
            $table->index(['staff_user_id', 'created_at']);
        });

        Schema::table('tenants', function (Blueprint $table) {
            $table->timestampTz('suspended_at')->nullable();
            $table->string('suspension_reason_code', 32)->nullable();
            $table->char('suspended_by', 26)->nullable();
        });

        Schema::table('stores', function (Blueprint $table) {
            $table->string('status_before_suspension', 16)->nullable();
        });

        Schema::table('audit_logs', function (Blueprint $table) {
            $table->index(['action', 'created_at']);
            $table->index(['actor_id', 'created_at']);
        });

        DB::statement('CREATE INDEX users_platform_role_index ON users (platform_role) WHERE platform_role IS NOT NULL');

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement('CREATE UNIQUE INDEX platform_invitations_one_open ON platform_invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL');
            foreach ([
                "users ADD CONSTRAINT users_platform_role_check CHECK (platform_role IS NULL OR platform_role IN ('super_admin','billing','support','read_only'))",
                "platform_invitations ADD CONSTRAINT platform_invitations_role_check CHECK (role IN ('super_admin','billing','support','read_only'))",
                "platform_impersonations ADD CONSTRAINT platform_impersonations_status_check CHECK (status IN ('pending','active','ended','expired'))",
                "platform_impersonations ADD CONSTRAINT platform_impersonations_ended_by_check CHECK (ended_by IS NULL OR ended_by IN ('staff','expiry','revoked'))",
                "tenants ADD CONSTRAINT tenants_status_check CHECK (status IN ('active','suspended'))",
                "stores ADD CONSTRAINT stores_status_before_suspension_check CHECK (status_before_suspension IS NULL OR status_before_suspension IN ('draft','active'))",
                "audit_logs ADD CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('user','system','platform_user'))",
            ] as $sql) {
                $db->statement("ALTER TABLE {$sql}");
            }
        } else {
            DB::statement('CREATE UNIQUE INDEX platform_invitations_one_open ON platform_invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL');
        }
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); down() exists for local rollbacks only.
        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach (['tenants' => 'tenants_status_check', 'stores' => 'stores_status_before_suspension_check',
                'audit_logs' => 'audit_logs_actor_type_check', 'users' => 'users_platform_role_check'] as $table => $check) {
                $db->statement("ALTER TABLE {$table} DROP CONSTRAINT IF EXISTS {$check}");
            }
        }
        DB::statement('DROP INDEX IF EXISTS users_platform_role_index');
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->dropIndex(['action', 'created_at']);
            $table->dropIndex(['actor_id', 'created_at']);
        });
        Schema::table('stores', fn (Blueprint $t) => $t->dropColumn('status_before_suspension'));
        Schema::table('tenants', fn (Blueprint $t) => $t->dropColumn(['suspended_at', 'suspension_reason_code', 'suspended_by']));
        Schema::dropIfExists('platform_impersonations');
        Schema::dropIfExists('platform_invitations');
        Schema::dropIfExists('platform_recovery_codes');
        Schema::table('users', fn (Blueprint $t) => $t->dropColumn(['platform_role', 'platform_disabled_at', 'platform_locked_until',
            'totp_secret', 'totp_confirmed_at', 'totp_last_step', 'platform_invited_by']));
    }
};

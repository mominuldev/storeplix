<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8D §3.1 (part A): POS registers (a till at an 8.8c location) and cash sessions (one register from open to
 * close). Both store-scoped [S] with the composite store FK and forced RLS (RlsTables::TENANT). Locations and
 * registers are referenced through (tenant_id, store_id, id) with RESTRICT, so a register or session can never point
 * into another store or tenant (S195). One open session per register (partial unique index, P88D-5).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('pos_registers', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('location_id', 26);
            $table->string('name', 40);
            $table->smallInteger('position')->default(0);
            $table->timestampTz('archived_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'location_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'location_id'])->references(['tenant_id', 'store_id', 'id'])->on('locations')->restrictOnDelete();
        });
        DB::statement('CREATE UNIQUE INDEX pos_registers_active_name_unique ON pos_registers (store_id, lower(name)) WHERE archived_at IS NULL');

        Schema::create('pos_sessions', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('register_id', 26);
            $table->char('location_id', 26);
            $table->string('status', 8)->default('open');
            $table->char('currency', 3);
            $table->foreignUlid('opened_by')->constrained('users');
            $table->timestampTz('opened_at');
            $table->bigInteger('opening_cash_amount')->default(0);
            $table->jsonb('opening_counts')->nullable();
            $table->foreignUlid('closed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('closed_at')->nullable();
            $table->bigInteger('counted_cash_amount')->nullable();
            $table->jsonb('closing_counts')->nullable();
            $table->bigInteger('expected_cash_amount')->nullable();
            $table->bigInteger('variance_amount')->nullable();
            $table->bigInteger('left_in_drawer_amount')->nullable();
            $table->bigInteger('banked_amount')->nullable();
            $table->string('close_note', 300)->nullable();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'register_id', 'opened_at'], 'pos_sessions_register_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'register_id'])->references(['tenant_id', 'store_id', 'id'])->on('pos_registers')->restrictOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'location_id'])->references(['tenant_id', 'store_id', 'id'])->on('locations')->restrictOnDelete();
        });
        DB::statement("CREATE UNIQUE INDEX pos_sessions_one_open_unique ON pos_sessions (register_id) WHERE status = 'open'");

        if ($pgsql) {
            $db = DB::connection();
            $db->statement('DROP INDEX IF EXISTS pos_sessions_register_index');
            $db->statement('CREATE INDEX pos_sessions_register_index ON pos_sessions (tenant_id, store_id, register_id, opened_at DESC)');
            foreach ([
                'pos_registers ADD CONSTRAINT pos_registers_position_check CHECK (position >= 0)',
                "pos_sessions ADD CONSTRAINT pos_sessions_status_check CHECK (status IN ('open','closed'))",
                'pos_sessions ADD CONSTRAINT pos_sessions_opening_check CHECK (opening_cash_amount >= 0)',
                "pos_sessions ADD CONSTRAINT pos_sessions_closed_check CHECK ((status = 'closed') = (closed_at IS NOT NULL AND counted_cash_amount IS NOT NULL AND expected_cash_amount IS NOT NULL))",
                'pos_sessions ADD CONSTRAINT pos_sessions_counted_check CHECK (counted_cash_amount IS NULL OR counted_cash_amount >= 0)',
                'pos_sessions ADD CONSTRAINT pos_sessions_left_check CHECK (left_in_drawer_amount IS NULL OR (left_in_drawer_amount >= 0 AND left_in_drawer_amount <= counted_cash_amount))',
                'pos_sessions ADD CONSTRAINT pos_sessions_revision_check CHECK (revision >= 1)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            RlsPolicies::enable($db, 'pos_registers');
            RlsPolicies::enable($db, 'pos_sessions');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('pos_sessions');
        Schema::dropIfExists('pos_registers');
    }
};

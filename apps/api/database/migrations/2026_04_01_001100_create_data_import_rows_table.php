<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: per-row dry-run results (values = normalised data used by run). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('data_import_rows', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('import_id');
            $table->integer('row_number');
            $table->string('status', 8);
            $table->string('action', 12);
            $table->string('label', 200);
            $table->string('key', 254)->nullable();
            $table->jsonb('values');
            $table->jsonb('messages')->default('[]');
            $table->char('result_id', 26)->nullable();

            $table->unique(['import_id', 'row_number']);
            $table->index(['tenant_id', 'store_id', 'import_id', 'status']);
            $table->foreign(['tenant_id', 'store_id', 'import_id'])->references(['tenant_id', 'store_id', 'id'])->on('data_imports')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE data_import_rows ADD CONSTRAINT data_import_rows_status_check CHECK (status IN ('ready','warning','error'))");
            DB::statement("ALTER TABLE data_import_rows ADD CONSTRAINT data_import_rows_action_check CHECK (action IN ('create','update','unchanged','skip'))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('data_import_rows');
    }
};

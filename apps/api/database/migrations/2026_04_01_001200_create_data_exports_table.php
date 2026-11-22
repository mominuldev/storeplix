<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: queued CSV exports (private file, 24 h). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('data_exports', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('type', 16);
            $table->string('status', 16);
            $table->jsonb('filters');
            $table->string('file_path', 255)->nullable();
            $table->integer('row_count')->nullable();
            $table->timestampTz('expires_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE data_exports ADD CONSTRAINT data_exports_type_check CHECK (type IN ('products','customers'))");
            DB::statement("ALTER TABLE data_exports ADD CONSTRAINT data_exports_status_check CHECK (status IN ('queued','running','completed','failed','expired'))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('data_exports');
    }
};

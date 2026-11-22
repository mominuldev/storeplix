<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: CSV imports (P4-18). The partial unique index allows one active import per store. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('data_imports', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('type', 16);
            $table->string('status', 16);
            $table->string('file_path', 255);
            $table->string('filename', 255);
            $table->integer('size_bytes');
            $table->char('checksum', 64);
            $table->char('delimiter', 1);
            $table->jsonb('headers');
            $table->jsonb('samples');
            $table->jsonb('column_map')->nullable();
            $table->jsonb('options')->default('{}');
            $table->integer('row_count')->nullable();
            $table->integer('processed_rows')->default(0);
            $table->jsonb('summary')->nullable();
            $table->string('failure_reason', 255)->nullable();
            $table->timestampTz('validated_at')->nullable();
            $table->timestampTz('started_at')->nullable();
            $table->timestampTz('completed_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        DB::statement("CREATE UNIQUE INDEX data_imports_one_active ON data_imports (store_id) WHERE status IN ('validating','importing')");

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE data_imports ADD CONSTRAINT data_imports_type_check CHECK (type IN ('products','customers'))");
            DB::statement("ALTER TABLE data_imports ADD CONSTRAINT data_imports_status_check CHECK (status IN ('uploaded','validating','validated','importing','completed','failed','cancelled'))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('data_imports');
    }
};

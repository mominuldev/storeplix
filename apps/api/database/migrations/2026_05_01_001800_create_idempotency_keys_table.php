<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: Idempotency-Key ledger (P5-14). response_body is encrypted at rest; rows live 24 h. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('idempotency_keys', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('scope', 64);
            $table->string('key', 64);
            $table->char('request_hash', 64);
            $table->string('status', 16);
            $table->smallInteger('response_status')->nullable();
            $table->text('response_body')->nullable();
            $table->timestampTz('locked_until');
            $table->timestampTz('created_at');
            $table->timestampTz('expires_at');

            $table->unique(['store_id', 'scope', 'key']);
            $table->index('expires_at');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_status_check CHECK (status IN ('processing','completed'))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('idempotency_keys');
    }
};

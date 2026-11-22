<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: server-side carts (P5-3, ADR 0006). Only sha256(token) is stored. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('carts', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('token_hash', 64)->unique();
            $table->string('status', 16)->default('active');
            $table->string('coupon_code', 32)->nullable();
            $table->char('currency', 3);
            $table->timestampTz('last_activity_at');
            $table->char('converted_order_id', 26)->nullable();
            $table->string('ip', 45)->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'status', 'last_activity_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE carts ADD CONSTRAINT carts_status_check CHECK (status IN ('active','converted','abandoned'))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('carts');
    }
};

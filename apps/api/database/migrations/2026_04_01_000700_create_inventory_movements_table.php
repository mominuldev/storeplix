<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: append-only stock ledger (no updated_at). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('inventory_movements', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('variant_id');
            $table->integer('delta');
            $table->integer('on_hand_after');
            $table->string('reason', 32);
            $table->string('note', 255)->nullable();
            $table->string('reference_type', 32)->nullable();
            $table->char('reference_id', 26)->nullable();
            $table->foreignUlid('actor_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('created_at')->useCurrent();

            $table->index(['tenant_id', 'store_id', 'variant_id', 'created_at']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id', 'variant_id'])->references(['tenant_id', 'store_id', 'id'])->on('product_variants')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_delta_check CHECK (delta <> 0)');
            DB::statement("ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_reason_check CHECK (reason IN ('initial','received','correction','damaged','lost','returned','import','other'))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('inventory_movements');
    }
};

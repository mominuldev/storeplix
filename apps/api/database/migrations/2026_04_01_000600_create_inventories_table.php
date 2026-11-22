<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: one inventory row per variant (single location). `committed` stays 0 until Phase 5. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('inventories', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('variant_id')->unique();
            $table->integer('on_hand')->default(0);
            $table->integer('committed')->default(0);
            $table->integer('low_stock_threshold')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'on_hand']);
            $table->foreign(['tenant_id', 'store_id', 'variant_id'])->references(['tenant_id', 'store_id', 'id'])->on('product_variants')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE inventories ADD CONSTRAINT inventories_committed_check CHECK (committed >= 0)');
            DB::statement('ALTER TABLE inventories ADD CONSTRAINT inventories_threshold_check CHECK (low_stock_threshold IS NULL OR low_stock_threshold BETWEEN 0 AND 100000)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('inventories');
    }
};

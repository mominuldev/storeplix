<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: cart lines hold a variant id and a quantity only (P5-4). FK3 keeps variants inside the store. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('cart_items', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('cart_id');
            $table->ulid('variant_id');
            $table->smallInteger('quantity');
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['cart_id', 'variant_id']);
            $table->index(['tenant_id', 'store_id', 'cart_id']);
            $table->foreign(['tenant_id', 'store_id', 'cart_id'])->references(['tenant_id', 'store_id', 'id'])->on('carts')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'variant_id'])->references(['tenant_id', 'store_id', 'id'])->on('product_variants')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE cart_items ADD CONSTRAINT cart_items_quantity_check CHECK (quantity BETWEEN 1 AND 99)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('cart_items');
    }
};

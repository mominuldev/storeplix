<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: order line snapshots (P5-31). product_id / variant_id are soft references (no FK). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('order_items', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('order_id');
            $table->char('product_id', 26)->nullable();
            $table->char('variant_id', 26)->nullable();
            $table->string('product_name', 200);
            $table->string('variant_title', 130);
            $table->jsonb('option_values')->default('[]');
            $table->string('sku', 64)->nullable();
            $table->char('image_media_id', 26)->nullable();
            $table->bigInteger('unit_price_amount');
            $table->bigInteger('compare_at_amount')->nullable();
            $table->bigInteger('unit_cost_amount')->nullable();
            $table->bigInteger('subtotal_amount');
            $table->bigInteger('discount_amount')->default(0);
            $table->bigInteger('total_amount');
            $table->smallInteger('quantity');
            $table->boolean('tracked');
            $table->smallInteger('restocked_quantity')->default(0);
            $table->smallInteger('position')->default(0);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'order_id']);
            $table->index(['tenant_id', 'store_id', 'variant_id']);
            $table->index(['tenant_id', 'store_id', 'product_id']);
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE order_items ADD CONSTRAINT order_items_total_check CHECK (total_amount = subtotal_amount - discount_amount)');
            DB::statement('ALTER TABLE order_items ADD CONSTRAINT order_items_quantity_check CHECK (quantity BETWEEN 1 AND 99)');
            DB::statement('ALTER TABLE order_items ADD CONSTRAINT order_items_money_check CHECK (unit_price_amount >= 0 AND subtotal_amount >= 0 AND discount_amount >= 0 AND total_amount >= 0)');
            DB::statement('ALTER TABLE order_items ADD CONSTRAINT order_items_restocked_check CHECK (restocked_quantity BETWEEN 0 AND quantity)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('order_items');
    }
};

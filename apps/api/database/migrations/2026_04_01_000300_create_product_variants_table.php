<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: variants (P4-1..P4-4). Every product has ≥ 1 variant. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('product_variants', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('product_id');
            $table->string('title', 130);
            $table->string('option1', 40)->default('');
            $table->string('option2', 40)->default('');
            $table->string('option3', 40)->default('');
            $table->string('sku', 64)->nullable();
            $table->string('barcode', 64)->nullable();
            $table->bigInteger('price_amount');
            $table->bigInteger('compare_at_amount')->nullable();
            $table->bigInteger('cost_amount')->nullable();
            $table->integer('weight_grams')->nullable();
            $table->smallInteger('position')->default(0);
            $table->boolean('is_default')->default(false);
            $table->boolean('is_enabled')->default(true);
            $table->boolean('track_inventory')->default(true);
            $table->boolean('allow_backorder')->default(false);
            $table->ulid('image_media_id')->nullable();
            $table->timestampsTz();
            $table->softDeletesTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'product_id', 'position']);
            $table->foreign(['tenant_id', 'store_id', 'product_id'])->references(['tenant_id', 'store_id', 'id'])->on('products')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'image_media_id'])->references(['tenant_id', 'id'])->on('media')->restrictOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX product_variants_store_sku_unique ON product_variants (store_id, lower(sku)) WHERE sku IS NOT NULL AND deleted_at IS NULL');
        DB::statement('CREATE UNIQUE INDEX product_variants_combination_unique ON product_variants (product_id, option1, option2, option3) WHERE deleted_at IS NULL');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE product_variants ADD CONSTRAINT product_variants_price_check CHECK (price_amount >= 0)');
            DB::statement('ALTER TABLE product_variants ADD CONSTRAINT product_variants_compare_at_check CHECK (compare_at_amount IS NULL OR compare_at_amount > price_amount)');
            DB::statement('ALTER TABLE product_variants ADD CONSTRAINT product_variants_cost_check CHECK (cost_amount IS NULL OR cost_amount >= 0)');
            DB::statement('ALTER TABLE product_variants ADD CONSTRAINT product_variants_weight_check CHECK (weight_grams IS NULL OR weight_grams BETWEEN 0 AND 1000000)');
            DB::statement('CREATE INDEX product_variants_sku_trgm ON product_variants USING GIN (sku gin_trgm_ops)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('product_variants');
    }
};

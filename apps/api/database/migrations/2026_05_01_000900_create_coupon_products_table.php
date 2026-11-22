<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: coupon eligibility by product (applies_to = products). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('coupon_products', function (Blueprint $table) {
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('coupon_id');
            $table->ulid('product_id');

            $table->primary(['coupon_id', 'product_id']);
            $table->index(['tenant_id', 'store_id', 'product_id']);
            $table->foreign(['tenant_id', 'store_id', 'coupon_id'])->references(['tenant_id', 'store_id', 'id'])->on('coupons')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'product_id'])->references(['tenant_id', 'store_id', 'id'])->on('products')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('coupon_products');
    }
};

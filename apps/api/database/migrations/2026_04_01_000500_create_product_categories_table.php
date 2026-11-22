<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: product ↔ category (many-to-many, P4-9). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('product_categories', function (Blueprint $table) {
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('product_id');
            $table->ulid('category_id');
            $table->integer('position')->default(0);

            $table->primary(['product_id', 'category_id']);
            $table->index(['tenant_id', 'store_id', 'category_id', 'position']);
            $table->foreign(['tenant_id', 'store_id', 'product_id'])->references(['tenant_id', 'store_id', 'id'])->on('products')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'category_id'])->references(['tenant_id', 'store_id', 'id'])->on('categories')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('product_categories');
    }
};

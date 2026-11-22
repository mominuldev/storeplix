<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: ordered product images (P4-7). The first is the cover. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('product_images', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('product_id');
            $table->ulid('media_id');
            $table->smallInteger('position');
            $table->string('alt', 160)->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['product_id', 'media_id']);
            $table->index(['tenant_id', 'store_id', 'product_id', 'position']);
            $table->foreign(['tenant_id', 'store_id', 'product_id'])->references(['tenant_id', 'store_id', 'id'])->on('products')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'media_id'])->references(['tenant_id', 'id'])->on('media')->restrictOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('product_images');
    }
};

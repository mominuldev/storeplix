<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: per-store sequences (P5-16). Written only by StoreCounter::next(). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('store_counters', function (Blueprint $table) {
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('key', 32);
            $table->bigInteger('value');
            $table->timestampsTz();

            $table->primary(['store_id', 'key']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('store_counters');
    }
};

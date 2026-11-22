<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: zone areas; thana_code '' = the whole district. An area belongs to at most one zone. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shipping_zone_areas', function (Blueprint $table) {
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('zone_id');
            $table->string('district_code', 32);
            $table->string('thana_code', 48)->default('');

            $table->primary(['zone_id', 'district_code', 'thana_code']);
            $table->unique(['store_id', 'district_code', 'thana_code']);
            $table->index(['tenant_id', 'store_id', 'district_code']);
            $table->foreign(['tenant_id', 'store_id', 'zone_id'])->references(['tenant_id', 'store_id', 'id'])->on('shipping_zones')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('shipping_zone_areas');
    }
};

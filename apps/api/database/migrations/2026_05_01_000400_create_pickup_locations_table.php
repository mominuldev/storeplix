<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: pickup addresses (onboarding 06, Settings → Shipping; couriers use them in 5b). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('pickup_locations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('name', 60);
            $table->string('contact_name', 80)->nullable();
            $table->string('contact_phone', 13)->nullable();
            $table->string('district_code', 32);
            $table->string('thana_code', 48);
            $table->string('address_line', 255);
            $table->boolean('is_default')->default(false);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX pickup_locations_one_default ON pickup_locations (store_id) WHERE is_default');
    }

    public function down(): void
    {
        Schema::dropIfExists('pickup_locations');
    }
};

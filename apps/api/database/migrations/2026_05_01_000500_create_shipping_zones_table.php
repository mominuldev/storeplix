<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: delivery zones (P5-7). Exactly one `fallback` zone per store, enforced by a partial unique index. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shipping_zones', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('name', 60);
            $table->string('kind', 16);
            $table->bigInteger('charge_amount');
            $table->smallInteger('min_days');
            $table->smallInteger('max_days');
            $table->boolean('is_active')->default(true);
            $table->smallInteger('position')->default(0);
            $table->ulid('pickup_location_id')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'position']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'pickup_location_id'])->references(['tenant_id', 'store_id', 'id'])->on('pickup_locations')->restrictOnDelete();
        });

        DB::statement("CREATE UNIQUE INDEX shipping_zones_one_fallback ON shipping_zones (store_id) WHERE kind = 'fallback'");

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE shipping_zones ADD CONSTRAINT shipping_zones_kind_check CHECK (kind IN ('custom','fallback'))");
            DB::statement('ALTER TABLE shipping_zones ADD CONSTRAINT shipping_zones_charge_check CHECK (charge_amount BETWEEN 0 AND 1000000)');
            DB::statement('ALTER TABLE shipping_zones ADD CONSTRAINT shipping_zones_min_days_check CHECK (min_days BETWEEN 0 AND 30)');
            DB::statement('ALTER TABLE shipping_zones ADD CONSTRAINT shipping_zones_max_days_check CHECK (max_days >= min_days AND max_days <= 30)');
            DB::statement("ALTER TABLE shipping_zones ADD CONSTRAINT shipping_zones_fallback_active_check CHECK (kind <> 'fallback' OR is_active)");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('shipping_zones');
    }
};

<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 001000 (5b-3): remembered courier area ids per store × provider × district/thana (P5B-39).
 * `thana_code` is '' for a district-level mapping. RLS forced.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('courier_area_mappings', function (Blueprint $table) {
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('provider', 16);
            $table->string('district_code', 32);
            $table->string('thana_code', 48)->default('');
            $table->string('provider_city_id', 32)->nullable();
            $table->string('provider_zone_id', 32)->nullable();
            $table->string('provider_area_id', 32)->nullable();
            $table->string('label', 160);
            $table->timestampsTz();

            $table->primary(['store_id', 'provider', 'district_code', 'thana_code']);
            $table->index(['tenant_id', 'store_id', 'provider']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement("ALTER TABLE courier_area_mappings ADD CONSTRAINT courier_area_mappings_provider_check CHECK (provider IN ('steadfast','pathao','redx'))");
            RlsPolicies::enable($db, 'courier_area_mappings');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('courier_area_mappings');
    }
};

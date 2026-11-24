<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8C §3.1 (part A): stock locations (warehouses / shops) of a store. Store-scoped [S] with the composite store
 * FK and forced RLS (RlsTables::TENANT, 83 after Phase 8.8c-A). Every store has exactly one default location (= the
 * online location, P88C-4): partial UNIQUE (store_id) WHERE is_default; a default can never be archived (CHECK on
 * Postgres). Names are unique per store among non-archived rows (case-insensitive). The optional pickup address link
 * is display/prefill only and becomes NULL when the pickup address is deleted.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('locations', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('name', 60);
            $table->string('type', 10)->default('warehouse');
            $table->string('address', 200)->nullable();
            $table->char('pickup_location_id', 26)->nullable();
            $table->boolean('is_default')->default(false);
            $table->smallInteger('position')->default(0);
            $table->timestampTz('archived_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'archived_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('pickup_location_id')->references('id')->on('pickup_locations')->nullOnDelete();
            }
        });

        $db = DB::connection();
        $db->statement('CREATE UNIQUE INDEX locations_active_name_unique ON locations (store_id, lower(name)) WHERE archived_at IS NULL');
        $db->statement('CREATE UNIQUE INDEX locations_one_default ON locations (store_id) WHERE is_default');

        if ($pgsql) {
            foreach ([
                "locations ADD CONSTRAINT locations_type_check CHECK (type IN ('warehouse','shop'))",
                'locations ADD CONSTRAINT locations_default_active_check CHECK (NOT (is_default AND archived_at IS NOT NULL))',
                'locations ADD CONSTRAINT locations_position_check CHECK (position >= 0)',
                'locations ADD CONSTRAINT locations_pickup_fk FOREIGN KEY (tenant_id, store_id, pickup_location_id) REFERENCES pickup_locations (tenant_id, store_id, id) ON DELETE SET NULL (pickup_location_id)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            RlsPolicies::enable($db, 'locations');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('locations');
    }
};

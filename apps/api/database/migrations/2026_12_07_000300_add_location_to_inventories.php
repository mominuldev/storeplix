<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8C §3.1: `inventories` becomes one row per variant PER LOCATION (P88C-3). `location_id` is added, backfilled
 * to each store's default location (batched per store), then made NOT NULL with the store-scoped FK to `locations`
 * (Postgres; NO ACTION, so a location with stock rows can't be deleted while store/tenant cascades still work). The old
 * UNIQUE(variant_id) is replaced by UNIQUE(tenant_id, store_id, variant_id, location_id).
 *
 * Pre-check: the app never lets on_hand go negative; the migration aborts with a clear message if a row is negative
 * (fix the stock first), then adds CHECK (on_hand >= 0) on Postgres.
 *
 * sqlite (tests only) keeps the column nullable and without the FK, like earlier pg-only constraints.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        $negative = DB::table('inventories')->where('on_hand', '<', 0)->count();
        if ($negative > 0) {
            throw new RuntimeException("Phase 8.8c migration aborted: {$negative} inventories row(s) have on_hand < 0. Correct those stock levels (an adjustment through the app) and run the migration again.");
        }

        Schema::table('inventories', function (Blueprint $table) {
            $table->char('location_id', 26)->nullable();
        });

        DB::table('locations')->where('is_default', true)->orderBy('store_id')->select(['id', 'store_id'])
            ->chunk(500, function ($locations) {
                foreach ($locations as $location) {
                    DB::table('inventories')->where('store_id', $location->store_id)->whereNull('location_id')
                        ->update(['location_id' => $location->id]);
                }
            });

        $orphans = DB::table('inventories')->whereNull('location_id')->count();
        if ($orphans > 0) {
            throw new RuntimeException("Phase 8.8c migration aborted: {$orphans} inventories row(s) have no default location for their store.");
        }

        Schema::table('inventories', function (Blueprint $table) {
            $table->dropUnique(['variant_id']);
            $table->unique(['tenant_id', 'store_id', 'variant_id', 'location_id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'location_id', 'on_hand']);
            $table->index('variant_id');
        });

        if ($pgsql) {
            DB::statement('ALTER TABLE inventories ALTER COLUMN location_id SET NOT NULL');
            DB::statement('ALTER TABLE inventories ADD CONSTRAINT inventories_location_fk FOREIGN KEY (tenant_id, store_id, location_id) REFERENCES locations (tenant_id, store_id, id)');
            DB::statement('ALTER TABLE inventories ADD CONSTRAINT inventories_on_hand_check CHECK (on_hand >= 0)');
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE inventories DROP CONSTRAINT IF EXISTS inventories_on_hand_check');
            DB::statement('ALTER TABLE inventories DROP CONSTRAINT IF EXISTS inventories_location_fk');
        }
        // Only valid while every variant has a single row (one location).
        Schema::table('inventories', function (Blueprint $table) {
            $table->dropIndex(['variant_id']);
            $table->dropIndex(['tenant_id', 'store_id', 'location_id', 'on_hand']);
            $table->dropUnique(['tenant_id', 'store_id', 'id']);
            $table->dropUnique(['tenant_id', 'store_id', 'variant_id', 'location_id']);
            $table->unique('variant_id');
        });
        Schema::table('inventories', function (Blueprint $table) {
            $table->dropColumn('location_id');
        });
    }
};

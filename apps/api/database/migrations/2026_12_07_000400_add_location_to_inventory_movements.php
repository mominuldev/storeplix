<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8C §3.1: every ledger row carries the location of its stock row. Before 8.8c a store had one stock row per
 * variant, at the (backfilled) default location, so each store's movements are backfilled to that location (batched
 * per store). NOT NULL + store-scoped FK on Postgres; index (tenant_id, store_id, location_id, created_at). The reason
 * CHECK is widened with `transfer_out`, `transfer_in`, `count` (part B writes them); reference types gain
 * `stock_transfer` / `stock_count` (no CHECK, as before).
 */
return new class extends Migration
{
    private const REASONS_8B = "'initial','received','correction','damaged','lost','returned','import','other','order_shipped','order_returned'";

    public function up(): void
    {
        Schema::table('inventory_movements', function (Blueprint $table) {
            $table->char('location_id', 26)->nullable();
        });

        DB::table('locations')->where('is_default', true)->orderBy('store_id')->select(['id', 'store_id'])
            ->chunk(500, function ($locations) {
                foreach ($locations as $location) {
                    DB::table('inventory_movements')->where('store_id', $location->store_id)->whereNull('location_id')
                        ->update(['location_id' => $location->id]);
                }
            });

        Schema::table('inventory_movements', function (Blueprint $table) {
            $table->index(['tenant_id', 'store_id', 'location_id', 'created_at']);
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE inventory_movements ALTER COLUMN location_id SET NOT NULL');
            DB::statement('ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_location_fk FOREIGN KEY (tenant_id, store_id, location_id) REFERENCES locations (tenant_id, store_id, id)');
            DB::statement('ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_reason_check');
            DB::statement('ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_reason_check CHECK (reason IN ('.self::REASONS_8B.",'transfer_out','transfer_in','count'))");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement("UPDATE inventory_movements SET reason = 'other' WHERE reason IN ('transfer_out','transfer_in','count')");
            DB::statement('ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_reason_check');
            DB::statement('ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_reason_check CHECK (reason IN ('.self::REASONS_8B.'))');
            DB::statement('ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_location_fk');
        }
        Schema::table('inventory_movements', function (Blueprint $table) {
            $table->dropIndex(['tenant_id', 'store_id', 'location_id', 'created_at']);
        });
        Schema::table('inventory_movements', function (Blueprint $table) {
            $table->dropColumn('location_id');
        });
    }
};

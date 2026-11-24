<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8C §3.1, P88C-8 "Receive at": a purchase order receives at one location (default location unless chosen,
 * editable until the first receipt) and each receipt records where it stocked. Existing rows are backfilled to the
 * store's default location; NOT NULL + store-scoped FK on Postgres.
 */
return new class extends Migration
{
    private const TABLES = ['purchase_orders', 'purchase_receipts'];

    public function up(): void
    {
        foreach (self::TABLES as $name) {
            Schema::table($name, function (Blueprint $table) {
                $table->char('location_id', 26)->nullable();
            });
        }

        DB::table('locations')->where('is_default', true)->orderBy('store_id')->select(['id', 'store_id'])
            ->chunk(500, function ($locations) {
                foreach ($locations as $location) {
                    foreach (self::TABLES as $name) {
                        DB::table($name)->where('store_id', $location->store_id)->whereNull('location_id')->update(['location_id' => $location->id]);
                    }
                }
            });

        if (DB::getDriverName() === 'pgsql') {
            foreach (self::TABLES as $name) {
                DB::statement("ALTER TABLE {$name} ALTER COLUMN location_id SET NOT NULL");
                DB::statement("ALTER TABLE {$name} ADD CONSTRAINT {$name}_location_fk FOREIGN KEY (tenant_id, store_id, location_id) REFERENCES locations (tenant_id, store_id, id)");
            }
        }
        Schema::table('purchase_orders', function (Blueprint $table) {
            $table->index(['tenant_id', 'store_id', 'location_id']);
        });
    }

    public function down(): void
    {
        Schema::table('purchase_orders', function (Blueprint $table) {
            $table->dropIndex(['tenant_id', 'store_id', 'location_id']);
        });
        foreach (self::TABLES as $name) {
            if (DB::getDriverName() === 'pgsql') {
                DB::statement("ALTER TABLE {$name} DROP CONSTRAINT IF EXISTS {$name}_location_fk");
            }
            Schema::table($name, function (Blueprint $table) {
                $table->dropColumn('location_id');
            });
        }
    }
};

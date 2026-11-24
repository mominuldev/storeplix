<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8C §3.1, P88C-4: an order line remembers the location its stock was committed at; release, ship and
 * restock always use it, so changing the online location never moves committed stock. Existing tracked lines are
 * backfilled to the store's default location (the only stock row they could have used), batched per store.
 * Untracked lines keep NULL. Store-scoped FK on Postgres (NULL = not checked).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('order_items', function (Blueprint $table) {
            $table->char('location_id', 26)->nullable();
        });

        DB::table('locations')->where('is_default', true)->orderBy('store_id')->select(['id', 'store_id'])
            ->chunk(500, function ($locations) {
                foreach ($locations as $location) {
                    DB::table('order_items')->where('store_id', $location->store_id)->where('tracked', true)
                        ->whereNotNull('variant_id')->whereNull('location_id')->update(['location_id' => $location->id]);
                }
            });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE order_items ADD CONSTRAINT order_items_location_fk FOREIGN KEY (tenant_id, store_id, location_id) REFERENCES locations (tenant_id, store_id, id)');
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_location_fk');
        }
        Schema::table('order_items', function (Blueprint $table) {
            $table->dropColumn('location_id');
        });
    }
};

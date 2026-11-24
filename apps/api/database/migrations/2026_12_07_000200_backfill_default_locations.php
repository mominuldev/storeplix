<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-8C §3.1 backfill: one default location per existing store ("Main warehouse", type warehouse,
 * is_default = true), its address prefilled from (and linked to) the store's default pickup address when one exists.
 * Idempotent: a store that already has a default location is skipped. New stores get the same row from
 * StoreProvisioner (Locations::ensureDefault). Runs on the owner connection (BYPASSRLS).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('stores')->orderBy('id')->select(['id', 'tenant_id'])->chunk(500, function ($stores) {
            foreach ($stores as $store) {
                if (DB::table('locations')->where('store_id', $store->id)->where('is_default', true)->exists()) {
                    continue;
                }
                $pickup = DB::table('pickup_locations')->where('store_id', $store->id)->orderByDesc('is_default')->orderBy('created_at')
                    ->where('is_default', true)->first(['id', 'address_line']);
                $now = now();
                DB::table('locations')->insert([
                    'id' => strtolower((string) Str::ulid()),
                    'tenant_id' => $store->tenant_id,
                    'store_id' => $store->id,
                    'name' => 'Main warehouse',
                    'type' => 'warehouse',
                    'address' => $pickup !== null ? mb_substr((string) $pickup->address_line, 0, 200) : null,
                    'pickup_location_id' => $pickup?->id,
                    'is_default' => true,
                    'position' => 0,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            }
        });
    }

    public function down(): void
    {
        // Forward-only data backfill: the locations table itself is dropped by 000100's down().
    }
};

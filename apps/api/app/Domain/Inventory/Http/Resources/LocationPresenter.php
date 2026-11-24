<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Http\Resources;

use App\Domain\Inventory\Models\Location;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Support\Facades\DB;

/** `Location` payloads (@storeplix/types, PHASE-8-8C §4). */
final class LocationPresenter
{
    /**
     * @param  iterable<Location>  $locations  (pickupLocation loaded)
     * @return list<array<string, mixed>>
     */
    public static function many(string $storeId, iterable $locations, bool $costs): array
    {
        $stats = self::stats($storeId);
        $out = [];
        foreach ($locations as $location) {
            $out[] = self::one($location, $costs, $stats[$location->id] ?? null);
        }

        return $out;
    }

    /**
     * @param  object{units: int|string, value: int|string, variants: int|string}|null  $stat
     * @return array<string, mixed> Location
     */
    public static function one(Location $location, bool $costs, ?object $stat = null): array
    {
        $stat ??= self::stats($location->store_id)[$location->id] ?? null;
        $pickup = $location->pickupLocation;

        return [
            'id' => $location->id,
            'name' => $location->name,
            'type' => $location->type,
            'address' => $location->address,
            'is_default' => $location->is_default,
            'position' => $location->position,
            'archived_at' => UserRef::iso($location->archived_at),
            'pickup_location' => $pickup === null ? null : ['id' => $pickup->id, 'name' => $pickup->name],
            'units_on_hand' => (int) ($stat->units ?? 0),
            'stock_value_amount' => $costs ? (int) ($stat->value ?? 0) : null,
            'variants_count' => (int) ($stat->variants ?? 0),
            'created_at' => UserRef::iso($location->created_at),
            'updated_at' => UserRef::iso($location->updated_at),
        ];
    }

    /**
     * Σ on_hand, Σ on_hand × variant cost (P4-5: only shown with costs.view) and rows with on_hand > 0, per location.
     *
     * @return array<string, object>
     */
    private static function stats(string $storeId): array
    {
        return DB::table('inventories')
            ->join('product_variants', 'product_variants.id', '=', 'inventories.variant_id')
            ->where('inventories.store_id', $storeId)
            ->whereNull('product_variants.deleted_at')
            ->groupBy('inventories.location_id')
            ->selectRaw(implode(', ', [
                'inventories.location_id as location_id',
                'coalesce(sum(CASE WHEN inventories.on_hand > 0 THEN inventories.on_hand ELSE 0 END), 0) as units',
                'coalesce(sum(CASE WHEN inventories.on_hand > 0 AND product_variants.cost_amount IS NOT NULL THEN inventories.on_hand * product_variants.cost_amount ELSE 0 END), 0) as value',
                'coalesce(sum(CASE WHEN inventories.on_hand > 0 THEN 1 ELSE 0 END), 0) as variants',
            ]))->get()->keyBy('location_id')->all();
    }
}

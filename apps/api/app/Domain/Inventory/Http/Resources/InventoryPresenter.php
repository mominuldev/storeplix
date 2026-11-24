<?php

namespace App\Domain\Inventory\Http\Resources;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Developer\ApiKeys\ApiKeyActors;
use App\Domain\Inventory\Locations\Locations;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Inventory\Models\Location;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Support\Carbon;

/**
 * InventoryLevel / InventoryItem / StockMovement payloads (@storeplix/types).
 *
 * PHASE-8-8C P88C-6 reader classes: level() is an ONLINE reader (the online row) that also reports the variant's
 * total over non-archived locations; item() is a TOTAL reader without a location ("All locations"), a LOCATION
 * reader with one, or (external API) online numbers on top with `locations[]` beside them.
 */
final class InventoryPresenter
{
    public const ONLINE = 'online';

    /**
     * InventoryLevel of the online row. $totalOnHand = Σ on_hand over non-archived locations (null = the online
     * row only, i.e. a one-location store); $onlineLocationId names the online location when the row is missing.
     *
     * @return array<string, mixed> InventoryLevel
     */
    public static function level(?Inventory $inventory, bool $tracked, ?int $totalOnHand = null, ?string $onlineLocationId = null): array
    {
        $onHand = $inventory?->on_hand ?? 0;
        $committed = $inventory?->committed ?? 0;
        $threshold = $inventory?->effectiveThreshold() ?? Inventory::DEFAULT_LOW_STOCK_THRESHOLD;
        $total = $totalOnHand ?? $onHand;

        return [
            'on_hand' => $onHand,
            'committed' => $committed,
            'available' => $onHand - $committed,
            'low_stock_threshold' => $inventory?->low_stock_threshold,
            'effective_threshold' => $threshold,
            'status' => Inventory::status($tracked, $onHand - $committed, $threshold),
            'location_id' => $inventory?->location_id ?? $onlineLocationId,
            'total_on_hand' => $total,
            'other_locations_on_hand' => $total - $onHand,
        ];
    }

    /**
     * InventoryLevel of a variant with `inventory` (online row) and `inventories.location` loaded.
     *
     * @return array<string, mixed>
     */
    public static function variantLevel(ProductVariant $variant, ?string $onlineLocationId = null): array
    {
        return self::level($variant->inventory, $variant->track_inventory, self::totalOnHand($variant), $onlineLocationId ?? ($variant->inventory === null ? Locations::defaultId($variant->store_id) : null));
    }

    /** Σ on_hand over the variant's rows at non-archived locations (`inventories.location` loaded; else online row). */
    public static function totalOnHand(ProductVariant $variant): int
    {
        if (! $variant->relationLoaded('inventories')) {
            return $variant->inventory?->on_hand ?? 0;
        }

        return (int) $variant->inventories->filter(fn (Inventory $i) => $i->location !== null && ! $i->location->isArchived())->sum('on_hand');
    }

    /** Σ (on_hand − committed) over non-archived locations. */
    public static function totalAvailable(ProductVariant $variant): int
    {
        if (! $variant->relationLoaded('inventories')) {
            return ($variant->inventory?->on_hand ?? 0) - ($variant->inventory?->committed ?? 0);
        }

        return (int) $variant->inventories->filter(fn (Inventory $i) => $i->location !== null && ! $i->location->isArchived())
            ->sum(fn (Inventory $i) => $i->on_hand - $i->committed);
    }

    /**
     * Variant must have product (+ images.media) and `inventories` loaded. $location: null = All locations (totals over
     * non-archived locations), a location id = that location's row, self::ONLINE = online row on top (external API).
     * $locations = the store's non-archived locations, default first (loaded when null).
     *
     * @param  list<Location>|null  $locations
     * @return array<string, mixed> InventoryItem
     */
    public static function item(ProductVariant $variant, bool $costs, ?string $location = null, ?array $locations = null): array
    {
        $product = $variant->product;
        $locations ??= Locations::active($variant->store_id);
        $rows = $variant->relationLoaded('inventories') ? $variant->inventories : $variant->inventories()->get();
        /** @var array<string, Inventory> $byLocation */
        $byLocation = $rows->keyBy('location_id')->all();
        $default = $locations[0] ?? null;
        $defaultRow = $default !== null ? ($byLocation[$default->id] ?? null) : null;

        $perLocation = [];
        $onHand = 0;
        $committed = 0;
        $updated = null;
        foreach ($locations as $l) {
            $row = $byLocation[$l->id] ?? null;
            $perLocation[] = [
                'id' => $l->id,
                'name' => $l->name,
                'on_hand' => $row?->on_hand ?? 0,
                'committed' => $row?->committed ?? 0,
                'available' => ($row?->on_hand ?? 0) - ($row?->committed ?? 0),
            ];
            $onHand += $row?->on_hand ?? 0;
            $committed += $row?->committed ?? 0;
            if ($row !== null && ($updated === null || $row->updated_at > $updated)) {
                $updated = $row->updated_at;
            }
        }

        if ($location === null) {
            $thresholdRaw = $defaultRow?->low_stock_threshold;
            $locationId = null;
        } else {
            $row = $location === self::ONLINE ? $defaultRow : ($byLocation[$location] ?? null);
            $onHand = $row?->on_hand ?? 0;
            $committed = $row?->committed ?? 0;
            $thresholdRaw = $row !== null ? $row->low_stock_threshold : $defaultRow?->low_stock_threshold;
            $updated = $row?->updated_at;
            $locationId = $location === self::ONLINE ? null : $location;
        }
        $threshold = $thresholdRaw ?? Inventory::DEFAULT_LOW_STOCK_THRESHOLD;
        $cover = $product->relationLoaded('images') ? $product->images->first() : null;

        return [
            'variant_id' => $variant->id,
            'product' => [
                'id' => $product->id,
                'name' => $product->name,
                'status' => $product->status,
                'image' => MediaPresenter::ref($cover?->media),
            ],
            'title' => $variant->title,
            'option_values' => $variant->optionValues(count($product->options ?? [])),
            'sku' => $variant->sku,
            'barcode' => $variant->barcode,
            'on_hand' => $onHand,
            'committed' => $committed,
            'available' => $onHand - $committed,
            'low_stock_threshold' => $thresholdRaw,
            'effective_threshold' => $threshold,
            'status' => Inventory::status($variant->track_inventory, $onHand - $committed, $threshold),
            'track_inventory' => $variant->track_inventory,
            'price_amount' => $variant->price_amount,
            'cost_amount' => $costs ? $variant->cost_amount : null,
            'updated_at' => UserRef::iso($updated instanceof Carbon ? $updated : $variant->updated_at),
            'location_id' => $locationId,
            'locations' => $perLocation,
        ];
    }

    /**
     * @param  array<string, string>|null  $names  location names by id (loaded when null)
     * @return array<string, mixed> StockMovement (variant.product and actor loaded)
     */
    public static function movement(InventoryMovement $movement, ?array $names = null): array
    {
        $variant = $movement->variant;
        $names ??= Locations::names($movement->store_id);

        return [
            'id' => $movement->id,
            'variant_id' => $movement->variant_id,
            'product' => ['id' => $variant?->product?->id, 'name' => $variant?->product?->name],
            'variant_title' => $variant?->title,
            'sku' => $variant?->sku,
            'delta' => $movement->delta,
            'on_hand_after' => $movement->on_hand_after,
            'reason' => $movement->reason,
            'note' => $movement->note,
            'reference' => $movement->reference_type !== null ? ['type' => $movement->reference_type, 'id' => $movement->reference_id] : null,
            'actor' => $movement->actor_api_key_id !== null ? ApiKeyActors::ref($movement->actor_api_key_id) : UserRef::of($movement->actor), // PHASE-8-4 §3
            'created_at' => UserRef::iso($movement->created_at),
            'location' => ['id' => $movement->location_id, 'name' => $names[$movement->location_id] ?? ''],
        ];
    }
}

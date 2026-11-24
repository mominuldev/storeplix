<?php

namespace App\Domain\Inventory\Http\Resources;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Developer\ApiKeys\ApiKeyActors;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Shared\Http\UserRef;

/** InventoryLevel / InventoryItem / StockMovement payloads (@storeplix/types). */
final class InventoryPresenter
{
    /** @return array<string, mixed> InventoryLevel */
    public static function level(?Inventory $inventory, bool $tracked): array
    {
        $onHand = $inventory?->on_hand ?? 0;
        $committed = $inventory?->committed ?? 0;
        $threshold = $inventory?->effectiveThreshold() ?? Inventory::DEFAULT_LOW_STOCK_THRESHOLD;

        return [
            'on_hand' => $onHand,
            'committed' => $committed,
            'available' => $onHand - $committed,
            'low_stock_threshold' => $inventory?->low_stock_threshold,
            'effective_threshold' => $threshold,
            'status' => Inventory::status($tracked, $onHand - $committed, $threshold),
        ];
    }

    /**
     * Variant must have product (+ images.media) and inventory loaded.
     *
     * @return array<string, mixed> InventoryItem
     */
    public static function item(ProductVariant $variant, bool $costs): array
    {
        $product = $variant->product;
        $inventory = $variant->inventory;
        $level = self::level($inventory, $variant->track_inventory);
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
        ] + $level + [
            'track_inventory' => $variant->track_inventory,
            'price_amount' => $variant->price_amount,
            'cost_amount' => $costs ? $variant->cost_amount : null,
            'updated_at' => UserRef::iso($inventory?->updated_at ?? $variant->updated_at),
        ];
    }

    /** @return array<string, mixed> StockMovement (variant.product and actor loaded) */
    public static function movement(InventoryMovement $movement): array
    {
        $variant = $movement->variant;

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
        ];
    }
}

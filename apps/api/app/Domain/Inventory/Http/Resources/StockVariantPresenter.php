<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Http\Resources;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Media\Http\Resources\MediaPresenter;

/** `StockVariantRef` (@storeplix/types, PHASE-8-8C part B) on transfer and count lines. */
final class StockVariantPresenter
{
    /** @return list<string> eager-load paths below the given relation (e.g. "items" → items.variant.product.images.media) */
    public static function paths(string $prefix = ''): array
    {
        $p = $prefix === '' ? '' : $prefix.'.';

        return ["{$p}variant.product.images.media"];
    }

    /** @return array<string, mixed> StockVariantRef */
    public static function ref(?ProductVariant $variant, string $variantId): array
    {
        $product = $variant?->product; // eager-load paths() to avoid N+1
        $cover = $product !== null && $product->relationLoaded('images') ? $product->images->first() : null;

        return [
            'id' => $variantId,
            'product' => ['id' => (string) $product?->id, 'name' => (string) ($product?->name ?? ''), 'image' => MediaPresenter::ref($cover?->media)],
            'title' => (string) ($variant?->title ?? ''),
            'option_values' => $variant !== null && $product !== null ? $variant->optionValues(count($product->options ?? [])) : [],
            'sku' => $variant?->sku,
            'barcode' => $variant?->barcode,
        ];
    }
}

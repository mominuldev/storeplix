<?php

namespace App\Domain\Catalog\Http\Resources;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Inventory\Http\Resources\InventoryPresenter;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Relations\Relation;

/**
 * ProductSummary / Product / ProductVariant payloads. $costs = Permission::ViewCosts (P4-5): when false every
 * cost_amount is null.
 */
final class ProductPresenter
{
    /** Eager loads every presenter needs (no N+1). */
    public static function with(bool $full = false): array
    {
        $with = [
            'variants.inventory',
            'images' => fn (Relation|Builder $q) => $q->orderBy('position'),
            'images.media',
            'categories' => fn (Relation|Builder $q) => $q->orderBy('product_categories.position'),
        ];

        return $full ? [...$with, 'createdBy', 'updatedBy'] : $with;
    }

    /** @return array<string, mixed> */
    public static function summary(Product $product, bool $costs): array
    {
        $variants = $product->variants;
        $card = self::cardVariant($variants->all());
        $cover = $product->images->first();
        $tracked = $variants->filter(fn (ProductVariant $v) => $v->track_inventory);
        $low = 0;
        $out = 0;
        foreach ($tracked as $v) {
            $level = InventoryPresenter::level($v->inventory, true);
            $low += $level['status'] === 'low_stock' ? 1 : 0;
            $out += $level['status'] === 'out_of_stock' ? 1 : 0;
        }

        return [
            'id' => $product->id,
            'name' => $product->name,
            'slug' => $product->slug,
            'type' => $product->type,
            'status' => $product->status,
            'currency' => $product->currency,
            'image' => MediaPresenter::ref($cover?->media),
            'price_min_amount' => $product->price_min_amount,
            'price_max_amount' => $product->price_max_amount,
            'price_amount' => $card?->price_amount ?? 0,
            'compare_at_amount' => $card?->compare_at_amount,
            'cost_amount' => $costs ? $card?->cost_amount : null,
            'variants_count' => $variants->count(),
            'first_sku' => $variants->first(fn (ProductVariant $v) => $v->sku !== null)?->sku,
            'stock' => [
                'on_hand' => (int) $variants->sum(fn (ProductVariant $v) => $v->inventory?->on_hand ?? 0),
                'available' => (int) $variants->sum(fn (ProductVariant $v) => ($v->inventory?->on_hand ?? 0) - ($v->inventory?->committed ?? 0)),
                'low_variants' => $low,
                'out_variants' => $out,
                'tracked' => $tracked->isNotEmpty(),
            ],
            'categories' => $product->categories->map(fn (Category $c) => CategoryPresenter::ref($c))->values()->all(),
            'published_at' => UserRef::iso($product->published_at),
            'created_at' => UserRef::iso($product->created_at),
            'updated_at' => UserRef::iso($product->updated_at),
        ];
    }

    /** @return array<string, mixed> */
    public static function full(Product $product, bool $costs): array
    {
        $optionCount = count($product->options ?? []);

        return self::summary($product, $costs) + [
            'description' => $product->description,
            'tags' => $product->tags ?? [],
            'options' => $product->options ?? [],
            'variants' => $product->variants->map(fn (ProductVariant $v) => self::variant($v, $optionCount, $costs))->values()->all(),
            'images' => $product->images->map(fn (ProductImage $i) => [
                'media_id' => $i->media_id,
                'alt' => $i->alt,
                'position' => $i->position,
                'media' => MediaPresenter::ref($i->media),
            ])->values()->all(),
            'seo' => ['title' => $product->seo_title, 'description' => $product->seo_description],
            'url_path' => '/products/'.$product->slug,
            'revision' => $product->revision,
            'created_by' => UserRef::of($product->createdBy),
            'updated_by' => UserRef::of($product->updatedBy),
        ];
    }

    /** @return array<string, mixed> */
    public static function variant(ProductVariant $variant, int $optionCount, bool $costs): array
    {
        return [
            'id' => $variant->id,
            'title' => $variant->title,
            'option_values' => $variant->optionValues($optionCount),
            'sku' => $variant->sku,
            'barcode' => $variant->barcode,
            'price_amount' => $variant->price_amount,
            'compare_at_amount' => $variant->compare_at_amount,
            'cost_amount' => $costs ? $variant->cost_amount : null,
            'weight_grams' => $variant->weight_grams,
            'position' => $variant->position,
            'is_default' => $variant->is_default,
            'is_enabled' => $variant->is_enabled,
            'track_inventory' => $variant->track_inventory,
            'allow_backorder' => $variant->allow_backorder,
            'image_media_id' => $variant->image_media_id,
            'inventory' => InventoryPresenter::level($variant->inventory, $variant->track_inventory),
            'updated_at' => UserRef::iso($variant->updated_at),
        ];
    }

    /**
     * Card variant = cheapest enabled variant (ties: position); first variant when none is enabled.
     *
     * @param  list<ProductVariant>  $variants  ordered by position
     */
    public static function cardVariant(array $variants): ?ProductVariant
    {
        $card = null;
        foreach ($variants as $v) {
            if ($v->is_enabled && ($card === null || $v->price_amount < $card->price_amount)) {
                $card = $v;
            }
        }

        return $card ?? ($variants[0] ?? null);
    }
}

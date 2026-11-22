<?php

namespace App\Domain\Pricing;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Inventory\Models\Inventory;
use Illuminate\Support\Facades\DB;

/**
 * Loads the catalog data CartPricer needs for a list of (variant id, quantity) pairs, inside one store. Variants of
 * another store simply don't load (→ `unavailable` / unknown), so foreign ids never price.
 */
final class LineLoader
{
    /**
     * @param  list<array{key: mixed, variant_id: string, quantity: int}>  $items
     * @param  list<string>  $statuses  product statuses that are sellable here (storefront: active; preview: + draft;
     *                                  manual orders: active + draft)
     * @return array{lines: list<array<string, mixed>>, variants: array<string, ProductVariant>}
     */
    public static function load(string $storeId, array $items, array $statuses = [Product::ACTIVE]): array
    {
        $ids = array_values(array_unique(array_map(fn ($i) => strtolower((string) $i['variant_id']), $items)));
        /** @var array<string, ProductVariant> $variants */
        $variants = $ids === [] ? [] : ProductVariant::withTrashed()->where('store_id', $storeId)->whereIn('id', $ids)
            ->with(['product' => fn ($q) => $q->withTrashed()->with('images.media'), 'inventory'])
            ->get()->keyBy('id')->all();
        $productIds = array_values(array_unique(array_map(fn (ProductVariant $v) => $v->product_id, $variants)));
        $categories = [];
        if ($productIds !== []) {
            foreach (DB::table('product_categories')->whereIn('product_id', $productIds)->get(['product_id', 'category_id']) as $row) {
                $categories[$row->product_id][] = $row->category_id;
            }
        }

        $lines = [];
        foreach ($items as $item) {
            $variant = $variants[strtolower((string) $item['variant_id'])] ?? null;
            $product = $variant?->product;
            /** @var Inventory|null $inventory */
            $inventory = $variant?->inventory;
            $lines[] = [
                'key' => $item['key'],
                'variant_id' => strtolower((string) $item['variant_id']),
                'product_id' => $product?->id,
                'category_ids' => $product ? ($categories[$product->id] ?? []) : [],
                'quantity' => (int) $item['quantity'],
                'price' => (int) ($variant?->price_amount ?? 0),
                'compare_at' => $variant?->compare_at_amount,
                'purchasable' => $variant !== null && ! $variant->trashed() && $variant->is_enabled
                    && $product !== null && ! $product->trashed() && in_array($product->status, $statuses, true),
                'tracked' => (bool) ($variant?->track_inventory ?? false),
                'backorder' => (bool) ($variant?->allow_backorder ?? false),
                'available' => $inventory ? $inventory->on_hand - $inventory->committed : 0,
                'threshold' => $inventory?->effectiveThreshold() ?? Inventory::DEFAULT_LOW_STOCK_THRESHOLD,
            ];
        }

        return ['lines' => $lines, 'variants' => $variants];
    }
}

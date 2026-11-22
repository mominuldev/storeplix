<?php

namespace App\Domain\Cart;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Media\MediaMaps;
use App\Domain\Media\Models\Media;
use App\Domain\Shipping\ZoneResolver;
use App\Domain\Stores\Models\Store;

/** Cart / CartLine payloads (@storeplix/types). Never cost, SKU, barcode or exact stock beyond `low_stock` (P5-6). */
final class CartPresenter
{
    /**
     * @param  array<string, mixed>  $priced  CartService::price() result
     * @return array<string, mixed>
     */
    public static function cart(Store $store, array $priced, ?Coupon $coupon): array
    {
        /** @var array<string, ProductVariant> $variants */
        $variants = $priced['variants'];
        $media = MediaMaps::load(array_values(array_filter(array_map(fn (ProductVariant $v) => $v->image_media_id, $variants))));

        $lines = [];
        $items = 0;
        foreach ($priced['lines'] as $i => $line) {
            $input = $priced['input'][$i];
            $item = $priced['items'][$line['key']];
            $variant = $variants[$input['variant_id']] ?? null;
            $product = $variant?->product;
            $items += $item->quantity;
            $lines[] = [
                'id' => $item->id,
                'variant_id' => $item->variant_id,
                'product_slug' => (string) $product?->slug,
                'product_name' => (string) $product?->name,
                'variant_title' => (string) $variant?->title,
                'option_values' => $variant && $product ? $variant->optionValues(count($product->options ?? [])) : [],
                'image' => self::image($variant, $media),
                'quantity' => $item->quantity,
                'unit_price_amount' => $line['unit_price_amount'],
                'compare_at_amount' => $line['compare_at_amount'],
                'line_amount' => $line['line_amount'],
                'issue' => $line['issue'],
                'max_quantity' => $line['max_quantity'],
                'low_stock' => $line['issue'] === null ? $line['low_stock'] : null,
            ];
        }

        $subtotal = $priced['subtotal'];
        $discount = $priced['discount'];
        $threshold = ZoneResolver::freeOver($store->id);

        return [
            'lines' => $lines,
            'lines_count' => count($lines),
            'items_count' => $items,
            'currency' => $store->currency ?: 'BDT',
            'coupon' => $coupon === null ? null : [
                'code' => $coupon->code,
                'type' => $coupon->type,
                'discount_amount' => $discount,
                'free_shipping' => $coupon->type === Coupon::FREE_SHIPPING,
            ],
            'subtotal_amount' => $subtotal,
            'discount_amount' => $discount,
            'savings_amount' => $priced['compare_savings'] + $discount,
            'estimated_total_amount' => $subtotal - $discount,
            'free_delivery' => $threshold === null ? null : [
                'threshold_amount' => $threshold,
                'remaining_amount' => max(0, $threshold - ($subtotal - $discount)),
            ],
            'can_checkout' => $lines !== [] && ! $priced['has_issues'],
        ];
    }

    /**
     * Variant image, else the product cover; StorefrontMedia or null.
     *
     * @param  array<string, Media>  $media
     * @return array<string, mixed>|null
     */
    public static function image(?ProductVariant $variant, array $media): ?array
    {
        $product = $variant?->product;
        $chosen = $variant?->image_media_id !== null ? ($media[$variant->image_media_id] ?? null) : null;
        $cover = $product?->images->first();
        $chosen ??= $cover?->media;
        if ($chosen === null || $chosen->status === Media::FAILED) {
            return null;
        }

        return array_merge(MediaMaps::storefrontMedia($chosen), ['alt' => $cover->alt ?? $chosen->alt ?? $product?->name]);
    }
}

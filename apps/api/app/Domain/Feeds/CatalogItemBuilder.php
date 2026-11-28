<?php

declare(strict_types=1);

namespace App\Domain\Feeds;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\DataTransfer\Import\ImportValues;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Payments\PaymentUrls;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-9D P89D-27 / P89D-28 (S340): one feed item per variant of this store. Inclusion: active (published), not
 * archived, price > 0, at least one image, category filter, sold-out rule; excluded items carry the reason. Mapping:
 * title, plain-text description (≤ 5,000), link on the primary host, images (main + ≤ 10), price / sale price, online
 * stock availability, brand, condition, language, country BD, no GTIN (identifier_exists = no).
 */
final class CatalogItemBuilder
{
    /**
     * @param  list<string>|null  $productIds  null = every product (full sync)
     * @return array<string, array{product_id: string, variant_id: string, excluded_reason: string|null, data: array<string, mixed>|null, hash: string|null}> by variant id
     */
    public static function build(Store $store, StoreIntegration $integration, ?array $productIds = null): array
    {
        $base = PaymentUrls::storefrontBase($store) ?? 'https://'.$store->slug.'.'.config('storeplix.platform_domain');
        $categories = (array) $integration->setting('category_ids', []);
        $filter = $integration->setting('include') === 'categories';
        $hideSoldOut = (bool) $integration->setting('hide_sold_out', false);
        $useSale = (bool) $integration->setting('use_sale_price', true);
        $brand = $integration->setting('default_brand') ?: $store->name;
        $google = $integration->provider === IntegrationProvider::GOOGLE_MERCHANT;
        $out = [];

        $query = Product::query()->where('store_id', $store->id)->with(['images.media', 'variants'])->orderBy('id');
        if ($productIds !== null) {
            $query->whereIn('id', $productIds);
        }
        $query->chunk(200, function ($products) use (&$out, $base, $categories, $filter, $hideSoldOut, $useSale, $brand, $store) {
            $ids = $products->pluck('id')->all();
            $inCategory = $filter ? DB::table('product_categories')->whereIn('product_id', $ids)->whereIn('category_id', $categories)->pluck('product_id')->flip()->all() : [];
            $variantIds = $products->flatMap(fn (Product $p) => $p->variants->pluck('id'))->all();
            $available = self::availability($variantIds);
            foreach ($products as $product) {
                /** @var Product $product */
                $images = $product->images->map(fn ($i) => MediaPresenter::url($i->media, ['w1600', 'w1024']))->filter()->values()->all();
                $description = Str::limit(trim(ImportValues::plainText($product->description)), (int) config('feeds.description_max', 5000), '');
                foreach ($product->variants as $variant) {
                    /** @var ProductVariant $variant */
                    if (! $variant->is_enabled) {
                        continue; // disabled variants are removed like deleted ones
                    }
                    $inStock = ! $variant->track_inventory || $variant->allow_backorder || ($available[$variant->id] ?? 0) > 0;
                    $reason = match (true) {
                        $product->status === Product::ARCHIVED => 'archived',
                        $product->status !== Product::ACTIVE => 'not_published',
                        $variant->price_amount <= 0 => 'no_price',
                        $images === [] => 'no_image',
                        $filter && ! isset($inCategory[$product->id]) => 'category_filtered',
                        $hideSoldOut && ! $inStock => 'sold_out_hidden',
                        default => null,
                    };
                    $data = null;
                    if ($reason === null) {
                        $title = $product->name.(($variant->title ?? '') !== '' && $variant->title !== 'Default' ? ' - '.$variant->title : '');
                        $variantImage = $variant->image_media_id !== null ? $product->images->firstWhere('media_id', $variant->image_media_id) : null;
                        $main = $variantImage !== null ? MediaPresenter::url($variantImage->media, ['w1600', 'w1024']) : $images[0];
                        $sale = $useSale && $variant->compare_at_amount !== null && $variant->compare_at_amount > $variant->price_amount;
                        $data = [
                            'id' => $variant->id,
                            'item_group_id' => $product->id,
                            'title' => Str::limit($title, 150, ''),
                            'description' => $description !== '' ? $description : $title,
                            'link' => $base.'/products/'.$product->slug.'?variant='.$variant->id,
                            'image_link' => $main,
                            'additional_image_links' => array_slice(array_values(array_diff($images, [$main])), 0, 10),
                            'price_amount' => $sale ? (int) $variant->compare_at_amount : (int) $variant->price_amount,
                            'sale_price_amount' => $sale ? (int) $variant->price_amount : null,
                            'currency' => $product->currency ?: $store->currency,
                            'availability' => $inStock ? 'in stock' : 'out of stock',
                            'brand' => Str::limit((string) $brand, 70, ''),
                            'condition' => 'new',
                            'language' => 'bn',
                            'country' => 'BD',
                            'identifier_exists' => 'no',
                        ];
                    }
                    $out[$variant->id] = [
                        'product_id' => $product->id, 'variant_id' => $variant->id, 'excluded_reason' => $reason, 'data' => $data,
                        'hash' => $data !== null ? hash('sha256', (string) json_encode($data)) : null,
                    ];
                }
            }
        });
        if ($google) {
            foreach ($out as $id => $row) {
                if ($row['data'] !== null) {
                    $out[$id]['data']['condition'] = (string) $integration->setting('condition', 'new');
                    $out[$id]['data']['language'] = (string) $integration->setting('feed_language', 'bn');
                    $out[$id]['hash'] = hash('sha256', (string) json_encode($out[$id]['data']));
                }
            }
        }

        return $out;
    }

    /** Online-location available stock per variant (P8.8c). @param list<string> $variantIds @return array<string, int> */
    private static function availability(array $variantIds): array
    {
        if ($variantIds === []) {
            return [];
        }

        return DB::table('inventories')->whereIn('variant_id', $variantIds)
            ->whereRaw('inventories.location_id = (SELECT online_l.id FROM locations online_l WHERE online_l.store_id = inventories.store_id AND online_l.is_default = true)')
            ->selectRaw('variant_id, (COALESCE(on_hand, 0) - COALESCE(committed, 0)) as available')->pluck('available', 'variant_id')
            ->map(fn ($v) => (int) $v)->all();
    }
}

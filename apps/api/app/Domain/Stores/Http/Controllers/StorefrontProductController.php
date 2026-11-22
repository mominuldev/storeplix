<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Catalog\CategoryService;
use App\Domain\Catalog\Http\Resources\ProductPresenter;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Media\MediaMaps;
use App\Domain\Media\Models\Media;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\ResolvedStorefront;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * §3.8 GET /storefront/products — card data only (P4-22): never cost, SKU, barcode, stock or store/tenant ids.
 * Only active products with ≥ 1 enabled variant. Draft store without a valid preview → 404 store_not_found.
 */
class StorefrontProductController
{
    public function __invoke(Request $request, CategoryService $categories): JsonResponse
    {
        $input = $request->validate([
            'sort' => ['sometimes', 'string', 'in:latest,bestsellers'],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:24'],
            'on_sale' => ['sometimes', 'in:0,1'],
            'category' => ['sometimes', 'nullable', 'string', 'max:140'],
        ]);

        /** @var ResolvedStorefront $resolved */
        $resolved = $request->attributes->get(ResolveStorefront::ATTRIBUTE);
        $preview = (bool) $request->attributes->get(ResolveStorefront::PREVIEW_ATTRIBUTE, false);
        $store = Store::query()->findOrFail($resolved->storeId);
        if ($store->status !== Store::STATUS_ACTIVE && ! $preview) {
            throw new ApiException(404, 'store_not_found', 'No store is registered for this host.');
        }

        $limit = (int) ($input['limit'] ?? 8);
        $onSale = ($input['on_sale'] ?? '0') === '1';
        $eligible = fn () => Product::query()->where('products.store_id', $store->id)->where('status', Product::ACTIVE)
            ->whereExists(fn ($q) => $q->select(DB::raw(1))->from('product_variants')
                ->whereColumn('product_variants.product_id', 'products.id')
                ->whereNull('product_variants.deleted_at')->where('product_variants.is_enabled', true));

        $query = $eligible();
        $empty = false;
        if (($input['category'] ?? null) !== null && $input['category'] !== '') {
            $category = Category::query()->where('store_id', $store->id)->where('slug', $input['category'])->first();
            if ($category === null) {
                $empty = true;
            } else {
                $ids = $categories->withDescendants($store, [$category->id]);
                $query->whereExists(fn ($q) => $q->select(DB::raw(1))->from('product_categories')
                    ->whereColumn('product_categories.product_id', 'products.id')->whereIn('product_categories.category_id', $ids));
            }
        }
        if ($onSale) {
            $query->whereExists(fn ($q) => $q->select(DB::raw(1))->from('product_variants')
                ->whereColumn('product_variants.product_id', 'products.id')
                ->whereNull('product_variants.deleted_at')->where('product_variants.is_enabled', true)
                ->whereNotNull('product_variants.compare_at_amount')
                ->whereColumn('product_variants.compare_at_amount', '>', 'product_variants.price_amount'));
        }

        $cards = [];
        if (! $empty) {
            /** @var Builder $query */
            $products = $query->orderByDesc('published_at')->orderByDesc('id')
                ->limit($onSale ? min(100, $limit * 4) : $limit)
                ->with(['variants' => fn ($q) => $q->where('is_enabled', true), 'images.media', 'categories'])
                ->get();
            foreach ($products as $product) {
                $card = $this->card($product);
                if ($card !== null && (! $onSale || $card['on_sale'])) {
                    $cards[] = $card;
                }
                if (count($cards) >= $limit) {
                    break;
                }
            }
        }

        return new JsonResponse(
            ['data' => $cards, 'meta' => ['has_products' => $eligible()->exists()]],
            200,
            $preview ? [] : ['Cache-Control' => 'public, max-age=0, s-maxage=60'],
        );
    }

    /** @return array<string, mixed>|null StorefrontProductCard (exact key set) */
    private function card(Product $product): ?array
    {
        $variant = ProductPresenter::cardVariant($product->variants->all());
        if ($variant === null) {
            return null;
        }
        $cover = $product->images->first();
        $media = $cover?->media;
        $onSale = $variant->compare_at_amount !== null && $variant->compare_at_amount > $variant->price_amount;

        return [
            'id' => $product->id,
            'slug' => $product->slug,
            'name' => $product->name,
            'subtitle' => $product->categories->first()?->name,
            'price_amount' => $variant->price_amount,
            'compare_at_amount' => $onSale ? $variant->compare_at_amount : null,
            'currency' => $product->currency,
            'on_sale' => $onSale,
            'image' => $media !== null && $media->status !== Media::FAILED
                ? array_merge(MediaMaps::storefrontMedia($media), ['alt' => $cover->alt ?? $media->alt ?? $product->name])
                : null,
        ];
    }
}

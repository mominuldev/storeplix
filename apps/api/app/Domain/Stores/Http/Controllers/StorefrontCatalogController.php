<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Media\MediaMaps;
use App\Domain\Media\Models\Media;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;

/**
 * §3.2 storefront PDP, availability and categories (P5-6, P5-28). Exact key sets: never cost, SKU, barcode, on_hand,
 * committed, tenant/store ids, revision or created_by. Draft store without preview → 404 store_not_found.
 */
class StorefrontCatalogController
{
    private const PUBLIC_CACHE = ['Cache-Control' => 'public, max-age=0, s-maxage=60'];

    public function product(Request $request, string $slug): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $product = $this->findProduct($ctx, $slug);
        $variants = $product->variants->where('is_enabled', true)->values();
        $optionCount = count($product->options ?? []);
        $images = $product->images->filter(fn (ProductImage $i) => $i->media !== null && $i->media->status !== Media::FAILED)->values();
        $categories = $product->categories->filter(fn (Category $c) => $c->deleted_at === null)->values();

        return new JsonResponse(['data' => [
            'id' => $product->id,
            'slug' => $product->slug,
            'name' => $product->name,
            'description' => $product->description,
            'options' => array_values($product->options ?? []),
            'variants' => $variants->map(fn (ProductVariant $v) => [
                'id' => $v->id,
                'title' => $v->title,
                'option_values' => $v->optionValues($optionCount),
                'price_amount' => $v->price_amount,
                'compare_at_amount' => $v->compare_at_amount !== null && $v->compare_at_amount > $v->price_amount ? $v->compare_at_amount : null,
                'image_media_id' => $v->image_media_id,
            ])->all(),
            'images' => $images->map(fn (ProductImage $i) => [
                'media_id' => $i->media_id,
                'alt' => $i->alt,
                'media' => array_merge(MediaMaps::storefrontMedia($i->media), ['alt' => $i->alt ?? $i->media->alt ?? $product->name]),
            ])->all(),
            'price_min_amount' => (int) $variants->min('price_amount'),
            'price_max_amount' => (int) $variants->max('price_amount'),
            'currency' => $product->currency,
            'categories' => $categories->map(fn (Category $c) => ['slug' => $c->slug, 'name' => $c->name])->all(),
            'seo' => ['title' => $product->seo_title, 'description' => $product->seo_description],
            'url_path' => '/products/'.$product->slug,
            'is_preview_only' => $product->status !== Product::ACTIVE,
            'updated_at' => UserRef::iso($product->updated_at),
        ]], 200, $ctx->preview ? [] : self::PUBLIC_CACHE);
    }

    /** P5-6: boolean availability plus "Only N left" only at or below the low-stock threshold. */
    public function availability(Request $request, string $slug): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $product = $this->findProduct($ctx, $slug);
        $rows = [];
        foreach ($product->variants->where('is_enabled', true) as $variant) {
            /** @var Inventory|null $inventory */
            $inventory = $variant->inventory;
            if (! $variant->track_inventory || $variant->allow_backorder) {
                $rows[] = ['id' => $variant->id, 'available' => true, 'low_stock' => null];

                continue;
            }
            $available = $inventory ? $inventory->on_hand - $inventory->committed : 0;
            $threshold = $inventory?->effectiveThreshold() ?? Inventory::DEFAULT_LOW_STOCK_THRESHOLD;
            $rows[] = ['id' => $variant->id, 'available' => $available > 0, 'low_stock' => $available > 0 && $available <= $threshold ? $available : null];
        }

        return new JsonResponse(['data' => ['variants' => $rows]], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function categories(Request $request): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        $all = Category::query()->where('store_id', $ctx->store->id)->where('is_visible', true)
            ->with('image')->orderBy('position')->orderBy('id')->get();
        $byParent = $all->groupBy(fn (Category $c) => $c->parent_id ?? '');
        $build = function (string $parent, int $depth) use (&$build, $byParent): array {
            if ($depth > Category::MAX_DEPTH) {
                return [];
            }

            return ($byParent[$parent] ?? collect())->map(fn (Category $c) => [
                'slug' => $c->slug,
                'name' => $c->name,
                'image' => self::media($c->image, $c->name),
                'url_path' => '/c/'.$c->slug,
                'children' => $build($c->id, $depth + 1),
            ])->values()->all();
        };

        return new JsonResponse(['data' => $build('', 1)], 200, $ctx->preview ? [] : self::PUBLIC_CACHE);
    }

    public function category(Request $request, string $slug): JsonResponse
    {
        $ctx = StorefrontContext::from($request)->requireVisible();
        /** @var Collection<string, Category> $all */
        $all = Category::query()->where('store_id', $ctx->store->id)->with('image')->orderBy('position')->orderBy('id')->get()->keyBy('id');
        $category = $all->first(fn (Category $c) => $c->slug === $slug) ?? throw new ApiException(404, 'not_found', 'Resource not found.');

        $ancestors = [];
        $parent = $category->parent_id !== null ? ($all[$category->parent_id] ?? null) : null;
        while ($parent !== null && count($ancestors) < Category::MAX_DEPTH) {
            array_unshift($ancestors, ['slug' => $parent->slug, 'name' => $parent->name]);
            $parent = $parent->parent_id !== null ? ($all[$parent->parent_id] ?? null) : null;
        }

        return new JsonResponse(['data' => [
            'slug' => $category->slug,
            'name' => $category->name,
            'image' => self::media($category->image, $category->name),
            'url_path' => '/c/'.$category->slug,
            'description' => $category->description,
            'ancestors' => $ancestors,
            'children' => $all->filter(fn (Category $c) => $c->parent_id === $category->id && $c->is_visible)
                ->map(fn (Category $c) => ['slug' => $c->slug, 'name' => $c->name, 'url_path' => '/c/'.$c->slug])->values()->all(),
        ]], 200, $ctx->preview ? [] : self::PUBLIC_CACHE);
    }

    /** Active (preview: also draft), non-deleted, with ≥ 1 enabled variant; else 404. */
    private function findProduct(StorefrontContext $ctx, string $slug): Product
    {
        $statuses = $ctx->preview ? [Product::ACTIVE, Product::DRAFT] : [Product::ACTIVE];
        $product = Product::query()->where('store_id', $ctx->store->id)->where('slug', $slug)->whereIn('status', $statuses)
            ->with(['variants.inventory', 'images.media', 'categories'])->first();
        if ($product === null || ! $product->variants->contains(fn (ProductVariant $v) => $v->is_enabled)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $product;
    }

    /** @return array<string, mixed>|null */
    private static function media(?Media $media, string $alt): ?array
    {
        return $media !== null && $media->status !== Media::FAILED
            ? array_merge(MediaMaps::storefrontMedia($media), ['alt' => $media->alt ?? $alt])
            : null;
    }
}

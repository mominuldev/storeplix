<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Catalog\CategoryService;
use App\Domain\Catalog\Http\Resources\ProductPresenter;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Support\StockSql;
use App\Domain\Inventory\InventorySql;
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
 * Phase 5 (§3.2): page/per_page (PLP), q, price range, in_stock, exclude, price and bestseller sorts.
 */
class StorefrontProductController
{
    public function __invoke(Request $request, CategoryService $categories): JsonResponse
    {
        $input = $request->validate([
            'sort' => ['sometimes', 'string', 'in:latest,bestsellers,price_asc,price_desc'],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:24', 'prohibits:page,per_page'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:48'],
            'on_sale' => ['sometimes', 'in:0,1'],
            'category' => ['sometimes', 'nullable', 'string', 'max:140'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'price_min' => ['sometimes', 'integer', 'min:0'],
            'price_max' => ['sometimes', 'integer', 'min:0'],
            'in_stock' => ['sometimes', 'in:0,1'],
            'exclude' => ['sometimes', 'nullable', 'string', 'max:26'],
        ]);

        /** @var ResolvedStorefront $resolved */
        $resolved = $request->attributes->get(ResolveStorefront::ATTRIBUTE);
        $preview = (bool) $request->attributes->get(ResolveStorefront::PREVIEW_ATTRIBUTE, false);
        $store = Store::query()->findOrFail($resolved->storeId);
        if ($store->status !== Store::STATUS_ACTIVE && ! $preview) {
            throw new ApiException(404, 'store_not_found', 'No store is registered for this host.');
        }

        $paged = isset($input['page']) || isset($input['per_page']);
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
        $this->applySearchFilters($query, $input);

        match ($input['sort'] ?? 'latest') {
            'price_asc' => $query->orderBy('products.price_min_amount')->orderByDesc('products.id'),
            'price_desc' => $query->orderByDesc('products.price_min_amount')->orderByDesc('products.id'),
            'bestsellers' => $this->bestsellers($query, $store->id),
            default => $query->orderByDesc('products.published_at')->orderByDesc('products.id'),
        };
        $query->select('products.*')->with(['variants' => fn ($q) => $q->where('is_enabled', true), 'images.media', 'categories']);

        $meta = ['has_products' => $eligible()->exists()];
        $cards = [];
        if ($paged) {
            $page = $empty ? null : $query->paginate((int) ($input['per_page'] ?? 24));
            foreach ($page?->getCollection() ?? [] as $product) {
                if (($card = $this->card($product)) !== null) {
                    $cards[] = $card;
                }
            }
            $meta += [
                'current_page' => $page?->currentPage() ?? 1,
                'per_page' => $page?->perPage() ?? (int) ($input['per_page'] ?? 24),
                'total' => $page?->total() ?? 0,
                'last_page' => $page?->lastPage() ?? 1,
            ];
        } elseif (! $empty) {
            $products = $query->limit($onSale ? min(100, $limit * 4) : $limit)->get();
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

        return new JsonResponse(['data' => $cards, 'meta' => $meta], 200, $preview ? [] : ['Cache-Control' => 'public, max-age=0, s-maxage=60']);
    }

    /** q (name or tag contains), price range on the card price, in_stock, exclude (P5 §3.2). */
    private function applySearchFilters(Builder $query, array $input): void
    {
        if (($q = trim((string) ($input['q'] ?? ''))) !== '') {
            $like = StockSql::contains($q);
            $op = StockSql::like();
            $query->where(fn ($w) => $w->where('products.name', $op, $like)->orWhereRaw("CAST(products.tags AS TEXT) {$op} ?", [StockSql::contains(mb_strtolower($q))]));
        }
        if (isset($input['price_min'])) {
            $query->where('products.price_min_amount', '>=', (int) $input['price_min']);
        }
        if (isset($input['price_max'])) {
            $query->where('products.price_min_amount', '<=', (int) $input['price_max']);
        }
        if (($input['in_stock'] ?? '0') === '1') {
            // PHASE-8-8C §5.3: ONLINE reader (the online location's row only).
            $query->whereExists(fn ($q) => InventorySql::joinOnline($q->select(DB::raw(1))->from('product_variants'))
                ->whereColumn('product_variants.product_id', 'products.id')
                ->whereNull('product_variants.deleted_at')->where('product_variants.is_enabled', true)
                ->where(fn ($w) => $w->where('product_variants.track_inventory', false)->orWhere('product_variants.allow_backorder', true)
                    ->orWhereRaw(StockSql::available().' > 0')));
        }
        if (($input['exclude'] ?? null) !== null && $input['exclude'] !== '') {
            $query->where('products.id', '<>', strtolower($input['exclude']));
        }
    }

    /** P5-30: units sold in non-cancelled orders of the last 30 days; ties and unsold products by latest. */
    private function bestsellers(Builder $query, string $storeId): void
    {
        $sales = DB::table('order_items')->join('orders', 'orders.id', '=', 'order_items.order_id')
            ->where('orders.store_id', $storeId)->where('orders.status', '<>', 'cancelled')
            ->where('orders.placed_at', '>=', now()->subDays(30))->whereNotNull('order_items.product_id')
            ->groupBy('order_items.product_id')->selectRaw('order_items.product_id as product_id, sum(order_items.quantity) as units');
        $query->leftJoinSub($sales, 'sales', 'sales.product_id', '=', 'products.id')
            ->orderByRaw('COALESCE(sales.units, 0) DESC')->orderByDesc('products.published_at')->orderByDesc('products.id');
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

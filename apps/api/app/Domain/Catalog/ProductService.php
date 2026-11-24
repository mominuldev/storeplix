<?php

namespace App\Domain\Catalog;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductCategory;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Catalog\Support\Slug;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Developer\Webhooks\WebhookEventType;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Product writes (§3.2). Every write is one transaction: lock, revision check, SKU re-check, diff variants / images /
 * categories, inventory rows (+ `initial` ledger rows) for new variants, price range over enabled variants,
 * published_at on first activation, revision bump. Plan limit (P4-21) is checked inside the transaction under a
 * per-store advisory lock (pgsql; no-op on sqlite, where writers are serialised anyway).
 */
class ProductService
{
    public function __construct(
        private readonly InventoryService $inventory,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /**
     * @param  array<string, mixed>  $plan  ProductPayloadValidator::normalise() output
     * @param  array{reason?: string, reference?: array{type: string, id: string}|null, audit?: bool, slug_base?: string}  $opts
     */
    public function create(Store $store, array $plan, ?User $user, array $opts = []): Product
    {
        return $this->guard(fn () => DB::transaction(function () use ($store, $plan, $user, $opts) {
            $this->lockStore($store);
            FeatureGate::assertWithin($this->context->tenant(), Limit::Products);

            $fields = $plan['fields'];
            $options = $plan['options'] ?? [];
            $variants = $plan['variants'] ?? [];
            $this->recheckSkus($store, $variants, null);

            $slug = $fields['slug'] ?? null;
            if ($slug !== null) {
                $this->assertSlugFree($store, $slug);
            } else {
                $slug = $this->defaultSlug($store, $opts['slug_base'] ?? Slug::from($fields['name'], 'p', 220));
            }
            $status = $fields['status'] ?? Product::DRAFT;
            [$min, $max] = self::range(array_map(fn ($v) => [$v['price_amount'], $v['is_enabled'] ?? true], $variants));

            $product = new Product([
                'name' => $fields['name'],
                'slug' => $slug,
                'type' => $options === [] ? Product::SIMPLE : Product::VARIABLE,
                'status' => $status,
                'description' => $fields['description'] ?? null,
                'options' => $options,
                'tags' => $fields['tags'] ?? [],
                'seo_title' => $fields['seo_title'] ?? null,
                'seo_description' => $fields['seo_description'] ?? null,
                'currency' => $store->currency ?: 'BDT',
                'created_by' => $user?->getKey(),
                'updated_by' => $user?->getKey(),
            ]);
            $product->store_id = $store->id;
            $product->price_min_amount = $min;
            $product->price_max_amount = $max;
            $product->published_at = $status === Product::ACTIVE ? now() : null;
            $product->save();

            $this->syncImages($product, $plan['images'] ?? []);
            $this->syncCategories($product, $plan['category_ids'] ?? []);
            $this->syncVariants($product, $variants, $options, $user, $opts['reason'] ?? 'initial', $opts['reference'] ?? null);

            if ($opts['audit'] ?? true) {
                $this->audit->log('product.created', $product, ['name' => $product->name, 'sku_count' => count(array_filter(array_column($variants, 'sku')))]);
            }
            WebhookEvents::emit(WebhookEventType::ProductUpdated, $product);

            return $product;
        }));
    }

    /**
     * @param  array<string, mixed>  $plan
     * @param  array{reason?: string, reference?: array{type: string, id: string}|null, audit?: bool}  $opts
     */
    public function update(Store $store, Product $product, array $plan, ?int $revision, ?User $user, array $opts = []): Product
    {
        return $this->guard(fn () => DB::transaction(function () use ($store, $product, $plan, $revision, $user, $opts) {
            /** @var Product $locked */
            $locked = Product::query()->whereKey($product->id)->lockForUpdate()->firstOrFail();
            if ($revision !== null && $locked->revision !== $revision) {
                throw StoreThemeService::conflict();
            }

            $fields = $plan['fields'];
            $before = $locked->status;
            foreach (['name', 'status', 'description', 'tags', 'seo_title', 'seo_description'] as $key) {
                if (array_key_exists($key, $fields)) {
                    $locked->{$key} = $fields[$key];
                }
            }
            if (array_key_exists('slug', $fields)) {
                if ($fields['slug'] === null) {
                    // explicit clear → regenerate from the (new) name
                    $locked->slug = $this->defaultSlug($store, Slug::from($locked->name, 'p', 220), $locked->id);
                } elseif ($fields['slug'] !== $locked->slug) {
                    $this->assertSlugFree($store, $fields['slug'], $locked->id);
                    $locked->slug = $fields['slug'];
                }
            }
            if ($plan['options'] !== null) {
                $locked->options = $plan['options'];
                $locked->type = $plan['options'] === [] ? Product::SIMPLE : Product::VARIABLE;
            }

            if ($plan['images'] !== null) {
                $this->syncImages($locked, $plan['images']);
            }
            if ($plan['category_ids'] !== null) {
                $this->syncCategories($locked, $plan['category_ids']);
            }
            if ($plan['variants'] !== null) {
                $this->recheckSkus($store, $plan['variants'], $locked->id);
                $this->syncVariants($locked, $plan['variants'], $locked->options ?? [], $user, $opts['reason'] ?? 'initial', $opts['reference'] ?? null);
            }

            $this->recomputePrices($locked);
            if ($locked->status === Product::ACTIVE && $locked->published_at === null) {
                $locked->published_at = now();
            }
            $locked->revision++;
            $locked->updated_by = $user?->getKey();
            $locked->save();

            if (($opts['audit'] ?? true) && $before !== $locked->status && in_array(Product::ACTIVE, [$before, $locked->status], true)) {
                $this->audit->log('product.status_changed', $locked, ['from' => $before, 'to' => $locked->status]);
            }
            WebhookEvents::emit(WebhookEventType::ProductUpdated, $locked);

            return $locked;
        }));
    }

    /**
     * Import update (P4-19): variant fields of matched rows, product fields from the group's first row, stock as a
     * SET through InventoryService (reason `import`, zero delta writes nothing). Bumps revision.
     *
     * @param  array<string, mixed>|null  $productFields  name/description/status/tags/seo_title/seo_description
     * @param  list<string>|null  $categoryIds
     * @param  array<string, array<string, mixed>>  $variantFields  variant id → changed fields
     * @param  array<string, int>  $stock  variant id → new on_hand
     * @param  array{type: string, id: string}  $reference
     * @param  array<string, string>  $stockLocations  variant id → location id (CSV `location`; omitted = default location, PHASE-8-8C P88C-7)
     */
    public function importUpdate(Store $store, Product $product, ?array $productFields, ?array $categoryIds, array $variantFields, array $stock, ?User $user, array $reference, array $stockLocations = []): Product
    {
        return DB::transaction(function () use ($store, $product, $productFields, $categoryIds, $variantFields, $stock, $user, $reference, $stockLocations) {
            /** @var Product $locked */
            $locked = Product::query()->whereKey($product->id)->lockForUpdate()->firstOrFail();
            foreach ($productFields ?? [] as $key => $value) {
                $locked->{$key} = $value;
            }
            if ($categoryIds !== null) {
                $this->syncCategories($locked, $categoryIds);
            }
            foreach ($variantFields as $variantId => $fields) {
                $variant = ProductVariant::query()->where('product_id', $locked->id)->whereKey($variantId)->first();
                if ($variant === null) {
                    continue;
                }
                $variant->fill($fields);
                if ($variant->compare_at_amount !== null && $variant->compare_at_amount <= $variant->price_amount) {
                    $variant->compare_at_amount = null;
                }
                $variant->save();
            }
            if ($stock !== []) {
                $items = [];
                foreach ($stock as $variantId => $qty) {
                    $items[] = ['variant_id' => $variantId, 'mode' => 'set', 'quantity' => $qty, 'location_id' => $stockLocations[$variantId] ?? null];
                }
                $this->inventory->adjust($store->id, 'import', null, $items, $user?->getKey(), $reference);
            }
            $this->recomputePrices($locked);
            if ($locked->status === Product::ACTIVE && $locked->published_at === null) {
                $locked->published_at = now();
            }
            $locked->revision++;
            $locked->updated_by = $user?->getKey();
            $locked->save();
            WebhookEvents::emit(WebhookEventType::ProductUpdated, $locked);

            return $locked;
        });
    }

    public function duplicate(Store $store, Product $source, ?User $user): Product
    {
        return DB::transaction(function () use ($store, $source, $user) {
            $this->lockStore($store);
            FeatureGate::assertWithin($this->context->tenant(), Limit::Products);

            $base = rtrim(substr($source->slug, 0, 214), '-').'-copy';
            $slug = $base;
            for ($i = 2; $this->slugTaken($store, $slug); $i++) {
                $slug = "{$base}-{$i}";
            }

            $copy = new Product([
                'name' => Str::limit('Copy of '.$source->name, 200, ''),
                'slug' => $slug,
                'type' => $source->type,
                'status' => Product::DRAFT,
                'description' => $source->description,
                'options' => $source->options,
                'tags' => $source->tags,
                'seo_title' => $source->seo_title,
                'seo_description' => $source->seo_description,
                'currency' => $source->currency,
                'created_by' => $user?->getKey(),
                'updated_by' => $user?->getKey(),
            ]);
            $copy->store_id = $store->id;
            $copy->price_min_amount = $source->price_min_amount;
            $copy->price_max_amount = $source->price_max_amount;
            $copy->save();

            $this->syncImages($copy, ProductImage::query()->where('product_id', $source->id)->orderBy('position')->get()
                ->map(fn (ProductImage $i) => ['media_id' => $i->media_id, 'alt' => $i->alt, 'position' => $i->position])->all());
            $this->syncCategories($copy, ProductCategory::query()->where('product_id', $source->id)->orderBy('position')->pluck('category_id')->all());

            $variants = ProductVariant::query()->where('product_id', $source->id)->with('inventory')->orderBy('position')->get();
            $rows = [];
            $stock = [];
            foreach ($variants as $variant) {
                $id = strtolower((string) Str::ulid());
                $rows[] = $this->variantRow($copy, $id, [
                    'title' => $variant->title, 'option1' => $variant->option1, 'option2' => $variant->option2, 'option3' => $variant->option3,
                    'sku' => null, 'barcode' => $variant->barcode, 'price_amount' => $variant->price_amount,
                    'compare_at_amount' => $variant->compare_at_amount, 'cost_amount' => $variant->cost_amount,
                    'weight_grams' => $variant->weight_grams, 'position' => $variant->position, 'is_default' => $variant->is_default,
                    'is_enabled' => $variant->is_enabled, 'track_inventory' => $variant->track_inventory,
                    'allow_backorder' => $variant->allow_backorder, 'image_media_id' => $variant->image_media_id,
                ]);
                $stock[] = ['variant_id' => $id, 'store_id' => $store->id, 'on_hand' => 0, 'threshold' => $variant->inventory?->low_stock_threshold];
            }
            ProductVariant::query()->insert($rows);
            $this->inventory->createMany($stock, 'initial', null, $user?->getKey());

            $this->audit->log('product.created', $copy, ['name' => $copy->name, 'sku_count' => 0]);
            WebhookEvents::emit(WebhookEventType::ProductUpdated, $copy);

            return $copy;
        });
    }

    public function delete(Product $product, bool $audit = true): void
    {
        DB::transaction(function () use ($product, $audit) {
            $skuCount = ProductVariant::query()->where('product_id', $product->id)->whereNotNull('sku')->count();
            ProductVariant::query()->where('product_id', $product->id)->update(['deleted_at' => now(), 'updated_at' => now()]);
            $product->delete();
            if ($audit) {
                $this->audit->log('product.deleted', $product, ['name' => $product->name, 'sku_count' => $skuCount]);
            }
        });
    }

    /**
     * @param  list<string>  $ids  product ids already checked against the store
     * @param  list<string>  $categoryIds
     */
    public function bulk(Store $store, string $action, array $ids, array $categoryIds, ?User $user): int
    {
        return DB::transaction(function () use ($store, $action, $ids, $categoryIds, $user) {
            $products = Product::query()->where('store_id', $store->id)->whereIn('id', $ids)->lockForUpdate()->get();

            if ($action === 'add_categories') {
                $existing = ProductCategory::query()->whereIn('product_id', $ids)->get()->groupBy('product_id');
                foreach ($products as $product) {
                    $merged = array_values(array_unique(array_merge($existing->get($product->id)?->pluck('category_id')->all() ?? [], $categoryIds)));
                    if (count($merged) > Product::MAX_CATEGORIES) {
                        throw ValidationException::withMessages(['category_ids' => ['A product can be in at most '.Product::MAX_CATEGORIES.' categories.']]);
                    }
                }
            }

            foreach ($products as $product) {
                match ($action) {
                    'activate' => $product->status = Product::ACTIVE,
                    'draft' => $product->status = Product::DRAFT,
                    'archive' => $product->status = Product::ARCHIVED,
                    default => null,
                };
                if ($action === 'delete') {
                    $this->delete($product, false);

                    continue;
                }
                if ($action === 'set_categories') {
                    $this->syncCategories($product, $categoryIds);
                } elseif ($action === 'add_categories') {
                    $current = ProductCategory::query()->where('product_id', $product->id)->orderBy('position')->pluck('category_id')->all();
                    $this->syncCategories($product, array_values(array_unique(array_merge($current, $categoryIds))));
                }
                if ($product->status === Product::ACTIVE && $product->published_at === null) {
                    $product->published_at = now();
                }
                $product->revision++;
                $product->updated_by = $user?->getKey();
                $product->save();
                WebhookEvents::emit(WebhookEventType::ProductUpdated, $product);
            }

            $this->audit->log('product.bulk_updated', null, ['action' => $action, 'count' => $products->count()]);

            return $products->count();
        });
    }

    public function recomputePrices(Product $product): void
    {
        $row = ProductVariant::query()->where('product_id', $product->id)->where('is_enabled', true)
            ->selectRaw('min(price_amount) as min_price, max(price_amount) as max_price')->first();
        $product->price_min_amount = (int) ($row?->min_price ?? 0);
        $product->price_max_amount = (int) ($row?->max_price ?? 0);
    }

    /**
     * @param  list<array{0: int, 1: bool}>  $prices  [price, enabled]
     * @return array{0: int, 1: int}
     */
    private static function range(array $prices): array
    {
        $enabled = array_map(fn ($p) => $p[0], array_filter($prices, fn ($p) => $p[1]));

        return $enabled === [] ? [0, 0] : [min($enabled), max($enabled)];
    }

    /**
     * Full replacement of the variant list (P4-1, P4-12). Missing variants are soft-deleted (SKU freed); existing ones
     * keep their id and stock; new ones get an inventory row (+ `initial` ledger row when initial_on_hand > 0).
     *
     * @param  list<array<string, mixed>>  $variants
     * @param  list<array{name: string, values: list<string>}>  $options
     * @param  array{type: string, id: string}|null  $reference
     */
    private function syncVariants(Product $product, array $variants, array $options, ?User $user, string $reason, ?array $reference): void
    {
        $existing = ProductVariant::query()->where('product_id', $product->id)->get()->keyBy('id');
        $keep = array_filter(array_column($variants, 'id'));
        $remove = array_diff($existing->keys()->all(), $keep);
        if ($remove !== []) {
            ProductVariant::query()->whereIn('id', $remove)->update(['deleted_at' => now(), 'updated_at' => now()]);
        }

        // SKU and option-combination swaps between kept variants must not trip the unique indexes mid-way.
        $swapping = [];
        foreach ($variants as $v) {
            if ($v['id'] !== null) {
                $current = $existing[$v['id']];
                if (strtolower((string) $current->sku) !== strtolower((string) $v['sku'])
                    || [$current->option1, $current->option2, $current->option3] !== self::optionColumns($v['option_values'])) {
                    $swapping[] = $v['id'];
                }
            }
        }
        foreach ($swapping as $n => $id) {
            ProductVariant::query()->whereKey($id)->update(['sku' => null, 'option1' => "\x1Fswap{$n}", 'option2' => '', 'option3' => '']);
        }

        $isSimple = $options === [];
        $new = [];
        $stock = [];
        $thresholds = [];
        foreach ($variants as $v) {
            [$o1, $o2, $o3] = self::optionColumns($v['option_values']);
            $attrs = [
                'title' => self::title($v['option_values']),
                'option1' => $o1, 'option2' => $o2, 'option3' => $o3,
                'sku' => $v['sku'],
                'price_amount' => $v['price_amount'],
                'position' => $v['position'],
                'is_default' => $isSimple,
            ];
            foreach (['barcode', 'compare_at_amount', 'cost_amount', 'weight_grams', 'is_enabled', 'track_inventory', 'allow_backorder', 'image_media_id'] as $key) {
                if (array_key_exists($key, $v)) {
                    $attrs[$key] = $v[$key];
                }
            }

            if ($v['id'] !== null) {
                $variant = ProductVariant::query()->whereKey($v['id'])->firstOrFail();
                $variant->fill($attrs);
                if (! array_key_exists('compare_at_amount', $v) && $variant->compare_at_amount !== null && $variant->compare_at_amount <= $variant->price_amount) {
                    $variant->compare_at_amount = null; // a kept compare-at that is no longer above the new price
                }
                $variant->save();
                if (array_key_exists('low_stock_threshold', $v)) {
                    $thresholds[$variant->id] = $v['low_stock_threshold'];
                }

                continue;
            }

            $id = strtolower((string) Str::ulid());
            $new[] = $this->variantRow($product, $id, $attrs + [
                'barcode' => null, 'compare_at_amount' => null, 'cost_amount' => null, 'weight_grams' => null,
                'is_enabled' => true, 'track_inventory' => true, 'allow_backorder' => false, 'image_media_id' => null,
            ]);
            $stock[] = ['variant_id' => $id, 'store_id' => $product->store_id, 'on_hand' => (int) ($v['initial_on_hand'] ?? 0), 'threshold' => $v['low_stock_threshold'] ?? null,
                'location_id' => $v['initial_location_id'] ?? null]; // default location unless an import names one
        }

        foreach (array_chunk($new, 100) as $chunk) {
            ProductVariant::query()->insert($chunk);
        }
        $this->inventory->createMany($stock, $reason, $reference, $user?->getKey());
        foreach ($thresholds as $variantId => $threshold) {
            Inventory::query()->online()->where('variant_id', $variantId)->update(['low_stock_threshold' => $threshold, 'updated_at' => now()]); // default location row (PHASE-8-8C P88C-7)
        }
    }

    /**
     * @param  array<string, mixed>  $attrs
     * @return array<string, mixed>
     */
    private function variantRow(Product $product, string $id, array $attrs): array
    {
        $now = now();

        return [
            'id' => $id,
            'tenant_id' => $this->context->requireId(),
            'store_id' => $product->store_id,
            'product_id' => $product->id,
            'title' => $attrs['title'],
            'option1' => $attrs['option1'],
            'option2' => $attrs['option2'],
            'option3' => $attrs['option3'],
            'sku' => $attrs['sku'],
            'barcode' => $attrs['barcode'],
            'price_amount' => $attrs['price_amount'],
            'compare_at_amount' => $attrs['compare_at_amount'],
            'cost_amount' => $attrs['cost_amount'],
            'weight_grams' => $attrs['weight_grams'],
            'position' => $attrs['position'],
            'is_default' => (bool) $attrs['is_default'],
            'is_enabled' => (bool) $attrs['is_enabled'],
            'track_inventory' => (bool) $attrs['track_inventory'],
            'allow_backorder' => (bool) $attrs['allow_backorder'],
            'image_media_id' => $attrs['image_media_id'],
            'created_at' => $now,
            'updated_at' => $now,
        ];
    }

    /**
     * @param  list<array{media_id: string, alt: string|null, position: int}>  $images
     */
    private function syncImages(Product $product, array $images): void
    {
        $existing = ProductImage::query()->where('product_id', $product->id)->get()->keyBy('media_id');
        $wanted = array_column($images, null, 'media_id');
        $removed = array_diff($existing->keys()->all(), array_keys($wanted));
        if ($removed !== []) {
            ProductImage::query()->where('product_id', $product->id)->whereIn('media_id', $removed)->delete();
            ProductVariant::query()->where('product_id', $product->id)->whereIn('image_media_id', $removed)->update(['image_media_id' => null]);
        }
        foreach (array_values($images) as $position => $image) {
            $row = $existing[$image['media_id']] ?? null;
            if ($row === null) {
                $row = new ProductImage(['media_id' => $image['media_id']]);
                $row->store_id = $product->store_id;
                $row->product_id = $product->id;
            }
            $row->position = $position;
            $row->alt = $image['alt'] ?? null;
            if ($row->isDirty()) {
                $row->save();
            }
        }
    }

    /** @param list<string> $categoryIds */
    public function syncCategories(Product $product, array $categoryIds): void
    {
        ProductCategory::query()->where('product_id', $product->id)->delete();
        $tenantId = $this->context->requireId();
        $rows = [];
        foreach (array_values(array_unique($categoryIds)) as $position => $categoryId) {
            $rows[] = ['tenant_id' => $tenantId, 'store_id' => $product->store_id, 'product_id' => $product->id, 'category_id' => $categoryId, 'position' => $position];
        }
        if ($rows !== []) {
            ProductCategory::query()->insert($rows);
        }
    }

    /** @param list<array<string, mixed>> $variants */
    private function recheckSkus(Store $store, array $variants, ?string $productId): void
    {
        $skus = [];
        foreach ($variants as $i => $v) {
            if (($v['sku'] ?? null) !== null) {
                $skus[strtolower($v['sku'])] ??= $i;
            }
        }
        if ($skus === []) {
            return;
        }
        $errors = [];
        foreach (ProductPayloadValidator::takenSkus($store, array_keys($skus), $productId) as $taken) {
            $errors['variants.'.$skus[$taken].'.sku'] = ['This SKU is already used by another product.'];
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }
    }

    /**
     * Unique-index violations that slip past the in-transaction checks (a parallel writer) → 422, never 500.
     *
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    private function guard(callable $callback): mixed
    {
        try {
            return $callback();
        } catch (QueryException $e) {
            $message = $e->getMessage();
            if (str_contains($message, 'product_variants_store_sku_unique') || (str_contains($message, 'UNIQUE') && str_contains($message, 'sku'))) {
                throw ValidationException::withMessages(['variants' => ['This SKU is already used by another product.']]);
            }
            if (str_contains($message, 'products_store_slug_unique') || (str_contains($message, 'UNIQUE') && str_contains($message, 'products.slug'))) {
                throw ValidationException::withMessages(['slug' => ['This link is already used by another product.']]);
            }
            throw $e;
        }
    }

    public function lockStore(Store $store): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::select('SELECT pg_advisory_xact_lock(hashtext(?))', [$store->id]);
        }
    }

    public function slugTaken(Store $store, string $slug, ?string $exceptId = null): bool
    {
        return Product::query()->where('store_id', $store->id)->where('slug', $slug)
            ->when($exceptId, fn ($q) => $q->whereKeyNot($exceptId))->exists();
    }

    private function assertSlugFree(Store $store, string $slug, ?string $exceptId = null): void
    {
        if ($this->slugTaken($store, $slug, $exceptId)) {
            throw ValidationException::withMessages(['slug' => ['This link is already used by another product.']]);
        }
    }

    private function defaultSlug(Store $store, string $base, ?string $exceptId = null): string
    {
        return Slug::unique($base, 220, fn ($s) => $this->slugTaken($store, $s, $exceptId));
    }

    /** @param list<string> $values @return array{0: string, 1: string, 2: string} */
    private static function optionColumns(array $values): array
    {
        return [$values[0] ?? '', $values[1] ?? '', $values[2] ?? ''];
    }

    /** @param list<string> $values */
    public static function title(array $values): string
    {
        return $values === [] ? 'Default' : Str::limit(implode(' / ', $values), 130, '');
    }

    /** Category ids of this store among $ids (non-deleted). @param list<string> $ids @return list<string> */
    public static function storeCategoryIds(Store $store, array $ids): array
    {
        return Category::query()->where('store_id', $store->id)->whereIn('id', $ids)->pluck('id')->all();
    }

    /** Not found helper for nested ids that are not in the store. */
    public static function unknown(string $field, string $message): ApiException
    {
        return new ApiException(422, 'validation_failed', 'The given data was invalid.', [$field => [$message]]);
    }
}

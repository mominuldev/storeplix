<?php

namespace App\Domain\DataTransfer\Import;

use App\Domain\Catalog\CategoryService;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductCategory;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Catalog\Support\Slug;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Stores\Models\Store;

/**
 * Dry-run of a products CSV (§5.2, P4-19). One row per variant; rows of one product share `handle` (or `name`).
 * Lookups use maps preloaded with one query each (SKUs, categories, current values of matched variants).
 *
 * Row `values` (consumed by RunImport): group, first, target_product_id, target_variant_id, product (first row of a
 * group), option_names, option_values, variant.
 */
final class ProductImportValidator
{
    /** @var array<string, array{variant_id: string, product_id: string}> lower(sku) → existing variant */
    private array $skus = [];

    /** @var array<string, string> lower("A > B") → category id */
    private array $paths = [];

    /** @var array<string, string> slug → category id */
    private array $slugs = [];

    /**
     * @param  array<string, string|null>  $columnMap  header → field
     * @param  array<string, bool>  $options
     * @param  iterable<int, array<string, string>>  $records  row_number → [header → raw value]
     * @return array{rows: list<array<string, mixed>>, summary: array<string, int>}
     */
    public function validate(Store $store, array $columnMap, array $options, iterable $records, ?int $remaining): array
    {
        $this->preload($store);
        $fieldHeaders = array_flip(array_filter($columnMap));

        // 1. parse every row into fields
        $rows = [];
        $previousKey = null;
        $closed = [];
        $seenSku = [];
        foreach ($records as $rowNumber => $cells) {
            $row = $this->parse($rowNumber, $cells, $columnMap, $fieldHeaders);
            $key = $row['handle'] !== null ? 'h:'.$row['handle'] : ($row['name'] !== null ? 'n:'.mb_strtolower($row['name']) : $previousKey);
            if ($key === null) {
                $this->error($row, 'name', 'Enter a product name.');
                $key = 'row:'.$rowNumber;
            }
            if ($key !== $previousKey) {
                if (isset($closed[$key])) {
                    $this->error($row, 'handle', 'Rows for one product must be next to each other.');
                    $key = 'row:'.$rowNumber;
                }
                if ($previousKey !== null) {
                    $closed[$previousKey] = true;
                }
            }
            $row['group'] = $key;
            $previousKey = str_starts_with($key, 'row:') ? $previousKey : $key;

            if ($row['variant']['sku'] !== null) {
                $lower = strtolower($row['variant']['sku']);
                if (isset($seenSku[$lower])) {
                    $this->error($row, 'sku', 'Same SKU as row '.$seenSku[$lower].'.');
                } else {
                    $seenSku[$lower] = $rowNumber;
                }
            }
            $rows[] = $row;
        }

        // 2. group rules: target product, options, create/update/unchanged
        $groups = [];
        foreach ($rows as $i => $row) {
            $groups[$row['group']][] = $i;
        }
        $current = $this->currentValues(array_values(array_filter(array_map(
            fn ($r) => $r['variant']['sku'] !== null ? ($this->skus[strtolower($r['variant']['sku'])]['variant_id'] ?? null) : null, $rows,
        ))));

        $createProducts = 0;
        $overLimit = 0;
        foreach ($groups as $indexes) {
            $this->group($rows, $indexes, $options, $current);
            $first = $rows[$indexes[0]];
            if ($first['action'] === 'create' && $first['status'] !== 'error') {
                $createProducts++;
                if ($remaining !== null && $createProducts > $remaining) {
                    $overLimit++;
                }
            }
        }

        $summary = ['total' => count($rows), 'create' => 0, 'update' => 0, 'unchanged' => 0, 'warnings' => 0, 'errors' => 0, 'over_limit' => $overLimit, 'create_products' => $createProducts];
        $out = [];
        foreach ($rows as $row) {
            if ($row['status'] === 'error') {
                $row['action'] = 'skip';
                $summary['errors']++;
            } else {
                $summary['warnings'] += $row['status'] === 'warning' ? 1 : 0;
                if (isset($summary[$row['action']])) {
                    $summary[$row['action']]++;
                }
            }
            $out[] = [
                'row_number' => $row['row_number'],
                'status' => $row['status'],
                'action' => $row['action'],
                'label' => mb_substr($row['label'], 0, 200),
                'key' => $row['variant']['sku'],
                'values' => [
                    'group' => $row['group'],
                    'first' => $row['first'] ?? false,
                    'target_product_id' => $row['target_product_id'] ?? null,
                    'target_variant_id' => $row['target_variant_id'] ?? null,
                    'product' => $row['product'],
                    'option_names' => $row['option_names'],
                    'option_values' => $row['option_values'],
                    'variant' => $row['variant'],
                    'variants_in_group' => $row['variants_in_group'] ?? null,
                ],
                'messages' => $row['messages'],
            ];
        }

        return ['rows' => $out, 'summary' => $summary];
    }

    private function preload(Store $store): void
    {
        foreach (ProductVariant::query()->where('store_id', $store->id)->whereNotNull('sku')
            ->whereIn('product_id', Product::query()->where('store_id', $store->id)->select('id'))
            ->get(['id', 'product_id', 'sku']) as $v) {
            $this->skus[strtolower($v->sku)] = ['variant_id' => $v->id, 'product_id' => $v->product_id];
        }

        $categories = Category::query()->where('store_id', $store->id)->get(['id', 'parent_id', 'name', 'slug', 'depth', 'position']);
        $byId = $categories->keyBy('id');
        foreach (CategoryService::depthFirst($categories->all()) as $c) {
            $names = [mb_strtolower($c->name)];
            for ($p = $c->parent_id; $p !== null; $p = $byId[$p]->parent_id ?? null) {
                array_unshift($names, mb_strtolower($byId[$p]->name));
            }
            $this->paths[implode(' > ', $names)] ??= $c->id;
            $this->slugs[$c->slug] = $c->id;
        }
    }

    /**
     * @param  array<string, string>  $cells
     * @param  array<string, string|null>  $columnMap
     * @param  array<string, string>  $fieldHeaders  field → header
     * @return array<string, mixed>
     */
    private function parse(int $rowNumber, array $cells, array $columnMap, array $fieldHeaders): array
    {
        $get = fn (string $field) => isset($fieldHeaders[$field]) ? trim((string) ($cells[$fieldHeaders[$field]] ?? '')) : '';
        $row = ['row_number' => $rowNumber, 'status' => 'ready', 'action' => 'create', 'messages' => [], 'label' => ''];

        $name = ImportValues::text($get('name'));
        $handleRaw = $get('handle');
        $row['name'] = $name !== '' ? mb_substr($name, 0, 200) : null;
        if ($name !== '' && mb_strlen($name) > 200) {
            $this->warn($row, 'name', 'The name was shortened to 200 characters.');
        }
        $row['handle'] = $handleRaw !== '' ? Slug::from($handleRaw, 'p', 220) : null;
        $row['label'] = $row['name'] ?? $handleRaw;

        // Product-level fields (used from the first row of a group).
        $product = ['name' => $row['name'], 'handle' => $row['handle'], 'description' => null, 'status' => null, 'tags' => null,
            'category_ids' => null, 'create_categories' => [], 'seo_title' => null, 'seo_description' => null];
        if (($raw = $get('description')) !== '') {
            [$doc, $stripped] = ImportValues::richText($raw);
            $product['description'] = $doc;
            if ($stripped) {
                $this->warn($row, 'description', 'Formatting was removed.');
            }
        }
        if (($raw = mb_strtolower($get('status'))) !== '') {
            $status = match ($raw) {
                'active', 'true', 'yes', 'published' => Product::ACTIVE,
                'draft', 'false', 'no' => Product::DRAFT,
                'archived' => Product::ARCHIVED,
                default => null,
            };
            if ($status === null) {
                $this->warn($row, 'status', "Status \"{$raw}\" isn't draft, active or archived — the default was used.");
            }
            $product['status'] = $status;
        }
        if (($raw = $get('tags')) !== '') {
            $tags = array_map(fn ($t) => mb_substr($t, 0, 40), ImportValues::tags($raw));
            if (count($tags) > Product::MAX_TAGS) {
                $this->warn($row, 'tags', 'Only the first 20 tags were kept.');
                $tags = array_slice($tags, 0, Product::MAX_TAGS);
            }
            $product['tags'] = $tags;
        }
        if (($raw = $get('category')) !== '') {
            [$product['category_ids'], $product['create_categories']] = $this->categories($row, $raw);
        }
        foreach (['seo_title' => 70, 'seo_description' => 160] as $field => $max) {
            $raw = ImportValues::text($get($field));
            if ($raw !== '') {
                if (mb_strlen($raw) > $max) {
                    $this->warn($row, $field, "Shortened to {$max} characters.");
                }
                $product[$field] = mb_substr($raw, 0, $max);
            }
        }
        if ($get('image_urls') !== '') {
            $this->warn($row, 'image_urls', "Photos from links aren't imported yet.");
        }
        $row['product'] = $product;

        // Options: a value column without a name column takes its header as the option name ("Size").
        $names = [];
        $values = [];
        foreach ([1, 2, 3] as $n) {
            $value = ImportValues::text($get("option{$n}_value"));
            $optionName = ImportValues::text($get("option{$n}_name"));
            if ($optionName === '' && isset($fieldHeaders["option{$n}_value"]) && ! isset($fieldHeaders["option{$n}_name"])) {
                $optionName = mb_convert_case(trim($fieldHeaders["option{$n}_value"]), MB_CASE_TITLE);
            }
            if ($value === '' && $optionName === '') {
                continue;
            }
            // Shopify writes "Title / Default Title" for simple products.
            if (mb_strtolower($optionName) === 'title' && mb_strtolower($value) === 'default title') {
                continue;
            }
            $names[] = mb_substr($optionName, 0, 40);
            $values[] = mb_substr($value, 0, 40);
        }
        $row['option_names'] = $names;
        $row['option_values'] = $values;

        // Variant fields.
        $variant = ['sku' => null, 'barcode' => null, 'price_amount' => null, 'compare_at_amount' => null, 'cost_amount' => null, 'weight_grams' => null, 'stock' => null];
        $sku = ImportValues::text($get('sku'));
        if ($sku !== '') {
            if (preg_match(ProductVariant::SKU_PATTERN, $sku) === 1) {
                $variant['sku'] = $sku;
            } else {
                $this->error($row, 'sku', 'Use letters, numbers, dots, dashes, slashes or underscores in the SKU (max 64).');
            }
        }
        $barcode = ImportValues::text($get('barcode'));
        if ($barcode !== '') {
            if (preg_match(ProductVariant::BARCODE_PATTERN, $barcode) === 1) {
                $variant['barcode'] = $barcode;
            } else {
                $this->warn($row, 'barcode', 'The barcode was ignored (letters, numbers or dashes, max 64).');
            }
        }
        $priceRaw = $get('price');
        [$price, $error, $changed] = ImportValues::money($priceRaw);
        if ($price === null) {
            $this->error($row, 'price', $error ?? 'Enter a price.');
        } else {
            $variant['price_amount'] = $price;
            if ($changed) {
                $this->warn($row, 'price', "Price \"{$priceRaw}\" read as ".ImportValues::formatMoney($price));
            }
        }
        foreach (['compare_at_price' => 'compare_at_amount', 'cost_price' => 'cost_amount'] as $field => $key) {
            $raw = $get($field);
            [$amount, $error, $changed] = ImportValues::money($raw);
            if ($error !== null) {
                $this->warn($row, $field, $error.' It was ignored.');
            } elseif ($amount !== null) {
                $variant[$key] = $amount;
                if ($changed) {
                    $this->warn($row, $field, "\"{$raw}\" read as ".ImportValues::formatMoney($amount));
                }
            }
        }
        if ($variant['compare_at_amount'] !== null && $variant['price_amount'] !== null && $variant['compare_at_amount'] <= $variant['price_amount']) {
            $this->warn($row, 'compare_at_price', 'Compare-at price must be higher than the price — it was ignored.');
            $variant['compare_at_amount'] = null;
        }
        if (($raw = $get('stock')) !== '') {
            [$stock, $error] = ImportValues::integer($raw);
            if ($error !== null) {
                $this->error($row, 'stock', $error);
            } elseif ($stock < 0) {
                $this->error($row, 'stock', "Stock can't be negative.");
            } elseif ($stock > 1_000_000) {
                $this->error($row, 'stock', 'Stock is too high (max 1 000 000).');
            } else {
                $variant['stock'] = $stock;
            }
        }
        if (($raw = $get('weight_kg')) !== '') {
            [$weight, $error] = ImportValues::decimal($raw);
            $grams = isset($fieldHeaders['weight_kg']) && mb_strtolower(trim($fieldHeaders['weight_kg'])) === 'variant grams';
            if ($error !== null) {
                $this->warn($row, 'weight_kg', $error.' It was ignored.');
            } else {
                $g = (int) round($grams ? $weight : $weight * 1000);
                if ($g > 1_000_000) {
                    $this->warn($row, 'weight_kg', 'The weight is too high and was ignored.');
                } else {
                    $variant['weight_grams'] = $g;
                }
            }
        }
        $row['variant'] = $variant;

        return $row;
    }

    /**
     * @param  array<string, mixed>  $row
     * @return array{0: list<string>, 1: list<list<string>>} [existing ids, paths to create]
     */
    private function categories(array &$row, string $raw): array
    {
        $parts = array_values(array_filter(array_map('trim', preg_split('/[|,]/', $raw) ?: []), fn ($p) => $p !== ''));
        if (count($parts) > 10) {
            $this->warn($row, 'category', 'Only the first 10 categories were kept.');
            $parts = array_slice($parts, 0, 10);
        }
        $ids = [];
        $create = [];
        foreach ($parts as $part) {
            $segments = array_values(array_filter(array_map(fn ($s) => mb_substr(ImportValues::text($s), 0, 120), explode('>', $part)), fn ($s) => $s !== ''));
            if ($segments === []) {
                continue;
            }
            $path = implode(' > ', array_map('mb_strtolower', $segments));
            $id = $this->paths[$path] ?? (count($segments) === 1 ? ($this->slugs[Slug::from($segments[0], 'c', 140)] ?? null) : null);
            if ($id !== null) {
                $ids[] = $id;
            } elseif (count($segments) > Category::MAX_DEPTH) {
                $this->warn($row, 'category', "\"{$part}\" is deeper than 3 levels — skipped.");
            } else {
                $create[] = $segments;
            }
        }

        return [array_values(array_unique($ids)), $create];
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @param  list<int>  $indexes
     * @param  array<string, bool>  $options
     * @param  array<string, array<string, mixed>>  $current  variant id → current values
     */
    private function group(array &$rows, array $indexes, array $options, array $current): void
    {
        $firstIndex = $indexes[0];
        $rows[$firstIndex]['first'] = true;
        $first = $rows[$firstIndex];

        // Existing product targeted by any matched SKU in the group.
        $targets = [];
        foreach ($indexes as $i) {
            $sku = $rows[$i]['variant']['sku'];
            if ($sku !== null && isset($this->skus[strtolower($sku)])) {
                $targets[$this->skus[strtolower($sku)]['product_id']] = true;
                $rows[$i]['target_variant_id'] = $this->skus[strtolower($sku)]['variant_id'];
            }
        }

        if (count($targets) > 1) {
            foreach ($indexes as $i) {
                $this->error($rows[$i], 'sku', 'These SKUs belong to different products. Split them into separate products.');
            }

            return;
        }

        if ($targets !== []) {
            $productId = array_key_first($targets);
            foreach ($indexes as $i) {
                $rows[$i]['target_product_id'] = $productId;
                if (! isset($rows[$i]['target_variant_id'])) {
                    $this->error($rows[$i], 'sku', "New variants for an existing product aren't imported yet — add them in the product editor.");

                    continue;
                }
                if (! $options['update_existing']) {
                    $this->warn($rows[$i], 'sku', 'A product with this SKU already exists — skipped.');
                    $rows[$i]['action'] = 'skip';

                    continue;
                }
                $rows[$i]['action'] = $this->changed($rows[$i], $i === $firstIndex, $current[$rows[$i]['target_variant_id']] ?? null) ? 'update' : 'unchanged';
            }

            return;
        }

        // New product: the first row needs a name; option rules of §3.2 over the group.
        if ($first['name'] === null) {
            $this->error($rows[$firstIndex], 'name', 'Enter a product name.');
        }
        $names = $first['option_names'];
        $errors = false;
        if (count($indexes) > Product::MAX_VARIANTS) {
            $this->error($rows[$firstIndex], null, 'A product can have at most 100 variants.');
            $errors = true;
        }
        if ($names === [] && count($indexes) > 1) {
            foreach (array_slice($indexes, 1) as $i) {
                $this->error($rows[$i], 'option1_value', 'Add option values (e.g. a size) to rows of the same product.');
            }
            $errors = true;
        }
        if (count(array_unique(array_map('mb_strtolower', $names))) !== count($names) || in_array('', $names, true)) {
            $this->error($rows[$firstIndex], 'option1_name', 'Give every option a different name.');
            $errors = true;
        }
        $combos = [];
        $distinct = array_fill(0, count($names), []);
        foreach ($indexes as $i) {
            $values = $rows[$i]['option_values'];
            if (count($values) !== count($names) || in_array('', $values, true)) {
                $this->error($rows[$i], 'option1_value', 'Fill in a value for every option.');
                $errors = true;

                continue;
            }
            $combo = mb_strtolower(implode("\x1F", $values));
            if (isset($combos[$combo])) {
                $this->error($rows[$i], 'option1_value', 'This combination already exists in row '.$combos[$combo].'.');
                $errors = true;
            }
            $combos[$combo] ??= $rows[$i]['row_number'];
            foreach ($values as $k => $value) {
                $distinct[$k][mb_strtolower($value)] = true;
            }
        }
        foreach ($distinct as $k => $set) {
            if (count($set) > Product::MAX_OPTION_VALUES) {
                $this->error($rows[$firstIndex], 'option'.($k + 1).'_value', 'An option can have at most 20 values.');
                $errors = true;
            }
        }

        $groupFailed = $errors || array_filter($indexes, fn ($i) => $rows[$i]['status'] === 'error') !== [];
        foreach ($indexes as $i) {
            $rows[$i]['action'] = 'create';
            if ($groupFailed && $rows[$i]['status'] !== 'error') {
                $this->error($rows[$i], null, 'Another row of this product has an error.');
            }
        }
        $rows[$firstIndex]['variants_in_group'] = count($indexes);
    }

    /**
     * Would applying this row change anything? (Idempotence: the same file twice → `unchanged`.)
     *
     * @param  array<string, mixed>  $row
     * @param  array<string, mixed>|null  $current
     */
    private function changed(array $row, bool $first, ?array $current): bool
    {
        if ($current === null) {
            return true;
        }
        $v = $row['variant'];
        foreach (['price_amount', 'compare_at_amount', 'cost_amount', 'barcode', 'weight_grams'] as $key) {
            if ($v[$key] !== null && $v[$key] !== $current[$key]) {
                return true;
            }
        }
        if ($v['stock'] !== null && $v['stock'] !== $current['on_hand']) {
            return true;
        }
        if ($first) {
            $p = $row['product'];
            foreach (['name', 'status', 'seo_title', 'seo_description'] as $key) {
                if ($p[$key] !== null && $p[$key] !== $current['product'][$key]) {
                    return true;
                }
            }
            if ($p['description'] !== null && $p['description'] != $current['product']['description']) {
                return true;
            }
            if ($p['tags'] !== null && $p['tags'] !== $current['product']['tags']) {
                return true;
            }
            if ($p['create_categories'] !== []) {
                return true;
            }
            if ($p['category_ids'] !== null) {
                $now = $current['product']['category_ids'];
                sort($now);
                $want = $p['category_ids'];
                sort($want);
                if ($now !== $want) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * @param  list<string>  $variantIds
     * @return array<string, array<string, mixed>>
     */
    private function currentValues(array $variantIds): array
    {
        if ($variantIds === []) {
            return [];
        }
        $out = [];
        foreach (array_chunk($variantIds, 500) as $chunk) {
            $variants = ProductVariant::query()->whereIn('id', $chunk)->get();
            $stock = Inventory::query()->whereIn('variant_id', $chunk)->pluck('on_hand', 'variant_id');
            $products = Product::query()->whereIn('id', $variants->pluck('product_id')->unique())->get()->keyBy('id');
            $categories = ProductCategory::query()->whereIn('product_id', $products->keys())->get()->groupBy('product_id');
            foreach ($variants as $variant) {
                $product = $products[$variant->product_id];
                $out[$variant->id] = [
                    'price_amount' => $variant->price_amount,
                    'compare_at_amount' => $variant->compare_at_amount,
                    'cost_amount' => $variant->cost_amount,
                    'barcode' => $variant->barcode,
                    'weight_grams' => $variant->weight_grams,
                    'on_hand' => (int) ($stock[$variant->id] ?? 0),
                    'product' => [
                        'name' => $product->name,
                        'status' => $product->status,
                        'seo_title' => $product->seo_title,
                        'seo_description' => $product->seo_description,
                        'description' => $product->description,
                        'tags' => $product->tags ?? [],
                        'category_ids' => $categories->get($product->id)?->pluck('category_id')->all() ?? [],
                    ],
                ];
            }
        }

        return $out;
    }

    /** @param array<string, mixed> $row */
    private function warn(array &$row, ?string $field, string $message): void
    {
        $row['messages'][] = ['level' => 'warning', 'field' => $field, 'message' => $message];
        if ($row['status'] === 'ready') {
            $row['status'] = 'warning';
        }
    }

    /** @param array<string, mixed> $row */
    private function error(array &$row, ?string $field, string $message): void
    {
        $row['messages'][] = ['level' => 'error', 'field' => $field, 'message' => $message];
        $row['status'] = 'error';
    }
}

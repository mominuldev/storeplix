<?php

namespace App\Domain\Catalog;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Pages\RichTextValidator;
use App\Domain\Stores\Models\Store;
use Illuminate\Validation\ValidationException;

/**
 * Cross-field product rules (§3.2) on top of ProductRequest. Produces a normalised plan for ProductService:
 *
 * [fields => [...present scalar fields], options => list|null, variants => list|null, images => list|null,
 *  category_ids => list|null]. null = "not sent, keep".
 */
final class ProductPayloadValidator
{
    /** @var array<string, list<string>> */
    private array $errors = [];

    /**
     * @param  array<string, mixed>  $input  validated ProductRequest input
     * @return array<string, mixed>
     *
     * @throws ValidationException
     */
    public static function normalise(Store $store, ?Product $product, array $input, bool $costs): array
    {
        $v = new self;
        $plan = $v->run($store, $product, $input, $costs);
        if ($v->errors !== []) {
            throw ValidationException::withMessages($v->errors);
        }

        return $plan;
    }

    /** @return array<string, mixed> */
    private function run(Store $store, ?Product $product, array $input, bool $costs): array
    {
        $fields = [];
        foreach (['name', 'slug', 'status'] as $key) {
            if (array_key_exists($key, $input)) {
                $fields[$key] = $input[$key];
            }
        }
        if (array_key_exists('description', $input)) {
            if ($input['description'] !== null) {
                foreach (RichTextValidator::validate($input['description'], 'description', Product::DESCRIPTION_MAX_BYTES) as $path => $messages) {
                    $this->errors[$path] = $messages;
                }
            }
            $fields['description'] = $input['description'];
        }
        if (array_key_exists('tags', $input)) {
            $fields['tags'] = array_values(array_unique(array_filter(array_map(fn ($t) => mb_strtolower(trim((string) $t)), $input['tags']), fn ($t) => $t !== '')));
        }
        if (isset($input['seo']) && is_array($input['seo'])) {
            if (array_key_exists('title', $input['seo'])) {
                $fields['seo_title'] = $input['seo']['title'];
            }
            if (array_key_exists('description', $input['seo'])) {
                $fields['seo_description'] = $input['seo']['description'];
            }
        }

        $options = array_key_exists('options', $input) ? $this->options($input['options']) : null;
        $current = $product?->options ?? [];
        $effective = $options ?? $current;

        if ($product !== null && $options !== null && $options !== $current && ! array_key_exists('variants', $input)) {
            $this->errors['variants'][] = 'Send the variants when the options change.';
        }

        $images = null;
        if (array_key_exists('images', $input)) {
            $images = array_map(fn (array $img, int $i) => [
                'media_id' => strtolower($img['media_id']),
                'alt' => isset($img['alt']) && trim((string) $img['alt']) !== '' ? trim((string) $img['alt']) : null,
                'position' => $i,
            ], array_values($input['images']), array_keys(array_values($input['images'])));
        }
        $imageIds = $images !== null
            ? array_column($images, 'media_id')
            : ($product ? ProductImage::query()->where('product_id', $product->id)->pluck('media_id')->all() : []);

        $variants = array_key_exists('variants', $input)
            ? $this->variants($store, $product, array_values($input['variants']), $effective, $imageIds, $costs)
            : null;

        return [
            'fields' => $fields,
            'options' => $options,
            'variants' => $variants,
            'images' => $images,
            'category_ids' => array_key_exists('category_ids', $input) ? array_values(array_map('strtolower', $input['category_ids'])) : null,
        ];
    }

    /**
     * @param  list<array{name: string, values: list<string>}>  $options
     * @return list<array{name: string, values: list<string>}>
     */
    private function options(array $options): array
    {
        $out = [];
        $names = [];
        foreach (array_values($options) as $i => $option) {
            $name = trim((string) $option['name']);
            if (isset($names[mb_strtolower($name)])) {
                $this->errors["options.{$i}.name"][] = 'Option names must be different.';
            }
            $names[mb_strtolower($name)] = true;
            $values = [];
            $seen = [];
            foreach (array_values($option['values']) as $j => $value) {
                $value = trim((string) $value);
                if ($value === '') {
                    $this->errors["options.{$i}.values.{$j}"][] = 'Enter a value.';

                    continue;
                }
                if (isset($seen[mb_strtolower($value)])) {
                    $this->errors["options.{$i}.values.{$j}"][] = 'This value is listed twice.';

                    continue;
                }
                $seen[mb_strtolower($value)] = true;
                $values[] = $value;
            }
            $out[] = ['name' => $name, 'values' => $values];
        }

        return $out;
    }

    /**
     * @param  list<array<string, mixed>>  $variants
     * @param  list<array{name: string, values: list<string>}>  $options
     * @param  list<string>  $imageIds
     * @return list<array<string, mixed>>
     */
    private function variants(Store $store, ?Product $product, array $variants, array $options, array $imageIds, bool $costs): array
    {
        if ($options === [] && count($variants) !== 1) {
            $this->errors['variants'][] = 'A product without options has exactly one variant.';
        }

        $existing = $product
            ? ProductVariant::query()->where('product_id', $product->id)->pluck('id')->flip()->all()
            : [];

        $out = [];
        $combos = [];
        $skus = [];
        $ids = [];
        foreach ($variants as $i => $variant) {
            $id = isset($variant['id']) && $variant['id'] !== null ? strtolower((string) $variant['id']) : null;
            if ($id !== null) {
                if (! isset($existing[$id]) || isset($ids[$id])) {
                    $this->errors["variants.{$i}.id"][] = 'Unknown variant.';
                    $id = null;
                } else {
                    $ids[$id] = true;
                }
            }

            $given = array_values($variant['option_values'] ?? []);
            $values = [];
            if (count($given) !== count($options)) {
                $this->errors["variants.{$i}.option_values"][] = $options === []
                    ? 'A product without options has no option values.'
                    : 'Pick a value for every option.';
            } else {
                foreach ($given as $k => $value) {
                    $match = null;
                    foreach ($options[$k]['values'] as $allowed) {
                        if (mb_strtolower($allowed) === mb_strtolower(trim((string) $value))) {
                            $match = $allowed;
                        }
                    }
                    if ($match === null) {
                        $this->errors["variants.{$i}.option_values.{$k}"][] = "This value isn't one of the option's values.";
                    }
                    $values[] = $match ?? '';
                }
                $combo = mb_strtolower(implode("\x1F", $values));
                if (isset($combos[$combo])) {
                    $this->errors["variants.{$i}.option_values"][] = 'This combination already exists.';
                }
                $combos[$combo] = true;
            }

            $sku = $variant['sku'] ?? null;
            if ($sku !== null) {
                $lower = strtolower($sku);
                if (isset($skus[$lower])) {
                    $this->errors["variants.{$i}.sku"][] = 'This SKU is used twice in this product.';
                }
                $skus[$lower] ??= $i;
            }

            $price = $variant['price_amount'];
            if (isset($variant['compare_at_amount']) && $variant['compare_at_amount'] <= $price) {
                $this->errors["variants.{$i}.compare_at_amount"][] = 'Compare-at price must be higher than the price.';
            }

            $image = $variant['image_media_id'] ?? null;
            if ($image !== null && ! in_array(strtolower($image), $imageIds, true)) {
                $this->errors["variants.{$i}.image_media_id"][] = "Pick one of this product's photos.";
            }

            if ($id !== null && array_key_exists('initial_on_hand', $variant)) {
                $this->errors["variants.{$i}.initial_on_hand"][] = 'Change stock from Inventory.';
            }

            $item = [
                'id' => $id,
                'option_values' => $values,
                'sku' => $sku,
                'price_amount' => $price,
                'position' => $i,
            ];
            foreach (['barcode', 'compare_at_amount', 'weight_grams', 'is_enabled', 'track_inventory', 'allow_backorder', 'low_stock_threshold'] as $key) {
                if (array_key_exists($key, $variant)) {
                    $item[$key] = $variant[$key];
                }
            }
            if (array_key_exists('image_media_id', $variant)) {
                $item['image_media_id'] = $image !== null ? strtolower($image) : null;
            }
            if ($costs && array_key_exists('cost_amount', $variant)) {
                $item['cost_amount'] = $variant['cost_amount']; // P4-5: ignored for staff
            }
            if ($id === null) {
                $item['initial_on_hand'] = (int) ($variant['initial_on_hand'] ?? 0);
            }
            $out[] = $item;
        }

        if ($skus !== []) {
            foreach (self::takenSkus($store, array_keys($skus), $product?->id) as $taken) {
                $i = $skus[strtolower($taken)] ?? null;
                if ($i !== null) {
                    $this->errors["variants.{$i}.sku"][] = 'This SKU is already used by another product.';
                }
            }
        }

        return $out;
    }

    /**
     * SKUs (lowercased input) already used by non-deleted variants of OTHER products in this store.
     *
     * @param  list<string>  $lowerSkus
     * @return list<string>
     */
    public static function takenSkus(Store $store, array $lowerSkus, ?string $exceptProductId): array
    {
        $taken = [];
        foreach (array_chunk($lowerSkus, 500) as $chunk) {
            $placeholders = implode(',', array_fill(0, count($chunk), '?'));
            $taken = array_merge($taken, ProductVariant::query()->where('store_id', $store->id)
                ->when($exceptProductId, fn ($q) => $q->where('product_id', '!=', $exceptProductId))
                ->whereNotNull('sku')
                ->whereRaw("lower(sku) in ({$placeholders})", $chunk)
                ->pluck('sku')->map(fn ($s) => strtolower($s))->all());
        }

        return array_values(array_unique($taken));
    }
}

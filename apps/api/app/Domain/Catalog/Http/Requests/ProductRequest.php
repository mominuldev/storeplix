<?php

namespace App\Domain\Catalog\Http\Requests;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Media\Models\Media;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * CreateProductInput / UpdateProductInput envelope (§3.2). Cross-field rules (options ↔ variants, SKU uniqueness,
 * variant ids, variant images) live in ProductPayloadValidator. Unknown keys are ignored: the service maps fields
 * explicitly, so tenant_id, store_id, price_*_amount, published_at, on_hand, committed … never reach a model.
 */
class ProductRequest extends FormRequest
{
    public function authorize(): bool
    {
        /** @var Store $store */
        $store = $this->route('store');

        return $this->user()->can('view', $store);
    }

    public function isCreate(): bool
    {
        return $this->isMethod('POST');
    }

    protected function prepareForValidation(): void
    {
        $in = $this->all();
        foreach (['name', 'slug'] as $key) {
            if (isset($in[$key]) && is_string($in[$key])) {
                $in[$key] = trim($in[$key]);
            }
        }
        if (array_key_exists('slug', $in) && $in['slug'] === '') {
            $in['slug'] = null;
        }
        if (isset($in['tags']) && is_array($in['tags'])) {
            $in['tags'] = array_map(fn ($t) => is_string($t) ? mb_strtolower(trim($t)) : $t, $in['tags']);
        }
        if (isset($in['variants']) && is_array($in['variants'])) {
            foreach ($in['variants'] as $i => $variant) {
                foreach (['sku', 'barcode'] as $key) {
                    if (is_array($variant) && isset($variant[$key]) && is_string($variant[$key])) {
                        $value = trim($variant[$key]);
                        $in['variants'][$i][$key] = $value === '' ? null : $value;
                    }
                }
            }
        }
        foreach (['title', 'description'] as $key) {
            if (isset($in['seo'][$key]) && is_string($in['seo'][$key])) {
                $in['seo'][$key] = trim($in['seo'][$key]) === '' ? null : trim($in['seo'][$key]);
            }
        }
        $this->replace($in);
    }

    public function rules(): array
    {
        $tenantId = app(TenantContext::class)->requireId();
        /** @var Store $store */
        $store = $this->route('store');
        $noControl = 'regex:/^[^\x00-\x1F\x7F]*$/u';
        $amount = ['integer:strict', 'min:0', 'max:'.Product::MAX_AMOUNT];

        return [
            'name' => [$this->isCreate() ? 'required' : 'sometimes', 'string', 'min:1', 'max:200', $noControl],
            'slug' => ['sometimes', 'nullable', 'string', 'max:220', 'regex:'.Product::SLUG_PATTERN],
            'status' => ['sometimes', 'string', Rule::in(Product::STATUSES)],
            'description' => ['sometimes', 'nullable', 'array'],
            'tags' => ['sometimes', 'array', 'max:'.Product::MAX_TAGS],
            'tags.*' => ['string', 'min:1', 'max:40', $noControl],
            'category_ids' => ['sometimes', 'array', 'max:'.Product::MAX_CATEGORIES],
            'category_ids.*' => ['string', 'distinct', Rule::exists('categories', 'id')
                ->where('tenant_id', $tenantId)->where('store_id', $store->id)->whereNull('deleted_at')],
            'options' => ['sometimes', 'array', 'max:'.Product::MAX_OPTIONS],
            'options.*' => ['array:name,values'],
            'options.*.name' => ['required', 'string', 'min:1', 'max:40', $noControl],
            'options.*.values' => ['required', 'array', 'min:1', 'max:'.Product::MAX_OPTION_VALUES],
            'options.*.values.*' => ['string', 'min:1', 'max:40', $noControl],
            'variants' => [$this->isCreate() ? 'required' : 'sometimes', 'array', 'min:1', 'max:'.Product::MAX_VARIANTS],
            'variants.*' => ['array'],
            'variants.*.id' => [$this->isCreate() ? 'prohibited' : 'sometimes', 'nullable', 'string', 'size:26'],
            'variants.*.option_values' => ['sometimes', 'array', 'max:'.Product::MAX_OPTIONS],
            'variants.*.option_values.*' => ['string', 'max:40'],
            'variants.*.sku' => ['sometimes', 'nullable', 'string', 'max:64', 'regex:'.ProductVariant::SKU_PATTERN],
            'variants.*.barcode' => ['sometimes', 'nullable', 'string', 'max:64', 'regex:'.ProductVariant::BARCODE_PATTERN],
            'variants.*.price_amount' => ['required', ...$amount],
            'variants.*.compare_at_amount' => ['sometimes', 'nullable', ...$amount],
            'variants.*.cost_amount' => ['sometimes', 'nullable', ...$amount],
            'variants.*.weight_grams' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:1000000'],
            'variants.*.is_enabled' => ['sometimes', 'boolean:strict'],
            'variants.*.track_inventory' => ['sometimes', 'boolean:strict'],
            'variants.*.allow_backorder' => ['sometimes', 'boolean:strict'],
            'variants.*.image_media_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'variants.*.initial_on_hand' => ['sometimes', 'integer:strict', 'min:0', 'max:1000000'],
            'variants.*.low_stock_threshold' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:100000'],
            'images' => ['sometimes', 'array', 'max:'.Product::MAX_IMAGES],
            'images.*' => ['array'],
            'images.*.media_id' => ['required', 'string', 'distinct', Rule::exists('media', 'id')
                ->where('tenant_id', $tenantId)->where('purpose', 'product_image')->whereNot('status', Media::FAILED)],
            'images.*.alt' => ['sometimes', 'nullable', 'string', 'max:160', $noControl],
            'seo' => ['sometimes', 'array'],
            'seo.title' => ['sometimes', 'nullable', 'string', 'max:70', $noControl],
            'seo.description' => ['sometimes', 'nullable', 'string', 'max:160', $noControl],
            'revision' => $this->isCreate() ? ['exclude'] : ['required', 'integer'],
        ];
    }

    /**
     * Validated input with `description` taken from the raw JSON (TrimStrings would eat spaces between marks).
     *
     * @return array<string, mixed>
     */
    public function productInput(): array
    {
        $validated = $this->validated();
        if (array_key_exists('description', $validated)) {
            $raw = json_decode((string) $this->getContent(), true, 64);
            if (is_array($raw) && array_key_exists('description', $raw)) {
                $validated['description'] = $raw['description'];
            }
        }

        return $validated;
    }

    public function messages(): array
    {
        return [
            'slug.regex' => 'Use lowercase letters, numbers and single hyphens.',
            'category_ids.*.exists' => 'Unknown category.',
            'category_ids.*.distinct' => 'This category is listed twice.',
            'images.*.media_id.exists' => 'Unknown image.',
            'images.*.media_id.distinct' => 'This image is listed twice.',
            'variants.*.sku.regex' => 'Use letters, numbers, dots, dashes, slashes or underscores (max 64).',
            'variants.*.barcode.regex' => 'Use letters, numbers or dashes (max 64).',
            'variants.*.price_amount.integer' => 'Enter the amount in paisa as a whole number.',
            'variants.*.compare_at_amount.integer' => 'Enter the amount in paisa as a whole number.',
            'variants.*.cost_amount.integer' => 'Enter the amount in paisa as a whole number.',
            'variants.*.id.prohibited' => 'Unknown variant.',
        ];
    }
}

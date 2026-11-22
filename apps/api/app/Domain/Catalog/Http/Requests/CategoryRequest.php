<?php

namespace App\Domain\Catalog\Http\Requests;

use App\Domain\Catalog\Models\Category;
use App\Domain\Media\Models\Media;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** CreateCategoryInput / UpdateCategoryInput (§3.1). */
class CategoryRequest extends FormRequest
{
    public function authorize(): bool
    {
        /** @var Store $store */
        $store = $this->route('store');

        return $this->user()->can('view', $store);
    }

    protected function prepareForValidation(): void
    {
        $in = $this->all();
        foreach (['name', 'slug'] as $key) {
            if (isset($in[$key]) && is_string($in[$key])) {
                $in[$key] = trim($in[$key]);
            }
        }
        if (isset($in['description']) && is_string($in['description'])) {
            $in['description'] = trim($in['description']) === '' ? null : trim($in['description']);
        }
        if (array_key_exists('slug', $in) && $in['slug'] === '') {
            $in['slug'] = null;
        }
        $this->replace($in);
    }

    public function rules(): array
    {
        $create = $this->isMethod('POST');
        /** @var Store $store */
        $store = $this->route('store');

        return [
            'name' => [$create ? 'required' : 'sometimes', 'string', 'min:1', 'max:120', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'slug' => ['sometimes', 'nullable', 'string', 'max:140', 'regex:'.Category::SLUG_PATTERN],
            'parent_id' => ['sometimes', 'nullable', 'string', Rule::exists('categories', 'id')
                ->where('tenant_id', app(TenantContext::class)->requireId())->where('store_id', $store->id)->whereNull('deleted_at')],
            'description' => ['sometimes', 'nullable', 'string', 'max:500', 'regex:/^[^\x00-\x09\x0B-\x1F\x7F]*$/u'],
            'image_media_id' => ['sometimes', 'nullable', 'string', Rule::exists('media', 'id')
                ->where('tenant_id', app(TenantContext::class)->requireId())
                ->whereIn('purpose', ['product_image', 'page_image'])->whereNot('status', Media::FAILED)],
            'is_visible' => ['sometimes', 'boolean:strict'],
        ];
    }

    public function messages(): array
    {
        return [
            'slug.regex' => 'Use lowercase letters, numbers and single hyphens.',
            'parent_id.exists' => 'Unknown category.',
            'image_media_id.exists' => 'Unknown image.',
            'name.regex' => 'Remove control characters.',
            'description.regex' => 'Remove control characters.',
        ];
    }
}

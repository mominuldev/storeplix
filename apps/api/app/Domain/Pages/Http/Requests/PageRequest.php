<?php

namespace App\Domain\Pages\Http\Requests;

use App\Domain\Media\Models\Media;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Pages\PageTemplates;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** CreatePageInput / UpdatePageInput envelope (PHASE-3-CONTRACT §3.2). Body blocks: PageBodyValidator. */
class PageRequest extends FormRequest
{
    public function authorize(): bool
    {
        /** @var Store $store */
        $store = $this->route('store');

        return $this->user()->can('update', $store);
    }

    public function isCreate(): bool
    {
        return $this->isMethod('POST');
    }

    protected function prepareForValidation(): void
    {
        $in = $this->all();
        foreach (['title', 'slug'] as $key) {
            if (isset($in[$key]) && is_string($in[$key])) {
                $in[$key] = trim($in[$key]);
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
        $noControl = 'regex:/^[^\x00-\x1F\x7F]*$/';

        $rules = [
            'title' => [$this->isCreate() ? 'required_without:template' : 'sometimes', 'string', 'min:1', 'max:120', $noControl],
            'slug' => ['sometimes', 'string', 'max:80', 'regex:'.StorePage::SLUG_PATTERN, Rule::notIn(StorePage::RESERVED_SLUGS)],
            'status' => ['sometimes', 'string', Rule::in(StorePage::STATUSES)],
            'body' => ['sometimes', 'array'],
            'seo' => ['sometimes', 'array:title,description,share_image_media_id'],
            'seo.title' => ['sometimes', 'nullable', 'string', 'max:70', $noControl],
            'seo.description' => ['sometimes', 'nullable', 'string', 'max:160', $noControl],
            'seo.share_image_media_id' => ['sometimes', 'nullable', 'string', 'ulid', Rule::exists('media', 'id')
                ->where('tenant_id', $tenantId)->where('purpose', 'page_image')->whereNot('status', Media::FAILED)],
        ];

        if ($this->isCreate()) {
            $rules['template'] = ['sometimes', 'string', Rule::in(PageTemplates::CODES)];
            $rules['add_to_menu'] = ['sometimes', 'nullable', 'string', 'in:main,footer,help'];
        } else {
            $rules['revision'] = ['required', 'integer'];
            $rules['template'] = ['prohibited'];
            $rules['add_to_menu'] = ['prohibited'];
        }

        return $rules;
    }

    /**
     * Validated input, with `body` taken from the raw JSON: the global TrimStrings middleware would otherwise eat
     * meaningful spaces between rich-text marks ("Bold " + "text"). PageBodyValidator trims plain-text fields itself.
     *
     * @return array<string, mixed>
     */
    public function pageInput(): array
    {
        $validated = $this->validated();
        if (array_key_exists('body', $validated)) {
            $raw = json_decode((string) $this->getContent(), true, 64);
            if (is_array($raw) && array_key_exists('body', $raw)) {
                $validated['body'] = $raw['body'];
            }
        }

        return $validated;
    }

    public function messages(): array
    {
        return [
            'slug.not_in' => 'This link is reserved. Choose another one.',
            'slug.regex' => 'Use lowercase letters, numbers and single hyphens.',
            'seo.share_image_media_id.exists' => 'Unknown image.',
        ];
    }
}

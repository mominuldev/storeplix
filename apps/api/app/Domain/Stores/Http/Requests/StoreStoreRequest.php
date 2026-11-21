<?php

namespace App\Domain\Stores\Http\Requests;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StoreLimitReachedException;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreStoreRequest extends FormRequest
{
    public function authorize(): bool
    {
        if (! ($this->user()?->can('create', Store::class) ?? false)) {
            return false;
        }

        // D1: one store per tenant. Checked before validation so the client gets 409, not a slug error.
        // (Tenant-scoped query; the DB unique constraint in StoreProvisioner covers races.)
        if (Store::query()->exists()) {
            throw new StoreLimitReachedException;
        }

        return true;
    }

    protected function prepareForValidation(): void
    {
        $this->merge(array_filter([
            'name' => is_string($this->input('name')) ? trim($this->input('name')) : $this->input('name'),
            'slug' => is_string($this->input('slug')) ? strtolower(trim($this->input('slug'))) : $this->input('slug'),
            'country' => is_string($this->input('country')) ? strtoupper(trim($this->input('country'))) : $this->input('country'),
            'currency' => is_string($this->input('currency')) ? strtoupper(trim($this->input('currency'))) : $this->input('currency'),
        ], fn ($v) => $v !== null));
    }

    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'min:2', 'max:80'],
            'name_bn' => ['sometimes', 'nullable', 'string', 'max:80'],
            'slug' => [
                'required', 'string', 'min:3', 'max:63',
                'regex:/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/',
                Rule::notIn(config('storeplix.reserved_slugs')),
                Rule::unique('stores', 'slug'),
            ],
            'business_categories' => ['sometimes', 'array', 'max:6'],
            'business_categories.*' => ['string', 'distinct', Rule::in(config('storeplix.business_categories'))],
            'country' => ['sometimes', 'string', 'regex:/^[A-Z]{2}$/'],
            'currency' => ['sometimes', 'string', 'in:BDT,USD'],
            'timezone' => ['sometimes', 'string', 'timezone:all'],
        ];
    }

    public function messages(): array
    {
        return [
            'slug.regex' => 'The slug may only contain lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.',
            'slug.not_in' => 'This slug is reserved.',
            'slug.unique' => 'This slug is already taken.',
        ];
    }
}

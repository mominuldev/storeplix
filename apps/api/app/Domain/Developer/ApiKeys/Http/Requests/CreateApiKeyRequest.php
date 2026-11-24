<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys\Http\Requests;

use App\Domain\Developer\ApiKeys\ApiScope;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** PHASE-8-4 §6.1 POST /api-keys `{name, scopes[], include_costs?}`. Authorization: route `perm:developers.manage`. */
class CreateApiKeyRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('name'))) {
            $this->merge(['name' => trim((string) $this->input('name'))]);
        }
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'name' => self::nameRules(),
            'scopes' => ['required', 'array', 'min:1', 'max:'.count(ApiScope::cases())],
            'scopes.*' => ['required', 'string', 'distinct', Rule::in(ApiScope::values())],
            'include_costs' => ['sometimes', 'boolean'],
        ];
    }

    /** @return list<string> */
    public static function nameRules(): array
    {
        return ['required', 'string', 'min:1', 'max:'.ApiKey::MAX_NAME, 'regex:/^[^\x00-\x1F\x7F]*$/u'];
    }
}

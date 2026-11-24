<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** PHASE-8-4 §6.1 PATCH /api-keys/{key}: rename only `{name}`. Authorization: route `perm:developers.manage`. */
class RenameApiKeyRequest extends FormRequest
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
        return ['name' => CreateApiKeyRequest::nameRules()];
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** PUT /stores/{store}/sms/templates/{key}/{language} (PHASE-8-9A §7.2); the body rules run in SmsTemplateCatalog. */
class SmsTemplateUpdateRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // perm:settings.manage on the route
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'body' => ['required', 'string', 'max:2000'],
            'revision' => ['sometimes', 'nullable', 'integer', 'min:0'],
        ];
    }
}

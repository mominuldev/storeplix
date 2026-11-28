<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** POST /stores/{store}/sms/test (PHASE-8-9A §6.2). Only `language`; a recipient is never accepted (S218). */
class SmsTestRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // perm:settings.manage|integrations.manage on the route
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['language' => ['sometimes', 'nullable', 'string', Rule::in(['bn', 'en'])]];
    }
}

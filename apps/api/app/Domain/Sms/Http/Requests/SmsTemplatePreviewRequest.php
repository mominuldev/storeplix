<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Requests;

use App\Domain\Sms\Templates\SmsTemplateCatalog;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** POST /stores/{store}/sms/templates/preview (PHASE-8-9A §7.3); the body rules run in SmsTemplateCatalog. */
class SmsTemplatePreviewRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // perm:settings.manage on the route
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'key' => ['required', 'string', Rule::in(SmsTemplateCatalog::KEYS)],
            'language' => ['required', 'string', Rule::in(['bn', 'en'])],
            'body' => ['required', 'string', 'max:2000'],
        ];
    }
}

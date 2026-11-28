<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** UpdateSmsCreditSettingsInput (P89A-12): `low_credit_threshold` 100 | 200 | 500 | null (key required). */
class SmsCreditSettingsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['low_credit_threshold' => ['present', 'nullable', 'integer', 'in:'.implode(',', (array) config('sms.low_credit_thresholds', [100, 200, 500]))]];
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/** UpdateCourierInput { revision, settings?, is_default? } (PHASE-5B §4.6). */
final class UpdateCourierRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'revision' => ['required', 'integer:strict', 'min:1'],
            'is_default' => ['sometimes', 'boolean:strict'],
        ] + CourierSettingsRules::rules((string) $this->route('provider'));
    }

    public function after(): array
    {
        return [fn (Validator $v) => CourierSettingsRules::checkPickupLocation($v, $this)];
    }

    /** @return array<string, string> */
    public function messages(): array
    {
        return CourierSettingsRules::messages();
    }

    /** @return array<string, mixed> */
    public function settings(): array
    {
        return (array) ($this->validated('settings') ?? []);
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Http\Requests;

use App\Domain\Couriers\Drivers\CourierArea;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** `?level=city|zone|area&parent_id=&district_code=&thana_code=` (PHASE-5B §4.6 areas). */
final class CourierAreasRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'level' => ['required', 'string', Rule::in(CourierArea::LEVELS)],
            'parent_id' => ['sometimes', 'nullable', 'string', 'max:32', 'regex:/^[A-Za-z0-9_-]+$/'],
            'district_code' => ['sometimes', 'nullable', 'string', 'max:32'],
            'thana_code' => ['sometimes', 'nullable', 'string', 'max:48'],
        ];
    }
}

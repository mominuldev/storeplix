<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics\Http\Requests;

use App\Domain\Admin\Analytics\AnalyticsWindow;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** PHASE-8-2 §6 / P82-17 query parameters (S86: enums and dates only; the window checks caps and the 731-day limit). */
class AnalyticsQueryRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // platform.can:view_analytics on the route
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'range' => ['sometimes', 'string', Rule::in(AnalyticsWindow::RANGES)],
            'from' => ['required_if:range,custom', 'nullable', 'date_format:Y-m-d', 'after_or_equal:'.AnalyticsWindow::MIN_FROM],
            'to' => ['required_if:range,custom', 'nullable', 'date_format:Y-m-d'],
            'granularity' => ['sometimes', 'string', Rule::in(AnalyticsWindow::GRANULARITIES)],
        ];
    }

    /** @return array{range?: string, from?: string|null, to?: string|null, granularity?: string} */
    public function window(): array
    {
        /** @var array{range?: string, from?: string|null, to?: string|null, granularity?: string} */
        return $this->validated();
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Http\Requests;

use App\Domain\Admin\Impersonation\Models\PlatformImpersonation;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** GET /admin/impersonations `filter[status|staff|tenant]`, `page`, `per_page` ≤ 100 (PHASE-8-1 §6.5). */
class ListImpersonationsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'filter' => ['sometimes', 'array'],
            'filter.status' => ['sometimes', 'string', Rule::in(PlatformImpersonation::STATUSES)],
            'filter.staff' => ['sometimes', 'string', 'ulid'],
            'filter.tenant' => ['sometimes', 'string', 'ulid'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ];
    }
}

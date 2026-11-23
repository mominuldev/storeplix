<?php

declare(strict_types=1);

namespace App\Domain\Reports\Http\Requests;

use App\Domain\Reports\ReportRange;
use Illuminate\Foundation\Http\FormRequest;

/** ReportRangeQuery { from?, to? } — store-local YYYY-MM-DD (PHASE-7-CONTRACT §6.3). Span/clip rules: ReportRange. */
final class ReportRangeRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'from' => ['sometimes', 'nullable', 'string', 'date_format:Y-m-d', 'after_or_equal:'.ReportRange::MIN_DATE],
            'to' => ['sometimes', 'nullable', 'string', 'date_format:Y-m-d', 'after_or_equal:'.ReportRange::MIN_DATE],
        ];
    }
}

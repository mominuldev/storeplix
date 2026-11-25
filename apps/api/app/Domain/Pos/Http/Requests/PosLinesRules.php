<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

/** PosLineInput[] rules shared by quote and sale (§5, P88D: 1–50 lines, quantity 1–999). */
final class PosLinesRules
{
    public const LINES_MAX = 50;

    public const QUANTITY_MAX = 999;

    /** @return array<string, list<string>> */
    public static function rules(): array
    {
        return [
            'session_id' => ['required', 'string', 'size:26'],
            'lines' => ['required', 'array', 'list', 'min:1', 'max:'.self::LINES_MAX],
            'lines.*' => ['array:variant_id,quantity'],
            'lines.*.variant_id' => ['required', 'string', 'size:26'],
            'lines.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:'.self::QUANTITY_MAX],
            'coupon_code' => ['sometimes', 'nullable', 'string', 'max:32'],
        ];
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * POST …/pos/registers/{register}/open (OpenPosSessionInput, §4): `counts` (denomination → count) or one
 * `opening_cash_amount`; counts win when both are sent. Plan `pos` (402 before validation). Count keys are checked
 * against the store currency's denominations by PosMoney.
 */
class OpenPosSessionRequest extends FormRequest
{
    public function authorize(): bool
    {
        PosPlanGate::assert();

        return true;
    }

    public function rules(): array
    {
        return [
            'counts' => ['sometimes', 'array', 'max:20'],
            // P88DA-QA-1: only a MISSING `counts` key needs the amount; `counts: {}` (all zero) = ৳ 0.
            'opening_cash_amount' => [Rule::requiredIf(! $this->has('counts')), 'integer:strict', 'min:0', 'max:'.(int) config('pos.max_cash_amount')],
            'note' => ['sometimes', 'nullable', 'string', 'max:300', 'regex:/^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/u'],
        ];
    }
}

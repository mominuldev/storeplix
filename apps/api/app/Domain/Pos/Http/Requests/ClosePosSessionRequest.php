<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * POST …/pos/sessions/{session}/close (ClosePosSessionInput, §4). No plan check: an open register can always be
 * closed, also after a downgrade (P88D-19, S197). `left_in_drawer_amount` ≤ counted is checked by PosMoney::close.
 */
class ClosePosSessionRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'counts' => ['sometimes', 'array', 'max:20'],
            // P88DA-QA-1: only a MISSING `counts` key needs the amount; `counts: {}` (all zero) = ৳ 0.
            'counted_cash_amount' => [Rule::requiredIf(! $this->has('counts')), 'integer:strict', 'min:0', 'max:'.(int) config('pos.max_cash_amount')],
            'left_in_drawer_amount' => ['required', 'integer:strict', 'min:0', 'max:'.(int) config('pos.max_cash_amount')],
            'note' => ['sometimes', 'nullable', 'string', 'max:300', 'regex:/^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/u'],
            'revision' => ['required', 'integer:strict', 'min:1'],
        ];
    }
}

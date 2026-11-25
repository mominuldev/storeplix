<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

use App\Domain\Shared\Support\PhoneRule;
use Illuminate\Foundation\Http\FormRequest;

/** POST …/pos/quote (PosQuoteInput, §5.1). Plan `pos` (402 before validation). */
class PosQuoteRequest extends FormRequest
{
    public function authorize(): bool
    {
        PosPlanGate::assert();

        return true;
    }

    public function rules(): array
    {
        return PosLinesRules::rules() + [
            'customer_phone' => ['sometimes', 'nullable', 'string', PhoneRule::bdMobile()],
        ];
    }
}

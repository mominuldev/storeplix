<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

use App\Domain\Pos\Models\PosHeldSale;
use App\Domain\Shared\Support\PhoneRule;
use Illuminate\Foundation\Http\FormRequest;

/** POST …/pos/held-sales (PosHeldSaleInput, §9). Plan `pos` (402 before validation). */
class PosHeldSaleRequest extends FormRequest
{
    public function authorize(): bool
    {
        PosPlanGate::assert();

        return true;
    }

    public function rules(): array
    {
        return PosLinesRules::rules() + [
            'customer_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'customer' => ['sometimes', 'nullable', 'array:phone,name', 'prohibits:customer_id'],
            'customer.phone' => ['required_with:customer', 'string', PhoneRule::bdMobile()],
            'customer.name' => ['sometimes', 'nullable', 'string', 'max:120', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'note' => ['sometimes', 'nullable', 'string', 'max:'.PosHeldSale::NOTE_MAX, 'regex:/^[^\x00-\x1F\x7F]*$/u'],
        ];
    }
}

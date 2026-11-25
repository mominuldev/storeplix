<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

use App\Domain\Shared\Support\PhoneRule;
use Illuminate\Foundation\Http\FormRequest;

/**
 * POST …/pos/sales (PosSaleInput, §5.2). Plan `pos` (402 before validation). Prices, the total, the cashier and the
 * register never come from the body (S198, S202): only variant ids, quantities, coupon code and the expected total.
 */
class PosSaleRequest extends FormRequest
{
    public const PAYMENTS_MAX = 4;

    public function authorize(): bool
    {
        PosPlanGate::assert();

        return true;
    }

    public function rules(): array
    {
        $text = 'regex:/^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/u';

        return PosLinesRules::rules() + [
            'customer_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'customer' => ['sometimes', 'nullable', 'array:phone,name', 'prohibits:customer_id'],
            'customer.phone' => ['required_with:customer', 'string', PhoneRule::bdMobile()],
            'customer.name' => ['sometimes', 'nullable', 'string', 'max:120', 'regex:/^[^\x00-\x1F\x7F]*$/u'],
            'expected_total_amount' => ['required', 'integer:strict', 'min:0'],
            'payments' => ['required', 'array', 'list', 'min:1', 'max:'.self::PAYMENTS_MAX],
            'payments.*' => ['array:method,amount,reference'],
            'payments.*.method' => ['required', 'string', 'in:cash,bkash_personal,card'],
            'payments.*.amount' => ['required', 'integer:strict', 'min:1'],
            'payments.*.reference' => ['sometimes', 'nullable', 'string', 'max:32', $text],
            'tendered_cash_amount' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:'.(int) config('pos.max_cash_amount')],
            'sms_receipt' => ['required', 'boolean:strict'],
            'held_sale_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'note' => ['sometimes', 'nullable', 'string', 'max:500', $text],
        ];
    }
}

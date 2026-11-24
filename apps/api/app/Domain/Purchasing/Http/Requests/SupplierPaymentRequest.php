<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Requests;

use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/** POST /stores/{store}/suppliers/{supplier}/payments (PHASE-8-8B §6.2, §8.3). `paid_on` 2020-01-01 … today (store tz). */
class SupplierPaymentRequest extends PurchasingWriteRequest
{
    public function rules(): array
    {
        return [
            'amount' => ['required', 'integer:strict', 'min:1', 'max:'.SupplierPayment::MAX_AMOUNT],
            'method' => ['required', 'string', Rule::in(SupplierPayment::METHODS)],
            'paid_on' => ['required', ...self::paidOnRules($this)],
            'purchase_order_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'reference' => ['sometimes', ...self::line(60)],
            'note' => ['sometimes', ...self::line(200)],
            'currency' => ['sometimes', 'string', 'size:3'],
        ];
    }

    /** @return list<string> */
    public static function paidOnRules(Request $request): array
    {
        $store = $request->route('store');
        $tz = $store instanceof Store ? ($store->timezone ?: 'Asia/Dhaka') : 'Asia/Dhaka';

        return ['date_format:Y-m-d', 'after_or_equal:'.self::DATE_MIN, 'before_or_equal:'.CarbonImmutable::now($tz)->format('Y-m-d')];
    }
}

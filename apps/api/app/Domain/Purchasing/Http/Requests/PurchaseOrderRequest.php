<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Requests;

use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonImmutable;

/**
 * POST /purchase-orders (create) and PATCH /purchase-orders/{po} (partial + required `revision`) — PHASE-8-8B §5.1,
 * §8.3. Client totals and currency are never read (S173). `expected_on`: 2020-01-01 … one year from today (store tz).
 */
class PurchaseOrderRequest extends PurchasingWriteRequest
{
    public function rules(): array
    {
        $patch = $this->isMethod('PATCH');
        $store = $this->route('store');
        $tz = $store instanceof Store ? ($store->timezone ?: 'Asia/Dhaka') : 'Asia/Dhaka';
        $max = CarbonImmutable::now($tz)->addYear()->format('Y-m-d');

        return [
            'revision' => $patch ? ['required', 'integer:strict', 'min:1'] : ['prohibited'],
            'supplier_id' => [$patch ? 'sometimes' : 'required', 'string', 'size:26'],
            'expected_on' => ['sometimes', 'nullable', 'date_format:Y-m-d', 'after_or_equal:'.self::DATE_MIN, 'before_or_equal:'.$max],
            'location_id' => ['sometimes', 'nullable', 'string', 'size:26'], // PHASE-8-8C P88C-8 "Receive at"
            'shipping_amount' => ['sometimes', 'integer:strict', 'min:0', 'max:1000000000'],
            'discount_amount' => ['sometimes', 'integer:strict', 'min:0', 'max:1000000000'],
            'notes' => ['sometimes', ...self::text(1000)],
            'lines' => [$patch ? 'sometimes' : 'required', 'array', 'min:1', 'max:'.PurchaseOrder::MAX_LINES],
            'lines.*' => ['array'],
            'lines.*.variant_id' => ['required', 'string', 'size:26', 'distinct:ignore_case'],
            'lines.*.unit_cost_amount' => ['sometimes', 'integer:strict', 'min:0', 'max:1000000000'],
            'lines.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:100000'],
        ];
    }

    public function messages(): array
    {
        return ['lines.*.variant_id.distinct' => 'This product is already on the purchase order.'];
    }
}

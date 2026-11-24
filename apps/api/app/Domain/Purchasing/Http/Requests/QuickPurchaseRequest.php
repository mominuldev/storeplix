<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Requests;

use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\SupplierPayment;
use Illuminate\Validation\Rule;

/** POST …/purchase-orders/quick (PHASE-8-8B §5.5, P88B-13; Idempotency-Key in the route middleware). */
class QuickPurchaseRequest extends PurchasingWriteRequest
{
    public function rules(): array
    {
        return [
            'supplier_id' => ['required', 'string', 'size:26'],
            'lines' => ['required', 'array', 'min:1', 'max:'.PurchaseOrder::MAX_LINES],
            'lines.*' => ['array'],
            'lines.*.variant_id' => ['required', 'string', 'size:26', 'distinct:ignore_case'],
            'lines.*.unit_cost_amount' => ['required', 'integer:strict', 'min:0', 'max:1000000000'],
            'lines.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:100000'],
            'lines.*.damaged' => ['sometimes', 'integer:strict', 'min:0', 'max:100000'],
            'shipping_amount' => ['sometimes', 'integer:strict', 'min:0', 'max:1000000000'],
            'discount_amount' => ['sometimes', 'integer:strict', 'min:0', 'max:1000000000'],
            'notes' => ['sometimes', ...self::text(1000)],
            'supplier_invoice_ref' => ['sometimes', ...self::line(60)],
            'invoice_media_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'payment' => ['sometimes', 'nullable', 'array:amount,method,paid_on,reference,note,currency'],
            'payment.amount' => ['required_with:payment', 'integer:strict', 'min:1', 'max:'.SupplierPayment::MAX_AMOUNT],
            'payment.method' => ['required_with:payment', 'string', Rule::in(SupplierPayment::METHODS)],
            'payment.paid_on' => ['required_with:payment', ...SupplierPaymentRequest::paidOnRules($this)],
            'payment.reference' => ['sometimes', ...self::line(60)],
            'payment.note' => ['sometimes', ...self::line(200)],
            'payment.currency' => ['sometimes', 'string', 'size:3'],
        ];
    }

    public function messages(): array
    {
        return ['lines.*.variant_id.distinct' => 'This product is listed twice.'];
    }
}

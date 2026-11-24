<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Requests;

/**
 * POST …/{po}/receipts (PHASE-8-8B §5.3; Idempotency-Key in the route middleware). Quantities only: an
 * `inventory.adjust`-only receiver can't send any cost (there is no cost field to send, P88B-11).
 */
class ReceiveRequest extends PurchasingWriteRequest
{
    public function rules(): array
    {
        return [
            'lines' => ['required', 'array', 'min:1', 'max:200'],
            'lines.*' => ['array'],
            'lines.*.item_id' => ['required', 'string', 'size:26'],
            'lines.*.received' => ['required', 'integer:strict', 'min:0', 'max:100000'],
            'lines.*.damaged' => ['sometimes', 'integer:strict', 'min:0', 'max:100000'],
            'supplier_invoice_ref' => ['sometimes', ...self::line(60)],
            'invoice_media_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'note' => ['sometimes', ...self::text(500)],
        ];
    }
}

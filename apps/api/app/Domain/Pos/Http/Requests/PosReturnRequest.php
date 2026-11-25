<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Requests;

use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * POST …/pos/sales/{sale}/returns (PosReturnInput, §9, P88D-17). The route carries `perm:pos.sell`; a refund also
 * needs `orders.refund` (403 `forbidden`, S206), then plan `pos` (402), both before validation. `reason` is one of the
 * existing return reasons (default `other`).
 */
class PosReturnRequest extends FormRequest
{
    public function authorize(): bool
    {
        if (! app(TenantContext::class)->allows(Permission::OrdersRefund)) {
            throw new ApiException(403, 'forbidden', 'You do not have permission to refund at the till.');
        }
        PosPlanGate::assert();

        return true;
    }

    public function rules(): array
    {
        return [
            'session_id' => ['required', 'string', 'size:26'],
            'lines' => ['required', 'array', 'list', 'min:1', 'max:'.PosLinesRules::LINES_MAX],
            'lines.*' => ['array:order_item_id,quantity'],
            'lines.*.order_item_id' => ['required', 'string', 'size:26', 'distinct:ignore_case'],
            'lines.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:'.PosLinesRules::QUANTITY_MAX],
            'refund_method' => ['required', 'string', 'in:cash,bkash_personal,card'],
            'reason' => ['sometimes', 'nullable', 'string', Rule::in(ReturnRequest::REASONS)],
            'note' => ['sometimes', 'nullable', 'string', 'max:500', 'regex:/^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/u'],
        ];
    }

    public function messages(): array
    {
        return ['lines.*.order_item_id.distinct' => 'Each item can appear once.'];
    }
}

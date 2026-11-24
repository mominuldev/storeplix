<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Transfers\Http;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Inventory\Models\StockTransfer;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Foundation\Http\FormRequest;

/**
 * POST /stock-transfers (create, optional `send: true`) and PATCH /stock-transfers/{transfer} (partial + required
 * `revision`) — PHASE-8-8C §7, §9. `perm:inventory.adjust` already ran; plan `multi_warehouse` → 402
 * `feature_not_in_plan` BEFORE body validation (P88C-13, S192).
 */
class StockTransferRequest extends FormRequest
{
    public function authorize(): bool
    {
        FeatureGate::assertAllows(app(TenantContext::class)->tenant(), Feature::MultiWarehouse);

        return true;
    }

    public function rules(): array
    {
        $patch = $this->isMethod('PATCH');

        return [
            'revision' => $patch ? ['required', 'integer:strict', 'min:1'] : ['prohibited'],
            'send' => $patch ? ['prohibited'] : ['sometimes', 'boolean:strict'],
            'from_location_id' => [$patch ? 'sometimes' : 'required', 'string', 'size:26'],
            'to_location_id' => [$patch ? 'sometimes' : 'required', 'string', 'size:26'],
            'note' => ['sometimes', 'nullable', 'string', 'max:500', 'regex:/^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/u'],
            'lines' => [$patch ? 'sometimes' : 'required', 'array', 'min:1', 'max:'.StockTransfer::MAX_LINES],
            'lines.*' => ['array'],
            'lines.*.variant_id' => ['required', 'string', 'size:26', 'distinct:ignore_case'],
            'lines.*.quantity' => ['required', 'integer:strict', 'min:1', 'max:'.StockTransfer::MAX_QUANTITY],
        ];
    }

    public function messages(): array
    {
        return ['lines.*.variant_id.distinct' => 'This product is already on the transfer.'];
    }
}

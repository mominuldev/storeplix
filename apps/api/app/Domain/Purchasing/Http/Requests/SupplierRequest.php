<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Requests;

use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Shared\Support\PhoneRule;
use Illuminate\Validation\Rule;

/** POST / PATCH /stores/{store}/suppliers (PHASE-8-8B §3, §8.3). PATCH = every field optional. */
class SupplierRequest extends PurchasingWriteRequest
{
    public function rules(): array
    {
        $patch = $this->isMethod('PATCH');

        return [
            'name' => [$patch ? 'sometimes' : 'required', 'string', 'min:1', 'max:120', 'regex:/^[^\x00-\x1F\x7F]*$/u', 'regex:/\S/u'],
            'contact_name' => ['sometimes', ...self::line(120)],
            'phone' => ['sometimes', 'nullable', 'string', 'max:20', PhoneRule::bdMobile()],
            'city' => ['sometimes', ...self::line(80)],
            'supplies' => ['sometimes', ...self::line(200)],
            'payment_terms_days' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:180'],
            'advance_percent' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:100'],
            'lead_time_days' => ['sometimes', 'nullable', 'integer:strict', 'min:0', 'max:180'],
            'pays_by_method' => ['sometimes', 'nullable', 'string', Rule::in(SupplierPayment::METHODS)],
            'pays_by_account' => ['sometimes', ...self::line(60)],
            'notes' => ['sometimes', ...self::text(500)],
        ];
    }
}

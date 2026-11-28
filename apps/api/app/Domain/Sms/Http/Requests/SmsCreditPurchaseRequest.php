<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Requests;

use App\Domain\Billing\Models\BillingPayment;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** SmsCreditPurchaseInput (PHASE-8-9A §5.3): `pack` and `provider` only — never credits or amounts (S212). */
class SmsCreditPurchaseRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'pack' => ['required', 'string', Rule::in(array_keys((array) config('sms.packs', [])))],
            'provider' => ['required', 'string', Rule::in(BillingPayment::GATEWAYS)],
        ];
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Requests;

use App\Domain\Billing\Models\BillingPayment;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** PayInvoiceInput (§9): only `provider` (S62); the amount is the invoice total. */
class PayInvoiceRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['provider' => ['required', 'string', Rule::in(BillingPayment::GATEWAYS)]];
    }
}

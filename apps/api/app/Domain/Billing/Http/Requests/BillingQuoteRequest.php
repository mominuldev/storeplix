<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Requests;

use App\Domain\Billing\Models\Plan;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** BillingQuoteInput (§9): only `plan_code` and `interval` are read (S62); prices, periods and status are computed. */
class BillingQuoteRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // abilities are checked in the controller (403 before validation details leak nothing here)
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'plan_code' => ['required', 'string', 'max:32'],
            'interval' => ['required', 'string', Rule::in(Plan::INTERVALS)],
        ];
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http\Requests;

use App\Domain\Billing\Models\Plan;
use Illuminate\Validation\Rule;

/** AdminQuoteInput {plan_code, interval, effective} (P8-13); no reason (no side effects). */
class AdminQuoteRequest extends AdminWriteRequest
{
    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'plan_code' => ['required', 'string', 'max:32'],
            'interval' => ['required', 'string', Rule::in(Plan::INTERVALS)],
            'effective' => ['required', 'string', Rule::in(['now', 'next_renewal'])],
        ];
    }
}

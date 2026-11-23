<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http\Requests;

use App\Domain\Billing\Models\Plan;
use Illuminate\Validation\Rule;

/** AdminChangePlanInput {plan_code, interval, effective, reason, notify} (P8-13). */
class AdminChangePlanRequest extends AdminWriteRequest
{
    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'plan_code' => ['required', 'string', 'max:32'],
            'interval' => ['required', 'string', Rule::in(Plan::INTERVALS)],
            'effective' => ['required', 'string', Rule::in(['now', 'next_renewal'])],
            'reason' => self::reasonRules(),
            'notify' => ['sometimes', 'boolean'],
        ];
    }
}

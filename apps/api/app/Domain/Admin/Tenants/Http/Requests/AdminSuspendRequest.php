<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http\Requests;

use Illuminate\Validation\Rule;

/** AdminSuspendInput {reason_code, reason, notify} (P8-12). */
class AdminSuspendRequest extends AdminWriteRequest
{
    public const REASON_CODES = ['unpaid', 'fraud', 'terms_violation', 'merchant_request', 'other'];

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'reason_code' => ['required', 'string', Rule::in(self::REASON_CODES)],
            'reason' => self::reasonRules(),
            'notify' => ['sometimes', 'boolean'],
        ];
    }
}

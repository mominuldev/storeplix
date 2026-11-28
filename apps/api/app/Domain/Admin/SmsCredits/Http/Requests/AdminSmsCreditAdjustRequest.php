<?php

declare(strict_types=1);

namespace App\Domain\Admin\SmsCredits\Http\Requests;

use App\Domain\Admin\Tenants\Http\Requests\AdminWriteRequest;

/** AdminSmsCreditAdjustInput (P89A-18): credits ±1…1,000,000 (never 0), reason 5–500. */
class AdminSmsCreditAdjustRequest extends AdminWriteRequest
{
    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'credits' => ['required', 'integer', 'between:-1000000,1000000', 'not_in:0'],
            'reason' => self::reasonRules(),
        ];
    }
}

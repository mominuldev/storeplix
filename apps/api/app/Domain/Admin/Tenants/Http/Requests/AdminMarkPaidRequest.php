<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http\Requests;

/** AdminMarkPaidInput {reference 1–120, reason} (P8-15). */
class AdminMarkPaidRequest extends AdminWriteRequest
{
    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['reference' => ['required', 'string', 'min:1', 'max:120'], 'reason' => self::reasonRules()];
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http\Requests;

/** AdminExtendInput {days 1–90, reason} (P8-14). */
class AdminExtendRequest extends AdminWriteRequest
{
    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['days' => ['required', 'integer', 'min:1', 'max:90'], 'reason' => self::reasonRules()];
    }
}

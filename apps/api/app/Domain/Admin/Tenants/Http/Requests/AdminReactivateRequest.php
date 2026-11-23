<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http\Requests;

/** AdminReactivateInput {reason, notify} (P8-12). */
class AdminReactivateRequest extends AdminWriteRequest
{
    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['reason' => self::reasonRules(), 'notify' => ['sometimes', 'boolean']];
    }
}

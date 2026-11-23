<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/**
 * PHASE-8-1 conventions: every admin write takes `reason` (5–500 chars, trimmed by TrimStrings) and stores it in the
 * audit row (S76). Subclasses add their own fields; permissions are checked by the `platform.can:<perm>` middleware.
 */
class AdminWriteRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return ['reason' => self::reasonRules()];
    }

    /** @return list<string> */
    public static function reasonRules(): array
    {
        return ['required', 'string', 'min:5', 'max:500'];
    }

    public function reason(): string
    {
        return trim((string) $this->validated('reason'));
    }
}

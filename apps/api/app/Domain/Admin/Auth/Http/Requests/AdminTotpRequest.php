<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** POST /admin/auth/totp: `{login_token, code}` or `{login_token, recovery_code}` (PHASE-8-1 §3.1 step 3). */
class AdminTotpRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'login_token' => ['required', 'string', 'max:128'],
            'code' => ['required_without:recovery_code', 'prohibits:recovery_code', 'nullable', 'string', 'regex:/^[0-9]{6}$/'],
            'recovery_code' => ['required_without:code', 'nullable', 'string', 'max:32'],
        ];
    }
}

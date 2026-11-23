<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** POST /admin/auth/enroll `{login_token, code}` (PHASE-8-1 §3.1 step 2). */
class AdminEnrollRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'login_token' => ['required', 'string', 'max:128'],
            'code' => ['required', 'string', 'regex:/^[0-9]{6}$/'],
        ];
    }
}

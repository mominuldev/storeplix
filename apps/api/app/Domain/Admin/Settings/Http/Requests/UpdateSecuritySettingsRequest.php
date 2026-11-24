<?php

declare(strict_types=1);

namespace App\Domain\Admin\Settings\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** PATCH /admin/settings/security `{staff_two_factor_required, current_password}` (amendment A1-4). */
class UpdateSecuritySettingsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // route middleware `platform.can:manage_settings`
    }

    public function rules(): array
    {
        return [
            'staff_two_factor_required' => ['required', 'boolean'],
            'current_password' => ['required', 'string', 'max:255'],
        ];
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/**
 * POST /admin/invitations/{token}/accept: a new user sends name + password + confirmation (PasswordRules); an existing
 * user sends their current password. Which case applies is decided by the controller from the invitation email.
 */
class AcceptPlatformInvitationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'nullable', 'string', 'max:255'],
            'password' => ['required', 'string', 'max:128'],
            'password_confirmation' => ['sometimes', 'nullable', 'string', 'max:128'],
        ];
    }
}

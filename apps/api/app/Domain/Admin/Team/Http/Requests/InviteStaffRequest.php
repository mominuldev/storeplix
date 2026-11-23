<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Http\Requests;

use App\Domain\Admin\Auth\AdminEmailDomains;
use App\Domain\Admin\Authorization\PlatformRole;
use Closure;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** POST /admin/team/invitations `{email, role}` (PHASE-8-1 P8-16; the email must match ADMIN_EMAIL_DOMAINS). */
class InviteStaffRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('email'))) {
            $this->merge(['email' => strtolower(trim($this->input('email')))]);
        }
    }

    public function rules(): array
    {
        return [
            'email' => ['required', 'string', 'email', 'max:255', function (string $attribute, mixed $value, Closure $fail): void {
                if (is_string($value) && ! AdminEmailDomains::allows($value)) {
                    $fail('Staff must use a Store Plix email address.');
                }
            }],
            'role' => ['required', 'string', Rule::enum(PlatformRole::class)],
        ];
    }
}

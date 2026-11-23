<?php

namespace App\Domain\Staff\Http\Requests;

use App\Domain\Staff\Models\StaffInvitation;
use Illuminate\Foundation\Http\FormRequest;

class InviteStaffRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('invite', StaffInvitation::class);
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
            'email' => ['required', 'string', 'email:rfc', 'max:254'],
            'name' => ['sometimes', 'nullable', 'string', 'max:120'],
            // PHASE-8-3 §6.2: exactly one of role_id (preferred) or legacy role (admin|staff).
            'role' => ['required_without:role_id', 'prohibits:role_id', 'string', 'in:admin,staff'],
            'role_id' => ['required_without:role', 'string', 'max:26'],
        ];
    }
}

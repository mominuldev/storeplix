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
            'role' => ['required', 'string', 'in:admin,staff'],
        ];
    }
}

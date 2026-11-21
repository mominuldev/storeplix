<?php

namespace App\Domain\Staff\Http\Requests;

use App\Domain\Identity\Rules\PasswordRules;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shared\Support\PhoneRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** Body for accepting an invitation as a NEW user (no Bearer). */
class AcceptInvitationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('phone')) && ($msisdn = Phone::bdMsisdn($this->input('phone')))) {
            $this->merge(['phone' => $msisdn]);
        }
    }

    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'min:2', 'max:120'],
            'password' => PasswordRules::rules(),
            'phone' => ['sometimes', 'nullable', 'string', PhoneRule::bdMobile(), Rule::unique('users', 'phone')],
        ];
    }
}

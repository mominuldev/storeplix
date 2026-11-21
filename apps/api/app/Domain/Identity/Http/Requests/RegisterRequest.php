<?php

namespace App\Domain\Identity\Http\Requests;

use App\Domain\Identity\Rules\PasswordRules;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shared\Support\PhoneRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class RegisterRequest extends FormRequest
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
        if (is_string($this->input('phone')) && ($msisdn = Phone::bdMsisdn($this->input('phone')))) {
            $this->merge(['phone' => $msisdn]);
        }
    }

    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'min:2', 'max:120'],
            'email' => ['required', 'string', 'email:rfc', 'max:254', 'unique:users,email'],
            'password' => PasswordRules::rules(),
            // Addendum A: required BD mobile, stored as 8801XXXXXXXXX, unique.
            'phone' => ['required', 'string', PhoneRule::bdMobile(), Rule::unique('users', 'phone')],
        ];
    }

    public function messages(): array
    {
        return ['phone.unique' => 'This phone number is already registered.'];
    }
}

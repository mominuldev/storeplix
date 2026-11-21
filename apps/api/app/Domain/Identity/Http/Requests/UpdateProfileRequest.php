<?php

namespace App\Domain\Identity\Http\Requests;

use App\Domain\Shared\Support\Phone;
use App\Domain\Shared\Support\PhoneRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class UpdateProfileRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        $merge = [];
        if (is_string($this->input('email'))) {
            $merge['email'] = strtolower(trim($this->input('email')));
        }
        if (is_string($this->input('name'))) {
            $merge['name'] = trim($this->input('name'));
        }
        if (is_string($this->input('phone')) && ($msisdn = Phone::bdMsisdn($this->input('phone')))) {
            $merge['phone'] = $msisdn;
        }
        $this->merge($merge);
    }

    public function rules(): array
    {
        $userId = $this->user()->getKey();

        return [
            'name' => ['sometimes', 'string', 'min:2', 'max:120'],
            'email' => ['sometimes', 'string', 'email:rfc', 'max:254', Rule::unique('users', 'email')->ignore($userId)],
            'phone' => ['sometimes', 'nullable', 'string', PhoneRule::bdMobile(), Rule::unique('users', 'phone')->ignore($userId)],
            'current_password' => ['sometimes', 'string'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator) {
            $user = $this->user();
            $email = $this->input('email');

            if (is_string($email) && $email !== $user->email) {
                $current = $this->input('current_password');
                if (! is_string($current) || $current === '') {
                    $validator->errors()->add('current_password', 'Your current password is required to change your email.');
                } elseif (! Hash::check($current, $user->password)) {
                    $validator->errors()->add('current_password', 'The current password is incorrect.');
                }
            }
        }];
    }
}

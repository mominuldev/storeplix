<?php

namespace App\Domain\Identity\Http\Requests;

use App\Domain\Identity\Rules\PasswordRules;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Validator;

class ChangePasswordRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'current_password' => ['required', 'string'],
            'password' => PasswordRules::rules(),
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator) {
            $current = $this->input('current_password');
            if (is_string($current) && ! Hash::check($current, $this->user()->password)) {
                $validator->errors()->add('current_password', 'The current password is incorrect.');
            }
        }];
    }
}

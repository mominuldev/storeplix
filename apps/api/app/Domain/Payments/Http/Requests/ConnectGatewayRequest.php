<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Requests;

use App\Domain\Payments\Models\PaymentGatewayAccount;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * ConnectGatewayInput { mode, credentials } (PHASE-5B §4.1). Credential fields per provider with their max lengths;
 * unknown credential keys are rejected (nothing else, e.g. a base URL, can be supplied: S27). Authorization is the
 * controller's `integrations.manage` check.
 */
final class ConnectGatewayRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $fields = PaymentGatewayAccount::CREDENTIAL_FIELDS[$this->provider()] ?? [];
        $rules = [
            'mode' => ['required', 'string', Rule::in(PaymentGatewayAccount::MODES)],
            'credentials' => ['required', 'array:'.implode(',', array_keys($fields))],
        ];
        foreach ($fields as $field => $max) {
            $rules["credentials.{$field}"] = ['required', 'string', 'max:'.$max, 'regex:/^[\x21-\x7E]+$/'];
        }

        return $rules;
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if ($this->input('mode') === PaymentGatewayAccount::LIVE && PaymentGatewayAccount::baseUrlFor($this->provider(), PaymentGatewayAccount::LIVE) === null) {
                $validator->errors()->add('mode', 'Live mode isn\'t available for this gateway yet.');
            }
        }];
    }

    /** @return array<string, string> */
    public function messages(): array
    {
        return ['credentials.*.regex' => 'Use the value exactly as the gateway shows it, without spaces.'];
    }

    public function provider(): string
    {
        return (string) $this->route('provider');
    }

    /** @return array<string, string> */
    public function credentials(): array
    {
        $fields = array_keys(PaymentGatewayAccount::CREDENTIAL_FIELDS[$this->provider()] ?? []);
        $validated = (array) $this->validated('credentials');

        return array_combine($fields, array_map(fn (string $f) => (string) $validated[$f], $fields));
    }
}

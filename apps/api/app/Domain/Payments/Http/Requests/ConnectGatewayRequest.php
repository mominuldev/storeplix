<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Requests;

use App\Domain\Payments\Gateways\NagadCrypto;
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
        if ($this->provider() === PaymentGatewayAccount::NAGAD) {
            // PHASE-8-9D §9.2: PEM keys span lines; the merchant number is a BD mobile; keys are parsed in after().
            $rules['credentials.merchant_id'] = ['required', 'string', 'max:32', 'regex:/^[0-9A-Za-z]{6,32}$/'];
            $rules['credentials.merchant_number'] = ['required', 'string', 'regex:/^(?:\+?88)?01[3-9][0-9]{8}$/'];
            $rules['credentials.merchant_private_key'] = ['required', 'string', 'max:8192'];
            $rules['credentials.pg_public_key'] = ['required', 'string', 'max:4096'];
        }

        return $rules;
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if ($this->input('mode') === PaymentGatewayAccount::LIVE && PaymentGatewayAccount::baseUrlFor($this->provider(), PaymentGatewayAccount::LIVE) === null) {
                $validator->errors()->add('mode', 'Live mode isn\'t available for this gateway yet.');
            }
            if ($this->provider() === PaymentGatewayAccount::NAGAD && ! $validator->errors()->hasAny(['credentials.merchant_private_key', 'credentials.pg_public_key'])) {
                $private = NagadCrypto::pem((string) $this->input('credentials.merchant_private_key'), 'PRIVATE KEY');
                $public = NagadCrypto::pem((string) $this->input('credentials.pg_public_key'), 'PUBLIC KEY');
                $bad = $private === null ? 'merchant_private_key' : ($public === null ? 'pg_public_key' : NagadCrypto::invalidField($private, $public));
                if ($bad !== null) {
                    $validator->errors()->add("credentials.{$bad}", $bad === 'merchant_private_key'
                        ? 'Paste the merchant private key (RSA, at least 2048 bits) exactly as Nagad issued it.'
                        : 'Paste Nagad\'s public key (RSA, at least 2048 bits) exactly as Nagad issued it.');
                }
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
        $values = array_combine($fields, array_map(fn (string $f) => (string) $validated[$f], $fields));
        if ($this->provider() === PaymentGatewayAccount::NAGAD) {
            $values['merchant_private_key'] = (string) NagadCrypto::pem($values['merchant_private_key'], 'PRIVATE KEY');
            $values['pg_public_key'] = (string) NagadCrypto::pem($values['pg_public_key'], 'PUBLIC KEY');
            $digits = preg_replace('/\D/', '', $values['merchant_number']) ?? '';
            $values['merchant_number'] = substr($digits, -11);
        }

        return $values;
    }
}

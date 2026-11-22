<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Http\Requests;

use App\Domain\Couriers\Models\CourierAccount;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * ConnectCourierInput { mode, credentials, settings? } (PHASE-5B §4.6). Credential fields per provider with their max
 * lengths; unknown credential keys are rejected (no base URL or host can be supplied: S27). Authorization is the
 * controller's `integrations.manage` check.
 */
final class ConnectCourierRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $fields = CourierAccount::CREDENTIAL_FIELDS[$this->provider()] ?? [];
        $rules = [
            // Steadfast has no sandbox: its only host is live (portal.packzy.com), so a "sandbox" connection would book
            // real parcels. Only `live` is accepted for it.
            'mode' => ['required', 'string', Rule::in($this->provider() === 'steadfast' ? ['live'] : CourierAccount::MODES)],
            'credentials' => ['required', 'array:'.implode(',', array_keys($fields))],
        ];
        foreach ($fields as $field => $max) {
            $rules["credentials.{$field}"] = $field === 'username'
                ? ['required', 'string', 'max:'.$max, 'email:rfc']
                : ['required', 'string', 'max:'.$max, 'regex:/^[\x21-\x7E]+$/'];
        }

        return $rules + CourierSettingsRules::rules($this->provider());
    }

    public function after(): array
    {
        return [fn (Validator $v) => CourierSettingsRules::checkPickupLocation($v, $this)];
    }

    /** @return array<string, string> */
    public function messages(): array
    {
        return [
            'credentials.*.regex' => 'Use the value exactly as the courier shows it, without spaces.',
            'mode.in' => $this->provider() === 'steadfast' ? 'Steadfast has no sandbox. Connect with your live API keys.' : 'Choose sandbox or live.',
        ] + CourierSettingsRules::messages();
    }

    public function provider(): string
    {
        return (string) $this->route('provider');
    }

    /** @return array<string, string> */
    public function credentials(): array
    {
        $fields = array_keys(CourierAccount::CREDENTIAL_FIELDS[$this->provider()] ?? []);
        $validated = (array) $this->validated('credentials');

        return array_combine($fields, array_map(fn (string $f) => (string) $validated[$f], $fields));
    }

    /** @return array<string, mixed> */
    public function settings(): array
    {
        return (array) ($this->validated('settings') ?? []);
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Sms\SmsRoute;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;

/**
 * PHASE-8-9B §4.6 input rules shared by create / update / rotate: sender IDs (8.9a pattern), groups, limits, prices,
 * alert settings, the driver's credential fields (HTTP: 1–5 free keys `[a-z_]{2,32}`) and settings (https endpoint
 * without IP literals or local names, S224; the HTTP mapping).
 */
final class SmsProviderRules
{
    /** @return array<string, mixed> */
    public static function common(bool $create): array
    {
        $req = $create ? 'required' : 'sometimes';
        $sender = ['string', 'regex:'.config('sms.sender_id_pattern')];

        return [
            'default_sender_id' => [$req, ...$sender],
            'promotional_sender_id' => ['sometimes', 'nullable', ...$sender],
            'promotional_sender_status' => ['sometimes', 'nullable', Rule::in(['approved', 'pending'])],
            'message_groups' => [$req, 'array', 'min:1', 'max:5'],
            'message_groups.*' => ['distinct', Rule::in(SmsRoute::values())],
            'rate_limit_per_minute' => ['sometimes', 'integer', 'between:1,6000'],
            'failover_after_failures' => ['sometimes', 'integer', 'between:1,10'],
            'failover_timeout_seconds' => ['sometimes', 'integer', 'between:3,30'],
            'price_masking_paisa' => ['sometimes', 'nullable', 'integer', 'between:0,100000'],
            'price_non_masking_paisa' => ['sometimes', 'nullable', 'integer', 'between:0,100000'],
            'low_threshold_paisa' => ['sometimes', 'nullable', 'integer', 'between:0,100000000000'],
            'alert_email' => ['sometimes', 'boolean'],
            'alert_in_app' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * Credentials complete for the driver; returns them as strings.
     *
     * @return array<string, string>
     */
    public static function credentials(string $driver, mixed $credentials, string $field = 'credentials'): array
    {
        if (! is_array($credentials) || $credentials === [] || array_is_list($credentials)) {
            throw ValidationException::withMessages([$field => ['Enter the API credentials.']]);
        }
        $out = [];
        foreach ($credentials as $key => $value) {
            if (! is_string($value) || trim($value) === '' || mb_strlen($value) > 255) {
                throw ValidationException::withMessages(["{$field}.{$key}" => ['Enter a value (up to 255 characters).']]);
            }
            $out[(string) $key] = trim($value);
        }
        if ($driver === 'http') {
            if (count($out) > 5) {
                throw ValidationException::withMessages([$field => ['Use at most 5 credential fields.']]);
            }
            foreach (array_keys($out) as $key) {
                if (preg_match('/^[a-z_]{2,32}$/', $key) !== 1) {
                    throw ValidationException::withMessages([$field => ['Credential field names use a–z and _ (2–32).']]);
                }
            }

            return $out;
        }
        $required = SmsProviderCatalog::credentialKeys($driver);
        foreach ($required as $key) {
            if (! isset($out[$key])) {
                throw ValidationException::withMessages(["{$field}.{$key}" => ['This field is required.']]);
            }
        }

        return array_intersect_key($out, array_flip($required));
    }

    /**
     * settings {account_id, base_url, http}; `$current` fills missing keys (update / rotate).
     *
     * @param  array<string, mixed>  $current
     * @param  list<string>  $credentialKeys
     * @return array{account_id: string|null, base_url: string, http: array<string, mixed>|null}
     */
    public static function settings(string $driver, mixed $settings, array $current = [], array $credentialKeys = []): array
    {
        $settings = is_array($settings) ? $settings : [];
        $merged = array_replace(['account_id' => null, 'base_url' => SmsProviderCatalog::get($driver)['default_base_url'] ?? null, 'http' => null], $current, $settings);
        $v = Validator::make($merged, [
            'account_id' => ['nullable', 'string', 'max:64'],
            'base_url' => ['required', 'string', 'max:255'],
            'http' => [$driver === 'http' ? 'required' : 'nullable', 'array'],
        ]);
        if ($v->fails()) {
            throw ValidationException::withMessages(collect($v->errors()->toArray())->mapWithKeys(fn ($m, $k) => ["settings.{$k}" => $m])->all());
        }
        try {
            SmsEndpointGuard::assertAcceptable((string) $merged['base_url']);
        } catch (InvalidArgumentException) {
            throw ValidationException::withMessages(['settings.base_url' => ['Use an https:// address.']]);
        }
        $http = null;
        if ($driver === 'http') {
            $param = ['required', 'string', 'regex:/^[A-Za-z0-9_.\-\[\]]{1,64}$/'];
            $h = Validator::make((array) $merged['http'], [
                'method' => ['required', Rule::in(['POST', 'GET'])],
                'body_format' => ['required', Rule::in(['json', 'form', 'query'])],
                'to_param' => $param,
                'text_param' => $param,
                'sender_param' => $param,
                'credential_params' => ['present', 'array'],
                'credential_params.*' => $param,
                'success_path' => ['required', 'string', 'regex:/^[A-Za-z0-9_.\-]{1,64}$/'],
                'success_value' => ['required', 'string', 'max:64'],
                'message_id_path' => ['nullable', 'string', 'regex:/^[A-Za-z0-9_.\-]{1,64}$/'],
            ]);
            if ($h->fails()) {
                throw ValidationException::withMessages(collect($h->errors()->toArray())->mapWithKeys(fn ($m, $k) => ["settings.http.{$k}" => $m])->all());
            }
            $http = $h->validated();
            $http['credential_params'] = array_map('strval', (array) $http['credential_params']);
            $http['message_id_path'] ??= null;
            foreach ($credentialKeys as $key) {
                if (! isset($http['credential_params'][$key])) {
                    throw ValidationException::withMessages(["settings.http.credential_params.{$key}" => ['Say which request parameter carries this credential.']]);
                }
            }
        }

        return ['account_id' => $merged['account_id'] !== null && $merged['account_id'] !== '' ? (string) $merged['account_id'] : null,
            'base_url' => rtrim((string) $merged['base_url'], '/'), 'http' => $http];
    }

    /** @param array<string, string> $credentials @return array<string, string> */
    public static function hints(array $credentials): array
    {
        return array_map(fn (string $v) => IntegrationCredentials::hint($v), $credentials);
    }
}

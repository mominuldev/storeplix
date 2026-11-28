<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;

/**
 * PHASE-8-9D P89D-4 / P89D-6: typed settings per provider. Unknown or read-only keys → 422 `validation_failed`; ID
 * fields are trimmed (upper-cased where the format is upper case), checked for pasted markup first (422
 * `integration_code_pasted`, details.field) and then against their pattern (422 `integration_id_invalid`). Defaults are
 * returned as `defaults` (§4.3). No field anywhere accepts HTML or script (rule 7).
 */
abstract class ProviderSettings
{
    /** types PASTED_CODE_PATTERN: the snippets merchants paste instead of an ID. */
    public const PASTED_CODE_PATTERN = '/<\s*\/?\s*(script|noscript|img|iframe)\b|fbq\s*\(|gtag\s*\(|ttq\.|googletagmanager\.com\/gtm\.js|function\s*\(/i';

    public const TRIGGERS = ['order_placed', 'order_confirmed', 'order_delivered'];

    public const TEST_CODE_PATTERN = '/^[A-Za-z0-9]{4,32}$/';

    /** @return array<string, mixed> complete settings with defaults (ID fields null) */
    abstract public static function defaults(): array;

    /** @return array<string, mixed> Laravel rules for the non-ID fields of the merged settings */
    abstract protected static function rules(): array;

    /** @return list<string> keys a merchant may write (PUT / PATCH); everything else is read-only or unknown */
    abstract public static function writable(): array;

    /**
     * ID fields: key => [pattern, label, upper-case, required]. Checked before the other rules.
     *
     * @return array<string, array{0: string, 1: string, 2: bool, 3: bool}>
     */
    public static function idFields(): array
    {
        return [];
    }

    /** Write-only secret fields typed by the merchant: key => [min, max]. @return array<string, array{0: int, 1: int}> */
    public static function credentialFields(): array
    {
        return [];
    }

    /** Secret fields that must be present for the integration to connect. @return list<string> */
    public static function requiredCredentials(): array
    {
        return array_keys(static::credentialFields());
    }

    /** @return class-string<ProviderSettings> */
    public static function for(string $provider): string
    {
        return match ($provider) {
            IntegrationProvider::META_PIXEL => MetaPixelSettings::class,
            IntegrationProvider::GA4 => Ga4Settings::class,
            IntegrationProvider::TIKTOK_PIXEL => TiktokPixelSettings::class,
            IntegrationProvider::GTM_SERVER => GtmServerSettings::class,
            IntegrationProvider::META_CATALOG => MetaCatalogSettings::class,
            IntegrationProvider::GOOGLE_MERCHANT => GoogleMerchantSettings::class,
            IntegrationProvider::AI_WRITER => AiWriterSettings::class,
            IntegrationProvider::AI_PHOTOS => AiPhotosSettings::class,
            default => throw new InvalidArgumentException("Unknown integration provider {$provider}."),
        };
    }

    public static function looksLikeCode(string $value): bool
    {
        return preg_match(self::PASTED_CODE_PATTERN, $value) === 1;
    }

    /**
     * Validates `$input` (the merchant's keys) over `$base` (stored settings or defaults) and returns the complete,
     * normalised settings.
     *
     * @param  array<string, mixed>  $input
     * @param  array<string, mixed>  $base
     * @return array<string, mixed>
     *
     * @throws ApiException|ValidationException
     */
    public static function validate(array $input, array $base): array
    {
        $unknown = array_diff(array_map('strval', array_keys($input)), static::writable());
        if ($unknown !== []) {
            $errors = [];
            foreach ($unknown as $key) {
                $errors["settings.{$key}"] = ['This setting does not exist or cannot be changed.'];
            }

            throw ValidationException::withMessages($errors);
        }

        // Rule 7 first: any pasted snippet in any string field is refused with the friendly error.
        foreach ($input as $key => $value) {
            if (is_string($value) && self::looksLikeCode($value)) {
                $label = static::idFields()[$key][1] ?? 'ID';

                throw new ApiException(422, 'integration_code_pasted', "This looks like code. Paste only the {$label}.", ['field' => "settings.{$key}"]);
            }
        }

        $merged = array_replace(static::defaults(), $base, $input);
        foreach (static::idFields() as $key => [$pattern, $label, $upper, $required]) {
            $value = $merged[$key] ?? null;
            if ($value === null || (is_string($value) && trim($value) === '')) {
                if ($required) {
                    throw new ApiException(422, 'integration_id_invalid', "Enter the {$label}.", ['field' => "settings.{$key}"]);
                }
                $merged[$key] = null;

                continue;
            }
            if (! is_string($value)) {
                throw new ApiException(422, 'integration_id_invalid', "The {$label} isn't valid.", ['field' => "settings.{$key}"]);
            }
            $value = preg_replace('/\s+/u', '', $value) ?? '';
            $value = $upper ? strtoupper($value) : $value;
            if (preg_match($pattern, $value) !== 1) {
                throw new ApiException(422, 'integration_id_invalid', "The {$label} isn't valid. Check it and try again.", ['field' => "settings.{$key}"]);
            }
            $merged[$key] = $value;
        }

        $rules = [];
        foreach (static::rules() as $key => $rule) {
            $rules["settings.{$key}"] = $rule;
        }
        $validated = Validator::make(['settings' => $merged], $rules)->validate();
        $out = [];
        foreach (array_keys(static::defaults()) as $key) {
            $out[$key] = array_key_exists($key, $validated['settings'] ?? []) ? $validated['settings'][$key] : $merged[$key];
        }

        return static::normalize($out);
    }

    /** @param array<string, mixed> $settings @return array<string, mixed> */
    protected static function normalize(array $settings): array
    {
        return $settings;
    }

    /** @return array<string, mixed> */
    protected static function trackingRules(): array
    {
        return [
            'purchase_trigger' => ['required', 'string', 'in:'.implode(',', self::TRIGGERS)],
            'include_delivery_charge' => ['required', 'boolean:strict'],
            'wait_for_consent' => ['required', 'boolean:strict'],
            'send_customer_data' => ['required', 'boolean:strict'],
        ];
    }

    /** @return array<string, mixed> */
    protected static function trackingDefaults(): array
    {
        return ['purchase_trigger' => 'order_confirmed', 'include_delivery_charge' => false, 'wait_for_consent' => false, 'send_customer_data' => true];
    }

    /** @return array<string, mixed> */
    protected static function feedRules(): array
    {
        return [
            'include' => ['required', 'string', 'in:all,categories'],
            'category_ids' => ['present', 'array', 'max:50', 'required_if:settings.include,categories'],
            'category_ids.*' => ['string', 'regex:/^[0-9A-Za-z]{26}$/'],
            'hide_sold_out' => ['required', 'boolean:strict'],
            'use_sale_price' => ['required', 'boolean:strict'],
        ];
    }

    /** @return array<string, mixed> */
    protected static function feedDefaults(): array
    {
        return ['include' => 'all', 'category_ids' => [], 'hide_sold_out' => false, 'use_sale_price' => true];
    }

    /** @param array<string, mixed> $settings @return array<string, mixed> */
    protected static function normalizeFeed(array $settings): array
    {
        $settings['category_ids'] = array_values(array_unique(array_map(fn ($id) => strtolower((string) $id), (array) $settings['category_ids'])));
        if ($settings['include'] === 'all') {
            $settings['category_ids'] = [];
        }

        return $settings;
    }
}

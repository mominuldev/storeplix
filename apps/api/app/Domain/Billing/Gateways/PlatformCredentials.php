<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Billing\Models\BillingPayment;

/**
 * P7-10 / S58: Storeplix's own gateway credentials, from env / the secret manager only (config `billing.*`). Never in
 * the DB, responses, logs or `raw`. A provider with any empty credential is not offered.
 */
final class PlatformCredentials
{
    public const FIELDS = [
        BillingPayment::BKASH => ['app_key', 'app_secret', 'username', 'password'],
        BillingPayment::SSLCOMMERZ => ['store_id', 'store_passwd'],
    ];

    /** @return array<string, string> */
    public static function for(string $provider): array
    {
        $values = [];
        foreach (self::FIELDS[$provider] ?? [] as $field) {
            $values[$field] = (string) config("billing.{$provider}.{$field}", '');
        }

        return $values;
    }

    public static function configured(string $provider): bool
    {
        $values = self::for($provider);

        return $values !== [] && ! in_array('', $values, true);
    }

    /** Providers offered to merchants (`meta.providers`): every provider under the fake driver, else configured ones. */
    public static function providers(): array
    {
        return array_values(array_filter(BillingPayment::GATEWAYS, fn (string $p) => (bool) config('billing.fake') || self::configured($p)));
    }

    public static function mode(): string
    {
        return (string) config('billing.gateway_mode', 'sandbox');
    }
}

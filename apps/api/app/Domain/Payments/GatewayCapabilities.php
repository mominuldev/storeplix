<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Payments\Models\PaymentGatewayAccount;

/**
 * PHASE-8-9D P89D-45: what each gateway driver can do (`PaymentGatewayAccount.capabilities`). bKash refund,
 * refund_partial, query; SSLCommerz + webhook; Nagad query, webhook (+ refund only when NAGAD_REFUNDS=true after
 * certification). `preauth` and `agreement` are offered by no driver: the UI greys them ("Not offered by Nagad yet").
 */
final class GatewayCapabilities
{
    /** @return list<string> */
    public static function for(string $provider): array
    {
        return match ($provider) {
            PaymentGatewayAccount::BKASH => ['refund', 'refund_partial', 'query'],
            PaymentGatewayAccount::SSLCOMMERZ => ['refund', 'refund_partial', 'query', 'webhook'],
            PaymentGatewayAccount::NAGAD => (bool) config('payments.providers.nagad.refunds') ? ['refund', 'query', 'webhook'] : ['query', 'webhook'],
            default => [],
        };
    }

    public static function supportsRefund(?string $provider): bool
    {
        return $provider !== null && in_array('refund', self::for($provider), true);
    }

    /** Where the merchant's onboarding papers point Nagad (the API return URL base); null for the others. */
    public static function callbackUrl(string $provider): ?string
    {
        return $provider === PaymentGatewayAccount::NAGAD
            ? rtrim((string) (config('payments.public_api_url') ?: config('app.url')), '/').'/api/v1/payments/return/nagad'
            : null;
    }
}

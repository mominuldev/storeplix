<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Contracts\Container\Container;

/** P7-20: FakeBillingGateway for both providers when `billing.fake`; else the platform adapters of the 5b drivers. */
final class BillingGatewayManager
{
    public function __construct(private readonly Container $container) {}

    public function driver(string $provider): BillingGateway
    {
        if (! in_array($provider, PlatformCredentials::providers(), true)) {
            throw new ApiException(422, 'billing_gateway_unavailable', 'This payment method is not available right now.', [
                'provider' => ['This payment method is not available right now.'],
            ]);
        }
        if ((bool) config('billing.fake')) {
            return $this->container->make(FakeBillingGateway::class);
        }

        return $this->container->make(match ($provider) {
            BillingPayment::BKASH => BkashBillingGateway::class,
            BillingPayment::SSLCOMMERZ => SslCommerzBillingGateway::class,
        });
    }
}

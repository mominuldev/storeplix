<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Payments\Gateways\BkashGateway;
use App\Domain\Payments\Gateways\FakeGateway;
use App\Domain\Payments\Gateways\NagadGateway;
use App\Domain\Payments\Gateways\PaymentGateway;
use App\Domain\Payments\Gateways\SslCommerzGateway;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use Illuminate\Contracts\Container\Container;
use InvalidArgumentException;

/** Resolves the gateway driver of a provider: FakeGateway for every provider when `payments.fake` (P5B-29). */
final class PaymentManager
{
    public function __construct(private readonly Container $container) {}

    public function driver(string $provider): PaymentGateway
    {
        if (! in_array($provider, PaymentGatewayAccount::PROVIDERS, true)) {
            throw new InvalidArgumentException("Unknown payment gateway [{$provider}].");
        }
        if ((bool) config('payments.fake')) {
            return $this->container->make(FakeGateway::class);
        }

        return $this->container->make(match ($provider) {
            PaymentGatewayAccount::BKASH => BkashGateway::class,
            PaymentGatewayAccount::SSLCOMMERZ => SslCommerzGateway::class,
            PaymentGatewayAccount::NAGAD => NagadGateway::class,
        });
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Payments\Gateways\Initiation;
use App\Domain\Payments\Gateways\Verification;

/** Platform bKash (P7-10, §7.1). bKash has no usable IPN: the reconciler queries pending payments (P7-12). */
final class BkashBillingGateway implements BillingGateway
{
    public function __construct(private readonly PlatformBkashProtocol $protocol) {}

    public function initiate(BillingPayment $payment, ChargeParty $party, string $returnUrl, ?string $ipnUrl): Initiation
    {
        $this->protocol->party = $party;
        try {
            return $this->protocol->initiate(PlatformGatewayAccount::charge($payment), PlatformGatewayAccount::make(BillingPayment::BKASH), $returnUrl, null);
        } finally {
            $this->protocol->party = null;
        }
    }

    public function complete(BillingPayment $payment, array $params): Verification
    {
        return $this->protocol->complete(PlatformGatewayAccount::charge($payment), PlatformGatewayAccount::make(BillingPayment::BKASH), $params);
    }

    public function query(BillingPayment $payment): Verification
    {
        return $this->protocol->query(PlatformGatewayAccount::charge($payment), PlatformGatewayAccount::make(BillingPayment::BKASH));
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Payments\Gateways\Initiation;
use App\Domain\Payments\Gateways\SslCommerzGateway;
use App\Domain\Payments\Gateways\Verification;

/** Platform SSLCommerz (P7-10, §7.1); its IPN is the single platform URL (P7-12, verify_sign with the platform passwd). */
final class SslCommerzBillingGateway implements BillingGateway
{
    public function __construct(private readonly PlatformSslCommerzProtocol $protocol) {}

    public function initiate(BillingPayment $payment, ChargeParty $party, string $returnUrl, ?string $ipnUrl): Initiation
    {
        $this->protocol->party = $party;
        try {
            return $this->protocol->initiate(PlatformGatewayAccount::charge($payment), PlatformGatewayAccount::make(BillingPayment::SSLCOMMERZ), $returnUrl, $ipnUrl);
        } finally {
            $this->protocol->party = null;
        }
    }

    public function complete(BillingPayment $payment, array $params): Verification
    {
        return $this->protocol->complete(PlatformGatewayAccount::charge($payment), PlatformGatewayAccount::make(BillingPayment::SSLCOMMERZ), $params);
    }

    public function query(BillingPayment $payment): Verification
    {
        return $this->protocol->query(PlatformGatewayAccount::charge($payment), PlatformGatewayAccount::make(BillingPayment::SSLCOMMERZ));
    }

    /** IPN signature with the PLATFORM store password (S55). */
    public static function verifyIpn(array $params): bool
    {
        $passwd = (string) config('billing.sslcommerz.store_passwd', '');

        return $passwd !== '' && SslCommerzGateway::verifySign($params, $passwd);
    }
}

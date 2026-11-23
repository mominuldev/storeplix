<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Payments\Gateways\Initiation;
use App\Domain\Payments\Gateways\Verification;

/**
 * A platform billing gateway (P7-10): Storeplix's own bKash / SSLCommerz accounts. Drivers only REPORT what the
 * provider says; BillingPaymentService decides (P7-9). Throws GatewayException like the merchant drivers.
 */
interface BillingGateway
{
    /** Start the hosted payment; $returnUrl is the signed billing return URL, $ipnUrl the platform IPN URL (SSLCommerz). */
    public function initiate(BillingPayment $payment, ChargeParty $party, string $returnUrl, ?string $ipnUrl): Initiation;

    /** After the browser return (bKash Execute → Query; SSLCommerz Validation API with val_id, else query by tran_id). */
    public function complete(BillingPayment $payment, array $params): Verification;

    /** Current provider state (bKash Query Payment; SSLCommerz transaction query by tran_id). */
    public function query(BillingPayment $payment): Verification;
}

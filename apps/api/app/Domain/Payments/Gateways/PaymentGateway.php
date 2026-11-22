<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;

/**
 * A hosted payment gateway driver (PHASE-5B-CONTRACT P5B-10–P5B-29, §5). Drivers only REPORT what the provider says;
 * the paid/mismatch decision (final success AND amount AND BDT AND reference == payment id) belongs to PaymentService.
 * Every outbound call goes through SafeHttpClient with the provider base URL from config by the account's mode.
 */
interface PaymentGateway
{
    /** Live credential check on connect (bKash grant token; SSLCommerz ৳10 test session, discarded). Throws GatewayException('credentials_invalid'|'provider_unavailable'). */
    public function checkCredentials(PaymentGatewayAccount $account): void;

    /** Start a hosted payment. $returnUrl is the signed API return URL (API-2 builds it); $ipnUrl may be null. */
    public function initiate(Payment $payment, PaymentGatewayAccount $account, string $returnUrl, ?string $ipnUrl): Initiation;

    /** Finish after the shopper returns (bKash: Execute; SSLCommerz: Validation API with val_id). $params = the return request's query/body. */
    public function complete(Payment $payment, PaymentGatewayAccount $account, array $params): Verification;

    /** Ask the provider for the current state (bKash Query Payment; SSLCommerz query by tran_id). */
    public function query(Payment $payment, PaymentGatewayAccount $account): Verification;

    public function refund(Payment $charge, Payment $refund, PaymentGatewayAccount $account, int $amount, ?string $reason): RefundResult;

    public function refundStatus(Payment $refund, PaymentGatewayAccount $account): RefundResult;
}

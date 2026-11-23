<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\SslCommerzGateway;
use App\Domain\Shared\Support\Money;

/**
 * The 5b SSLCommerz v4 protocol with the platform's session fields (P7-11): tran_id = billing payment id,
 * "Storeplix {Plan} plan ({interval})", category saas, non-physical goods, no shipping, the owner as customer, the
 * store city (fallback Dhaka), value_a = invoice number. No other PII.
 */
final class PlatformSslCommerzProtocol extends SslCommerzGateway
{
    public ?ChargeParty $party = null;

    /** VERIFY against sandbox: `product_profile: non-physical-goods` with `shipping_method: NO` and no ship_* (§7.1). */
    protected function sessionFields(Payment $payment, string $returnUrl, ?string $ipnUrl): array
    {
        $party = $this->party;
        $fields = [
            'total_amount' => Money::toDecimal($payment->amount),
            'currency' => 'BDT',
            'tran_id' => $payment->id,
            'success_url' => $returnUrl,
            'fail_url' => $returnUrl,
            'cancel_url' => $returnUrl,
            'cus_name' => mb_substr($party?->name ?: 'Storeplix merchant', 0, 50),
            'cus_email' => $party?->email ?: $this->fallbackEmail('billing-'.strtolower(substr($payment->id, -8))),
            'cus_add1' => mb_substr($party?->city ?: 'Dhaka', 0, 50),
            'cus_city' => mb_substr($party?->city ?: 'Dhaka', 0, 50),
            'cus_postcode' => '1000',
            'cus_country' => 'Bangladesh',
            'cus_phone' => $party?->phone ?: '01000000000',
            'shipping_method' => 'NO',
            'num_of_item' => 1,
            'product_name' => mb_substr($party?->productName ?: 'Storeplix plan', 0, 255),
            'product_category' => 'saas',
            'product_profile' => 'non-physical-goods',
            'value_a' => $party?->invoiceNumber ?? 'billing',
        ];
        if ($ipnUrl !== null) {
            $fields['ipn_url'] = $ipnUrl;
        }

        return $fields;
    }
}

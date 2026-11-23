<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\BkashGateway;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Shared\Support\Money;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Cache\Factory as CacheFactory;

/**
 * The 5b bKash Tokenized Checkout protocol with the platform's token identity and create body (P7-10, P7-11): the
 * grant token in the global cache (`billing:bkash:token:{fingerprint}`), payerReference = the owner's phone (else
 * 01000000000), merchantInvoiceNumber = the billing payment id, intent sale.
 */
final class PlatformBkashProtocol extends BkashGateway
{
    public ?ChargeParty $party = null;

    public function __construct(SafeHttpClient $http, TenantContext $context, CacheFactory $cache)
    {
        parent::__construct($http, new GlobalTokenCache($context, $cache));
    }

    protected function cacheKey(PaymentGatewayAccount $account): string
    {
        $fingerprint = substr(hash_hmac('sha256', $account->mode.'|'.json_encode($account->credentials), (string) config('app.key')), 0, 16);

        return "billing:bkash:token:{$fingerprint}";
    }

    /** VERIFY against sandbox: `mode: "0011"` as in 5b; payerReference with the owner's phone (§7.1). */
    protected function createBody(Payment $payment, string $returnUrl): array
    {
        $phone = preg_replace('/^\+?88/', '', (string) ($this->party?->phone ?? ''));

        return [
            'mode' => '0011',
            'payerReference' => is_string($phone) && preg_match('/^01\d{9}$/', $phone) === 1 ? $phone : '01000000000',
            'callbackURL' => $returnUrl,
            'amount' => Money::toDecimal($payment->amount),
            'currency' => 'BDT',
            'intent' => 'sale',
            'merchantInvoiceNumber' => $payment->id,
        ];
    }
}

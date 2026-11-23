<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use LogicException;

/**
 * An in-memory gateway account carrying the PLATFORM credentials (P7-10) for the 5b protocol code. Never saved
 * (save() throws), never loaded from the merchant accounts table; credentials are a plain array (not the merchant
 * encrypter) and stay out of serialization.
 */
final class PlatformGatewayAccount extends PaymentGatewayAccount
{
    public static function make(string $provider): self
    {
        $account = new self;
        $account->forceFill([
            'id' => 'platform',
            'provider' => $provider,
            'mode' => PlatformCredentials::mode(),
            'status' => self::CONNECTED,
            'enabled' => true,
        ]);
        $account->setRawAttributes(array_merge($account->getAttributes(), ['credentials' => json_encode(PlatformCredentials::for($provider))]));

        return $account;
    }

    /** The billing payment as the transient charge the 5b drivers expect (id = our reference, amount, provider id). */
    public static function charge(BillingPayment $payment): Payment
    {
        $charge = new Payment;
        $charge->forceFill([
            'id' => $payment->id,
            'provider' => $payment->provider,
            'amount' => $payment->amount,
            'currency' => 'BDT',
            'provider_payment_id' => $payment->provider_payment_id,
        ]);

        return $charge;
    }

    protected function casts(): array
    {
        return ['credentials' => 'array'] + array_diff_key(parent::casts(), ['credentials' => true]);
    }

    public function save(array $options = []): bool
    {
        throw new LogicException('The platform gateway account is never stored.');
    }
}

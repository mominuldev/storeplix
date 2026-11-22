<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Support\Facades\URL;

/**
 * P5B-29 fake driver (PAYMENTS_FAKE=true; local, testing, e2e; refused in production). Bound for every provider.
 *
 * initiate() → the fake hosted page `/api/v1/dev/fake-gateway/{payment}` (signed, tenant in the signature), whose
 * Pay / Fail / Cancel buttons record the outcome here and redirect the browser to the return URL the payment was
 * initiated with, adding the provider's return params (bKash: paymentID + status=success|failure|cancel;
 * SSLCommerz: tran_id + val_id + status=VALID|FAILED|CANCELLED).
 *
 * Deterministic outcomes after "Pay", by the payment amount's last two paisa digits:
 *   13 → failed (`fake_declined`);  17 → reported amount is 1 paisa more (amount mismatch);
 *   19 → complete() throws provider_unavailable (execute timeout), then query() reports Completed.
 * Credentials: a value starting with "invalid" → credentials_invalid; "unavailable" → provider_unavailable.
 * Refunds succeed, except an amount ending in 13 paisa → failed.
 *
 * State (return URL, outcome) lives in TenantCache under "payments:fake:{payment id}" for 26 hours.
 */
final class FakeGateway implements PaymentGateway
{
    public const ROUTE = 'dev.fake-gateway.show';

    public const OUTCOMES = ['pay', 'fail', 'cancel'];

    public function __construct(private readonly TenantCache $cache) {}

    public function checkCredentials(PaymentGatewayAccount $account): void
    {
        foreach ((array) $account->credentials as $value) {
            $value = strtolower((string) $value);
            if (str_starts_with($value, 'invalid')) {
                throw new GatewayException(GatewayException::CREDENTIALS_INVALID, 'Fake gateway: credentials rejected.');
            }
            if (str_starts_with($value, 'unavailable')) {
                throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'Fake gateway: provider unavailable.');
            }
        }
    }

    public function initiate(Payment $payment, PaymentGatewayAccount $account, string $returnUrl, ?string $ipnUrl): Initiation
    {
        $providerPaymentId = 'FAKE'.strtoupper(substr($payment->id, -20));
        $this->cache->put(self::key($payment->id), [
            'return_url' => $returnUrl,
            'provider' => $payment->provider,
            'provider_payment_id' => $providerPaymentId,
            'outcome' => null,
            'executed' => false,
        ], now()->addHours(26));

        return new Initiation(self::pageUrl($payment), $providerPaymentId, ['fake' => true, 'paymentID' => $providerPaymentId]);
    }

    public function complete(Payment $payment, PaymentGatewayAccount $account, array $params): Verification
    {
        $state = $this->state($payment);
        // Like the real drivers, the return params never decide (S22): only the button pressed on the fake page does.
        $outcome = $state['outcome'] ?? null;
        if ($outcome === 'pay' && self::cents($payment->amount) === 19 && ! ($state['executed'] ?? false)) {
            $this->remember($payment, ['executed' => true]);
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'Fake gateway: execute timed out.');
        }

        return $this->report($payment, $outcome);
    }

    public function query(Payment $payment, PaymentGatewayAccount $account): Verification
    {
        return $this->report($payment, $this->state($payment)['outcome'] ?? null);
    }

    public function refund(Payment $charge, Payment $refund, PaymentGatewayAccount $account, int $amount, ?string $reason): RefundResult
    {
        if (self::cents($amount) === 13) {
            return new RefundResult(RefundResult::FAILED, null, 'fake_refund_rejected', ['fake' => true]);
        }

        return new RefundResult(RefundResult::SUCCEEDED, 'FAKER'.strtoupper(substr($refund->id, -20)), null, ['fake' => true]);
    }

    public function refundStatus(Payment $refund, PaymentGatewayAccount $account): RefundResult
    {
        return new RefundResult(RefundResult::SUCCEEDED, $refund->provider_payment_id ?? 'FAKER'.strtoupper(substr($refund->id, -20)), null, ['fake' => true]);
    }

    // ---------------------------------------------------------------- the fake hosted page (FakeGatewayController)

    /** Signed page URL (26 h); the tenant travels in the signature like the document download (no pre-tenant lookup). */
    public static function pageUrl(Payment $payment): string
    {
        return URL::temporarySignedRoute(self::ROUTE, now()->addHours(26), ['payment' => $payment->id, 'tenant' => $payment->tenant_id]);
    }

    /** @return array<string, mixed>|null the stored state (null = never initiated through the fake). Tenant context required. */
    public function state(Payment|string $payment): ?array
    {
        $state = $this->cache->get(self::key($payment instanceof Payment ? $payment->id : $payment));

        return is_array($state) ? $state : null;
    }

    /** Records the button pressed and returns the browser redirect target (return URL + provider params). */
    public function recordOutcome(Payment $payment, string $outcome): ?string
    {
        $state = $this->state($payment);
        if ($state === null || ! in_array($outcome, self::OUTCOMES, true)) {
            return null;
        }
        $this->remember($payment, ['outcome' => $outcome]);
        $params = $payment->provider === PaymentGatewayAccount::SSLCOMMERZ
            ? ['tran_id' => $payment->id, 'val_id' => 'FAKEVAL'.strtoupper(substr($payment->id, -16)),
                'status' => ['pay' => 'VALID', 'fail' => 'FAILED', 'cancel' => 'CANCELLED'][$outcome]]
            : ['paymentID' => (string) $state['provider_payment_id'], 'status' => ['pay' => 'success', 'fail' => 'failure', 'cancel' => 'cancel'][$outcome]];
        $url = (string) $state['return_url'];

        return $url.(str_contains($url, '?') ? '&' : '?').http_build_query($params);
    }

    // ---------------------------------------------------------------- internals

    private function report(Payment $payment, ?string $outcome): Verification
    {
        $raw = ['fake' => true, 'outcome' => $outcome];
        $trx = 'FAKETRX'.strtoupper(substr($payment->id, -12));

        return match ($outcome) {
            'pay' => match (self::cents($payment->amount)) {
                13 => new Verification(Verification::FAILED, $payment->amount, 'BDT', $payment->id, null, 'fake_declined', $raw),
                17 => new Verification(Verification::SUCCEEDED, $payment->amount + 1, 'BDT', $payment->id, $trx, null, $raw),
                default => new Verification(Verification::SUCCEEDED, $payment->amount, 'BDT', $payment->id, $trx, null, $raw),
            },
            'fail' => new Verification(Verification::FAILED, $payment->amount, 'BDT', $payment->id, null, 'payment_failed', $raw),
            'cancel' => new Verification(Verification::CANCELLED, $payment->amount, 'BDT', $payment->id, null, 'cancelled_by_shopper', $raw),
            default => new Verification(Verification::PENDING, null, null, $payment->id, null, null, $raw),
        };
    }

    private function remember(Payment $payment, array $changes): void
    {
        $this->cache->put(self::key($payment->id), array_merge($this->state($payment) ?? [], $changes), now()->addHours(26));
    }

    private static function cents(int $amount): int
    {
        return $amount % 100;
    }

    private static function key(string $paymentId): string
    {
        return 'payments:fake:'.$paymentId;
    }
}

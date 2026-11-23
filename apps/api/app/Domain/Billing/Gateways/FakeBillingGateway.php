<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Gateways\Initiation;
use App\Domain\Payments\Gateways\Verification;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\URL;

/**
 * P7-20 / §7.2 fake platform gateway (BILLING_FAKE=true; local, testing, e2e; refused in production). Bound for both
 * providers. `initiate()` → the signed fake page `/api/v1/dev/fake-billing-gateway/{payment}` whose buttons record the
 * outcome here and redirect the browser to the return URL with provider-shaped params (bKash `paymentID` + `status`;
 * SSLCommerz `tran_id` + `val_id` + `status`). Only the button decides (S53), never the return params:
 *   pay → succeeded · wrong_amount → succeeded with amount + 1 paisa · fail → failed · cancel → cancelled ·
 *   timeout → complete() throws provider_unavailable once, then query() reports succeeded.
 * State lives in the GLOBAL cache under `billing:fake:{payment}` for 26 h.
 */
final class FakeBillingGateway implements BillingGateway
{
    public const ROUTE = 'dev.fake-billing-gateway.show';

    public const OUTCOMES = ['pay', 'wrong_amount', 'fail', 'cancel', 'timeout'];

    public const LABELS = ['pay' => 'Pay', 'wrong_amount' => 'Pay wrong amount', 'fail' => 'Fail', 'cancel' => 'Cancel', 'timeout' => 'Pay, then time out'];

    public function initiate(BillingPayment $payment, ChargeParty $party, string $returnUrl, ?string $ipnUrl): Initiation
    {
        $providerPaymentId = 'FAKEB'.strtoupper(substr($payment->id, -20));
        Cache::put(self::key($payment->id), [
            'return_url' => $returnUrl,
            'provider' => $payment->provider,
            'provider_payment_id' => $providerPaymentId,
            'outcome' => null,
            'executed' => false,
        ], now()->addHours(26));

        return new Initiation(self::pageUrl($payment), $providerPaymentId, ['fake' => true, 'paymentID' => $providerPaymentId]);
    }

    public function complete(BillingPayment $payment, array $params): Verification
    {
        $state = $this->state($payment->id);
        $outcome = $state['outcome'] ?? null;
        if ($outcome === 'timeout' && ! ($state['executed'] ?? false)) {
            $this->remember($payment->id, ['executed' => true]);
            throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'Fake billing gateway: execute timed out.');
        }

        return $this->report($payment, $outcome);
    }

    public function query(BillingPayment $payment): Verification
    {
        return $this->report($payment, $this->state($payment->id)['outcome'] ?? null);
    }

    public static function pageUrl(BillingPayment $payment): string
    {
        // Signed RELATIVE (path + query) and prefixed with PUBLIC_API_URL like the return URL: the page must verify on
        // whatever API origin the browser or the e2e helper reaches (APP_URL, a tunnel, a second port). Route uses
        // `signed:relative`; the payment id, tenant and expiry stay covered by the signature.
        $relative = URL::temporarySignedRoute(self::ROUTE, now()->addHours(26), ['payment' => $payment->id, 'tenant' => $payment->tenant_id], absolute: false);

        return rtrim((string) (config('payments.public_api_url') ?: config('app.url')), '/').$relative;
    }

    /** @return array<string, mixed>|null */
    public function state(string $paymentId): ?array
    {
        $state = Cache::get(self::key($paymentId));

        return is_array($state) ? $state : null;
    }

    /** Records the button and returns the browser redirect target (return URL + provider params). */
    public function recordOutcome(BillingPayment $payment, string $outcome): ?string
    {
        $state = $this->state($payment->id);
        if ($state === null || ! in_array($outcome, self::OUTCOMES, true)) {
            return null;
        }
        $this->remember($payment->id, ['outcome' => $outcome]);
        $paid = in_array($outcome, ['pay', 'wrong_amount', 'timeout'], true);
        $params = $payment->provider === BillingPayment::SSLCOMMERZ
            ? ['tran_id' => $payment->id, 'val_id' => 'FAKEBVAL'.strtoupper(substr($payment->id, -16)),
                'status' => $paid ? 'VALID' : ($outcome === 'cancel' ? 'CANCELLED' : 'FAILED')]
            : ['paymentID' => (string) $state['provider_payment_id'], 'status' => $paid ? 'success' : ($outcome === 'cancel' ? 'cancel' : 'failure')];
        $url = (string) $state['return_url'];

        return $url.(str_contains($url, '?') ? '&' : '?').http_build_query($params);
    }

    private function report(BillingPayment $payment, ?string $outcome): Verification
    {
        $raw = ['fake' => true, 'outcome' => $outcome];
        $trx = 'FAKEBTRX'.strtoupper(substr($payment->id, -12));

        return match ($outcome) {
            'pay', 'timeout' => new Verification(Verification::SUCCEEDED, $payment->amount, 'BDT', $payment->id, $trx, null, $raw),
            'wrong_amount' => new Verification(Verification::SUCCEEDED, $payment->amount + 1, 'BDT', $payment->id, $trx, null, $raw),
            'fail' => new Verification(Verification::FAILED, $payment->amount, 'BDT', $payment->id, null, 'payment_failed', $raw),
            'cancel' => new Verification(Verification::CANCELLED, $payment->amount, 'BDT', $payment->id, null, 'cancelled_by_payer', $raw),
            default => new Verification(Verification::PENDING, null, null, $payment->id, null, null, $raw),
        };
    }

    /** @param array<string, mixed> $changes */
    private function remember(string $paymentId, array $changes): void
    {
        Cache::put(self::key($paymentId), array_merge($this->state($paymentId) ?? [], $changes), now()->addHours(26));
    }

    private static function key(string $paymentId): string
    {
        return 'billing:fake:'.$paymentId;
    }
}

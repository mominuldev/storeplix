<?php

declare(strict_types=1);

namespace App\Domain\Sms\Credits;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Gateways\PlatformCredentials;
use App\Domain\Billing\InvoiceService;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\PlanChangeService;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-9A §5.3 (P89A-9): buy an SMS credit pack = issue a platform billing invoice `kind sms_credits` and start the
 * Phase 7 platform payment. Credits come ONLY from BillingPaymentService::confirm() after server-side verification
 * (rule 8, S212); the client never sends credits or amounts. Same Idempotency-Key + same body → the same invoice and
 * payment; another body → 409 `idempotency_key_mismatch`.
 */
final class SmsCreditPurchaseService
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly InvoiceService $invoices,
        private readonly PlanChangeService $plans,
        private readonly BillingPaymentService $payments,
    ) {}

    /** @return array{invoice: BillingInvoice, payment: BillingPayment} */
    public function purchase(string $packCode, string $provider, string $idempotencyKey, Authenticatable $user): array
    {
        $pack = self::pack($packCode);
        if (! in_array($provider, PlatformCredentials::providers(), true)) {
            throw new ApiException(422, 'billing_gateway_unavailable', 'This payment method is not available right now.', ['provider' => ['This payment method is not available right now.']]);
        }
        $tenantId = $this->context->requireId();

        $invoice = BillingLock::run($tenantId, fn () => DB::transaction(function () use ($pack, $provider, $idempotencyKey, $user) {
            $existing = BillingInvoice::query()->where('idempotency_key', $idempotencyKey)->first();
            if ($existing !== null) {
                $payment = BillingPayment::query()->where('idempotency_key', $idempotencyKey)->first();
                if ($existing->kind !== BillingInvoice::SMS_CREDITS || (int) $existing->sms_credits !== $pack['credits']
                    || $existing->total_amount !== $pack['price_amount'] || ($payment !== null && $payment->provider !== $provider)) {
                    throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
                }

                return $existing;
            }

            return $this->invoices->issueSmsCredits($this->plans->current(), $pack, (string) $user->getAuthIdentifier(), $idempotencyKey);
        }));

        $payment = $this->payments->pay($invoice, $provider, $idempotencyKey, $user); // 502 provider_unavailable keeps the invoice open

        return ['invoice' => $invoice->refresh(), 'payment' => $payment];
    }

    /** @return array{code: string, credits: int, price_amount: int} */
    public static function pack(string $code): array
    {
        $pack = config('sms.packs.'.$code);
        if (! is_array($pack)) {
            throw new ApiException(422, 'validation_failed', 'Choose an SMS credit pack.', ['pack' => ['Choose an SMS credit pack.']]);
        }

        return ['code' => $code, 'credits' => (int) $pack['credits'], 'price_amount' => (int) $pack['price_amount']];
    }

    /** @return list<array{code: string, credits: int, price_amount: int, currency: string}> SmsCreditPack[] in config order */
    public static function packs(): array
    {
        $out = [];
        foreach ((array) config('sms.packs', []) as $code => $pack) {
            $out[] = ['code' => (string) $code, 'credits' => (int) $pack['credits'], 'price_amount' => (int) $pack['price_amount'], 'currency' => 'BDT'];
        }

        return $out;
    }
}

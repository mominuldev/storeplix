<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Gateways\BillingGatewayManager;
use App\Domain\Billing\Gateways\ChargeParty;
use App\Domain\Billing\Jobs\RenderBillingInvoicePdf;
use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\PayloadScrubber;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Sms\Credits\SmsCreditService;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Billing payments (P7-9–P7-14, §3.4). Drivers only REPORT; `confirm()` decides: an invoice is paid only when the
 * provider reports final success AND amount = invoice total (exact paisa) AND currency BDT AND reference = our payment
 * id. Gateways are called OUTSIDE any transaction; every state change is a conditional update under BillingLock.
 */
final class BillingPaymentService
{
    /** Failure codes that are final: never re-queried (the provider already took a decision we refused). */
    public const MISMATCH_CODES = ['amount_mismatch', 'currency_mismatch', 'reference_mismatch'];

    public function __construct(
        private readonly TenantContext $context,
        private readonly BillingGatewayManager $gateways,
        private readonly PlanChangeService $plans,
        private readonly AuditLogger $audit,
        private readonly BillingNotifier $notifier,
        private readonly SmsCreditService $credits,
    ) {}

    /**
     * POST /billing/invoices/{invoice}/pay. Same Idempotency-Key → the same payment (409 mismatch for another invoice
     * or provider). 409 invoice_not_open, 422 billing_gateway_unavailable, 502 provider_unavailable.
     */
    public function pay(BillingInvoice $invoice, string $provider, string $idempotencyKey, Authenticatable $user): BillingPayment
    {
        $existing = BillingPayment::query()->where('idempotency_key', $idempotencyKey)->first();
        if ($existing !== null) {
            if ($existing->invoice_id !== $invoice->id || $existing->provider !== $provider) {
                throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
            }

            return $existing;
        }
        $gateway = $this->gateways->driver($provider); // 422 billing_gateway_unavailable

        $payment = BillingLock::run($invoice->tenant_id, fn () => DB::transaction(function () use ($invoice, $provider, $idempotencyKey, $user) {
            $row = BillingInvoice::query()->whereKey($invoice->id)->lockForUpdate()->first();
            if ($row === null || $row->status !== BillingInvoice::OPEN) {
                throw new ApiException(409, 'invoice_not_open', 'This invoice is already paid or void.');
            }
            $payment = new BillingPayment;
            $payment->forceFill([
                'invoice_id' => $row->id,
                'provider' => $provider,
                'status' => BillingPayment::PENDING,
                'amount' => $row->total_amount,
                'currency' => 'BDT',
                'expires_at' => now()->addMinutes((int) config('billing.payment_hold_minutes', 30)),
                'initiated_by' => $user->getAuthIdentifier(),
                'idempotency_key' => $idempotencyKey,
            ]);
            try {
                $payment->save();
            } catch (UniqueConstraintViolationException) {
                throw new ApiException(409, 'idempotency_key_in_use', 'This request is still being processed. Try again in a moment.');
            }
            $this->audit->log('billing.payment_initiated', $payment, ['invoice' => $row->number, 'provider' => $provider, 'amount' => $row->total_amount], $user);

            return $payment;
        }));

        try {
            $initiation = $gateway->initiate($payment, $this->party($invoice), BillingUrls::returnUrl($payment), $provider === BillingPayment::SSLCOMMERZ ? BillingUrls::ipnUrl() : null);
            if (! BillingUrls::allowedRedirect($provider, $initiation->redirectUrl)) {
                throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE, 'Unexpected provider page.');
            }
        } catch (Throwable $e) {
            if (! $e instanceof GatewayException) {
                report($e);
            }
            Log::warning('billing.initiation_failed', ['payment_id' => $payment->id, 'provider' => $provider, 'code' => $e instanceof GatewayException ? $e->errorCode : 'error']);
            $this->finish($payment, BillingPayment::FAILED, 'initiation_failed');
            throw new ApiException(502, 'provider_unavailable', 'The payment provider did not answer. Try again in a moment.');
        }

        DB::table('billing_payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)->update([
            'provider_payment_id' => $initiation->providerPaymentId !== null ? mb_substr($initiation->providerPaymentId, 0, 64) : null,
            'raw' => json_encode(['redirect_url' => $initiation->redirectUrl, 'answers' => [['initiate' => PayloadScrubber::scrub($initiation->raw)]]]),
            'updated_at' => now(),
        ]);

        return $payment->refresh();
    }

    /** Browser return trigger (B22): Execute / Validation, then confirm. Provider errors leave it pending (reconcile). */
    public function handleReturn(BillingPayment $payment, array $params): void
    {
        if ($payment->status === BillingPayment::SUCCEEDED || in_array($payment->failure_code, self::MISMATCH_CODES, true)) {
            return;
        }
        try {
            $verification = $this->gateways->driver($payment->provider)->complete($payment, $params);
        } catch (GatewayException|ApiException $e) {
            Log::info('billing.return_unverified', ['payment_id' => $payment->id, 'code' => $e instanceof GatewayException ? $e->errorCode : $e->errorCode]);

            return;
        }
        $this->confirm($payment, $verification);
    }

    /** Reconcile / status poll: ask the provider and confirm; an expired pending payment becomes cancelled (P7-13). */
    public function refresh(BillingPayment $payment): BillingPayment
    {
        if ($payment->provider === BillingPayment::MANUAL || $payment->status === BillingPayment::SUCCEEDED
            || in_array($payment->failure_code, self::MISMATCH_CODES, true) || $payment->failure_code === 'initiation_failed') {
            return $payment;
        }
        try {
            $verification = $this->gateways->driver($payment->provider)->query($payment);
            DB::table('billing_payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)->update(['last_queried_at' => now()]);
            $this->confirm($payment, $verification);
        } catch (GatewayException|ApiException $e) {
            Log::info('billing.query_failed', ['payment_id' => $payment->id]);
            DB::table('billing_payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)->update(['last_queried_at' => now()]);
        }
        $payment->refresh();
        if ($payment->status === BillingPayment::PENDING && $payment->expires_at->isPast()) {
            $this->finish($payment, BillingPayment::CANCELLED, 'expired');
            $payment->refresh();
        }

        return $payment;
    }

    /** §3.4: the only place a billing payment succeeds and an invoice gets paid. */
    public function confirm(BillingPayment $payment, Verification $verification, ?Authenticatable $actor = null): BillingPayment
    {
        $this->remember($payment, $verification);
        if ($verification->status === Verification::PENDING) {
            return $payment;
        }
        if ($verification->status !== Verification::SUCCEEDED) {
            $this->finish($payment, $verification->status === Verification::CANCELLED ? BillingPayment::CANCELLED : BillingPayment::FAILED,
                $verification->failureCode ?? ($verification->status === Verification::CANCELLED ? 'cancelled' : 'payment_failed'));

            return $payment->refresh();
        }

        return BillingLock::run($payment->tenant_id, function () use ($payment, $verification, $actor) {
            $invoice = BillingInvoice::query()->find($payment->invoice_id);
            $mismatch = match (true) {
                $invoice === null || $verification->amount !== $invoice->total_amount || $verification->amount !== $payment->amount => 'amount_mismatch',
                strtoupper((string) $verification->currency) !== 'BDT' => 'currency_mismatch',
                strtolower((string) $verification->reference) !== $payment->id => 'reference_mismatch',
                default => null,
            };
            if ($mismatch !== null) {
                $this->finish($payment, BillingPayment::FAILED, $mismatch, force: true);
                $this->notifier->ops('payment_mismatch', ['tenant' => $payment->tenant_id, 'number' => $invoice?->number, 'payment' => $payment->id,
                    'detail' => $mismatch.' (reported '.($verification->amount !== null ? Money::bdt($verification->amount) : 'no amount').')']);

                return $payment->refresh();
            }

            $result = DB::transaction(function () use ($payment, $invoice, $verification, $actor) {
                $now = now();
                $moved = DB::table('billing_payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)
                    ->whereIn('status', [BillingPayment::PENDING, BillingPayment::FAILED, BillingPayment::CANCELLED])
                    ->where(fn ($q) => $q->whereNull('failure_code')->orWhereNotIn('failure_code', self::MISMATCH_CODES))
                    ->update([
                        'status' => BillingPayment::SUCCEEDED, 'failure_code' => null, 'verified_at' => $now, 'updated_at' => $now,
                        'provider_trx_id' => $verification->providerTrxId !== null ? mb_substr($verification->providerTrxId, 0, 64) : null,
                    ]);
                if ($moved !== 1) {
                    return null; // somebody else confirmed it first
                }
                $this->audit->log('billing.payment_succeeded', $payment, ['invoice' => $invoice->number, 'provider' => $payment->provider, 'amount' => $payment->amount], $actor, system: $actor === null);

                return $this->payInvoice($invoice->refresh(), $payment, $actor);
            });

            $payment->refresh();
            if (($result === 'paid' || $result === 'late') && $invoice->kind === BillingInvoice::SMS_CREDITS) {
                RenderBillingInvoicePdf::dispatch($invoice->id)->forTenant($invoice->tenant_id)->afterCommit();
                $this->notifier->owner(BillingMail::SMS_CREDITS_ADDED, [
                    'number' => $invoice->number, 'amount' => Money::bdt($invoice->total_amount),
                    'credits' => number_format((int) $invoice->sms_credits), 'balance' => number_format($this->credits->balance()),
                ]);
                $this->notifier->ownerSms(PlatformSmsType::PaymentReceived, ['invoice_no' => (string) $invoice->number,
                    'amount' => Money::plain((int) $invoice->total_amount), 'plan' => 'SMS credits']);
            } elseif ($result === 'paid' || $result === 'late') {
                RenderBillingInvoicePdf::dispatch($invoice->id)->forTenant($invoice->tenant_id)->afterCommit();
                $subscription = $this->plans->current();
                $this->notifier->owner(BillingMail::PAYMENT_RECEIVED, [
                    'number' => $invoice->number, 'amount' => Money::bdt($invoice->total_amount), 'plan' => $invoice->plan->name,
                    'date' => BillingNotifier::date($subscription->current_period_end),
                ]);
                $this->notifier->ownerSms(PlatformSmsType::PaymentReceived, ['invoice_no' => (string) $invoice->number,
                    'amount' => Money::plain((int) $invoice->total_amount), 'plan' => (string) $invoice->plan->name]);
            } elseif ($result === 'duplicate') {
                $this->notifier->ops('payment_duplicate', ['tenant' => $payment->tenant_id, 'number' => $invoice->number, 'payment' => $payment->id,
                    'detail' => 'duplicate payment of '.Money::bdt($payment->amount)]);
            }

            return $payment;
        });
    }

    /**
     * Invoice side of a verified payment (P7-14): open → paid; void → paid late (unless another invoice was paid since);
     * already paid (or paid-since) → the payment is a duplicate. Returns paid | late | duplicate.
     *
     * PHASE-8-9A §5.3 step 4: an `sms_credits` invoice has no "paid since" rule (void → paid late: the money was taken)
     * and grants its credits in this same transaction (SmsCreditService::grantForInvoice, once per invoice); it never
     * reaches plans->applyPaidInvoice.
     */
    private function payInvoice(BillingInvoice $invoice, BillingPayment $payment, ?Authenticatable $actor): string
    {
        $now = now();
        $late = false;
        $sms = $invoice->kind === BillingInvoice::SMS_CREDITS;
        if ($sms) {
            $late = $invoice->status === BillingInvoice::VOID;
        } elseif ($invoice->status === BillingInvoice::VOID) {
            $paidSince = BillingInvoice::query()->subscriptionKinds()->where('status', BillingInvoice::PAID)->where('paid_at', '>', $invoice->issued_at)->exists();
            $late = ! $paidSince;
        }
        $from = $late ? BillingInvoice::VOID : BillingInvoice::OPEN;
        $affected = ($invoice->status === $from) ? DB::table('billing_invoices')->where('id', $invoice->id)->where('tenant_id', $invoice->tenant_id)
            ->where('status', $from)->update([
                'status' => BillingInvoice::PAID, 'paid_at' => $now, 'paid_payment_id' => $payment->id, 'paid_late' => $late, 'updated_at' => $now,
            ]) : 0;

        if ($affected !== 1) {
            DB::table('billing_payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)->update(['is_duplicate' => true]);
            $this->audit->log('billing.payment_duplicate', $payment, ['invoice' => $invoice->number, 'amount' => $payment->amount], system: true);

            return 'duplicate';
        }
        $invoice->refresh();
        $this->audit->log('billing.invoice_paid', $invoice, ['number' => $invoice->number, 'late' => $late, 'payment' => $payment->id], $actor, system: $actor === null);
        if ($sms) {
            $this->credits->grantForInvoice($invoice, $actor);
        } else {
            $this->plans->applyPaidInvoice($invoice, $late, $actor);
        }

        return $late ? 'late' : 'paid';
    }

    /** pending (or a non-final failure) → failed | cancelled. $force also overrides a pending/failed row with a mismatch. */
    private function finish(BillingPayment $payment, string $status, ?string $code, bool $force = false): void
    {
        $now = now();
        $from = $force ? [BillingPayment::PENDING, BillingPayment::FAILED, BillingPayment::CANCELLED] : [BillingPayment::PENDING];
        $affected = DB::table('billing_payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)
            ->whereIn('status', $from)->update(['status' => $status, 'failure_code' => $code !== null ? mb_substr($code, 0, 48) : null, 'updated_at' => $now]);
        if ($affected === 1) {
            $this->audit->log('billing.payment_failed', $payment, ['status' => $status, 'failure_code' => $code, 'provider' => $payment->provider], system: true);
        }
    }

    /** Keeps the last 5 scrubbed provider answers (never returned by the API). */
    private function remember(BillingPayment $payment, Verification $verification): void
    {
        $raw = DB::table('billing_payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)->value('raw');
        $raw = is_string($raw) ? (json_decode($raw, true) ?: []) : [];
        $answers = array_slice([...((array) ($raw['answers'] ?? [])), [$verification->status => PayloadScrubber::scrub($verification->raw)]], -5);
        DB::table('billing_payments')->where('id', $payment->id)->where('tenant_id', $payment->tenant_id)
            ->update(['raw' => json_encode(['answers' => $answers] + $raw)]);
    }

    private function party(BillingInvoice $invoice): ChargeParty
    {
        $owner = BillingNotifier::ownerUser();
        $plan = $invoice->plan;

        return new ChargeParty(
            (string) ($owner->name ?? $invoice->bill_to['name'] ?? 'Storeplix merchant'),
            $owner?->email,
            $owner?->phone,
            InvoiceService::billingCity(),
            $invoice->kind === BillingInvoice::SMS_CREDITS || $plan === null
                ? InvoiceService::smsCreditsDescription((int) $invoice->sms_credits)
                : BillingQuoteService::planDescription($plan, (string) $invoice->interval),
            $invoice->number,
        );
    }

    /** Pending payments show the provider page link only while they can still be paid (§9 redirect_url). */
    public static function redirectUrl(BillingPayment $payment): ?string
    {
        if ($payment->status !== BillingPayment::PENDING || $payment->expires_at->isPast()) {
            return null;
        }
        $url = $payment->raw['redirect_url'] ?? null;

        return is_string($url) ? $url : null;
    }
}

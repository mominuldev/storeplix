<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Resources;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;

/** Output shapes of PHASE-7 §9 (BillingInvoiceSummary, BillingInvoice, BillingPayment, BillingQuote, ChangePlanResult). */
final class BillingPresenter
{
    /** @return array<string, mixed> */
    public static function invoiceSummary(BillingInvoice $invoice): array
    {
        return [
            'id' => $invoice->id,
            'number' => $invoice->number,
            'kind' => $invoice->kind,
            'status' => $invoice->status,
            'description' => (string) ($invoice->lines[0]['description'] ?? ''),
            'total_amount' => $invoice->total_amount,
            'currency' => 'BDT',
            'issued_at' => $invoice->issued_at->toIso8601ZuluString(),
            'due_at' => $invoice->due_at->toIso8601ZuluString(),
            'paid_at' => $invoice->paid_at?->toIso8601ZuluString(),
            'is_overdue' => $invoice->isOverdue(),
            'can_pay' => $invoice->isOpen() && Permission::ManageBilling->grantedTo(app(TenantContext::class)->role()),
        ];
    }

    /** @return array<string, mixed> */
    public static function invoice(BillingInvoice $invoice): array
    {
        $invoice->loadMissing('plan');
        $bill = (array) $invoice->bill_to;

        return self::invoiceSummary($invoice) + [
            'plan_code' => $invoice->plan->code,
            'interval' => $invoice->interval,
            'subtotal_amount' => $invoice->subtotal_amount,
            'tax_amount' => $invoice->tax_amount,
            'tax_rate_bps' => $invoice->tax_rate_bps,
            'credit_amount' => $invoice->credit_amount,
            'lines' => array_map(fn (array $l) => [
                'description' => (string) $l['description'],
                'plan_code' => $l['plan_code'] ?? null,
                'interval' => $l['interval'] ?? null,
                'period_start' => $l['period_start'] ?? null,
                'period_end' => $l['period_end'] ?? null,
                'quantity' => (int) ($l['quantity'] ?? 1),
                'unit_amount' => (int) ($l['unit_amount'] ?? $l['amount']),
                'amount' => (int) $l['amount'],
            ], $invoice->lines),
            'bill_to' => [
                'name' => (string) ($bill['name'] ?? ''),
                'address' => $bill['address'] ?? null,
                'email' => $bill['email'] ?? null,
                'phone' => $bill['phone'] ?? null,
            ],
            'period_start' => $invoice->period_start?->toIso8601ZuluString(),
            'period_end' => $invoice->period_end?->toIso8601ZuluString(),
            'voided_at' => $invoice->voided_at?->toIso8601ZuluString(),
            'void_reason' => $invoice->void_reason,
            'paid_late' => $invoice->paid_late,
            'payments' => $invoice->payments()->orderBy('created_at')->get()->map(fn (BillingPayment $p) => self::payment($p))->all(),
        ];
    }

    /** @return array<string, mixed> */
    public static function payment(BillingPayment $payment): array
    {
        return [
            'id' => $payment->id,
            'invoice_id' => $payment->invoice_id,
            'provider' => $payment->provider,
            'status' => $payment->status,
            'amount' => $payment->amount,
            'currency' => 'BDT',
            'redirect_url' => BillingPaymentService::redirectUrl($payment),
            'failure_code' => $payment->failure_code,
            'is_duplicate' => $payment->is_duplicate,
            'created_at' => $payment->created_at->toIso8601ZuluString(),
            'expires_at' => $payment->expires_at->toIso8601ZuluString(),
            'verified_at' => $payment->verified_at?->toIso8601ZuluString(),
        ];
    }

    /**
     * @param  array<string, mixed>  $quote  BillingQuoteService::quote()
     * @return array<string, mixed>
     */
    public static function quote(array $quote): array
    {
        /** @var Plan $plan */
        $plan = $quote['plan'];

        return [
            'kind' => $quote['kind'],
            'plan' => PlanPresenter::plan($plan),
            'interval' => $quote['interval'],
            'amount' => $quote['amount'],
            'credit_amount' => $quote['credit_amount'],
            'currency' => 'BDT',
            'requires_payment' => $quote['requires_payment'],
            'effective_at' => $quote['effective_at']->toIso8601ZuluString(),
            'period_start' => $quote['period_start']?->toIso8601ZuluString(),
            'period_end' => $quote['period_end']?->toIso8601ZuluString(),
            'lines' => $quote['lines'],
            'warnings' => $quote['warnings'],
        ];
    }

    /** @return array<string, mixed> ChangePlanResult */
    public static function changeResult(Subscription $subscription, ?BillingInvoice $invoice): array
    {
        return [
            'subscription' => PlanPresenter::subscription($subscription->loadMissing('plan')),
            'invoice' => $invoice !== null ? self::invoice($invoice) : null,
        ];
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\Support\InvoiceNumberAllocator;
use App\Domain\Billing\Support\VatCalculator;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * P7-7 / P7-15: issues and voids Storeplix invoices. One open invoice per tenant: issuing voids the old open one
 * (`superseded`) in the same transaction. Call inside the tenant context, under BillingLock, inside a transaction.
 */
final class InvoiceService
{
    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * @param  list<array<string, mixed>>  $lines
     */
    public function issue(
        Subscription $subscription,
        string $kind,
        Plan $plan,
        string $interval,
        int $total,
        int $credit,
        array $lines,
        ?Carbon $periodStart,
        ?Carbon $periodEnd,
        Carbon $dueAt,
        ?string $createdBy = null,
        ?string $idempotencyKey = null,
    ): BillingInvoice {
        $open = BillingInvoice::query()->subscriptionKinds()->where('status', BillingInvoice::OPEN)->lockForUpdate()->first();
        if ($open !== null) {
            $this->void($open, BillingInvoice::VOID_SUPERSEDED);
        }

        $now = now();
        $invoice = new BillingInvoice;
        $invoice->forceFill(VatCalculator::split($total) + [
            'subscription_id' => $subscription->id,
            'number' => InvoiceNumberAllocator::next((int) $now->format('Y')),
            'kind' => $kind,
            'status' => BillingInvoice::OPEN,
            'plan_id' => $plan->id,
            'interval' => $interval,
            'currency' => 'BDT',
            'total_amount' => $total,
            'credit_amount' => $credit,
            'lines' => $lines,
            'bill_to' => self::billTo(),
            'period_start' => $periodStart,
            'period_end' => $periodEnd,
            'issued_at' => $now,
            'due_at' => $dueAt,
            'reminders' => [],
            'created_by' => $createdBy,
            'idempotency_key' => $idempotencyKey,
        ]);
        $invoice->save();

        $this->audit->log('billing.invoice_issued', $invoice, [
            'number' => $invoice->number, 'kind' => $kind, 'plan' => $plan->code, 'interval' => $interval, 'total_amount' => $total,
        ], system: $createdBy === null);

        return $invoice;
    }

    /**
     * PHASE-8-9A §5.3 step 2: an SMS credit pack invoice (`kind sms_credits`, no plan / interval, `sms_credits` = pack
     * credits, one line "SMS credits · 5,000", VAT-inclusive split, due in 24 h). Voids an older open `sms_credits`
     * invoice (`superseded`) and never touches subscription invoices. Under BillingLock, in a transaction, in the tenant.
     *
     * @param  array{credits: int, price_amount: int}  $pack
     */
    public function issueSmsCredits(Subscription $subscription, array $pack, ?string $createdBy = null, ?string $idempotencyKey = null): BillingInvoice
    {
        $open = BillingInvoice::query()->where('kind', BillingInvoice::SMS_CREDITS)->where('status', BillingInvoice::OPEN)->lockForUpdate()->first();
        if ($open !== null) {
            $this->void($open, BillingInvoice::VOID_SUPERSEDED, system: $createdBy === null);
        }
        $now = now();
        $total = (int) $pack['price_amount'];
        $credits = (int) $pack['credits'];
        $invoice = new BillingInvoice;
        $invoice->forceFill(VatCalculator::split($total) + [
            'subscription_id' => $subscription->id,
            'number' => InvoiceNumberAllocator::next((int) $now->format('Y')),
            'kind' => BillingInvoice::SMS_CREDITS,
            'status' => BillingInvoice::OPEN,
            'plan_id' => null,
            'interval' => null,
            'sms_credits' => $credits,
            'currency' => 'BDT',
            'total_amount' => $total,
            'credit_amount' => 0,
            'lines' => [[
                'description' => self::smsCreditsDescription($credits), 'plan_code' => null, 'interval' => null,
                'period_start' => null, 'period_end' => null, 'quantity' => 1, 'unit_amount' => $total, 'amount' => $total,
            ]],
            'bill_to' => self::billTo(),
            'period_start' => null,
            'period_end' => null,
            'issued_at' => $now,
            'due_at' => $now->copy()->addHours((int) config('sms.invoice_hours', 24)),
            'reminders' => [],
            'created_by' => $createdBy,
            'idempotency_key' => $idempotencyKey,
        ]);
        $invoice->save();

        $this->audit->log('billing.invoice_issued', $invoice, [
            'number' => $invoice->number, 'kind' => BillingInvoice::SMS_CREDITS, 'sms_credits' => $credits, 'total_amount' => $total,
        ], system: $createdBy === null);

        return $invoice;
    }

    /** "SMS credits · 5,000" (invoice line, PDF, provider description). */
    public static function smsCreditsDescription(int $credits): string
    {
        return 'SMS credits · '.number_format($credits);
    }

    /**
     * open → void (conditional). Returns false when the invoice was no longer open.
     * PHASE-8-1 P8-8: `$actor` (staff) and `$meta` (merged over the default meta) for the admin void.
     *
     * @param  array<string, mixed>  $meta
     */
    public function void(BillingInvoice $invoice, string $reason, bool $system = true, ?Authenticatable $actor = null, array $meta = []): bool
    {
        $now = now();
        $affected = DB::table('billing_invoices')->where('id', $invoice->id)->where('tenant_id', $invoice->tenant_id)
            ->where('status', BillingInvoice::OPEN)
            ->update(['status' => BillingInvoice::VOID, 'void_reason' => $reason, 'voided_at' => $now, 'updated_at' => $now]);
        if ($affected !== 1) {
            return false;
        }
        $invoice->forceFill(['status' => BillingInvoice::VOID, 'void_reason' => $reason, 'voided_at' => $now]);
        $this->audit->log('billing.invoice_voided', $invoice, $meta + ['number' => $invoice->number, 'reason' => $reason], $actor,
            system: $system && $actor === null, platform: $actor !== null ? true : null);

        return true;
    }

    /**
     * Snapshot of who the invoice is issued to (P7-15): the store's name, business address and contact; the owner's
     * email/phone as a fallback. "Edit billing details" = Settings → Store details.
     *
     * @return array{name: string, address: string|null, email: string|null, phone: string|null}
     */
    public static function billTo(): array
    {
        $store = Store::query()->first();
        $settings = $store !== null ? StoreSetting::query()->where('store_id', $store->id)->first() : null;
        $owner = BillingNotifier::ownerUser();
        $address = $settings?->business_address ?? [];
        $parts = array_values(array_filter([
            $address['street'] ?? null, $address['area'] ?? null, $address['district'] ?? null, $address['postcode'] ?? null,
        ], fn ($v) => is_string($v) && trim($v) !== ''));

        return [
            'name' => (string) ($store?->name ?? Tenant::query()->whereKey(app(TenantContext::class)->id())->value('name') ?? 'Store'),
            'address' => $parts !== [] ? implode(', ', $parts) : null,
            'email' => $settings?->contact_email ?: $owner?->email,
            'phone' => $settings?->contact_phone ?: $owner?->phone,
        ];
    }

    /** Store city for the provider (SSLCommerz cus_city), fallback Dhaka (P7-11). */
    public static function billingCity(): string
    {
        $store = Store::query()->first();
        $address = $store !== null ? (StoreSetting::query()->where('store_id', $store->id)->value('business_address') ?? null) : null;
        $address = is_string($address) ? (json_decode($address, true) ?: []) : (array) $address;
        $district = $address['district'] ?? null;

        return is_string($district) && $district !== '' ? $district : 'Dhaka';
    }
}

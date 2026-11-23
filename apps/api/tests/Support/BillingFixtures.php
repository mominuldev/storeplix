<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Gateways\FakeBillingGateway;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/** Phase 7 helpers: plan changes, invoices and fake platform payments through the API. */
trait BillingFixtures
{
    use DomainFixtures;

    /** @param array<string, string> $h */
    protected function changePlan(array $h, string $plan, string $interval = 'month', ?string $key = null): TestResponse
    {
        return $this->flushHeaders()->withHeaders($h + ['Idempotency-Key' => $key ?? (string) Str::ulid()])
            ->postJson('/api/v1/billing/change-plan', ['plan_code' => $plan, 'interval' => $interval]);
    }

    /** @param array<string, string> $h */
    protected function payInvoice(array $h, string $invoiceId, string $provider = 'bkash', ?string $key = null): TestResponse
    {
        return $this->flushHeaders()->withHeaders($h + ['Idempotency-Key' => $key ?? (string) Str::ulid()])
            ->postJson("/api/v1/billing/invoices/{$invoiceId}/pay", ['provider' => $provider]);
    }

    /** Presses a fake page button and follows the browser to the signed return URL. Returns the return response. */
    protected function fakeOutcome(Tenant $tenant, string $paymentId, string $outcome = 'pay'): TestResponse
    {
        $target = $this->inTenant($tenant, fn () => app(FakeBillingGateway::class)->recordOutcome(BillingPayment::query()->findOrFail($paymentId), $outcome));
        $this->assertNotNull($target);

        return $this->flushHeaders()->get($target);
    }

    /** change-plan → pay → fake outcome. @return array{invoice: string, payment: string} */
    protected function buyPlan(array $h, Tenant $tenant, string $plan, string $interval = 'month', string $provider = 'bkash', string $outcome = 'pay'): array
    {
        $invoice = $this->changePlan($h, $plan, $interval)->assertCreated()->json('data.invoice.id');
        $payment = $this->payInvoice($h, $invoice, $provider)->assertCreated()->json('data.id');
        $this->fakeOutcome($tenant, $payment, $outcome)->assertStatus(303);

        return ['invoice' => $invoice, 'payment' => $payment];
    }

    protected function subscriptionOf(Tenant $tenant): Subscription
    {
        return $this->inTenant($tenant, fn () => Subscription::query()->with(['plan', 'scheduledPlan'])->whereIn('status', Subscription::CURRENT_STATUSES)->sole());
    }

    protected function invoiceOf(Tenant $tenant, string $id): BillingInvoice
    {
        return $this->inTenant($tenant, fn () => BillingInvoice::query()->findOrFail($id));
    }

    protected function paymentOf(Tenant $tenant, string $id): BillingPayment
    {
        return $this->inTenant($tenant, fn () => BillingPayment::query()->findOrFail($id));
    }

    /** Puts the tenant on a paid plan for a fresh period (like an ops comp) without an invoice. */
    protected function onPaidPlan(Tenant $tenant, string $plan, string $interval = 'month', ?Carbon $start = null): Subscription
    {
        $start ??= now();
        $this->inTenant($tenant, fn () => Subscription::query()->whereIn('status', Subscription::CURRENT_STATUSES)->update([
            'plan_id' => Plan::query()->where('code', $plan)->value('id'),
            'status' => Subscription::ACTIVE,
            'billing_interval' => $interval,
            'trial_ends_at' => null,
            'current_period_start' => $start,
            'current_period_end' => $interval === 'year' ? $start->copy()->addYearNoOverflow() : $start->copy()->addMonthNoOverflow(),
        ]));
        FeatureGate::forget($tenant->id);

        return $this->subscriptionOf($tenant);
    }

    protected function runBilling(Tenant $tenant): void
    {
        $this->artisan('billing:run', ['--sync' => true])->assertExitCode(0);
    }
}

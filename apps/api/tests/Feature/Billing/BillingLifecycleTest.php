<?php

declare(strict_types=1);

namespace Tests\Feature\Billing;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Gateways\FakeBillingGateway;
use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\TestCase;

/** PHASE-7 §11 lifecycle on the fake gateway with a frozen clock. */
#[Group('billing')]
class BillingLifecycleTest extends TestCase
{
    use BillingFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $this->freezeSecond();
    }

    public function test_free_to_starter_new_payment_activates_the_plan(): void
    {
        [, $tenant, , $h] = $this->domainShop('free');
        $this->onPaidPlan($tenant, 'free');

        $change = $this->changePlan($h, 'starter')->assertCreated()
            ->assertJsonPath('data.invoice.kind', 'new')
            ->assertJsonPath('data.invoice.status', 'open')
            ->assertJsonPath('data.invoice.total_amount', 49900)
            ->assertJsonPath('data.invoice.tax_amount', 6508)
            ->assertJsonPath('data.invoice.subtotal_amount', 43392);
        $this->assertMatchesRegularExpression('/^SP-\d{4}-000001$/', $change->json('data.invoice.number'));

        $pay = $this->payInvoice($h, $change->json('data.invoice.id'))->assertCreated()
            ->assertJsonPath('data.status', 'pending')->assertJsonPath('data.amount', 49900);
        $this->assertStringContainsString('/api/v1/dev/fake-billing-gateway/', $pay->json('data.redirect_url'));

        $this->fakeOutcome($tenant, $pay->json('data.id'))
            ->assertStatus(303)->assertHeader('Location', 'http://localhost:5183/settings/plan?payment='.$pay->json('data.id'));

        $sub = $this->subscriptionOf($tenant);
        $this->assertSame('starter', $sub->plan->code);
        $this->assertSame(Subscription::ACTIVE, $sub->status);
        $this->assertTrue($sub->current_period_end->equalTo(now()->addMonthNoOverflow()));
        $this->assertTrue(FeatureGate::allows($tenant, Feature::CustomDomain));
        $invoice = $this->invoiceOf($tenant, $change->json('data.invoice.id'));
        $this->assertSame(BillingInvoice::PAID, $invoice->status);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'billing.invoice_paid')->exists());
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::PAYMENT_RECEIVED);

        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/billing/payments/'.$pay->json('data.id'))
            ->assertOk()->assertJsonPath('data.status', 'succeeded')->assertJsonPath('data.redirect_url', null);
    }

    public function test_paying_during_the_trial_keeps_the_unused_trial_days(): void
    {
        [, $tenant, , $h] = $this->shop();
        $trialEnd = $this->subscriptionOf($tenant)->trial_ends_at;
        $this->buyPlan($h, $tenant, 'growth');
        $sub = $this->subscriptionOf($tenant);
        $this->assertSame('growth', $sub->plan->code);
        $this->assertTrue($sub->current_period_end->equalTo($trialEnd->copy()->addMonthNoOverflow()));
    }

    public function test_trial_end_drops_to_free_then_detaches_custom_domains_after_the_grace(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $domain = $this->activeDomain($h, $tenant, $store, 'shop-a.localhost');
        $this->api($h, 'POST', $this->domainsUrl($store, "/{$domain->id}/primary"))->assertOk();

        $this->travel(15)->days();
        $this->runBilling($tenant);
        $sub = $this->subscriptionOf($tenant);
        $this->assertSame('free', $sub->plan->code);
        $this->assertSame(Subscription::ACTIVE, $sub->status);
        $this->assertTrue($sub->domain_grace_ends_at->equalTo(now()->addDays(7)));
        $this->assertSame(StoreDomain::STATUS_ACTIVE, $this->domainRow($tenant, $domain->id)->status, 'nothing detached during the grace');
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/features')->assertOk()
            ->assertJsonPath('data.plan_code', 'free')->assertJsonPath('data.domain_grace_ends_at', $sub->domain_grace_ends_at->toIso8601ZuluString());
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::DOMAIN_WILL_DETACH);

        $this->travel(7)->days();
        $this->runBilling($tenant);
        $row = $this->domainRow($tenant, $domain->id);
        $this->assertSame(StoreDomain::STATUS_EXPIRED, $row->status);
        $this->assertSame('plan_limit', $row->failure_code);
        $this->assertFalse((bool) $row->is_primary);
        $this->assertTrue($this->inTenant($tenant, fn () => StoreDomain::query()->where('type', 'platform')->where('is_primary', true)->exists()));
        $this->assertNull($this->subscriptionOf($tenant)->domain_grace_ends_at);

        // S66: a detached domain can't be revived on Free.
        $this->api($h, 'POST', $this->domainsUrl($store, "/{$domain->id}/verify"))->assertStatus(402)
            ->assertJsonPath('error.code', 'feature_not_in_plan')->assertJsonPath('error.details.upgrade_plan', ['starter']);
    }

    public function test_renewal_invoice_at_t_minus_7_paid_early_extends_the_period_once(): void
    {
        [, $tenant, , $h] = $this->shop();
        $sub = $this->onPaidPlan($tenant, 'starter');
        $end = $sub->current_period_end->copy();

        $this->travelTo($end->copy()->subDays(8));
        $this->runBilling($tenant);
        $this->assertSame(0, $this->inTenant($tenant, fn () => BillingInvoice::query()->count()));

        $this->travelTo($end->copy()->subDays(7));
        $this->runBilling($tenant);
        $this->runBilling($tenant); // idempotent
        $invoices = $this->inTenant($tenant, fn () => BillingInvoice::query()->get());
        $this->assertCount(1, $invoices);
        $invoice = $invoices->first();
        $this->assertSame('renewal', $invoice->kind);
        $this->assertTrue($invoice->period_start->equalTo($end));
        $this->assertTrue($invoice->due_at->equalTo($end));
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::INVOICE_ISSUED);

        $this->travelTo($end->copy()->subDays(3));
        $this->runBilling($tenant);
        $this->runBilling($tenant);
        $this->assertSame(['t-3'], $this->invoiceOf($tenant, $invoice->id)->reminders);
        Mail::assertQueuedCount(2 + 0); // issued + T-3 (no payment yet)

        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/subscription')->assertOk()
            ->assertJsonPath('data.open_invoice.id', $invoice->id)->assertJsonPath('data.open_invoice.can_pay', true);

        $payment = $this->payInvoice($h, $invoice->id, 'sslcommerz')->assertCreated()->json('data.id');
        $this->fakeOutcome($tenant, $payment)->assertStatus(303);
        $sub = $this->subscriptionOf($tenant);
        $this->assertTrue($sub->current_period_start->equalTo($end));
        $this->assertTrue($sub->current_period_end->equalTo($end->copy()->addMonthNoOverflow()));

        $this->travelTo($end->copy()->addHour());
        $this->runBilling($tenant);
        $this->assertSame(Subscription::ACTIVE, $this->subscriptionOf($tenant)->status);
        $this->assertSame(1, $this->inTenant($tenant, fn () => BillingInvoice::query()->count()));
    }

    public function test_unpaid_renewal_goes_past_due_keeps_features_and_payment_in_grace_restores_the_period(): void
    {
        [, $tenant, , $h] = $this->shop();
        $sub = $this->onPaidPlan($tenant, 'starter');
        $end = $sub->current_period_end->copy();
        $this->travelTo($end->copy()->subDays(7));
        $this->runBilling($tenant);
        $this->travelTo($end->copy()->addHour());
        $this->runBilling($tenant);

        $sub = $this->subscriptionOf($tenant);
        $this->assertSame(Subscription::PAST_DUE, $sub->status);
        $this->assertTrue($sub->grace_ends_at->equalTo($end->copy()->addDays(7)));
        $this->assertTrue(FeatureGate::allows($tenant, Feature::CustomDomain), 'P7-1: past_due keeps the paid plan');
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::PAST_DUE);
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/features')->assertJsonPath('data.subscription_status', 'past_due')
            ->assertJsonPath('data.grace_ends_at', $sub->grace_ends_at->toIso8601ZuluString());

        // Only Free (cancel) is accepted in past_due.
        $this->changePlan($h, 'growth')->assertStatus(409)->assertJsonPath('error.code', 'invoice_overdue');

        $invoice = $this->inTenant($tenant, fn () => BillingInvoice::query()->sole());
        $this->assertTrue($invoice->isOverdue());
        $this->travel(2)->days();
        $payment = $this->payInvoice($h, $invoice->id)->assertCreated()->json('data.id');
        $this->fakeOutcome($tenant, $payment);
        $sub = $this->subscriptionOf($tenant);
        $this->assertSame(Subscription::ACTIVE, $sub->status);
        $this->assertNull($sub->grace_ends_at);
        $this->assertTrue($sub->current_period_start->equalTo($end));
        $this->assertTrue($sub->current_period_end->equalTo($end->copy()->addMonthNoOverflow()));
    }

    public function test_grace_end_expires_to_a_new_free_row_voids_the_invoice_and_detaches_domains_at_once(): void
    {
        [, $tenant, $store, $h] = $this->domainShop('starter');
        $this->onPaidPlan($tenant, 'starter');
        $domain = $this->activeDomain($h, $tenant, $store, 'shop-b.localhost');
        $end = $this->subscriptionOf($tenant)->current_period_end->copy();
        $old = $this->subscriptionOf($tenant)->id;

        $this->travelTo($end->copy()->addHour());
        $this->runBilling($tenant); // past_due (issues the renewal invoice)
        $this->travelTo($end->copy()->addDays(6));
        $this->runBilling($tenant);
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::GRACE_ENDING);
        $this->travelTo($end->copy()->addDays(7)->addHour());
        $this->runBilling($tenant);

        $expired = $this->inTenant($tenant, fn () => Subscription::query()->findOrFail($old));
        $this->assertSame(Subscription::EXPIRED, $expired->status);
        $this->assertSame('unpaid', $expired->ended_reason);
        $this->assertNotNull($expired->ended_at);
        $free = $this->subscriptionOf($tenant);
        $this->assertNotSame($old, $free->id);
        $this->assertSame('free', $free->plan->code);
        $this->assertSame(Subscription::ACTIVE, $free->status);
        $invoice = $this->inTenant($tenant, fn () => BillingInvoice::query()->sole());
        $this->assertSame([BillingInvoice::VOID, 'unpaid'], [$invoice->status, $invoice->void_reason]);
        $this->assertSame(StoreDomain::STATUS_EXPIRED, $this->domainRow($tenant, $domain->id)->status);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'subscription.expired')->exists());
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::DROPPED_TO_FREE);

        // P7-14 late payment after expiry: the void invoice is paid late and starts a new term now.
        $payment = $this->inTenant($tenant, function () use ($invoice) {
            $p = new BillingPayment;
            $p->forceFill(['invoice_id' => $invoice->id, 'provider' => 'bkash', 'status' => 'cancelled', 'amount' => $invoice->total_amount,
                'currency' => 'BDT', 'expires_at' => now()->subMinute(), 'failure_code' => 'expired', 'provider_payment_id' => 'FAKEB1'])->save();

            return $p;
        });
        $this->inTenant($tenant, fn () => app(BillingPaymentService::class)->confirm($payment,
            new Verification('succeeded', $invoice->total_amount, 'BDT', $payment->id, 'TRXLATE1', null)));
        $invoice = $this->invoiceOf($tenant, $invoice->id);
        $this->assertSame([BillingInvoice::PAID, true], [$invoice->status, $invoice->paid_late]);
        $sub = $this->subscriptionOf($tenant);
        $this->assertSame('starter', $sub->plan->code);
        $this->assertTrue($sub->current_period_start->equalTo(now()));
    }

    public function test_upgrade_mid_period_is_prorated_and_the_renewal_invoice_is_reissued(): void
    {
        [, $tenant, , $h] = $this->shop();
        $sub = $this->onPaidPlan($tenant, 'starter');
        $start = $sub->current_period_start->copy();
        $end = $sub->current_period_end->copy();
        $this->travelTo($end->copy()->subDays(7));
        $this->runBilling($tenant);
        $renewal = $this->inTenant($tenant, fn () => BillingInvoice::query()->sole());

        $period = $end->getTimestamp() - $start->getTimestamp();
        $remaining = $end->getTimestamp() - now()->getTimestamp();
        $expected = (int) (ceil((149900 - 49900) * $remaining / $period / 100) * 100);
        $quote = $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/billing/quote', ['plan_code' => 'growth', 'interval' => 'month'])
            ->assertOk()->assertJsonPath('data.kind', 'upgrade')->assertJsonPath('data.amount', $expected)->assertJsonPath('data.requires_payment', true);
        $change = $this->changePlan($h, 'growth')->assertCreated()->assertJsonPath('data.invoice.total_amount', $quote->json('data.amount'));
        $this->assertSame([BillingInvoice::VOID, 'superseded'], [$this->invoiceOf($tenant, $renewal->id)->status, $this->invoiceOf($tenant, $renewal->id)->void_reason]);

        $payment = $this->payInvoice($h, $change->json('data.invoice.id'))->json('data.id');
        $this->fakeOutcome($tenant, $payment);
        $sub = $this->subscriptionOf($tenant);
        $this->assertSame('growth', $sub->plan->code);
        $this->assertTrue($sub->current_period_end->equalTo($end), 'period unchanged');

        $this->runBilling($tenant);
        $reissued = $this->inTenant($tenant, fn () => BillingInvoice::query()->where('kind', 'renewal')->where('status', 'open')->sole());
        $this->assertSame(149900, $reissued->total_amount);
    }

    public function test_month_to_year_upgrade_credits_the_unused_month(): void
    {
        [, $tenant, , $h] = $this->shop();
        $sub = $this->onPaidPlan($tenant, 'starter');
        $this->travel(10)->days();
        $period = $sub->current_period_end->getTimestamp() - $sub->current_period_start->getTimestamp();
        $remaining = $sub->current_period_end->getTimestamp() - now()->getTimestamp();
        $credit = intdiv(49900 * $remaining, $period);
        $total = (int) (ceil((499000 - $credit) / 100) * 100);

        $quote = $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/billing/quote', ['plan_code' => 'starter', 'interval' => 'year'])
            ->assertOk()->assertJsonPath('data.kind', 'upgrade')->assertJsonPath('data.amount', $total)
            ->assertJsonPath('data.credit_amount', 499000 - $total);
        $this->assertCount(2, $quote->json('data.lines'));
        $this->buyPlan($h, $tenant, 'starter', 'year');
        $sub = $this->subscriptionOf($tenant);
        $this->assertSame('year', $sub->billing_interval);
        $this->assertTrue($sub->current_period_end->equalTo(now()->addYearNoOverflow()));
    }

    public function test_downgrade_is_scheduled_kept_or_applied_at_period_end_with_a_lower_renewal(): void
    {
        [, $tenant, , $h] = $this->shop();
        $end = $this->onPaidPlan($tenant, 'growth')->current_period_end->copy();

        $this->changePlan($h, 'starter')->assertOk()->assertJsonPath('data.invoice', null)
            ->assertJsonPath('data.subscription.scheduled_change.plan.code', 'starter')
            ->assertJsonPath('data.subscription.scheduled_change.effective_at', $end->toIso8601ZuluString());
        $this->flushHeaders()->withHeaders($h)->deleteJson('/api/v1/billing/scheduled-change')->assertOk()->assertJsonPath('data.scheduled_change', null);
        $this->flushHeaders()->withHeaders($h)->deleteJson('/api/v1/billing/scheduled-change')->assertNotFound();
        $this->changePlan($h, 'starter')->assertOk();

        $this->travelTo($end->copy()->subDays(7));
        $this->runBilling($tenant);
        $renewal = $this->inTenant($tenant, fn () => BillingInvoice::query()->sole());
        $this->assertSame(49900, $renewal->total_amount, 'renewal at the lower price');
        $this->assertSame('growth', $this->subscriptionOf($tenant)->plan->code, 'growth until the period end');

        $payment = $this->payInvoice($h, $renewal->id)->json('data.id');
        $this->fakeOutcome($tenant, $payment);
        $this->assertSame('growth', $this->subscriptionOf($tenant)->plan->code);

        $this->travelTo($end->copy()->addHour());
        $this->runBilling($tenant);
        $sub = $this->subscriptionOf($tenant);
        $this->assertSame(['starter', Subscription::ACTIVE, null], [$sub->plan->code, $sub->status, $sub->scheduled_plan_id]);
        $this->assertTrue($sub->current_period_end->equalTo($end->copy()->addMonthNoOverflow()));
    }

    public function test_cancel_switches_to_free_at_period_end_and_cancel_in_past_due_is_immediate(): void
    {
        [, $tenant, , $h] = $this->shop();
        $end = $this->onPaidPlan($tenant, 'starter')->current_period_end->copy();
        $this->changePlan($h, 'free')->assertOk()->assertJsonPath('data.subscription.cancel_at_period_end', true);
        $this->travelTo($end->copy()->subDays(7));
        $this->runBilling($tenant);
        $this->assertSame(0, $this->inTenant($tenant, fn () => BillingInvoice::query()->count()), 'no renewal when the next plan is Free');
        $this->travelTo($end->copy()->addHour());
        $this->runBilling($tenant);
        $this->assertSame('free', $this->subscriptionOf($tenant)->plan->code);

        [, $tenant2, , $h2] = $this->shop('owner', 'two');
        $end2 = $this->onPaidPlan($tenant2, 'starter')->current_period_end->copy();
        $this->travelTo($end2->copy()->addHour());
        $this->runBilling($tenant2);
        $this->assertSame(Subscription::PAST_DUE, $this->subscriptionOf($tenant2)->status);
        $this->changePlan($h2, 'free')->assertOk()->assertJsonPath('data.subscription.plan.code', 'free')->assertJsonPath('data.invoice', null);
        $this->assertSame('cancelled', $this->inTenant($tenant2, fn () => Subscription::query()->where('status', 'expired')->sole()->ended_reason));
        $this->assertSame('cancelled', $this->inTenant($tenant2, fn () => BillingInvoice::query()->sole()->void_reason));
    }

    public function test_duplicate_payment_is_flagged_and_changes_the_plan_once(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->onPaidPlan($tenant, 'free');
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $first = $this->payInvoice($h, $invoice, 'bkash')->json('data.id');
        $second = $this->payInvoice($h, $invoice, 'sslcommerz')->json('data.id');
        $this->fakeOutcome($tenant, $first);
        $periodEnd = $this->subscriptionOf($tenant)->current_period_end;
        $this->fakeOutcome($tenant, $second);

        $this->assertTrue($this->paymentOf($tenant, $second)->is_duplicate);
        $this->assertSame('succeeded', $this->paymentOf($tenant, $second)->status);
        $this->assertTrue($this->subscriptionOf($tenant)->current_period_end->equalTo($periodEnd));
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'billing.payment_duplicate')->exists());
        // the same return twice (replay) changes nothing
        $this->fakeOutcome($tenant, $first)->assertStatus(303);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'billing.invoice_paid')->count());
    }

    public function test_change_invoice_is_voided_after_24_hours(): void
    {
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'growth')->json('data.invoice.id');
        $this->travel(25)->hours();
        $this->runBilling($tenant);
        $this->assertSame([BillingInvoice::VOID, 'expired'], [$this->invoiceOf($tenant, $invoice)->status, $this->invoiceOf($tenant, $invoice)->void_reason]);
        $this->payInvoice($h, $invoice)->assertStatus(409)->assertJsonPath('error.code', 'invoice_not_open');
    }

    public function test_timeout_then_reconcile_pays_and_expired_pending_payments_are_cancelled(): void
    {
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $payment = $this->payInvoice($h, $invoice)->json('data.id');
        $this->fakeOutcome($tenant, $payment, 'timeout')->assertStatus(303);
        $this->assertSame('pending', $this->paymentOf($tenant, $payment)->status);

        $this->travel(3)->minutes();
        $this->artisan('billing:reconcile-payments', ['--sync' => true])->assertExitCode(0);
        $this->assertSame('succeeded', $this->paymentOf($tenant, $payment)->status);
        $this->assertSame('starter', $this->subscriptionOf($tenant)->plan->code);

        $invoice2 = $this->changePlan($h, 'growth')->json('data.invoice.id');
        $abandoned = $this->payInvoice($h, $invoice2)->json('data.id');
        $this->travel(31)->minutes();
        $this->artisan('billing:reconcile-payments', ['--sync' => true])->assertExitCode(0);
        $this->assertSame(['cancelled', 'expired'], [$this->paymentOf($tenant, $abandoned)->status, $this->paymentOf($tenant, $abandoned)->failure_code]);
    }

    public function test_status_poll_queries_the_provider_after_10_seconds(): void
    {
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $payment = $this->payInvoice($h, $invoice)->json('data.id');
        $this->inTenant($tenant, fn () => app(FakeBillingGateway::class)
            ->recordOutcome(BillingPayment::query()->findOrFail($payment), 'pay'));
        $this->flushHeaders()->withHeaders($h)->getJson("/api/v1/billing/payments/{$payment}")->assertJsonPath('data.status', 'pending');
        $this->travel(11)->seconds();
        $this->flushHeaders()->withHeaders($h)->getJson("/api/v1/billing/payments/{$payment}")->assertJsonPath('data.status', 'succeeded');
    }

    public function test_ops_commands(): void
    {
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $number = $this->invoiceOf($tenant, $invoice)->number;
        $this->artisan('billing:mark-paid', ['invoice' => $number])->assertExitCode(1); // --reason required
        $this->artisan('billing:mark-paid', ['invoice' => $number, '--reference' => 'BANK-1', '--reason' => 'bank transfer'])->assertExitCode(0);
        $this->assertSame('paid', $this->invoiceOf($tenant, $invoice)->status);
        $this->assertSame('starter', $this->subscriptionOf($tenant)->plan->code);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'billing.manual_payment')->exists());

        $open = $this->changePlan($h, 'growth', 'month')->assertStatus(201);
        $this->artisan('billing:void', ['invoice' => $open->json('data.invoice.number'), '--reason' => 'test'])->assertExitCode(0);
        $this->assertSame('manual', $this->invoiceOf($tenant, $open->json('data.invoice.id'))->void_reason);

        $before = $this->subscriptionOf($tenant)->current_period_end;
        $this->artisan('billing:extend', ['tenant' => $tenant->id, '--days' => 5, '--reason' => 'support'])->assertExitCode(0);
        $this->assertTrue($this->subscriptionOf($tenant)->current_period_end->equalTo($before->copy()->addDays(5)));

        $this->artisan('billing:change-plan', ['tenant' => $tenant->id, 'plan' => 'growth', '--interval' => 'year', '--reason' => 'partner'])->assertExitCode(0);
        $this->assertSame(['growth', 'year'], [$this->subscriptionOf($tenant)->plan->code, $this->subscriptionOf($tenant)->billing_interval]);
        $this->artisan('billing:show', ['tenant' => $tenant->id])->assertExitCode(0);
    }
}

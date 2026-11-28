<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Credits;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Media\Models\Media;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Sms\Models\SmsCreditAccount;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\TestCase;

/**
 * PHASE-8-9A §5.3 (P89A-9, S212): an SMS credit pack is a platform billing invoice `kind sms_credits`; credits arrive
 * only after a server-verified payment, exactly once per invoice; SMS invoices never touch the subscription.
 */
#[Group('sms')]
#[Group('billing')]
#[Group('security')]
class SmsCreditPurchaseTest extends TestCase
{
    use BillingFixtures, RefreshDatabase, SmsCreditFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    private function account(Tenant $tenant): ?SmsCreditAccount
    {
        return $this->inTenant($tenant, fn () => SmsCreditAccount::query()->first());
    }

    /** @return list<SmsCreditLedgerEntry> */
    private function ledger(Tenant $tenant): array
    {
        return $this->inTenant($tenant, fn () => SmsCreditLedgerEntry::query()->orderBy('created_at')->orderBy('id')->get()->all());
    }

    public function test_purchase_issues_an_sms_credits_invoice_and_starts_a_payment(): void
    {
        [, $tenant, , $h] = $this->shop();
        $res = $this->buyPack($h, 'credits_5000')->assertCreated()
            ->assertJsonPath('data.invoice.kind', 'sms_credits')
            ->assertJsonPath('data.invoice.status', 'open')
            ->assertJsonPath('data.invoice.plan_code', null)
            ->assertJsonPath('data.invoice.interval', null)
            ->assertJsonPath('data.invoice.sms_credits', 5000)
            ->assertJsonPath('data.invoice.total_amount', 160000)
            ->assertJsonPath('data.invoice.description', 'SMS credits · 5,000')
            ->assertJsonPath('data.invoice.lines.0.amount', 160000)
            ->assertJsonPath('data.payment.status', 'pending')
            ->assertJsonPath('data.payment.amount', 160000)
            ->assertJsonPath('data.payment.provider', 'bkash');
        $this->assertSame(160000, $res->json('data.invoice.subtotal_amount') + $res->json('data.invoice.tax_amount'));
        $this->assertNotNull($res->json('data.payment.redirect_url'));
        $invoice = $this->invoiceOf($tenant, $res->json('data.invoice.id'));
        $this->assertEqualsWithDelta(now()->addHours(24)->getTimestamp(), $invoice->due_at->getTimestamp(), 5);
        $this->assertNull($this->account($tenant), 'no credits (and no account) before a verified payment');

        // The account read shows the open invoice, the packs in config order and the providers.
        $this->api($h, 'GET', '/api/v1/billing/sms-credits')->assertOk()
            ->assertJsonPath('data.balance', 0)->assertJsonPath('data.status', 'none')
            ->assertJsonPath('data.estimated_days_left', null)->assertJsonPath('data.low_credit_threshold', null)
            ->assertJsonPath('data.packs.0', ['code' => 'credits_1000', 'credits' => 1000, 'price_amount' => 35000, 'currency' => 'BDT'])
            ->assertJsonPath('data.packs.2.code', 'credits_10000')
            ->assertJsonPath('data.providers', ['bkash', 'sslcommerz'])
            ->assertJsonPath('data.open_invoice.id', $invoice->id)
            ->assertJsonPath('data.last_purchase_at', null);

        // Validation: pack and provider only; never credits or amounts.
        $this->buyPack($h, 'credits_2')->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->buyPack($h, 'credits_1000', 'nagad')->assertStatus(422);
        $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/billing/sms-credits/purchase', ['pack' => 'credits_1000', 'provider' => 'bkash'])
            ->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_idempotency_replay_and_mismatch(): void
    {
        [, $tenant, , $h] = $this->shop();
        $key = (string) Str::ulid();
        $first = $this->buyPack($h, 'credits_1000', 'bkash', $key)->assertCreated();
        $again = $this->buyPack($h, 'credits_1000', 'bkash', $key)->assertCreated();
        $this->assertSame($first->json('data.invoice.id'), $again->json('data.invoice.id'));
        $this->assertSame($first->json('data.payment.id'), $again->json('data.payment.id'));
        $this->buyPack($h, 'credits_5000', 'bkash', $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->buyPack($h, 'credits_1000', 'sslcommerz', $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->assertSame(1, $this->inTenant($tenant, fn () => BillingInvoice::query()->where('kind', 'sms_credits')->count()));
    }

    public function test_a_new_purchase_supersedes_only_the_older_sms_invoice(): void
    {
        [, $tenant, , $h] = $this->shop();
        $subscriptionInvoice = $this->changePlan($h, 'growth')->assertCreated()->json('data.invoice.id');
        $a = $this->buyPack($h)->assertCreated()->json('data.invoice.id');
        // Both open at once (one subscription + one SMS invoice).
        $this->assertSame('open', $this->invoiceOf($tenant, $subscriptionInvoice)->status);
        $this->assertSame('open', $this->invoiceOf($tenant, $a)->status);

        $b = $this->buyPack($h, 'credits_5000')->assertCreated()->json('data.invoice.id');
        $this->assertSame([BillingInvoice::VOID, 'superseded'], [$this->invoiceOf($tenant, $a)->status, $this->invoiceOf($tenant, $a)->void_reason]);
        $this->assertSame('open', $this->invoiceOf($tenant, $b)->status);
        $this->assertSame('open', $this->invoiceOf($tenant, $subscriptionInvoice)->status, 'subscription invoice untouched');

        // A plan change voids the old subscription invoice, never the SMS one.
        $this->changePlan($h, 'starter', 'year')->assertCreated();
        $this->assertSame('void', $this->invoiceOf($tenant, $subscriptionInvoice)->status);
        $this->assertSame('open', $this->invoiceOf($tenant, $b)->status);

        // The subscription banner ignores the SMS invoice; the invoice list filters by kind.
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/subscription')->assertOk()
            ->assertJsonPath('data.open_invoice.kind', fn ($kind) => $kind !== 'sms_credits');
        $this->api($h, 'GET', '/api/v1/billing/invoices?filter[kind]=sms_credits')->assertOk()->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.id', $b);
        $this->api($h, 'GET', '/api/v1/billing/invoices?filter[kind]=new,upgrade')->assertOk()
            ->assertJsonPath('data', fn ($rows) => collect($rows)->every(fn ($r) => $r['kind'] !== 'sms_credits'));
        $this->api($h, 'GET', '/api/v1/billing/invoices?filter[kind]=gift')->assertStatus(422);
    }

    public function test_verified_payment_grants_credits_once_and_never_touches_the_subscription(): void
    {
        [, $tenant, , $h] = $this->shop();
        $plan = $this->subscriptionOf($tenant);
        $res = $this->buyPack($h, 'credits_1000')->assertCreated();
        $payment = (string) $res->json('data.payment.id');
        $invoiceId = (string) $res->json('data.invoice.id');

        $back = $this->fakeOutcome($tenant, $payment);
        $back->assertStatus(303);
        $this->assertStringEndsWith('/integrations/sms?tab=credits&payment='.$payment, (string) $back->headers->get('Location'));

        $invoice = $this->invoiceOf($tenant, $invoiceId);
        $this->assertSame([BillingInvoice::PAID, false], [$invoice->status, $invoice->paid_late]);
        $account = $this->account($tenant);
        $this->assertSame([1000, 1000, 200], [$account->balance, $account->purchased_total, $account->low_credit_threshold]);
        $this->assertNotNull($account->last_purchase_at);
        $ledger = $this->ledger($tenant);
        $this->assertCount(1, $ledger);
        $this->assertSame(['purchase', 1000, 1000, $invoiceId], [$ledger[0]->type, $ledger[0]->credits, $ledger[0]->balance_after, $ledger[0]->billing_invoice_id]);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'sms_credits.purchased')->count());
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::SMS_CREDITS_ADDED);
        Mail::assertNotQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::PAYMENT_RECEIVED);

        // The subscription is exactly as before (no activation / extension / plan change).
        $after = $this->subscriptionOf($tenant);
        $this->assertSame([$plan->id, $plan->plan_id, $plan->status, (string) $plan->current_period_end], [$after->id, $after->plan_id, $after->status, (string) $after->current_period_end]);

        // Replayed return, reconcile and a direct confirm: no second grant.
        $this->fakeOutcome($tenant, $payment)->assertStatus(303);
        $this->artisan('billing:reconcile-payments', ['--sync' => true])->assertExitCode(0);
        $this->inTenant($tenant, function () use ($payment) {
            $row = BillingPayment::query()->findOrFail($payment);
            app(BillingPaymentService::class)->confirm($row, new Verification(Verification::SUCCEEDED, $row->amount, 'BDT', $row->id, 'TRX-AGAIN', null, []));
        });
        $this->assertCount(1, $this->ledger($tenant));
        $this->assertSame(1000, $this->account($tenant)->balance);

        // Ledger + account read after the purchase.
        $this->api($h, 'GET', '/api/v1/billing/sms-credits/ledger')->assertOk()
            ->assertJsonPath('data.0.type', 'purchase')->assertJsonPath('data.0.invoice.id', $invoiceId)
            ->assertJsonPath('data.0.invoice.number', $invoice->number)->assertJsonPath('data.0.reason', null)
            ->assertJsonPath('meta.per_page', 50)->assertJsonPath('meta.next_cursor', null);
        $this->api($h, 'GET', '/api/v1/billing/sms-credits')->assertOk()
            ->assertJsonPath('data.balance', 1000)->assertJsonPath('data.status', 'healthy')->assertJsonPath('data.open_invoice', null);
    }

    public function test_a_second_payment_of_the_same_invoice_is_a_duplicate_without_a_second_grant(): void
    {
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->buyPack($h)->assertCreated()->json('data.invoice.id');
        $second = $this->payInvoice($h, $invoice)->assertCreated()->json('data.id'); // a second attempt while still open
        $first = $this->inTenant($tenant, fn () => BillingPayment::query()->where('invoice_id', $invoice)->where('id', '<>', $second)->value('id'));
        $this->fakeOutcome($tenant, $first)->assertStatus(303);
        $this->fakeOutcome($tenant, $second)->assertStatus(303);
        $this->assertTrue($this->paymentOf($tenant, $second)->is_duplicate);
        $this->assertSame(1000, $this->account($tenant)->balance);
        $this->assertCount(1, $this->ledger($tenant));
    }

    public function test_amount_mismatch_and_failed_payments_grant_nothing(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->buyAndPay($h, $tenant, 'credits_1000', 'wrong_amount');
        $this->assertNull($this->account($tenant));
        $this->buyAndPay($h, $tenant, 'credits_1000', 'fail');
        $this->buyAndPay($h, $tenant, 'credits_1000', 'cancel');
        $this->assertNull($this->account($tenant));
        $this->assertSame(0, $this->inTenant($tenant, fn () => SmsCreditLedgerEntry::query()->count()));
    }

    public function test_void_then_paid_is_paid_late_with_the_grant(): void
    {
        [, $tenant, , $h] = $this->shop();
        $a = $this->buyPack($h)->assertCreated();
        $this->buyPack($h, 'credits_5000')->assertCreated(); // supersedes A
        $this->assertSame('void', $this->invoiceOf($tenant, $a->json('data.invoice.id'))->status);
        $this->fakeOutcome($tenant, (string) $a->json('data.payment.id'))->assertStatus(303); // the payer finished A anyway
        $invoice = $this->invoiceOf($tenant, $a->json('data.invoice.id'));
        $this->assertSame([BillingInvoice::PAID, true], [$invoice->status, $invoice->paid_late]);
        $this->assertSame(1000, $this->account($tenant)->balance);
    }

    public function test_expired_sms_invoices_are_voided_by_billing_run_without_touching_the_subscription(): void
    {
        [, $tenant, , $h] = $this->shop();
        $sub = $this->changePlan($h, 'growth')->assertCreated()->json('data.invoice.id');
        $sms = $this->buyPack($h)->assertCreated()->json('data.invoice.id');
        $this->travel(25)->hours();
        $this->runBilling($tenant);
        $this->assertSame([BillingInvoice::VOID, 'expired'], [$this->invoiceOf($tenant, $sms)->status, $this->invoiceOf($tenant, $sms)->void_reason]);
        $this->assertNotSame('superseded', $this->invoiceOf($tenant, $sub)->void_reason);
        $this->assertSame(0, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'billing.invoice_resent')->count());
    }

    public function test_renewal_and_dunning_ignore_an_open_sms_invoice(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->onPaidPlan($tenant, 'starter', 'month', now()->subMonthNoOverflow()->addDays(6));
        $sms = $this->buyPack($h)->assertCreated()->json('data.invoice.id');
        $this->runBilling($tenant); // T−7: renewal invoice issued next to the open SMS invoice
        $open = $this->inTenant($tenant, fn () => BillingInvoice::query()->where('status', 'open')->pluck('kind')->sort()->values()->all());
        $this->assertSame(['renewal', 'sms_credits'], $open);
        $this->assertSame('open', $this->invoiceOf($tenant, $sms)->status);
    }

    #[Group('tenancy')]
    public function test_permissions_and_tenant_isolation(): void
    {
        [, $tenant, , $h] = $this->shop();
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->buyAndPay($h, $tenant);

        // Admin (Manager): reads + alert, never buys.
        $this->api($admin, 'GET', '/api/v1/billing/sms-credits')->assertOk();
        $this->api($admin, 'GET', '/api/v1/billing/sms-credits/ledger')->assertOk();
        $this->api($admin, 'PATCH', '/api/v1/billing/sms-credits', ['low_credit_threshold' => 500])->assertOk();
        $this->buyPack($admin)->assertForbidden();
        // Staff: nothing.
        $this->api($staff, 'GET', '/api/v1/billing/sms-credits')->assertForbidden();
        $this->api($staff, 'GET', '/api/v1/billing/sms-credits/ledger')->assertForbidden();
        $this->api($staff, 'PATCH', '/api/v1/billing/sms-credits', ['low_credit_threshold' => 100])->assertForbidden();
        $this->buyPack($staff)->assertForbidden();

        // Another tenant sees its own (empty) account and ledger, never A's rows; A's invoice id is 404 for B.
        [, $other, , $hB] = $this->shop();
        $this->api($hB, 'GET', '/api/v1/billing/sms-credits')->assertOk()->assertJsonPath('data.balance', 0)->assertJsonPath('data.status', 'none');
        $this->api($hB, 'GET', '/api/v1/billing/sms-credits/ledger')->assertOk()->assertJsonCount(0, 'data');
        $invoice = $this->inTenant($tenant, fn () => BillingInvoice::query()->where('kind', 'sms_credits')->value('id'));
        $this->api($hB, 'GET', "/api/v1/billing/invoices/{$invoice}")->assertNotFound();
        $this->inTenant($other, fn () => $this->assertSame(0, SmsCreditLedgerEntry::query()->count()));
    }

    /** Deleting a tenant that bought credits and requested a sender ID cascades (no RESTRICT FK on the invoice or the document). */
    public function test_deleting_a_tenant_with_purchased_credits_and_a_sender_id_cascades(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->buyAndPay($h, $tenant);
        $this->inTenant($tenant, function () use ($store) {
            $media = new Media;
            $media->forceFill(['purpose' => 'sender_id_document', 'disk' => 'local', 'path' => 'tenants/x/'.Str::ulid().'.pdf', 'mime' => 'application/pdf',
                'size_bytes' => 1234, 'width' => 0, 'height' => 0, 'checksum' => str_repeat('a', 64), 'status' => 'ready', 'variants' => []])->save();
            $row = new SmsSenderId;
            $row->forceFill(['store_id' => $store->id, 'sender_id' => 'GONEBD', 'business_name' => 'Gone Ltd', 'uses' => ['order_updates'],
                'status' => 'pending', 'document_media_id' => $media->id, 'rights_confirmed_at' => now(), 'requested_at' => now()])->save();
        });
        $this->assertSame(1, $this->platformQuery(SmsCreditLedgerEntry::class)->where('tenant_id', $tenant->id)->where('type', 'purchase')->count());

        $this->platformQuery(Tenant::class)->whereKey($tenant->id)->delete();

        $this->assertSame(0, $this->platformQuery(SmsCreditLedgerEntry::class)->where('tenant_id', $tenant->id)->count());
        $this->assertSame(0, $this->platformQuery(SmsSenderId::class)->where('tenant_id', $tenant->id)->count());
        $this->assertSame(0, $this->platformQuery(BillingInvoice::class)->where('tenant_id', $tenant->id)->count());
    }
}

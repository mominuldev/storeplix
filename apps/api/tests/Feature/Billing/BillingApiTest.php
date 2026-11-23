<?php

declare(strict_types=1);

namespace Tests\Feature\Billing;

use App\Domain\Billing\BillingServiceProvider;
use App\Domain\Billing\BillingUrls;
use App\Domain\Billing\Limit;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\Models\Plan;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\BillingFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-7 §6.1–6.2 endpoints, roles, isolation, idempotency and the §10 security items S53–S65. */
#[Group('billing')]
#[Group('security')]
class BillingApiTest extends TestCase
{
    use BillingFixtures, RefreshDatabase, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    public function test_plans_carry_the_yearly_price_and_every_limit(): void
    {
        $this->getJson('/api/v1/plans')->assertOk()
            ->assertJsonPath('data.0.price_yearly_amount', null)
            ->assertJsonPath('data.1.price_yearly_amount', 499000)
            ->assertJsonPath('data.2.price_yearly_amount', 1499000);
        foreach (Plan::query()->get() as $plan) {
            foreach (Limit::cases() as $limit) {
                $this->assertArrayHasKey($limit->value, $plan->limits, "{$plan->code} misses {$limit->value}");
            }
        }
    }

    public function test_subscription_shape_and_quote_for_every_kind(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/subscription')->assertOk()
            ->assertJsonPath('data.billing_interval', 'month')->assertJsonPath('data.scheduled_change', null)
            ->assertJsonPath('data.open_invoice', null)->assertJsonPath('data.grace_ends_at', null)
            ->assertJsonStructure(['data' => ['id', 'status', 'plan', 'trial_ends_at', 'current_period_start', 'current_period_end',
                'cancel_at_period_end', 'billing_interval', 'scheduled_change', 'past_due_at', 'grace_ends_at', 'domain_grace_ends_at', 'open_invoice']]);

        $quote = fn (string $plan, string $interval) => $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/billing/quote', ['plan_code' => $plan, 'interval' => $interval]);
        $quote('growth', 'year')->assertOk()->assertJsonPath('data.kind', 'new')->assertJsonPath('data.amount', 1499000)
            ->assertJsonPath('data.plan.code', 'growth')->assertJsonPath('data.currency', 'BDT')->assertJsonPath('data.warnings', []);
        $quote('free', 'year')->assertStatus(422)->assertJsonPath('error.code', 'plan_unavailable');
        $quote('platinum', 'month')->assertStatus(422)->assertJsonPath('error.code', 'plan_unavailable');
        $quote('growth', 'weekly')->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');

        $this->onPaidPlan($tenant, 'growth');
        for ($i = 0; $i < 120; $i++) {
            $this->api($h, 'POST', '/api/v1/stores/'.$this->inTenant($tenant, fn () => Store::query()->value('id')).'/products', $this->simpleProduct("P{$i}"))->assertCreated();
        }
        $quote('free', 'month')->assertOk()->assertJsonPath('data.kind', 'cancel')->assertJsonPath('data.amount', 0)
            ->assertJsonPath('data.requires_payment', false)
            ->assertJsonPath('data.warnings.0.key', 'products')->assertJsonPath('data.warnings.0.used', 120)->assertJsonPath('data.warnings.0.limit', 100);
        $quote('growth', 'month')->assertStatus(409)->assertJsonPath('error.code', 'plan_unchanged');
    }

    /** QA L-1: downgrade warnings name only lost features that have a module, with human copy; key = FeatureKey. */
    public function test_downgrade_warnings_list_only_built_features(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->onPaidPlan($tenant, 'growth');
        $warnings = $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/billing/quote', ['plan_code' => 'starter', 'interval' => 'month'])
            ->assertOk()->json('data.warnings');
        $this->assertSame([['key' => 'profit_reports', 'used' => null, 'limit' => null, 'message' => 'Profit & loss reports is not included in Starter.']], $warnings);
        $keys = array_column($this->flushHeaders()->withHeaders($h)->postJson('/api/v1/billing/quote', ['plan_code' => 'free', 'interval' => 'month'])->json('data.warnings'), 'key');
        $this->assertSame(['bulk_courier_booking', 'profit_reports'], array_values(array_diff($keys, ['products', 'staff_seats', 'orders_per_month', 'courier_connections', 'sms_per_month', 'custom_domains'])));
    }

    public function test_quote_and_change_plan_amounts_are_equal(): void
    {
        [, $tenant, , $h] = $this->shop();
        $this->onPaidPlan($tenant, 'starter');
        $this->travel(9)->days();
        $this->freezeSecond();
        $quote = $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/billing/quote', ['plan_code' => 'growth', 'interval' => 'month'])->json('data');
        $change = $this->changePlan($h, 'growth')->assertCreated()->json('data');
        $this->assertSame($quote['amount'], $change['invoice']['total_amount']);
        $this->assertSame($quote['lines'], $change['invoice']['lines']);
    }

    /** S57 */
    public function test_roles(): void
    {
        [, $tenant, , $owner] = $this->shop();
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $invoice = $this->changePlan($owner, 'starter')->assertCreated()->json('data.invoice.id');

        $this->flushHeaders()->withHeaders($admin)->getJson('/api/v1/billing/invoices')->assertOk()->assertJsonPath('data.0.can_pay', false);
        $this->flushHeaders()->withHeaders($owner)->getJson('/api/v1/billing/invoices')->assertOk()->assertJsonPath('data.0.can_pay', true);
        $this->flushHeaders()->withHeaders($admin)->getJson("/api/v1/billing/invoices/{$invoice}")->assertOk();
        $this->flushHeaders()->withHeaders($admin)->postJson('/api/v1/billing/quote', ['plan_code' => 'growth', 'interval' => 'month'])->assertOk();
        $this->changePlan($admin, 'growth')->assertForbidden();
        $this->payInvoice($admin, $invoice)->assertForbidden();
        $this->flushHeaders()->withHeaders($admin)->deleteJson('/api/v1/billing/scheduled-change')->assertForbidden();

        foreach (['GET /api/v1/billing/invoices', "GET /api/v1/billing/invoices/{$invoice}", "GET /api/v1/billing/invoices/{$invoice}/pdf",
            'POST /api/v1/billing/quote', 'GET /api/v1/subscription'] as $route) {
            [$method, $url] = explode(' ', $route);
            $this->flushHeaders()->withHeaders($staff)->json($method, $url, ['plan_code' => 'growth', 'interval' => 'month'])->assertForbidden();
        }
        $this->flushHeaders()->withHeaders($staff)->getJson('/api/v1/features')->assertOk();
    }

    /** S56 */
    public function test_another_tenants_invoices_and_payments_are_404(): void
    {
        [, $tenantA, , $hA] = $this->shop();
        [, $tenantB, , $hB] = $this->shop('owner', 'bshop');
        $invoice = $this->changePlan($hB, 'starter')->json('data.invoice.id');
        $payment = $this->payInvoice($hB, $invoice)->json('data.id');

        $this->assertTenantIsolation($hA, [
            ['GET', "/api/v1/billing/invoices/{$invoice}"],
            ['GET', "/api/v1/billing/invoices/{$invoice}/pdf"],
            ['GET', "/api/v1/billing/payments/{$payment}"],
        ]);
        $this->payInvoice($hA, $invoice)->assertNotFound()->assertJsonPath('error.code', 'not_found');
        $this->flushHeaders()->withHeaders($hA)->getJson('/api/v1/billing/invoices')->assertOk()->assertJsonCount(0, 'data');
        $this->assertSame('pending', $this->paymentOf($tenantB, $payment)->status);
        $this->assertNotNull($tenantA);
    }

    /** S61 */
    public function test_idempotency_keys(): void
    {
        [, $tenant, , $h] = $this->shop();
        $key = (string) Str::ulid();
        $first = $this->changePlan($h, 'starter', 'month', $key)->assertCreated()->json('data.invoice.id');
        $this->assertSame($first, $this->changePlan($h, 'starter', 'month', $key)->assertCreated()->json('data.invoice.id'));
        $this->changePlan($h, 'growth', 'month', $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/billing/change-plan', ['plan_code' => 'starter', 'interval' => 'month'])
            ->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');

        $payKey = (string) Str::ulid();
        $p1 = $this->payInvoice($h, $first, 'bkash', $payKey)->assertCreated()->json('data');
        $p2 = $this->payInvoice($h, $first, 'bkash', $payKey)->assertCreated()->json('data');
        $this->assertSame($p1['id'], $p2['id']);
        $this->assertSame($p1['redirect_url'], $p2['redirect_url']);
        $this->payInvoice($h, $first, 'sslcommerz', $payKey)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->assertSame(1, $this->inTenant($tenant, fn () => BillingPayment::query()->count()));
        $this->flushHeaders()->withHeaders($h)->postJson("/api/v1/billing/invoices/{$first}/pay", ['provider' => 'bkash'])->assertStatus(400);
    }

    /** One open invoice per tenant (P7-7): a new change supersedes the previous open one. */
    public function test_a_new_change_supersedes_the_open_invoice(): void
    {
        [, $tenant, , $h] = $this->shop();
        $first = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $second = $this->changePlan($h, 'growth')->json('data.invoice.id');
        $this->assertSame(['void', 'superseded'], [$this->invoiceOf($tenant, $first)->status, $this->invoiceOf($tenant, $first)->void_reason]);
        $this->assertSame('open', $this->invoiceOf($tenant, $second)->status);
        $this->payInvoice($h, $first)->assertStatus(409)->assertJsonPath('error.code', 'invoice_not_open');
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/billing/invoices?filter[status]=void')->assertOk()->assertJsonCount(1, 'data');
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/billing/invoices?per_page=51')->assertStatus(422);
    }

    /** S62 */
    public function test_mass_assignment_has_no_effect(): void
    {
        [, $tenant, , $h] = $this->shop();
        $res = $this->flushHeaders()->withHeaders($h + ['Idempotency-Key' => (string) Str::ulid()])->postJson('/api/v1/billing/change-plan', [
            'plan_code' => 'starter', 'interval' => 'month', 'amount' => 1, 'total_amount' => 1, 'status' => 'paid',
            'current_period_end' => '2099-01-01T00:00:00Z', 'plan_id' => 'x',
        ])->assertCreated();
        $this->assertSame(49900, $res->json('data.invoice.total_amount'));
        $this->assertSame('open', $res->json('data.invoice.status'));
        $this->flushHeaders()->withHeaders($h + ['Idempotency-Key' => (string) Str::ulid()])
            ->postJson('/api/v1/billing/invoices/'.$res->json('data.invoice.id').'/pay', ['provider' => 'bkash', 'amount' => 1])
            ->assertCreated()->assertJsonPath('data.amount', 49900);
    }

    /** S53 + S54 */
    public function test_forged_return_and_wrong_amount_never_pay(): void
    {
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $payment = $this->payInvoice($h, $invoice)->json('data.id');
        $return = $this->inTenant($tenant, fn () => BillingUrls::returnUrl(BillingPayment::query()->findOrFail($payment)));
        // No button pressed: the provider still says "Initiated" whatever the query string claims.
        $this->flushHeaders()->get($return.'&status=success&paymentID=x')->assertStatus(303);
        $this->assertSame('pending', $this->paymentOf($tenant, $payment)->status);
        $this->assertSame('open', $this->invoiceOf($tenant, $invoice)->status);

        $this->fakeOutcome($tenant, $payment, 'wrong_amount')->assertStatus(303);
        $row = $this->paymentOf($tenant, $payment);
        $this->assertSame(['failed', 'amount_mismatch'], [$row->status, $row->failure_code]);
        $this->assertSame('open', $this->invoiceOf($tenant, $invoice)->status);
        $this->assertSame('trialing', $this->subscriptionOf($tenant)->status);
        // a mismatch is final: a later "pay" outcome doesn't turn it into a success
        $this->fakeOutcome($tenant, $payment, 'pay');
        $this->assertSame('failed', $this->paymentOf($tenant, $payment)->status);

        $failed = $this->payInvoice($h, $invoice)->json('data.id');
        $this->fakeOutcome($tenant, $failed, 'fail');
        $this->assertSame('failed', $this->paymentOf($tenant, $failed)->status);
        $cancelled = $this->payInvoice($h, $invoice)->json('data.id');
        $this->fakeOutcome($tenant, $cancelled, 'cancel');
        $this->assertSame('cancelled', $this->paymentOf($tenant, $cancelled)->status);
    }

    /** S59 */
    public function test_returns_only_redirect_to_the_merchant_app(): void
    {
        [, $tenant, , $h] = $this->shop();
        $payment = $this->payInvoice($h, $this->changePlan($h, 'starter')->json('data.invoice.id'))->json('data.id');
        $return = $this->inTenant($tenant, fn () => BillingUrls::returnUrl(BillingPayment::query()->findOrFail($payment)));
        $this->flushHeaders()->get($return.'&next=https://evil.example')->assertStatus(303)
            ->assertHeader('Location', 'http://localhost:5173/settings/plan?payment='.$payment);
        $this->flushHeaders()->get("/api/v1/billing/payments/return/bkash/{$payment}?expires=1&signature=".str_repeat('a', 64))
            ->assertStatus(303)->assertHeader('Location', 'http://localhost:5173/settings/plan?payment_error=1');
        $this->flushHeaders()->get(str_replace('/bkash/', '/sslcommerz/', $return))->assertStatus(303)
            ->assertHeader('Location', 'http://localhost:5173/settings/plan?payment_error=1');
    }

    /** S64 */
    public function test_invoice_pdf_escapes_merchant_values_and_caches_once_final(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['name' => '<img src=x onerror=alert(1)>']));
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $res = $this->flushHeaders()->withHeaders($h)->get("/api/v1/billing/invoices/{$invoice}/pdf")->assertOk()
            ->assertHeader('Cache-Control', 'no-store, private');
        $this->assertStringContainsString('attachment; filename="SP-', (string) $res->headers->get('Content-Disposition'));
        $html = (string) $res->getContent();
        $this->assertStringNotContainsString('<img src=x', $html);
        $this->assertStringContainsString('&lt;img src=x onerror=alert(1)&gt;', $html);
        $this->assertNull($this->invoiceOf($tenant, $invoice)->pdf_path, 'open invoices are rendered on demand');

        $payment = $this->payInvoice($h, $invoice)->json('data.id');
        $this->fakeOutcome($tenant, $payment);
        $this->assertNotNull($path = $this->invoiceOf($tenant, $invoice)->pdf_path);
        $this->assertStringStartsWith('tenants/'.$tenant->id.'/billing/', $path);
    }

    /** S65 */
    public function test_fake_billing_refuses_production_and_dev_routes_need_the_fake(): void
    {
        config(['billing.fake' => true]);
        $this->app['env'] = 'production';
        try {
            BillingServiceProvider::assertSafeConfiguration($this->app);
            $this->fail('expected a boot refusal');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('BILLING_FAKE', $e->getMessage());
        } finally {
            $this->app['env'] = 'testing';
        }

        [, , , $h] = $this->shop();
        config(['billing.fake' => false]);
        $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/dev/billing/clock', ['state' => 'trial_ended'])->assertNotFound();
    }

    /** The fake page URL the API hands out verifies on another API origin too (e2e port ≠ APP_URL); tampering still fails. */
    public function test_fake_page_signature_survives_a_different_api_origin_but_not_tampering(): void
    {
        config(['app.url' => 'http://localhost:8000', 'payments.public_api_url' => 'http://localhost:8000']);
        [, $tenant, , $h] = $this->shop();
        $url = $this->payInvoice($h, $this->changePlan($h, 'starter')->json('data.invoice.id'))->assertCreated()->json('data.redirect_url');
        $this->assertStringStartsWith('http://localhost:8000/api/v1/dev/fake-billing-gateway/', $url);
        $parts = parse_url($url);
        $path = $parts['path'].'?'.$parts['query'];

        $page = $this->flushHeaders()->get('http://127.0.0.1:8200'.$path)->assertOk();
        preg_match('/action="([^"]+outcome[^"]*|[^"]+\/pay\?[^"]+)"/', (string) $page->getContent(), $m);
        $action = html_entity_decode($m[1]);
        $this->assertStringStartsWith('/api/v1/dev/fake-billing-gateway/', $action);
        $this->flushHeaders()->post('http://127.0.0.1:8200'.$action)->assertStatus(303);

        $this->flushHeaders()->get('http://127.0.0.1:8200'.str_replace('tenant=', 'tenant=x', $path))->assertForbidden();
        $this->assertNotNull($tenant);
    }

    public function test_dev_clock_moves_the_subscription_and_runs_the_job(): void
    {
        [, $tenant, , $h] = $this->shop();
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $this->flushHeaders()->withHeaders($admin)->postJson('/api/v1/dev/billing/clock', ['state' => 'trial_ended'])->assertForbidden();
        $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/dev/billing/clock', ['state' => 'grace_ended'])->assertStatus(409);
        $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/dev/billing/clock', ['state' => 'trial_ended'])->assertOk()
            ->assertJsonPath('data.plan.code', 'free')->assertJsonPath('data.status', 'active');

        $this->buyPlan($h, $tenant, 'starter');
        $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/dev/billing/clock', ['state' => 'renewal_due'])->assertOk()
            ->assertJsonPath('data.open_invoice.kind', 'renewal');
        $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/dev/billing/clock', ['state' => 'period_ended'])->assertOk()
            ->assertJsonPath('data.status', 'past_due');
        $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/dev/billing/clock', ['state' => 'grace_ended'])->assertOk()
            ->assertJsonPath('data.status', 'active')->assertJsonPath('data.plan.code', 'free');
        $this->assertSame(1, $this->inTenant($tenant, fn () => BillingInvoice::query()->where('void_reason', 'unpaid')->count()));
    }
}

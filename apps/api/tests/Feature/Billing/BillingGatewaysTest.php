<?php

declare(strict_types=1);

namespace Tests\Feature\Billing;

use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Identity\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\PaymentGatewayFixtures;
use Tests\TestCase;

/**
 * PHASE-7 §11 "Gateways": the platform adapters of the 5b drivers against Http::fake fixtures
 * (tests/Fixtures/billing), the global platform token, the platform IPN, unconfigured providers and S58 leakage.
 */
#[Group('billing')]
class BillingGatewaysTest extends TestCase
{
    use BillingFixtures, PaymentGatewayFixtures, RefreshDatabase;

    private const BKASH = ['app_key' => 'platform-appkey-77', 'app_secret' => 'platform-secret-xyz', 'username' => 'platformUser', 'password' => 'platform-pass-123'];

    private const SSL = ['store_id' => 'storeplix0live', 'store_passwd' => 'platform-store-passwd'];

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        config(['billing.fake' => false, 'billing.bkash' => self::BKASH, 'billing.sslcommerz' => self::SSL, 'payments.public_api_url' => 'https://api.storeplix.test']);
    }

    public function test_bkash_platform_payment_uses_one_global_token_for_every_tenant_and_the_billing_create_body(): void
    {
        $bodies = [];
        $this->fakeProvider([
            'auth/grant-token' => '../billing/bkash/grant_token',
            'payment/create' => function (Request $r) use (&$bodies) {
                $bodies[] = $r->data();

                return Http::response($this->paymentFixture('../billing/bkash/create_payment', ['amount' => $r->data()['amount'], 'merchantInvoiceNumber' => $r->data()['merchantInvoiceNumber'], 'callbackURL' => 'x']));
            },
            'payment/execute' => function (Request $r) use (&$bodies) {
                return Http::response($this->paymentFixture('../billing/bkash/execute_payment', [
                    'amount' => '499.00', 'merchantInvoiceNumber' => $bodies[0]['merchantInvoiceNumber'],
                ]));
            },
        ]);

        [$owner, $tenant, , $h] = $this->shop();
        $owner->forceFill(['phone' => '+8801711000111'])->save();
        [, $tenant2, , $h2] = $this->shop('owner', 'other');

        $invoice = $this->changePlan($h, 'starter')->assertCreated()->json('data.invoice.id');
        $pay = $this->payInvoice($h, $invoice, 'bkash')->assertCreated();
        $this->assertStringStartsWith('https://sandbox.payment.bkash.com/', $pay->json('data.redirect_url'));
        $invoice2 = $this->changePlan($h2, 'starter')->json('data.invoice.id');
        $this->payInvoice($h2, $invoice2, 'bkash')->assertCreated();

        $this->assertSame(1, $this->callCount('auth/grant-token'), 'P7-10: one platform grant across tenants');
        $this->assertSame('01711000111', $bodies[0]['payerReference']);
        $this->assertSame($pay->json('data.id'), $bodies[0]['merchantInvoiceNumber']);
        $this->assertSame('499.00', $bodies[0]['amount']);
        $this->assertSame('sale', $bodies[0]['intent']);
        $this->assertStringStartsWith('https://api.storeplix.test/api/v1/billing/payments/return/bkash/'.$pay->json('data.id'), $bodies[0]['callbackURL']);

        // S53: the browser return only triggers Execute; the provider answer decides.
        $this->flushHeaders()->get($bodies[0]['callbackURL'].'&paymentID=TR0011ON1565154754797&status=success')
            ->assertStatus(303)->assertHeader('Location', 'http://localhost:5173/settings/plan?payment='.$pay->json('data.id'));
        $this->assertSame('succeeded', $this->paymentOf($tenant, $pay->json('data.id'))->status);
        $this->assertSame('starter', $this->subscriptionOf($tenant)->plan->code);
        $this->assertSame(Subscription::TRIALING, $this->subscriptionOf($tenant2)->status);
    }

    public function test_sslcommerz_session_fields_validation_and_the_platform_ipn(): void
    {
        $session = null;
        $this->fakeProvider([
            'gwprocess/v4/api.php' => function (Request $r) use (&$session) {
                $session = $r->data();

                return Http::response($this->paymentFixture('../billing/sslcommerz/session'));
            },
            'validator/api/validationserverAPI.php' => function (Request $r) use (&$session) {
                return Http::response($this->paymentFixture('../billing/sslcommerz/validation_valid', [
                    'tran_id' => $session['tran_id'], 'amount' => '1499.00', 'value_a' => $session['value_a'],
                ]));
            },
        ]);
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'growth')->json('data.invoice.id');
        $payment = $this->payInvoice($h, $invoice, 'sslcommerz')->assertCreated()->json('data.id');

        $this->assertSame($payment, $session['tran_id']);
        $this->assertSame('1499.00', $session['total_amount']);
        $this->assertSame(['saas', 'non-physical-goods', 'NO'], [$session['product_category'], $session['product_profile'], $session['shipping_method']]);
        $this->assertArrayNotHasKey('ship_name', $session);
        $this->assertSame('Storeplix Growth plan (monthly)', $session['product_name']);
        $this->assertSame($this->invoiceOf($tenant, $invoice)->number, $session['value_a']);
        $this->assertSame('https://api.storeplix.test/api/v1/billing/webhooks/sslcommerz', $session['ipn_url']);
        $this->assertSame(self::SSL['store_id'], $session['store_id']);

        $ipn = ['tran_id' => $payment, 'val_id' => '2611221016021Z4fKRg8bGkAuWq', 'status' => 'VALID', 'amount' => '1499.00'];
        $ipn['verify_key'] = 'amount,status,tran_id,val_id';
        $forged = $ipn + ['verify_sign' => md5('forged')];
        $this->flushHeaders()->post('/api/v1/billing/webhooks/sslcommerz', $forged)->assertOk()->assertExactJson(['data' => ['received' => true]]);
        $this->assertSame('pending', $this->paymentOf($tenant, $payment)->status, 'S55: bad sign changes nothing');

        $signed = $ipn + ['verify_sign' => $this->sign($ipn)];
        $this->flushHeaders()->post('/api/v1/billing/webhooks/sslcommerz', $signed)->assertOk()->assertExactJson(['data' => ['received' => true]]);
        $this->flushHeaders()->post('/api/v1/billing/webhooks/sslcommerz', $signed)->assertOk(); // replay
        $this->assertSame('succeeded', $this->paymentOf($tenant, $payment)->status);
        $this->assertSame('growth', $this->subscriptionOf($tenant)->plan->code);
        $this->assertSame(1, $this->callCount('validator/api/validationserverAPI.php'), 'replayed IPN: no second validation');

        $unknown = ['tran_id' => strtolower((string) Str::ulid()), 'val_id' => 'x', 'status' => 'VALID', 'amount' => '1.00', 'verify_key' => 'amount,status,tran_id,val_id'];
        $this->flushHeaders()->post('/api/v1/billing/webhooks/sslcommerz', $unknown + ['verify_sign' => $this->sign($unknown)])
            ->assertOk()->assertExactJson(['data' => ['received' => true]]);
    }

    public function test_unconfigured_provider_is_not_offered_and_pay_answers_422(): void
    {
        config(['billing.bkash.app_key' => '']);
        Http::fake();
        [, , , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $this->flushHeaders()->withHeaders($h)->getJson('/api/v1/billing/invoices')->assertOk()->assertJsonPath('meta.providers', ['sslcommerz']);
        $this->payInvoice($h, $invoice, 'bkash')->assertStatus(422)->assertJsonPath('error.code', 'billing_gateway_unavailable');
    }

    public function test_provider_timeout_on_initiate_is_502_and_the_attempt_fails(): void
    {
        $this->fakeProvider(['auth/grant-token' => '../billing/bkash/grant_token', 'payment/create' => 'timeout']);
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $this->payInvoice($h, $invoice, 'bkash')->assertStatus(502)->assertJsonPath('error.code', 'provider_unavailable');
        $row = $this->inTenant($tenant, fn () => BillingPayment::query()->sole());
        $this->assertSame(['failed', 'initiation_failed'], [$row->status, $row->failure_code]);
        $this->assertSame('open', $this->invoiceOf($tenant, $invoice)->status);
    }

    /** S58: platform secrets never appear in responses, the DB or logs. */
    public function test_platform_credentials_never_leak(): void
    {
        $logged = [];
        Log::listen(function ($message) use (&$logged) {
            $logged[] = $message->message.' '.json_encode($message->context);
        });
        $this->fakeProvider([
            'auth/grant-token' => '../billing/bkash/grant_token',
            'payment/create' => fn (Request $r) => Http::response($this->paymentFixture('../billing/bkash/create_payment', ['amount' => '499.00', 'merchantInvoiceNumber' => $r->data()['merchantInvoiceNumber'], 'callbackURL' => 'x'])),
        ]);
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $responses = [$this->payInvoice($h, $invoice, 'bkash')->getContent()];
        $responses[] = $this->flushHeaders()->withHeaders($h)->getJson("/api/v1/billing/invoices/{$invoice}")->getContent();
        $db = json_encode($this->platformTable('billing_payments')->get()).json_encode($this->platformTable('billing_invoices')->get());
        foreach ([...array_values(self::BKASH), self::SSL['store_passwd']] as $secret) {
            foreach ([...$responses, $db, ...$logged] as $haystack) {
                $this->assertStringNotContainsString($secret, (string) $haystack);
            }
        }
        $this->assertTrue(User::query()->exists());
    }

    /** @param array<string, string> $params */
    private function sign(array $params): string
    {
        $data = [];
        foreach (explode(',', $params['verify_key']) as $key) {
            $data[$key] = $params[$key];
        }
        $data['store_passwd'] = md5(self::SSL['store_passwd']);
        ksort($data);

        return md5(implode('&', array_map(fn ($k, $v) => "{$k}={$v}", array_keys($data), $data)));
    }
}

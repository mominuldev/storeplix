<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\GatewayCapabilities;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Gateways\NagadCrypto;
use App\Domain\Payments\Gateways\NagadGateway;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\GatewaysServiceProvider;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Payments\PaymentService;
use App\Domain\Payments\PaymentUrls;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\OnlinePaymentFixtures;
use Tests\Support\PaymentGatewayFixtures;
use Tests\TestCase;

/**
 * PHASE-8-9D §9 Nagad (P89D-44–P89D-48, S342): credentials + key validation, initialize / complete with real RSA
 * crypto against TEST keys (tests/Fixtures/payments/nagad — a merchant pair and a stand-in "Nagad PG" pair; the fake
 * provider decrypts what we send with the PG private key and answers encrypted to the merchant, signed by the PG key),
 * Verify Payment mapping + mismatch vectors, the signed return (trigger only), the untrusted webhook, refunds
 * unsupported, reconcile, capabilities and checkout.
 */
#[Group('nagad')]
#[Group('payments')]
class NagadGatewayTest extends TestCase
{
    use OnlinePaymentFixtures, PaymentGatewayFixtures, RefreshDatabase;

    private const MERCHANT_ID = '683002007104225';

    private const REF = 'MDYyODIzMTcxNjU4OS42ODMwMDIwMDcxMDQyMjUuMDE';

    /** @var list<array{path: string, headers: array<string, mixed>, body: array<string, mixed>, sensitive: array<string, mixed>|null, signed: bool}> */
    private array $seen = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
        config(['payments.fake' => false]);
    }

    private static function key(string $name): string
    {
        return (string) file_get_contents(base_path("tests/Fixtures/payments/nagad/{$name}.pem"));
    }

    /** @return array<string, string> */
    private static function creds(array $override = []): array
    {
        return $override + [
            'merchant_id' => self::MERCHANT_ID,
            'merchant_number' => '01700000001',
            'merchant_private_key' => self::key('merchant_private'),
            'pg_public_key' => self::key('pg_public'),
        ];
    }

    /**
     * A fake Nagad: initialize (decrypt + verify ours, answer encrypted + signed), complete, verify. $verify is the
     * Verify Payment body (or a callable / status int / 'timeout').
     */
    private function fakeNagad(array|callable|int|string|null $verify = null, array $options = []): void
    {
        $this->seen = [];
        Http::swap(new Factory(app('events')));
        Http::fake(function (Request $request) use ($verify, $options) {
            $path = (string) parse_url($request->url(), PHP_URL_PATH);
            $body = $request->data();
            $sensitive = null;
            $signed = false;
            if (is_string($body['sensitiveData'] ?? null)) {
                $plain = NagadCrypto::decrypt($body['sensitiveData'], self::key('pg_private'));
                $sensitive = $plain !== null ? json_decode($plain, true) : null;
                $signed = $plain !== null && NagadCrypto::verify($plain, (string) ($body['signature'] ?? ''), self::key('merchant_public'));
            }
            $this->seen[] = ['path' => $path, 'url' => $request->url(), 'headers' => $request->headers(), 'body' => $body, 'sensitive' => $sensitive, 'signed' => $signed];

            if (str_contains($path, '/check-out/initialize/')) {
                if (($options['initialize'] ?? null) === 'timeout') {
                    throw new ConnectionException('cURL error 28');
                }
                if (is_int($options['initialize'] ?? null)) {
                    return Http::response(['reason' => 'InvalidMerchant', 'message' => 'Invalid merchant'], $options['initialize']);
                }
                $answer = (string) json_encode(['paymentReferenceId' => self::REF, 'challenge' => $sensitive['challenge'] ?? '', 'acceptDateTime' => '20261128182005']);
                $sig = NagadCrypto::sign($answer, ($options['bad_signature'] ?? false) ? self::key('merchant_private') : self::key('pg_private'));

                return Http::response(['sensitiveData' => NagadCrypto::encrypt($answer, self::key('merchant_public')), 'signature' => $sig]);
            }
            if (str_contains($path, '/check-out/complete/')) {
                return Http::response($this->paymentFixture('nagad/complete'));
            }
            if (str_contains($path, '/verify/payment/')) {
                if ($verify === 'timeout') {
                    throw new ConnectionException('cURL error 28');
                }
                if (is_int($verify)) {
                    return Http::response('', $verify);
                }

                return Http::response(is_callable($verify) ? $verify($request) : $verify);
            }

            return Http::response(['unexpected' => $path], 599);
        });
    }

    /** @return array<string, mixed> */
    private function verifyBody(Payment $p, string $status = 'Success', ?string $amount = null, ?string $orderId = null, array $extra = []): array
    {
        return $extra + $this->paymentFixture('nagad/verify_payment', [
            'order_id' => $orderId ?? $p->id, 'ref' => self::REF, 'amount' => $amount ?? Money::toDecimal((int) $p->amount), 'status' => $status,
        ]);
    }

    /** @return array{0: NagadGateway, 1: PaymentGatewayAccount} */
    private function driver(Store $store): array
    {
        return [app(NagadGateway::class), $this->gatewayAccount($store, 'nagad', self::creds())];
    }

    private function connectNagad(array $h, Store $store, array $creds = [], string $mode = 'sandbox'): TestResponse
    {
        return $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/payment-gateways/nagad", ['mode' => $mode, 'credentials' => $creds + self::creds()]);
    }

    public function test_connect_validates_keys_checks_with_initialize_and_never_returns_or_logs_secrets(): void
    {
        $logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$logged) {
            $logged[] = $e->message.' '.json_encode($e->context);
        });
        $this->fakeNagad();
        [$user, $tenant, $store, $h] = $this->liveShop('nagad');

        $this->connectNagad($h, $store, ['merchant_private_key' => 'not a key'])->assertStatus(422)->assertJsonValidationErrors('credentials.merchant_private_key', 'error.details');
        $this->connectNagad($h, $store, ['merchant_private_key' => self::key('weak_private')])->assertStatus(422)->assertJsonValidationErrors('credentials.merchant_private_key', 'error.details');
        $this->connectNagad($h, $store, ['pg_public_key' => self::key('weak_private')])->assertStatus(422)->assertJsonValidationErrors('credentials.pg_public_key', 'error.details');
        $this->connectNagad($h, $store, ['merchant_number' => '0123'])->assertStatus(422)->assertJsonValidationErrors('credentials.merchant_number', 'error.details');
        $this->connectNagad($h, $store, ['base_url' => 'https://evil.example'])->assertStatus(422); // S27: no host can be supplied
        $this->assertSame([], $this->seen);

        // A bare base64 key (as Nagad hands it out) is wrapped to PEM.
        $bare = preg_replace('/-----[A-Z ]+-----|\s/', '', self::key('pg_public'));
        $r = $this->connectNagad($h, $store, ['pg_public_key' => $bare, 'merchant_number' => '+8801700000001'])->assertOk()
            ->assertJsonPath('data.provider', 'nagad')->assertJsonPath('data.status', 'connected')
            ->assertJsonPath('data.credentials_hint', '••••4225')->assertJsonPath('data.capabilities', ['query', 'webhook'])
            ->assertJsonPath('data.callback_url', rtrim((string) config('payments.public_api_url'), '/').'/api/v1/payments/return/nagad');
        // The credential check is a signed initialize for a throw-away order id (no money moves).
        $this->assertCount(1, $this->seen);
        $this->assertStringContainsString('/check-out/initialize/'.self::MERCHANT_ID.'/CHK', $this->seen[0]['path']);
        $this->assertTrue($this->seen[0]['signed']);
        $this->assertSame(self::MERCHANT_ID, $this->seen[0]['sensitive']['merchantId']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{40}$/', $this->seen[0]['sensitive']['challenge']);
        $this->assertMatchesRegularExpression('/^\d{14}$/', $this->seen[0]['body']['dateTime']);
        $this->assertSame(['v-0.2.0'], $this->seen[0]['headers']['X-KM-Api-Version']);
        $this->assertSame(['PC_WEB'], $this->seen[0]['headers']['X-KM-Client-Type']);
        $this->assertNotEmpty($this->seen[0]['headers']['X-KM-IP-V4'][0]);

        $account = $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->where('provider', 'nagad')->firstOrFail());
        $this->assertSame('01700000001', $account->credentials['merchant_number']);
        $this->assertStringStartsWith('-----BEGIN PUBLIC KEY-----', $account->credentials['pg_public_key']);
        $raw = (string) $this->platformTable('payment_gateway_accounts')->where('id', $account->id)->value('credentials');
        $this->assertStringNotContainsString('PRIVATE KEY', $raw); // encrypted at rest
        $secretBody = substr(preg_replace('/-----[A-Z ]+-----|\s/', '', self::key('merchant_private')), 40, 40);
        foreach ([$r->getContent(), implode("\n", $logged), (string) json_encode($this->platformTable('audit_logs')->get())] as $haystack) {
            $this->assertStringNotContainsString($secretBody, $haystack);
            $this->assertStringNotContainsString('PRIVATE KEY', $haystack);
        }
        $list = collect($this->api($h, 'GET', "/api/v1/stores/{$store->id}/payment-gateways")->json('data'))->keyBy('provider');
        $this->assertSame(['refund', 'refund_partial', 'query'], $list['bkash']['capabilities']);
        $this->assertSame(['refund', 'refund_partial', 'query', 'webhook'], $list['sslcommerz']['capabilities']);
        $this->assertNull($list['bkash']['callback_url']);

        // Rejected merchant id / signature → credentials_invalid; Nagad down → provider_unavailable; nothing saved.
        [, , $store2, $h2] = $this->liveShop('nagad2');
        $this->fakeNagad(null, ['initialize' => 403]);
        $this->connectNagad($h2, $store2)->assertStatus(422)->assertJsonPath('error.code', 'credentials_invalid');
        $this->fakeNagad(null, ['bad_signature' => true]);
        $this->connectNagad($h2, $store2)->assertStatus(422)->assertJsonPath('error.code', 'credentials_invalid');
        $this->fakeNagad(null, ['initialize' => 'timeout']);
        $this->connectNagad($h2, $store2)->assertStatus(502)->assertJsonPath('error.code', 'provider_unavailable');
        $this->fakeNagad(null, ['initialize' => 503]);
        $this->connectNagad($h2, $store2)->assertStatus(502);
        $this->assertSame('not_connected', collect($this->api($h2, 'GET', "/api/v1/stores/{$store2->id}/payment-gateways")->json('data'))->firstWhere('provider', 'nagad')['status']);

        // Staff can't configure (5b permissions).
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->connectNagad($staff, $store)->assertForbidden();
        unset($user);
    }

    public function test_initiate_runs_initialize_then_complete_with_encrypted_signed_data_and_redirects_to_nagad(): void
    {
        [, $tenant, $store] = $this->liveShop('nginit');
        $this->inTenant($tenant, function () use ($store) {
            [$nagad, $account] = $this->driver($store);
            $payment = $this->gatewayPayment($store, $account, 1000);
            $this->fakeNagad();
            $return = PaymentUrls::returnUrl($payment);
            $init = $nagad->initiate($payment, $account, $return, null);

            $this->assertSame(self::REF, $init->providerPaymentId);
            $this->assertStringStartsWith('https://sandbox-ssl.mynagad.com', $init->redirectUrl);
            [$initialize, $complete] = $this->seen;
            $this->assertStringStartsWith('https://sandbox-ssl.mynagad.com/api/dfs/check-out/initialize/'.self::MERCHANT_ID.'/'.$payment->id, $initialize['url']);
            $this->assertTrue($initialize['signed']);
            $this->assertSame($payment->id, $initialize['sensitive']['orderId']);
            $this->assertStringEndsWith('/check-out/complete/'.self::REF, $complete['path']);
            $this->assertTrue($complete['signed']);
            $this->assertSame(['merchantId' => self::MERCHANT_ID, 'orderId' => $payment->id, 'currencyCode' => '050', 'amount' => '10.00',
                'challenge' => $initialize['sensitive']['challenge']], $complete['sensitive']);
            $this->assertSame($return, $complete['body']['merchantCallbackURL']);
            $this->assertStringContainsString('/api/v1/payments/return/nagad/'.$payment->id, $return);
            // No key material in what is stored on the payment.
            $this->assertStringNotContainsString('sensitiveData', (string) json_encode($init->raw));
        });
    }

    /** @return array<string, array{0: string, 1: string|null, 2: string|null, 3: array<string, mixed>, 4: string, 5: string|null}> */
    public static function verifyVectors(): array
    {
        return [
            'success' => ['Success', null, null, [], 'succeeded', null],
            'amount differs' => ['Success', '10.01', null, [], 'failed', 'amount_mismatch'],
            'amount 3 decimals' => ['Success', '10.001', null, [], 'failed', 'amount_mismatch'],
            'other order' => ['Success', null, '01jbadorder0000000000000000', [], 'failed', 'reference_mismatch'],
            'not BDT' => ['Success', null, null, ['currencyCode' => 'USD'], 'failed', 'currency_mismatch'],
            'aborted' => ['Aborted', null, null, [], 'cancelled', 'nagad_aborted'],
            'failed' => ['Failed', null, null, [], 'failed', 'nagad_failed'],
            'still ready' => ['Ready', null, null, [], 'pending', null],
        ];
    }

    #[DataProvider('verifyVectors')]
    public function test_paid_only_when_verify_says_success_with_matching_amount_order_and_currency(string $status, ?string $amount, ?string $orderId, array $extra, string $expected, ?string $code): void
    {
        [, $tenant, $store] = $this->liveShop('ngv');
        $this->inTenant($tenant, function () use ($store, $status, $amount, $orderId, $extra, $expected, $code) {
            [, $account] = $this->driver($store);
            $payment = $this->gatewayPayment($store, $account, 1000, ['provider_payment_id' => self::REF]);
            $this->fakeNagad($this->verifyBody($payment, $status, $amount, $orderId, $extra));
            app(PaymentService::class)->verify($payment);
            $payment->refresh();
            $this->assertSame([$expected, $code], [$payment->status, $payment->failure_code]);
            if ($expected === 'succeeded') {
                $this->assertSame('000005S2', $payment->provider_trx_id);
                $this->assertNotNull(PaymentGatewayAccount::query()->find($account->id)->verified_at); // test payment verified the account
            }
            $this->assertStringEndsWith('/verify/payment/'.self::REF, $this->seen[0]['path']);
            $this->assertStringNotContainsString('016****5678', (string) json_encode($payment->raw)); // shopper wallet scrubbed
        });
    }

    public function test_verify_errors_leave_the_payment_pending_and_query_without_a_reference_is_pending(): void
    {
        [, $tenant, $store] = $this->liveShop('ngq');
        $this->inTenant($tenant, function () use ($store) {
            [$nagad, $account] = $this->driver($store);
            $payment = $this->gatewayPayment($store, $account, 1000, ['provider_payment_id' => self::REF]);
            $this->fakeNagad('timeout');
            $this->assertNull(app(PaymentService::class)->verify($payment));
            $this->fakeNagad(500);
            $this->assertNull(app(PaymentService::class)->verify($payment));
            $this->fakeNagad(['reason' => 'NotFound']);
            $this->assertSame(Verification::PENDING, $nagad->query($payment, $account)->status);
            $this->assertSame('pending', $payment->refresh()->status);
            $fresh = $this->gatewayPayment($store, $account, 1000);
            $this->assertSame('not_initiated', $nagad->query($fresh, $account)->failureCode);
        });
    }

    public function test_refunds_are_unsupported_until_certified(): void
    {
        [, $tenant, $store] = $this->liveShop('ngr');
        $this->inTenant($tenant, function () use ($store) {
            [$nagad, $account] = $this->driver($store);
            $payment = $this->gatewayPayment($store, $account, 1000);
            try {
                $nagad->refund($payment, $payment, $account, 1000, null);
                $this->fail('expected an exception');
            } catch (GatewayException $e) {
                $this->assertSame('gateway_refund_unsupported', $e->errorCode);
            }
        });
        config(['payments.providers.nagad.refunds' => true]);
        $this->assertContains('refund', GatewayCapabilities::for('nagad'));
    }

    public function test_checkout_return_is_a_trigger_only_and_duplicate_callbacks_apply_once(): void
    {
        [, $tenant, $store, $h, $variant] = $this->onlineShop('ngco', providers: ['nagad']);
        config(['payments.fake' => false]);
        $this->inTenant($tenant, function () use ($store) {
            $a = PaymentGatewayAccount::query()->where('store_id', $store->id)->where('provider', 'nagad')->firstOrFail();
            $a->credentials = self::creds();
            $a->save();
        });
        $this->assertContains('nagad', $this->sf($store, 'GET', '/config')->json('data.commerce.payment_methods'));

        $this->fakeNagad();
        $r = $this->onlineCheckout($store, $variant, 'nagad')->assertCreated()
            ->assertJsonPath('data.order.payment_method', 'nagad')->assertJsonPath('data.payment.provider', 'nagad')->assertJsonPath('data.payment.status', 'redirect');
        $paymentId = $r->json('data.payment.payment_id');
        $this->assertStringStartsWith('https://sandbox-ssl.mynagad.com', $r->json('data.payment.redirect_url'));
        $payment = $this->paymentRow($tenant, $paymentId);
        $this->assertSame(self::REF, $payment->provider_payment_id);
        $return = PaymentUrls::returnUrl($payment);
        $parts = parse_url($return);
        $base = $parts['path'].'?'.$parts['query'];

        // Callback says Success but Verify says Failed: Verify decides (rule 8). Forged params are ignored.
        $this->fakeNagad($this->verifyBody($payment, 'Ready'));
        $this->gatewayReturn($base.'&payment_ref_id=FORGED&status=Success&order_id='.$paymentId)->assertStatus(303);
        $this->assertSame('pending', $this->paymentRow($tenant, $paymentId)->status);
        $this->assertStringEndsWith('/verify/payment/'.self::REF, $this->seen[0]['path']); // the STORED reference, not the forged one

        // Bad signature → 403 page, no provider call.
        $this->fakeNagad($this->verifyBody($payment));
        $this->gatewayReturn('/api/v1/payments/return/nagad/'.$paymentId.'?expires=1&signature='.str_repeat('a', 64))->assertStatus(403);
        $this->assertSame([], $this->seen);

        $this->gatewayReturn($base.'&payment_ref_id='.self::REF.'&status=Success')->assertStatus(303);
        $this->gatewayReturn($base.'&payment_ref_id='.self::REF.'&status=Success')->assertStatus(303); // duplicate callback
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->assertSame(['confirmed', 'paid', $payment->amount], [$order->status, $order->payment_status, $order->paid_amount]);
        $this->assertSame(1, $this->inTenant($tenant, fn () => Payment::query()->where('order_id', $order->id)->where('status', 'succeeded')->count()));

        // Gateway refund → 422 gateway_refund_unsupported; can_refund false; manual refunds stay possible.
        $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/refunds",
            ['method' => 'gateway', 'payment_id' => $paymentId, 'amount' => 1000])->assertStatus(422)->assertJsonPath('error.code', 'gateway_refund_unsupported');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order->id}")->assertJsonPath('data.payments.0.can_refund', false);
        $this->assertSame(0, $this->inTenant($tenant, fn () => Payment::query()->where('order_id', $order->id)->where('type', 'refund')->count()));
        // Cancel-and-refund is off for Nagad (P89D-48): the order cancels, nothing is sent to Nagad.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/cancel", ['reason' => 'out_of_stock', 'notify_customer' => false])->assertOk()
            ->assertJsonPath('data.refunded_amount', 0);
    }

    public function test_webhook_is_an_untrusted_trigger_deduplicated_and_verified(): void
    {
        [, $tenant, $store] = $this->liveShop('ngwh');
        [, $tenantB, $storeB] = $this->liveShop('ngwhb');
        [$account, $payment, $other] = $this->inTenant($tenant, function () use ($store) {
            [, $account] = $this->driver($store);
            $account->route_key = PaymentGatewayAccount::newRouteKey();
            $account->save();

            return [$account, $this->gatewayPayment($store, $account, 1000, ['provider_payment_id' => self::REF]), null];
        });
        $foreign = $this->inTenant($tenantB, function () use ($storeB) {
            [, $acc] = $this->driver($storeB);

            return $this->gatewayPayment($storeB, $acc, 1000, ['provider_payment_id' => self::REF]);
        });
        $url = '/api/v1/webhooks/nagad/'.$account->route_key;

        $this->flushHeaders()->postJson('/api/v1/webhooks/nagad/'.Str::random(32), ['payment_ref_id' => self::REF, 'order_id' => $payment->id])->assertNotFound();
        $this->flushHeaders()->postJson('/api/v1/webhooks/bkash/'.$account->route_key, ['Type' => 'x'])->assertNotFound(); // the key is bound to its provider

        // A forged "Success" for a payment Verify reports as Ready changes nothing.
        $this->fakeNagad($this->verifyBody($payment, 'Ready'));
        $this->flushHeaders()->postJson($url, ['payment_ref_id' => self::REF, 'order_id' => $payment->id, 'status' => 'Success'])->assertOk()->assertExactJson(['data' => ['received' => true]]);
        $this->assertSame('pending', $this->paymentRow($tenant, $payment->id)->status);
        // Replay of the same notification: stored once, processed once.
        $this->flushHeaders()->postJson($url, ['payment_ref_id' => self::REF, 'order_id' => $payment->id, 'status' => 'Success'])->assertOk();
        $this->assertSame(1, $this->inTenant($tenant, fn () => WebhookEvent::query()->where('provider', 'nagad')->count()));
        $this->assertCount(1, $this->seen);

        // Another status → new event → Verify now says Success → paid.
        $this->fakeNagad($this->verifyBody($payment));
        $this->flushHeaders()->postJson($url, ['payment_ref_id' => self::REF, 'order_id' => $payment->id, 'status' => 'Completed'])->assertOk();
        $this->assertSame('succeeded', $this->paymentRow($tenant, $payment->id)->status);

        // A notification naming another tenant's payment is ignored (looked up within this account's store only).
        $this->fakeNagad($this->verifyBody($foreign));
        $this->flushHeaders()->postJson($url, ['payment_ref_id' => 'OTHER', 'order_id' => $foreign->id, 'status' => 'Success'])->assertOk();
        $this->assertSame([], $this->seen);
        $this->assertSame('pending', $this->paymentRow($tenantB, $foreign->id)->status);
        $this->assertSame('ignored', $this->inTenant($tenant, fn () => WebhookEvent::query()->where('event_id', 'OTHER:success')->value('status')));
        // Garbage → acknowledged, nothing stored.
        $this->flushHeaders()->postJson($url, ['hello' => 'world'])->assertOk();
        $this->assertSame(3, $this->inTenant($tenant, fn () => WebhookEvent::query()->where('provider', 'nagad')->count()));
        unset($other);
    }

    public function test_reconcile_verifies_pending_nagad_charges(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop('ngrc', providers: ['nagad']);
        $r = $this->onlineCheckout($store, $variant, 'nagad')->assertCreated();
        $paymentId = $r->json('data.payment.payment_id');
        // The fake gateway's page: the shopper paid, but no return arrived; reconcile picks it up.
        $this->pressFake($tenant, $paymentId);
        $this->travel(3)->minutes();
        $this->artisan('payments:reconcile')->assertSuccessful();
        $this->assertSame('succeeded', $this->paymentRow($tenant, $paymentId)->status);
    }

    public function test_http_sandbox_is_refused_in_production_and_nagad_needs_https_otherwise(): void
    {
        config(['payments.providers.nagad.sandbox_allow_http' => true]);
        $this->app['env'] = 'production';
        try {
            GatewaysServiceProvider::assertSafeConfiguration($this->app);
            $this->fail('expected the boot check to refuse');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('NAGAD_SANDBOX_ALLOW_HTTP', $e->getMessage());
        } finally {
            $this->app['env'] = 'testing';
        }

        [, $tenant, $store] = $this->liveShop('nghttp');
        config(['payments.providers.nagad.base_urls.sandbox' => 'http://sandbox.mynagad.test/api/dfs', 'payments.providers.nagad.sandbox_allow_http' => false]);
        $this->inTenant($tenant, function () use ($store) {
            [$nagad, $account] = $this->driver($store);
            $this->fakeNagad();
            $this->expectException(\InvalidArgumentException::class); // SafeHttpClient: https only
            $nagad->checkCredentials($account);
        });
    }
}

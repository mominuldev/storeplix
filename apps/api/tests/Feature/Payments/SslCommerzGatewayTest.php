<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Orders\Models\Order;
use App\Domain\Payments\Gateways\RefundResult;
use App\Domain\Payments\Gateways\SslCommerzGateway;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\PaymentGatewayFixtures;
use Tests\TestCase;

/** PHASE-5B §5.2 / §13 "SSLCommerz driver": Http::fake + docs-built fixtures (tests/Fixtures/payments/sslcommerz). */
#[Group('payments')]
class SslCommerzGatewayTest extends TestCase
{
    use CommerceFixtures, PaymentGatewayFixtures, RefreshDatabase;

    private const CREDS = ['store_id' => 'testbox1234', 'store_passwd' => 'qwerty-pass'];

    private Tenant $tenant;

    private Store $store;

    private array $h;

    protected function setUp(): void
    {
        parent::setUp();
        config(['payments.fake' => false]);
        [, $this->tenant, $this->store, $this->h] = $this->liveShop();
    }

    /** @return array{0: SslCommerzGateway, 1: PaymentGatewayAccount} */
    private function driver(): array
    {
        return [app(SslCommerzGateway::class), $this->gatewayAccount($this->store, 'sslcommerz', self::CREDS)];
    }

    public function test_session_sends_only_the_listed_fields_and_returns_the_gateway_page(): void
    {
        [, $variant] = $this->stocked($this->h, $this->store, 177000);
        $number = $this->placeOrder($this->store, $variant)->json('data.order.number');
        $this->inTenant($this->tenant, function () use ($number) {
            [$ssl, $account] = $this->driver();
            $order = Order::query()->where('number', $number)->firstOrFail();
            $p = $this->gatewayPayment($this->store, $account, $order->total_amount, ['purpose' => 'order', 'order_id' => $order->id]);
            $this->fakeProvider(['gwprocess/v4/api.php' => 'sslcommerz/session']);
            $init = $ssl->initiate($p, $account, 'https://api.test/api/v1/payments/return/sslcommerz/'.$p->id.'?expires=1&signature=s', 'https://api.test/api/v1/webhooks/sslcommerz/KEY');
            $this->assertStringStartsWith('https://sandbox.sslcommerz.com/EasyCheckOut/', $init->redirectUrl);
            $this->assertNull($init->providerPaymentId);
            $this->assertSame('[redacted]', $init->raw['sessionkey']);

            Http::assertSent(function (Request $r) use ($p, $order) {
                $allowed = ['store_id', 'store_passwd', 'total_amount', 'currency', 'tran_id', 'success_url', 'fail_url', 'cancel_url', 'ipn_url',
                    'cus_name', 'cus_email', 'cus_add1', 'cus_city', 'cus_postcode', 'cus_country', 'cus_phone', 'shipping_method', 'num_of_item',
                    'product_name', 'product_category', 'product_profile', 'value_a', 'ship_name', 'ship_add1', 'ship_city', 'ship_postcode', 'ship_country'];
                $data = $r->data();

                return $r->url() === 'https://sandbox.sslcommerz.com/gwprocess/v4/api.php' && $r->isForm()
                    && array_diff(array_keys($data), $allowed) === []
                    && $data['tran_id'] === $p->id && $data['currency'] === 'BDT'
                    && $data['total_amount'] === number_format($order->total_amount / 100, 2, '.', '')
                    && $data['value_a'] === $order->number && $data['cus_phone'] === $order->customer_phone
                    && $data['cus_email'] === 'noreply+'.strtolower($order->number).'@storeplix.test'
                    && $data['ipn_url'] === 'https://api.test/api/v1/webhooks/sslcommerz/KEY'
                    && $data['success_url'] === $data['fail_url'];
            });
        });
    }

    public function test_validation_api_valid_validated_invalid_and_risk(): void
    {
        $this->inTenant($this->tenant, function () {
            [$ssl, $account] = $this->driver();
            $p = $this->gatewayPayment($this->store, $account, 177050);
            $vars = ['tran_id' => $p->id, 'amount' => '1770.50'];

            $this->fakeProvider(['validationserverAPI.php' => 'sslcommerz/validation_valid'], $vars);
            $v = $ssl->complete($p, $account, ['val_id' => '2611221016021Z4fKRg8bGkAuWq', 'status' => 'VALID', 'tran_id' => $p->id]);
            $this->assertSame([Verification::SUCCEEDED, 177050, 'BDT', $p->id, '2611221016020LZvlXBRe6Y9vR'], [$v->status, $v->amount, $v->currency, $v->reference, $v->providerTrxId]);
            $this->assertSame('0', $v->raw['risk_level'], 'risk level stays for PaymentService');
            $this->assertSame('[redacted]', $v->raw['card_issuer']);
            Http::assertSent(fn (Request $r) => str_contains($r->url(), 'validationserverAPI.php?') && $r['val_id'] === '2611221016021Z4fKRg8bGkAuWq'
                && $r['store_id'] === 'testbox1234' && $r['format'] === 'json');

            $validated = $this->paymentFixture('sslcommerz/validation_valid', $vars);
            $this->fakeProvider(['validationserverAPI.php' => fn () => Http::response(['status' => 'VALIDATED', 'risk_level' => '1'] + $validated)]);
            $v = $ssl->complete($p, $account, ['val_id' => 'x']);
            $this->assertSame([Verification::SUCCEEDED, '1'], [$v->status, $v->raw['risk_level']]);

            $this->fakeProvider(['validationserverAPI.php' => 'sslcommerz/validation_invalid']);
            $v = $ssl->complete($p, $account, ['val_id' => 'forged', 'status' => 'VALID']);
            $this->assertSame([Verification::FAILED, null], [$v->status, $v->amount]);

            $this->fakeProvider(['validationserverAPI.php' => fn () => Http::response(['amount' => '1770.505'] + $validated)]);
            $this->assertNull($ssl->complete($p, $account, ['val_id' => 'x'])->amount, '3 decimals → no amount (mismatch)');
        });
    }

    public function test_query_by_tran_id_and_returns_without_val_id(): void
    {
        $this->inTenant($this->tenant, function () {
            [$ssl, $account] = $this->driver();
            $p = $this->gatewayPayment($this->store, $account, 1000);
            $this->fakeProvider(['merchantTransIDvalidationAPI.php' => 'sslcommerz/query_by_tran_id'], ['tran_id' => $p->id, 'amount' => '10.00']);
            $v = $ssl->query($p, $account);
            $this->assertSame([Verification::SUCCEEDED, 1000, 'BDT', $p->id], [$v->status, $v->amount, $v->currency, $v->reference]);
            Http::assertSent(fn (Request $r) => $r['tran_id'] === $p->id);

            $this->fakeProvider(['merchantTransIDvalidationAPI.php' => fn () => Http::response(['APIConnect' => 'DONE', 'no_of_trans_found' => 0, 'element' => []])]);
            $this->assertSame(Verification::PENDING, $ssl->query($p, $account)->status);
            $this->assertSame(Verification::CANCELLED, $ssl->complete($p, $account, ['status' => 'CANCELLED', 'tran_id' => $p->id])->status);
            $this->assertSame(Verification::FAILED, $ssl->complete($p, $account, ['status' => 'FAILED'])->status);
            $this->assertSame(0, $this->callCount('validationserverAPI.php'));
        });
    }

    public function test_refund_success_processing_failed_and_status(): void
    {
        $this->inTenant($this->tenant, function () {
            [$ssl, $account] = $this->driver();
            $charge = $this->gatewayPayment($this->store, $account, 177000, ['status' => 'succeeded', 'provider_trx_id' => '2611221016020LZvlXBRe6Y9vR']);
            $refund = $this->gatewayPayment($this->store, $account, 50000, ['type' => 'refund', 'parent_payment_id' => $charge->id]);
            $vars = ['tran_id' => $charge->id];
            foreach (['refund_success' => RefundResult::SUCCEEDED, 'refund_processing' => RefundResult::PROCESSING, 'refund_failed' => RefundResult::FAILED] as $fixture => $status) {
                $this->fakeProvider(['merchantTransIDvalidationAPI.php' => "sslcommerz/{$fixture}"], $vars);
                $r = $ssl->refund($charge, $refund, $account, 50000, 'Damaged');
                $this->assertSame($status, $r->status, $fixture);
            }
            Http::assertSent(fn (Request $r) => $r['bank_tran_id'] === '2611221016020LZvlXBRe6Y9vR' && $r['refund_amount'] === '500.00'
                && $r['refe_id'] === $refund->id && $r['refund_remarks'] === 'Damaged');

            $refund->provider_payment_id = '5c76e0fbc0e14';
            $this->fakeProvider(['merchantTransIDvalidationAPI.php' => 'sslcommerz/refund_status'], $vars);
            $this->assertSame(RefundResult::SUCCEEDED, $ssl->refundStatus($refund, $account)->status);
            Http::assertSent(fn (Request $r) => $r['refund_ref_id'] === '5c76e0fbc0e14');

            $this->fakeProvider(['merchantTransIDvalidationAPI.php' => 'timeout']);
            $this->assertSame([RefundResult::PROCESSING, 'timeout'], [($t = $ssl->refund($charge, $refund, $account, 50000, null))->status, $t->failureCode]);
        });
    }

    /** IPN pre-filter: the md5 scheme of the official PHP SDK. */
    #[Group('security')]
    public function test_verify_sign_pre_filter(): void
    {
        $params = ['tran_id' => 'T1', 'val_id' => 'V1', 'amount' => '10.00', 'status' => 'VALID', 'verify_key' => 'amount,status,tran_id,val_id'];
        $hash = md5('amount=10.00&status=VALID&store_passwd='.md5('qwerty-pass').'&tran_id=T1&val_id=V1');
        $this->assertTrue(SslCommerzGateway::verifySign($params + ['verify_sign' => $hash], 'qwerty-pass'));
        $this->assertFalse(SslCommerzGateway::verifySign($params + ['verify_sign' => $hash], 'other-pass'));
        $this->assertFalse(SslCommerzGateway::verifySign(['amount' => '99.00'] + $params + ['verify_sign' => $hash], 'qwerty-pass'));
        $this->assertFalse(SslCommerzGateway::verifySign(['verify_key' => 'amount,missing'] + $params + ['verify_sign' => $hash], 'qwerty-pass'));
        $this->assertFalse(SslCommerzGateway::verifySign($params, 'qwerty-pass'));
    }
}

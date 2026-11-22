<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\BkashGateway;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Gateways\RefundResult;
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

/** PHASE-5B §5.1 / §13 "bKash driver": Http::fake + docs-built fixtures (tests/Fixtures/payments/bkash). */
#[Group('payments')]
class BkashGatewayTest extends TestCase
{
    use CommerceFixtures, PaymentGatewayFixtures, RefreshDatabase;

    private const CREDS = ['app_key' => 'appkey-3f9a', 'app_secret' => 'app-secret', 'username' => 'sandboxUser', 'password' => 'sandbox-pass'];

    private const BASE = 'https://tokenized.sandbox.bka.sh/v2/tokenized-checkout/';

    private Tenant $tenant;

    private Store $store;

    protected function setUp(): void
    {
        parent::setUp();
        config(['payments.fake' => false]);
        [, $this->tenant, $this->store] = $this->liveShop();
    }

    /** @return array{0: BkashGateway, 1: PaymentGatewayAccount} */
    private function driver(): array
    {
        return [app(BkashGateway::class), $this->gatewayAccount($this->store, 'bkash', self::CREDS)];
    }

    private function vars(Payment $p, ?string $amount = null): array
    {
        return ['amount' => $amount ?? '10.00', 'merchantInvoiceNumber' => $p->id, 'callbackURL' => 'https://api.test/cb'];
    }

    public function test_one_grant_serves_many_payments_and_the_token_is_refreshed_after_50_minutes(): void
    {
        $this->inTenant($this->tenant, function () {
            [$bkash, $account] = $this->driver();
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'auth/refresh-token' => 'bkash/refresh_token', 'payment/create' => 'bkash/create_payment'],
                ['amount' => '10.00', 'merchantInvoiceNumber' => 'x', 'callbackURL' => 'https://api.test/cb']);
            for ($i = 0; $i < 3; $i++) {
                $p = $this->gatewayPayment($this->store, $account, 1000);
                $init = $bkash->initiate($p, $account, 'https://api.test/cb?expires=1&signature=s', null);
                $this->assertSame('TR0011ON1565154754797', $init->providerPaymentId);
                $this->assertStringStartsWith('https://sandbox.payment.bkash.com/', $init->redirectUrl);
            }
            $this->assertSame(1, $this->callCount('auth/grant-token'));
            $this->assertSame(3, $this->callCount('payment/create'));
            Http::assertSent(fn (Request $r) => $r->url() === self::BASE.'payment/create'
                && $r->header('Authorization')[0] === 'eyJraWQiOiJmYWtlLWlkLXRva2VuIn0.sandbox' && $r->header('X-App-Key')[0] === 'appkey-3f9a'
                && $r['amount'] === '10.00' && $r['currency'] === 'BDT' && $r['intent'] === 'sale' && $r['merchantInvoiceNumber'] === $r['merchantInvoiceNumber']
                && $r['callbackURL'] === 'https://api.test/cb?expires=1&signature=s');
            $this->assertArrayNotHasKey('id_token', $init->raw);

            $this->travel(51)->minutes();
            $bkash->initiate($this->gatewayPayment($this->store, $account, 1000), $account, 'https://api.test/cb', null);
            $this->assertSame([1, 1], [$this->callCount('auth/grant-token'), $this->callCount('auth/refresh-token')]);
            Http::assertSent(fn (Request $r) => str_ends_with($r->url(), 'payment/create') && $r->header('Authorization')[0] === 'eyJraWQiOiJyZWZyZXNoZWQifQ.sandbox');
        });
    }

    public function test_token_calls_are_limited_to_two_per_hour_and_a_failed_grant_is_cached_five_minutes(): void
    {
        $this->inTenant($this->tenant, function () {
            [$bkash, $account] = $this->driver();
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token']);
            $bkash->checkCredentials($account);
            $bkash->checkCredentials($account);
            try {
                $bkash->checkCredentials($account);
                $this->fail('third token call in an hour must be refused');
            } catch (GatewayException $e) {
                $this->assertSame('provider_unavailable', $e->errorCode);
            }
            $this->assertSame(2, $this->callCount('auth/grant-token'), 'the guard refuses before calling bKash');
            $this->travel(61)->minutes();
            $bkash->checkCredentials($account);
            $this->assertSame(3, $this->callCount('auth/grant-token'));

            $other = $this->gatewayAccount(Store::query()->findOrFail($this->store->id), 'sslcommerz', ['store_id' => 'x', 'store_passwd' => 'y']);
            $other->provider = 'bkash'; // unsaved: a second bKash credential set
            $other->credentials = ['app_key' => 'wrong'] + self::CREDS;
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token_invalid']);
            foreach ([1, 2] as $_) {
                try {
                    $bkash->checkCredentials($other);
                    $this->fail('invalid credentials');
                } catch (GatewayException $e) {
                    $this->assertSame('credentials_invalid', $e->errorCode);
                }
            }
            $this->assertSame(1, $this->callCount('auth/grant-token'), 'the failure is cached for 5 minutes');
        });
    }

    public function test_create_execute_completed(): void
    {
        $this->inTenant($this->tenant, function () {
            [$bkash, $account] = $this->driver();
            $p = $this->gatewayPayment($this->store, $account, 177050, ['provider_payment_id' => 'TR0011ON1565154754797']);
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'payment/execute' => 'bkash/execute_payment'], $this->vars($p, '1770.50'));
            $v = $bkash->complete($p, $account, ['paymentID' => 'FORGED', 'status' => 'success']);
            $this->assertSame([Verification::SUCCEEDED, 177050, 'BDT', $p->id, '6H7801QFYM', null], [$v->status, $v->amount, $v->currency, $v->reference, $v->providerTrxId, $v->failureCode]);
            Http::assertSent(fn (Request $r) => str_ends_with($r->url(), 'payment/execute') && $r['paymentId'] === 'TR0011ON1565154754797');
            $this->assertSame('[redacted]', $v->raw['customerMsisdn'], 'PayloadScrubber');
            $this->assertSame('[redacted]', $v->raw['payerReference']);
        });
    }

    public function test_execute_timeout_then_query_completed(): void
    {
        $this->inTenant($this->tenant, function () {
            [$bkash, $account] = $this->driver();
            $p = $this->gatewayPayment($this->store, $account, 1000, ['provider_payment_id' => 'TR0011ON1565154754797']);
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'payment/execute' => 'timeout', 'query/payment' => 'bkash/query_payment_completed'], $this->vars($p));
            $v = $bkash->complete($p, $account, ['status' => 'success']);
            $this->assertSame([Verification::SUCCEEDED, 1000, '6H7801QFYM'], [$v->status, $v->amount, $v->providerTrxId]);
            $this->assertSame([1, 1], [$this->callCount('payment/execute'), $this->callCount('query/payment')]);

            // Still Initiated after the timeout → Execute once more, then report what the provider says.
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'payment/execute' => ['timeout', 'bkash/execute_payment'], 'query/payment' => 'bkash/query_payment_initiated'], $this->vars($p));
            $this->assertSame(Verification::SUCCEEDED, $bkash->complete($p, $account, ['status' => 'success'])->status);
            $this->assertSame(2, $this->callCount('payment/execute'));
        });
    }

    public function test_cancel_callback_with_provider_initiated_is_cancelled_and_completed_still_wins(): void
    {
        $this->inTenant($this->tenant, function () {
            [$bkash, $account] = $this->driver();
            $p = $this->gatewayPayment($this->store, $account, 1000, ['provider_payment_id' => 'TR0011ON1565154754797']);
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'query/payment' => 'bkash/query_payment_initiated'], $this->vars($p));
            $v = $bkash->complete($p, $account, ['status' => 'cancel']);
            $this->assertSame([Verification::CANCELLED, 'cancelled_by_shopper'], [$v->status, $v->failureCode]);
            $this->assertSame(Verification::FAILED, $bkash->complete($p, $account, ['status' => 'failure'])->status);
            $this->assertSame(0, $this->callCount('payment/execute'), 'never execute on cancel/failure');

            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'query/payment' => 'bkash/query_payment_completed'], $this->vars($p));
            $this->assertSame(Verification::SUCCEEDED, $bkash->complete($p, $account, ['status' => 'cancel'])->status);
            // Initiated after a success callback (S22): stays pending.
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'payment/execute' => 500, 'query/payment' => 'bkash/query_payment_initiated'], $this->vars($p));
            $this->assertSame(Verification::PENDING, $bkash->complete($p, $account, ['status' => 'success'])->status);
        });
    }

    public function test_refund_full_partial_rejected_and_timeout_recovers_through_refund_status(): void
    {
        $this->inTenant($this->tenant, function () {
            [$bkash, $account] = $this->driver();
            $charge = $this->gatewayPayment($this->store, $account, 177000, ['status' => 'succeeded', 'provider_payment_id' => 'TR0011ON1565154754797', 'provider_trx_id' => '6H7801QFYM']);
            $refund = fn (int $amount) => $this->gatewayPayment($this->store, $account, $amount, ['type' => 'refund', 'parent_payment_id' => $charge->id]);

            $full = $refund(177000);
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'refund/payment/transaction' => 'bkash/refund'], ['originalAmount' => '1770.00', 'refundAmount' => '1770.00', 'sku' => $full->id]);
            $r = $bkash->refund($charge, $full, $account, 177000, 'Customer cancelled');
            $this->assertSame([RefundResult::SUCCEEDED, '6H7801QFZZ'], [$r->status, $r->providerRefundId]);
            Http::assertSent(fn (Request $q) => str_ends_with($q->url(), 'refund/payment/transaction') && $q['refundAmount'] === '1770.00'
                && $q['sku'] === $full->id && $q['trxId'] === '6H7801QFYM' && $q['paymentId'] === 'TR0011ON1565154754797' && $q['reason'] === 'Customer cancelled');

            $partial = $refund(50005);
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'refund/payment/transaction' => 'bkash/refund'], ['originalAmount' => '1770.00', 'refundAmount' => '500.05', 'sku' => $partial->id]);
            $this->assertSame(RefundResult::SUCCEEDED, $bkash->refund($charge, $partial, $account, 50005, null)->status);
            Http::assertSent(fn (Request $q) => str_ends_with($q->url(), 'refund/payment/transaction') && $q['refundAmount'] === '500.05' && $q['reason'] === 'Refund');

            $over = $refund(177100);
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'refund/payment/transaction' => 'bkash/refund_rejected']);
            $r = $bkash->refund($charge, $over, $account, 177100, null);
            $this->assertSame([RefundResult::FAILED, 'bkash_2071'], [$r->status, $r->failureCode]);

            $late = $refund(30000);
            $this->fakeProvider(['auth/grant-token' => 'bkash/grant_token', 'refund/payment/transaction' => 'timeout', 'refund/payment/status' => 'bkash/refund_status'], ['originalAmount' => '1770.00', 'refundAmount' => '300.00']);
            $r = $bkash->refund($charge, $late, $account, 30000, null);
            $this->assertSame([RefundResult::SUCCEEDED, '6H7801QFZZ'], [$r->status, $r->providerRefundId]);
            $this->assertSame(1, $this->callCount('refund/payment/status'));
            $this->assertSame(RefundResult::SUCCEEDED, $bkash->refundStatus($late, $account)->status);
            $this->assertSame([RefundResult::FAILED, 'refund_not_found'], [$bkash->refundStatus($refund(12300), $account)->status, $bkash->refundStatus($refund(12300), $account)->failureCode]);
        });
    }

    public function test_live_mode_without_a_configured_base_url_is_not_connected(): void
    {
        $this->inTenant($this->tenant, function () {
            [$bkash, $account] = $this->driver();
            $account->mode = 'live';
            Http::fake();
            try {
                $bkash->checkCredentials($account);
                $this->fail('no BKASH_LIVE_BASE_URL');
            } catch (GatewayException $e) {
                $this->assertSame('gateway_not_connected', $e->errorCode);
            }
            Http::assertNothingSent();
        });
    }
}

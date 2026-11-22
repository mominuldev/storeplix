<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Coupons\Models\Coupon;
use App\Domain\Orders\Mail\NewOrderMerchantMail;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\FakeGateway;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Gateways\Initiation;
use App\Domain\Payments\Gateways\PaymentGateway;
use App\Domain\Payments\Gateways\RefundResult;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\Mail\PaymentAlertMail;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Sms\SmsGateway;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\OnlinePaymentFixtures;
use Tests\TestCase;

/** PHASE-5B §13 "Checkout online" (P5B-13–P5B-21, §5.3) with the fake gateway. */
#[Group('payments')]
class OnlineCheckoutTest extends TestCase
{
    use OnlinePaymentFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
    }

    private function sms(): array
    {
        return app(SmsGateway::class)->sent;
    }

    public function test_bkash_checkout_holds_the_order_then_a_verified_return_confirms_it_once(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated()
            ->assertJsonPath('data.order.status', 'pending_payment')->assertJsonPath('data.order.payment_method', 'bkash')
            ->assertJsonPath('data.order.paid_amount', 0)
            ->assertJsonPath('data.payment.provider', 'bkash')->assertJsonPath('data.payment.status', 'redirect')
            ->assertJsonPath('data.payment.amount', 107000)
            ->assertJsonPath('data.order.payment.status', 'pending')->assertJsonPath('data.order.payment.can_retry', true)
            ->assertJsonPath('data.order.payment.can_switch_to_cod', true);
        $this->assertSame(['payment_id', 'provider', 'status', 'redirect_url', 'amount', 'expires_at'], array_keys($r->json('data.payment')));
        $this->assertStringContainsString('/api/v1/dev/fake-gateway/', $r->json('data.payment.redirect_url'));
        $paymentId = $r->json('data.payment.payment_id');
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->assertEqualsWithDelta(30 * 60, $order->placed_at->diffInSeconds($order->payment_expires_at), 2);
        $this->assertSame(1, $this->committed($tenant, $variant));
        $this->assertSame([], $this->sms());
        Mail::assertNotSent(NewOrderMerchantMail::class);
        $this->inTenant($tenant, fn () => $this->assertFalse(Payment::query()->where('order_id', $order->id)->where('provider', 'cod')->exists()));

        $url = $this->pressFake($tenant, $paymentId);
        $this->gatewayReturn($url)->assertStatus(303)
            ->assertHeader('Location', 'https://'.$this->host($store).'/checkout/payment-result?payment='.$paymentId);
        $order = $this->orderRow($tenant, $order->number);
        $this->assertSame(['confirmed', 'paid', 107000], [$order->status, $order->payment_status, $order->paid_amount]);
        $payment = $this->paymentRow($tenant, $paymentId);
        $this->assertSame('succeeded', $payment->status);
        $this->assertNotNull($payment->provider_trx_id);
        $this->assertCount(1, $this->sms());
        $this->assertStringContainsString($order->number, $this->sms()[0]['text']);
        Mail::assertSent(NewOrderMerchantMail::class, 1);

        // Replay of the same return (and a reconcile pass): no second effect.
        $this->gatewayReturn($url)->assertStatus(303);
        $this->artisan('payments:reconcile')->assertSuccessful();
        $this->assertSame(107000, $this->orderRow($tenant, $order->number)->paid_amount);
        $this->assertCount(1, $this->sms());

        $this->sf($store, 'GET', "/payments/{$paymentId}/result")->assertOk()->assertHeader('Cache-Control', 'no-store, private')
            ->assertExactJson(['data' => ['status' => 'succeeded', 'order_number' => $order->number, 'amount' => 107000, 'currency' => 'BDT', 'purpose' => 'order', 'shop_name' => $store->name]]);
    }

    public function test_sslcommerz_return_by_browser_post(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant, 'sslcommerz')->assertCreated()->assertJsonPath('data.order.payment_method', 'sslcommerz');
        $id = $r->json('data.payment.payment_id');
        $url = $this->pressFake($tenant, $id);
        [$path, $query] = explode('?', $url, 2);
        parse_str($query, $q);
        $signed = $path.'?expires='.$q['expires'].'&signature='.$q['signature'];
        $this->gatewayReturn($signed, 'POST', ['tran_id' => $id, 'val_id' => 'VAL123', 'status' => 'VALID'])->assertStatus(303);
        $this->assertSame('confirmed', $this->orderRow($tenant, $r->json('data.order.number'))->status);
    }

    public function test_initiation_failure_keeps_the_order_and_the_shopper_retries(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $this->app->bind(FakeGateway::class, fn () => new class implements PaymentGateway
        {
            public function checkCredentials(PaymentGatewayAccount $account): void {}

            public function initiate(Payment $payment, PaymentGatewayAccount $account, string $returnUrl, ?string $ipnUrl): Initiation
            {
                throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE);
            }

            public function complete(Payment $payment, PaymentGatewayAccount $account, array $params): Verification
            {
                throw new GatewayException(GatewayException::PROVIDER_UNAVAILABLE);
            }

            public function query(Payment $payment, PaymentGatewayAccount $account): Verification
            {
                return new Verification('pending', null, null, null, null, null);
            }

            public function refund(Payment $charge, Payment $refund, PaymentGatewayAccount $account, int $amount, ?string $reason): RefundResult
            {
                return new RefundResult('failed', null, 'x');
            }

            public function refundStatus(Payment $refund, PaymentGatewayAccount $account): RefundResult
            {
                return new RefundResult('failed', null, 'x');
            }
        });
        $r = $this->onlineCheckout($store, $variant)->assertCreated()
            ->assertJsonPath('data.payment.status', 'initiation_failed')->assertJsonPath('data.payment.redirect_url', null)
            ->assertJsonPath('data.order.status', 'pending_payment')
            ->assertJsonPath('data.order.payment.status', 'failed')->assertJsonPath('data.order.payment.can_retry', true);
        $this->assertSame('initiation_failed', $this->paymentRow($tenant, $r->json('data.payment.payment_id'))->failure_code);
        $this->assertSame(1, $this->committed($tenant, $variant));

        $this->app->offsetUnset(FakeGateway::class);
        $token = $r->json('data.confirmation_token');
        $retry = $this->sf($store, 'POST', '/orders/pay', ['payment_method' => 'bkash'], null, ['X-Order-Token' => $token, 'Idempotency-Key' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('data.payment.status', 'redirect')->assertJsonPath('data.order.status', 'pending_payment');
        $this->payOnline($tenant, $retry->json('data.payment.payment_id'))->assertStatus(303);
        $this->assertSame('confirmed', $this->orderRow($tenant, $r->json('data.order.number'))->status);
    }

    public function test_failed_payment_then_retry_then_paid(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $first = $r->json('data.payment.payment_id');
        $token = $r->json('data.confirmation_token');
        $this->payOnline($tenant, $first, 'fail')->assertStatus(303);
        $this->assertSame('failed', $this->paymentRow($tenant, $first)->status);
        $this->sf($store, 'GET', '/orders/confirmation', [], null, ['X-Order-Token' => $token])->assertOk()
            ->assertJsonPath('data.status', 'pending_payment')->assertJsonPath('data.payment.status', 'failed')
            ->assertJsonPath('data.payment.can_retry', true);

        $key = (string) Str::uuid();
        $retry = $this->sf($store, 'POST', '/orders/pay', ['payment_method' => 'sslcommerz'], null, ['X-Order-Token' => $token, 'Idempotency-Key' => $key])
            ->assertOk()->assertJsonPath('data.payment.provider', 'sslcommerz')->assertJsonPath('data.order.payment_method', 'sslcommerz');
        // Same key → replay of the same answer (no third attempt).
        $this->sf($store, 'POST', '/orders/pay', ['payment_method' => 'sslcommerz'], null, ['X-Order-Token' => $token, 'Idempotency-Key' => $key])
            ->assertOk()->assertHeader('Idempotent-Replayed', 'true');
        $second = $retry->json('data.payment.payment_id');
        $this->assertNotSame($first, $second);
        $this->payOnline($tenant, $second)->assertStatus(303);
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->assertSame(['confirmed', 107000], [$order->status, $order->paid_amount]);
        $this->assertSame(2, $this->paymentRow($tenant, $second)->attempt);

        // Not pending any more → 409.
        $this->sf($store, 'POST', '/orders/pay', ['payment_method' => 'bkash'], null, ['X-Order-Token' => $token, 'Idempotency-Key' => (string) Str::uuid()])
            ->assertStatus(409)->assertJsonPath('error.code', 'payment_not_pending');
        // Unknown token → 404.
        $this->sf($store, 'POST', '/orders/pay', ['payment_method' => 'bkash'], null, ['X-Order-Token' => 'nope', 'Idempotency-Key' => (string) Str::uuid()])
            ->assertNotFound();
    }

    public function test_switch_to_cod_moves_the_order_to_pending_and_sends_the_order_sms(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $token = $r->json('data.confirmation_token');
        $this->sf($store, 'POST', '/orders/pay', ['payment_method' => 'cod'], null, ['X-Order-Token' => $token, 'Idempotency-Key' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('data.payment', null)->assertJsonPath('data.order.status', 'pending')
            ->assertJsonPath('data.order.payment_method', 'cod')->assertJsonPath('data.order.payment.status', 'cancelled')
            ->assertJsonPath('data.order.payment.can_retry', false);
        $this->assertSame('cancelled', $this->paymentRow($tenant, $r->json('data.payment.payment_id'))->status);
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->inTenant($tenant, fn () => $this->assertSame(107000, (int) Payment::query()->where('order_id', $order->id)->where('provider', 'cod')->where('status', 'pending')->value('amount')));
        $this->assertCount(1, $this->sms());
        $this->assertSame(1, $this->committed($tenant, $variant));
    }

    public function test_cod_is_refused_when_disabled(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $this->inTenant($tenant, fn () => StoreSetting::query()->where('store_id', $store->id)->update(['cod_enabled' => false]));
        $this->sf($store, 'POST', '/orders/pay', ['payment_method' => 'cod'], null, ['X-Order-Token' => $r->json('data.confirmation_token'), 'Idempotency-Key' => (string) Str::uuid()])
            ->assertStatus(422)->assertJsonPath('error.code', 'payment_method_unavailable');
    }

    public function test_hold_expiry_cancels_and_releases_stock_and_coupon_without_sms(): void
    {
        [, $tenant, $store, $h, $variant] = $this->onlineShop();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'TEN', 'type' => 'percentage', 'percent_bps' => 1000, 'status' => 'active', 'usage_limit' => 1, 'usage_per_customer' => null])->assertCreated();
        $cart = $this->cartWith($store, $variant);
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'TEN'], $cart)->assertOk();
        $total = $this->sf($store, 'GET', '/cart', [], $cart)->json('data.estimated_total_amount') + 7000;
        $r = $this->checkout($store, $cart, $this->checkoutBody($total, ['payment_method' => 'bkash']))->assertCreated();
        $number = $r->json('data.order.number');

        $this->artisan('payments:expire')->assertSuccessful();
        $this->assertSame('pending_payment', $this->orderRow($tenant, $number)->status, 'hold still open');

        $this->travel(31)->minutes();
        $this->artisan('payments:expire')->assertSuccessful();
        $order = $this->orderRow($tenant, $number);
        $this->assertSame(['cancelled', 'payment_timeout'], [$order->status, $order->cancel_reason]);
        $payment = $this->paymentRow($tenant, $r->json('data.payment.payment_id'));
        $this->assertSame(['cancelled', 'expired'], [$payment->status, $payment->failure_code]);
        $this->assertSame(0, $this->committed($tenant, $variant));
        $this->assertSame([], $this->sms());
        $this->inTenant($tenant, fn () => $this->assertSame(0, (int) Coupon::query()->where('code', 'TEN')->value('used_count')));
    }

    public function test_expiry_queries_first_and_applies_a_payment_that_went_through(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $this->pressFake($tenant, $r->json('data.payment.payment_id')); // paid at bKash, the browser never came back
        $this->travel(31)->minutes();
        $this->artisan('payments:expire')->assertSuccessful();
        $this->assertSame('confirmed', $this->orderRow($tenant, $r->json('data.order.number'))->status);
    }

    public function test_dev_time_travel_endpoint_expires_the_hold(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $id = $r->json('data.payment.payment_id');
        $this->flushHeaders()->postJson("/api/v1/dev/payments/{$id}/expire-now")->assertOk()
            ->assertExactJson(['data' => ['order_status' => 'cancelled', 'cancel_reason' => 'payment_timeout', 'payment_status' => 'cancelled']]);
        $this->assertSame(0, $this->committed($tenant, $variant));

        config(['payments.fake' => false]);
        $this->flushHeaders()->postJson("/api/v1/dev/payments/{$id}/expire-now")->assertNotFound();
    }

    public function test_late_payment_is_refunded_and_the_order_stays_cancelled(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant, 'sslcommerz')->assertCreated();
        $id = $r->json('data.payment.payment_id');
        $this->travel(31)->minutes();
        $this->artisan('payments:expire')->assertSuccessful();
        $url = $this->pressFake($tenant, $id); // SSLCommerz took the money after the hold ended
        $this->gatewayReturn($url)->assertStatus(303);
        $this->gatewayReturn($url)->assertStatus(303); // replay

        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->assertSame(['cancelled', 107000, 107000, 'refunded'], [$order->status, $order->paid_amount, $order->refunded_amount, $order->payment_status]);
        $this->inTenant($tenant, function () use ($id) {
            $this->assertSame(1, Payment::query()->where('parent_payment_id', $id)->where('type', 'refund')->count());
            $this->assertSame(107000, Payment::query()->whereKey($id)->value('refunded_amount'));
        });
        Mail::assertSent(PaymentAlertMail::class, fn (PaymentAlertMail $m) => $m->kind === 'late_refund');
        Mail::assertSent(PaymentAlertMail::class, 1);
        $this->assertSame([], $this->sms());
    }

    public function test_advance_delivery_charge_at_checkout(): void
    {
        [, $tenant, $store, $h, $variant] = $this->onlineShop();
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/settings", ['checkout' => ['cod_advance' => 'sometimes']])->assertStatus(422);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/settings", ['checkout' => ['cod_advance' => 'delivery_charge']])->assertOk()
            ->assertJsonPath('data.commerce.checkout.cod_advance', 'delivery_charge');
        $this->sf($store, 'GET', '/config')->assertJsonPath('data.commerce.cod_advance', 'delivery_charge')
            ->assertJsonPath('data.commerce.payment_methods', ['cod', 'bkash', 'sslcommerz']);

        $this->onlineCheckout($store, $variant, 'cod')->assertStatus(422)->assertJsonPath('error.code', 'advance_required')
            ->assertJsonValidationErrors('advance_gateway', 'error.details');
        $this->assertSame(0, $this->committed($tenant, $variant));

        $r = $this->onlineCheckout($store, $variant, 'cod', ['advance_gateway' => 'bkash'])->assertCreated()
            ->assertJsonPath('data.order.status', 'pending_payment')->assertJsonPath('data.order.payment_method', 'cod')
            ->assertJsonPath('data.payment.amount', 7000)->assertJsonPath('data.order.payment.purpose', 'advance')
            ->assertJsonPath('data.order.payment.can_switch_to_cod', false);
        $this->sf($store, 'POST', '/orders/pay', ['payment_method' => 'cod'], null, ['X-Order-Token' => $r->json('data.confirmation_token'), 'Idempotency-Key' => (string) Str::uuid()])
            ->assertStatus(422)->assertJsonPath('error.code', 'payment_method_unavailable');
        $this->payOnline($tenant, $r->json('data.payment.payment_id'))->assertStatus(303);
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->assertSame(['confirmed', 'partially_paid', 7000, 100000], [$order->status, $order->payment_status, $order->paid_amount, $order->dueAmount()]);
        $this->inTenant($tenant, fn () => $this->assertSame(100000, (int) Payment::query()->where('order_id', $order->id)->where('provider', 'cod')->where('status', 'pending')->value('amount')));
        $full = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order->id}")->assertOk()->json('data');
        $advance = collect($full['payments'])->firstWhere('purpose', 'advance');
        $this->assertSame(['succeeded', 'bkash', 7000, true], [$advance['status'], $advance['provider'], $advance['amount'], $advance['can_refund']]);
        $this->assertSame(['id', 'provider', 'type', 'status', 'amount', 'currency', 'method', 'reference', 'note', 'actor', 'created_at', 'purpose', 'provider_trx_id', 'refunded_amount', 'expires_at', 'failure_code', 'payment_link_id', 'return_request_id', 'can_refund'], array_keys($advance));
        $this->assertSame([], $full['payment_links']);

        // A free-delivery order needs no advance.
        $this->setCodAdvance($tenant, $store, 'none');
        $this->onlineCheckout($store, $variant, 'cod', ['advance_gateway' => 'bkash'])->assertCreated()->assertJsonPath('data.payment', null)
            ->assertJsonPath('data.order.status', 'pending')->assertJsonPath('data.order.payment', null);
    }

    public function test_unavailable_methods_are_refused_and_merchants_cannot_confirm_unpaid_orders(): void
    {
        [, $tenant, $store, $h, $variant] = $this->onlineShop(providers: ['bkash']);
        $this->onlineCheckout($store, $variant, 'sslcommerz')->assertStatus(422)->assertJsonPath('error.code', 'payment_method_unavailable');
        $this->onlineCheckout($store, $variant, 'nagad')->assertStatus(422)->assertJsonPath('error.code', 'payment_method_unavailable');
        $this->inTenant($tenant, fn () => $this->connectGateway($store, 'bkash', enabled: false));
        $this->sf($store, 'GET', '/config')->assertJsonPath('data.commerce.payment_methods', ['cod']);
        $this->onlineCheckout($store, $variant, 'bkash')->assertStatus(422);
        $this->inTenant($tenant, fn () => $this->connectGateway($store, 'bkash'));

        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order->id}")->assertJsonPath('data.allowed_transitions', ['cancelled'])
            ->assertJsonPath('data.payment_expires_at', $order->payment_expires_at->toIso8601ZuluString());
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/confirm")->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        // Merchant cancel of an unpaid hold releases stock and closes the attempt.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/cancel", ['reason' => 'customer_request', 'notify_customer' => false])->assertOk()->assertJsonPath('data.status', 'cancelled');
        $this->assertSame(['cancelled', 'order_cancelled'], [$this->paymentRow($tenant, $r->json('data.payment.payment_id'))->status, $this->paymentRow($tenant, $r->json('data.payment.payment_id'))->failure_code]);
    }

    public function test_schedules_are_registered(): void
    {
        $this->artisan('schedule:list')->expectsOutputToContain('payments:expire')->expectsOutputToContain('payment-links:expire')
            ->expectsOutputToContain('payments:reconcile')->expectsOutputToContain('payments:refund-status')->expectsOutputToContain('webhooks:prune');
    }

    public function test_reconcile_applies_paid_charges_whose_browser_never_returned(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $this->pressFake($tenant, $r->json('data.payment.payment_id'));
        $this->artisan('payments:reconcile')->assertSuccessful();
        $this->assertSame('pending_payment', $this->orderRow($tenant, $r->json('data.order.number'))->status, 'younger than 2 min');
        $this->travel(3)->minutes();
        $this->artisan('payments:reconcile')->assertSuccessful();
        $this->assertSame('confirmed', $this->orderRow($tenant, $r->json('data.order.number'))->status);
        $this->assertSame(Order::CONFIRMED, $this->orderRow($tenant, $r->json('data.order.number'))->status);
    }
}

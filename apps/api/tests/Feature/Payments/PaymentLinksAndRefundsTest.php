<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Mail\PaymentAlertMail;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Sms\SmsGateway;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\OnlinePaymentFixtures;
use Tests\TestCase;

/** PHASE-5B §13 "Payment links" (P5B-22/23, S28) and "Refunds" (P5B-24/25, S30). */
#[Group('payments')]
class PaymentLinksAndRefundsTest extends TestCase
{
    use OnlinePaymentFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    private function sms(): array
    {
        return app(SmsGateway::class)->sent;
    }

    /** A pending COD order (manual, ৳1000 + delivery). @return array{0: mixed, 1: mixed, 2: mixed, 3: array<string, string>, 4: array<string, mixed>} */
    private function codOrder(): array
    {
        [$user, $tenant, $store, $h, $variant] = $this->onlineShop();
        $order = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false, 'shipping_amount_override' => 12000]))->assertCreated()->json('data');

        return [$tenant, $store, $h, $variant, $order];
    }

    private function link(array $h, $store, array $order, array $body, ?string $key = null)
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/payment-links", $body + [
            'provider' => 'bkash', 'expires_in_minutes' => 120, 'cancel_if_unpaid' => true, 'send_sms' => false,
        ]);
    }

    public function test_amount_kinds_bounds_and_one_active_link(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [$tenant, $store, $h, , $order] = $this->codOrder();
        $due = $order['due_amount'];
        $this->assertSame(112000, $due);
        $path = "/api/v1/stores/{$store->id}/orders/{$order['id']}/payment-links";

        $this->link($h, $store, $order, ['amount_kind' => 'custom', 'amount' => $due + 1])->assertStatus(422)->assertJsonValidationErrors('amount', 'error.details');
        $this->link($h, $store, $order, ['amount_kind' => 'custom'])->assertStatus(422);
        $this->link($h, $store, $order, ['amount_kind' => 'percent', 'percent_bps' => 0])->assertStatus(422);
        $this->link($h, $store, $order, ['amount_kind' => 'full', 'provider' => 'nagad'])->assertStatus(422);
        $this->inTenant($tenant, fn () => $this->connectGateway($store, 'sslcommerz', enabled: false));
        $this->link($h, $store, $order, ['amount_kind' => 'full', 'provider' => 'sslcommerz'])->assertStatus(422)->assertJsonPath('error.code', 'gateway_not_connected');

        foreach ([['delivery_charge', null, 12000], ['percent', null, 28000], ['percent', 1000, 11200], ['full', null, $due], ['custom', null, 5000]] as [$kind, $bps, $amount]) {
            $body = ['amount_kind' => $kind] + ($bps !== null ? ['percent_bps' => $bps] : []) + ($kind === 'custom' ? ['amount' => 5000] : []);
            $link = $this->link($h, $store, $order, $body + ['status' => 'paid', 'token_hash' => 'x'])->assertCreated()
                ->assertJsonPath('data.amount', $amount)->assertJsonPath('data.status', 'active')->assertJsonPath('data.amount_kind', $kind)
                ->assertJsonPath('data.percent_bps', $kind === 'percent' ? ($bps ?? 2500) : null)->json('data');
            $this->assertSame(['id', 'order_id', 'amount_kind', 'percent_bps', 'amount', 'currency', 'provider', 'status', 'url', 'expires_at', 'cancel_if_unpaid', 'sent_via', 'paid_at', 'created_by', 'created_at'], array_keys($link));
            $this->assertMatchesRegularExpression('#^https://'.preg_quote($this->host($store), '#').'/pay/[A-Za-z0-9]{12}$#', $link['url']);
            $this->link($h, $store, $order, ['amount_kind' => 'full'])->assertStatus(409)->assertJsonPath('error.code', 'payment_link_active');
            $this->api($h, 'DELETE', "{$path}/{$link['id']}")->assertNoContent();
        }
        $this->api($h, 'GET', $path)->assertOk()->assertJsonCount(5, 'data')->assertJsonPath('data.0.status', 'cancelled');
        // Token stored hashed + encrypted, never in plain text.
        $token = substr($link['url'], -12);
        $this->inTenant($tenant, function () use ($token, $link) {
            $row = PaymentLink::query()->findOrFail($link['id']);
            $this->assertSame(hash('sha256', $token), $row->token_hash);
            $this->assertStringNotContainsString($token, $row->token_encrypted);
        });
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertJsonCount(5, 'data.payment_links');

        // Wrong order state.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/cancel", ['reason' => 'other', 'notify_customer' => false])->assertOk();
        $this->link($h, $store, $order, ['amount_kind' => 'full'])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
    }

    public function test_shopper_pays_a_link_and_the_order_confirms_itself(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [$tenant, $store, $h, , $order] = $this->codOrder();
        $link = $this->link($h, $store, $order, ['amount_kind' => 'delivery_charge', 'send_sms' => true])->assertCreated()->assertJsonPath('data.sent_via', ['sms'])->json('data');
        $token = substr($link['url'], -12);
        $this->assertCount(1, $this->sms());
        $text = $this->sms()[0]['text'];
        $this->assertStringContainsString($link['url'], $text);
        $this->assertStringContainsString('120', $text);
        $this->assertLessThanOrEqual(201, mb_strlen($text));

        $this->sf($store, 'GET', "/payment-links/{$token}")->assertOk()->assertExactJson(['data' => [
            'order_number' => $order['number'], 'shop_name' => $store->name, 'amount' => 12000, 'currency' => 'BDT', 'provider' => 'bkash',
            'expires_at' => $link['expires_at'], 'status' => 'active',
        ]]);
        $init = $this->sf($store, 'POST', "/payment-links/{$token}/pay", [], null, ['Idempotency-Key' => (string) Str::uuid()])->assertOk()
            ->assertJsonPath('data.status', 'redirect')->assertJsonPath('data.amount', 12000)->assertJsonPath('data.expires_at', $link['expires_at'])->json('data');
        $this->payOnline($tenant, $init['payment_id'])->assertStatus(303)
            ->assertHeader('Location', 'https://'.$this->host($store).'/pay/result?payment='.$init['payment_id']);

        $full = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertOk()
            ->assertJsonPath('data.status', 'confirmed')->assertJsonPath('data.payment_status', 'partially_paid')
            ->assertJsonPath('data.paid_amount', 12000)->assertJsonPath('data.due_amount', 100000)
            ->assertJsonPath('data.payment_links.0.status', 'paid')->json('data');
        $this->assertSame(100000, collect($full['payments'])->firstWhere('provider', 'cod')['amount']);
        $this->assertSame('link', collect($full['payments'])->firstWhere('provider', 'bkash')['purpose']);
        $this->sf($store, 'GET', "/payments/{$init['payment_id']}/result")->assertJsonPath('data.purpose', 'link')->assertJsonPath('data.status', 'succeeded');

        // S28: paid / unknown / malformed → byte-identical 404.
        $paid = $this->sf($store, 'GET', "/payment-links/{$token}")->assertNotFound()->getContent();
        $unknown = $this->sf($store, 'GET', '/payment-links/AAAAAAAAAAAA')->assertNotFound()->getContent();
        $this->assertSame($paid, $unknown);
        $this->assertSame($paid, $this->sf($store, 'GET', '/payment-links/short')->assertNotFound()->getContent());
        $this->api($h, 'DELETE', "/api/v1/stores/{$store->id}/orders/{$order['id']}/payment-links/{$link['id']}")->assertStatus(409);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/payment-links/{$link['id']}/resend")->assertStatus(409);
    }

    public function test_link_expiry_with_and_without_cancel(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [$tenant, $store, $h, $variant, $order] = $this->codOrder();
        $this->link($h, $store, $order, ['amount_kind' => 'full', 'cancel_if_unpaid' => false])->assertCreated();
        $this->travel(121)->minutes();
        $this->artisan('payment-links:expire')->assertSuccessful();
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertJsonPath('data.status', 'pending')
            ->assertJsonPath('data.payment_links.0.status', 'expired');

        $link = $this->link($h, $store, $order, ['amount_kind' => 'full', 'cancel_if_unpaid' => true])->assertCreated()->json('data');
        $this->sf($store, 'GET', '/payment-links/'.substr($link['url'], -12))->assertOk();
        $this->travel(121)->minutes();
        $this->sf($store, 'GET', '/payment-links/'.substr($link['url'], -12))->assertNotFound();
        $this->artisan('payment-links:expire')->assertSuccessful();
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertJsonPath('data.status', 'cancelled')
            ->assertJsonPath('data.cancel_reason', 'payment_link_expired');
        $this->assertSame(0, $this->committed($tenant, $variant));
    }

    public function test_resend_throttle_and_pay_link_throttle(): void
    {
        [, $store, $h, , $order] = $this->codOrder();
        $link = $this->link($h, $store, $order, ['amount_kind' => 'full'])->assertCreated()->assertJsonPath('data.sent_via', [])->json('data');
        $resend = "/api/v1/stores/{$store->id}/orders/{$order['id']}/payment-links/{$link['id']}/resend";
        for ($i = 0; $i < 3; $i++) {
            $this->api($h, 'POST', $resend)->assertOk()->assertJsonPath('data.sent_via', ['sms']);
        }
        $this->api($h, 'POST', $resend)->assertStatus(429);
        $this->assertCount(3, $this->sms());

        $token = substr($link['url'], -12);
        for ($i = 0; $i < 20; $i++) {
            $this->sf($store, 'GET', "/payment-links/{$token}", [], null, ['X-Storefront-Client-Ip' => '198.51.100.7'])->assertOk();
        }
        $this->sf($store, 'GET', "/payment-links/{$token}", [], null, ['X-Storefront-Client-Ip' => '198.51.100.7'])->assertStatus(429);
        $this->sf($store, 'GET', "/payment-links/{$token}", [], null, ['X-Storefront-Client-Ip' => '198.51.100.8'])->assertOk();
    }

    /** P5B-24 / S30: partial + full gateway refunds; amounts change only on provider success. */
    public function test_gateway_refunds(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, $tenant, $store, $h, $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $charge = $r->json('data.payment.payment_id');
        $this->payOnline($tenant, $charge)->assertStatus(303);
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $refund = fn (array $body, ?array $hh = null, ?string $key = null) => $this->api(($hh ?? $h) + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/refunds", $body + ['method' => 'gateway', 'payment_id' => $charge]);

        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $refund(['amount' => 1000], $staff)->assertForbidden();
        $refund(['amount' => 1000, 'payment_id' => null])->assertStatus(422)->assertJsonValidationErrors('payment_id', 'error.details');
        $refund(['amount' => 99])->assertStatus(422);
        $refund(['amount' => 107001])->assertStatus(422)->assertJsonPath('error.code', 'refund_exceeds_paid');

        $key = (string) Str::uuid();
        $first = $refund(['amount' => 7000, 'note' => 'Late delivery'], null, $key)->assertCreated()
            ->assertJsonPath('data.status', 'succeeded')->assertJsonPath('data.method', 'gateway')->assertJsonPath('data.provider', 'bkash')
            ->assertJsonPath('data.type', 'refund')->assertJsonPath('data.can_refund', false)->json('data');
        $refund(['amount' => 7000, 'note' => 'Late delivery'], null, $key)->assertCreated()->assertJsonPath('data.id', $first['id']); // replay
        $o = $this->orderRow($tenant, $order->number);
        $this->assertSame([7000, 'partially_refunded'], [$o->refunded_amount, $o->payment_status]);
        $this->assertSame(7000, $this->paymentRow($tenant, $charge)->refunded_amount);

        // Provider refusal (fake: amount ending in 13 paisa) → 422, nothing changes; a new key can retry.
        $refund(['amount' => 1013])->assertStatus(422)->assertJsonPath('error.code', 'gateway_refund_rejected');
        $this->assertSame(7000, $this->orderRow($tenant, $order->number)->refunded_amount);
        Mail::assertNotSent(PaymentAlertMail::class);

        $refund(['amount' => 100000])->assertCreated();
        $o = $this->orderRow($tenant, $order->number);
        $this->assertSame([107000, 'refunded'], [$o->refunded_amount, $o->payment_status]);
        $refund(['amount' => 100])->assertStatus(422)->assertJsonPath('error.code', 'refund_exceeds_paid');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order->id}")->assertJsonPath('data.can.refund', false);
    }

    public function test_cancel_refunds_to_the_gateway_by_default(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, $tenant, $store, $h, $variant] = $this->onlineShop(stock: 20);
        $orders = [];
        foreach (['01711000011', '01711000012'] as $phone) {
            $r = $this->onlineCheckout($store, $variant, 'bkash', ['contact' => ['phone' => $phone]])->assertCreated();
            $this->payOnline($tenant, $r->json('data.payment.payment_id'))->assertStatus(303);
            $orders[] = $this->orderRow($tenant, $r->json('data.order.number'));
        }
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($staff, 'POST', "/api/v1/stores/{$store->id}/orders/{$orders[0]->id}/cancel", ['reason' => 'out_of_stock'])->assertForbidden();

        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$orders[0]->id}/cancel", ['reason' => 'out_of_stock', 'notify_customer' => false])->assertOk()
            ->assertJsonPath('data.status', 'cancelled')->assertJsonPath('data.refunded_amount', 107000)->assertJsonPath('data.payment_status', 'refunded');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$orders[1]->id}/cancel", ['reason' => 'out_of_stock', 'notify_customer' => false, 'refund_to_gateway' => false])->assertOk()
            ->assertJsonPath('data.refunded_amount', 0)->assertJsonPath('data.payments.0.can_refund', true);
    }

    public function test_return_linked_gateway_refund(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, $tenant, $store, $h, $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant, 'bkash', [], 2)->assertCreated();
        $charge = $r->json('data.payment.payment_id');
        $this->payOnline($tenant, $charge)->assertStatus(303);
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        foreach (['ship', 'deliver'] as $step) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/{$step}", ['notify_customer' => false])->assertOk();
        }
        $item = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order->id}")->json('data.items.0.id');
        $return = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/returns", ['type' => 'return', 'reason' => 'damaged', 'lines' => [['order_item_id' => $item, 'quantity' => 1]]])
            ->assertCreated()->json('data');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/returns/{$return['id']}/approve", [])->assertOk();
        $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$order->id}/refunds", [
            'amount' => $return['requested_amount'], 'method' => 'gateway', 'payment_id' => $charge, 'return_id' => $return['id'],
        ])->assertCreated()->assertJsonPath('data.return_request_id', $return['id']);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/returns/{$return['id']}")->assertJsonPath('data.refunded_amount', $return['requested_amount']);
    }

    public function test_exchange_order_sends_a_payment_link_for_the_difference(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, $tenant, $store, $h, $variant] = $this->onlineShop();
        [, $dearer] = $this->stocked($h, $store, 150000, 5);
        $order = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->assertCreated()->json('data');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/{$step}", ['notify_customer' => false])->assertOk();
        }
        $return = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => 'exchange', 'reason' => 'wrong_size',
            'lines' => [['order_item_id' => $order['items'][0]['id'], 'quantity' => 1, 'exchange_variant_id' => $dearer]]])->assertCreated()->json('data');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/returns/{$return['id']}/approve", [])->assertOk();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/returns/{$return['id']}/receive", ['checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true],
            'lines' => [['return_item_id' => $return['items'][0]['id'], 'restock_quantity' => 1]]])->assertOk();
        $res = $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/returns/{$return['id']}/exchange-order", [
            'send_payment_link' => ['provider' => 'bkash', 'expires_in_minutes' => 1440],
        ])->assertCreated()->json('data');
        $this->assertSame('active', $res['payment_link']['status']);
        // Only the price difference of the goods (৳1,500 − ৳1,000), not the delivery charge.
        $this->assertSame(50000, $res['payment_link']['amount']);
        $this->assertSame('custom', $res['payment_link']['amount_kind']);
        $this->assertSame(50000 + $res['order']['shipping_amount'], $res['order']['due_amount']);
        $this->assertSame(['sms'], $res['payment_link']['sent_via']);
    }
}

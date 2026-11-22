<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\Mail\PaymentAlertMail;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Payments\PaymentService;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\OnlinePaymentFixtures;
use Tests\TestCase;

/** PHASE-5B §12 S22–S25, S29, S39 (payments) and the §13 tenancy items for returns and webhooks. */
#[Group('security')]
#[Group('payments')]
class PaymentSecurityTest extends TestCase
{
    use OnlinePaymentFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
    }

    /** S22: the return query never decides; only Execute/Query/Validation do. */
    public function test_forged_success_redirect_changes_nothing(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $id = $r->json('data.payment.payment_id');
        $signed = $this->pressFake($tenant, $id, 'cancel'); // the shopper cancelled at bKash …
        // … the provider still reports Initiated (no button result recorded) …
        $this->inTenant($tenant, function () use ($id) {
            $cache = app(TenantCache::class);
            $cache->put('payments:fake:'.$id, ['outcome' => null] + (array) $cache->get('payments:fake:'.$id), 3600);
        });
        // … and forges status=success: the provider still says Initiated → nothing changes.
        $forged = preg_replace('/status=cancel/', 'status=success', $signed);
        $this->gatewayReturn($forged)->assertStatus(303);
        $this->assertSame('pending', $this->paymentRow($tenant, $id)->status);
        $this->assertSame('pending_payment', $this->orderRow($tenant, $r->json('data.order.number'))->status);

        // Provider FAILED + forged success → failed, order untouched.
        $this->pressFake($tenant, $id, 'fail');
        $this->gatewayReturn($forged)->assertStatus(303);
        $this->assertSame('failed', $this->paymentRow($tenant, $id)->status);
        $this->assertSame(0, $this->orderRow($tenant, $r->json('data.order.number'))->paid_amount);
    }

    /** S23: 1 paisa off → failed + audit + merchant email; order untouched. */
    public function test_amount_mismatch_is_rejected_and_reported(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop(price: 100017);
        $r = $this->onlineCheckout($store, $variant)->assertCreated()->assertJsonPath('data.payment.amount', 107017);
        $id = $r->json('data.payment.payment_id');
        $this->payOnline($tenant, $id)->assertStatus(303);
        $payment = $this->paymentRow($tenant, $id);
        $this->assertSame(['failed', 'amount_mismatch'], [$payment->status, $payment->failure_code]);
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->assertSame(['pending_payment', 0], [$order->status, $order->paid_amount]);
        $this->inTenant($tenant, fn () => $this->assertSame(1, AuditLog::query()->where('action', 'payment.mismatch')->count()));
        Mail::assertSent(PaymentAlertMail::class, fn (PaymentAlertMail $m) => $m->kind === 'mismatch');
    }

    public function test_currency_and_reference_mismatches(): void
    {
        $p = new Payment;
        $p->id = '01jabcdefghjkmnpqrstvwxyz0';
        $p->amount = 1000;
        $ok = new Verification('succeeded', 1000, 'BDT', '01JABCDEFGHJKMNPQRSTVWXYZ0', 'T1', null);
        $this->assertNull(PaymentService::mismatch($p, $ok));
        $this->assertSame('amount_mismatch', PaymentService::mismatch($p, new Verification('succeeded', 1001, 'BDT', $p->id, 'T1', null)));
        $this->assertSame('amount_mismatch', PaymentService::mismatch($p, new Verification('succeeded', null, 'BDT', $p->id, 'T1', null)));
        $this->assertSame('currency_mismatch', PaymentService::mismatch($p, new Verification('succeeded', 1000, 'USD', $p->id, 'T1', null)));
        $this->assertSame('reference_mismatch', PaymentService::mismatch($p, new Verification('succeeded', 1000, 'BDT', '01jabcdefghjkmnpqrstvwxyz1', 'T1', null)));
        $this->assertSame('reference_mismatch', PaymentService::mismatch($p, new Verification('succeeded', 1000, 'BDT', null, 'T1', null)));
    }

    /** S24: same IPN twice → one stored event, one effect; one trx id can't pay two charges. */
    public function test_ipn_replay_and_duplicate_transaction(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant, 'sslcommerz')->assertCreated();
        $id = $r->json('data.payment.payment_id');
        $this->pressFake($tenant, $id); // paid at the gateway; IPN arrives before the browser
        $key = $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->where('store_id', $store->id)->where('provider', 'sslcommerz')->value('route_key'));
        $fields = $this->ipnFields($id, 'VAL-1');
        $this->flushHeaders()->post("/api/v1/webhooks/sslcommerz/{$key}", $fields)->assertOk()->assertExactJson(['data' => ['received' => true]]);
        $this->flushHeaders()->post("/api/v1/webhooks/sslcommerz/{$key}", $fields)->assertOk()->assertExactJson(['data' => ['received' => true]]);
        $this->inTenant($tenant, function () {
            $this->assertSame(1, WebhookEvent::query()->count());
            $event = WebhookEvent::query()->firstOrFail();
            $this->assertSame(['processed', 'VAL-1'], [$event->status, $event->event_id]);
            $this->assertSame('[redacted]', $event->payload['verify_sign']);
        });
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->assertSame(['confirmed', 107000], [$order->status, $order->paid_amount]);

        // One provider transaction can't pay a second charge.
        $r2 = $this->onlineCheckout($store, $variant, 'sslcommerz', ['contact' => ['phone' => '01711000002']])->assertCreated();
        $second = $this->paymentRow($tenant, $r2->json('data.payment.payment_id'));
        $trx = $this->paymentRow($tenant, $id)->provider_trx_id;
        $this->inTenant($tenant, fn () => app(PaymentService::class)->apply($second, new Verification('succeeded', 107000, 'BDT', $second->id, $trx, null), 'test'));
        $this->assertSame(['failed', 'duplicate_transaction'], [$this->paymentRow($tenant, $second->id)->status, $this->paymentRow($tenant, $second->id)->failure_code]);
        $this->assertSame('pending_payment', $this->orderRow($tenant, $r2->json('data.order.number'))->status);
    }

    /** S25: unknown key → 404; bad verify_sign → stored as ignored, nothing applied; INVALID validation → unpaid. */
    public function test_forged_webhooks(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant, 'sslcommerz')->assertCreated();
        $id = $r->json('data.payment.payment_id');
        $key = $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->where('store_id', $store->id)->where('provider', 'sslcommerz')->value('route_key'));

        $this->flushHeaders()->post('/api/v1/webhooks/sslcommerz/'.str_repeat('a', 32), $this->ipnFields($id, 'V1'))->assertNotFound();
        $this->flushHeaders()->post('/api/v1/webhooks/bkash/'.$key, [])->assertNotFound(); // provider bound to the key

        $forged = $this->ipnFields($id, 'V2');
        $forged['verify_sign'] = md5('forged');
        $this->flushHeaders()->post("/api/v1/webhooks/sslcommerz/{$key}", $forged)->assertOk();
        $this->inTenant($tenant, fn () => $this->assertSame('ignored', WebhookEvent::query()->where('event_id', 'V2')->value('status')));

        // Valid verify_sign but the Validation API doesn't confirm (the shopper never paid) → still unpaid.
        $this->flushHeaders()->post("/api/v1/webhooks/sslcommerz/{$key}", $this->ipnFields($id, 'V3'))->assertOk();
        $this->assertSame('pending', $this->paymentRow($tenant, $id)->status);
        $this->assertSame('pending_payment', $this->orderRow($tenant, $r->json('data.order.number'))->status);
    }

    public function test_bkash_sns_endpoint_is_a_trigger_and_refuses_foreign_subscribe_urls(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $id = $r->json('data.payment.payment_id');
        $key = $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->where('store_id', $store->id)->where('provider', 'bkash')->value('route_key'));
        Http::fake();
        $this->flushHeaders()->call('POST', "/api/v1/webhooks/bkash/{$key}", [], [], [], ['CONTENT_TYPE' => 'text/plain'], json_encode([
            'Type' => 'SubscriptionConfirmation', 'MessageId' => 'm1', 'SubscribeURL' => 'http://169.254.169.254/latest/meta-data',
        ]))->assertOk();
        Http::assertNothingSent();

        // A notification only triggers Query Payment: paid at bKash → applied; forged → no effect.
        $this->pressFake($tenant, $id);
        $this->flushHeaders()->call('POST', "/api/v1/webhooks/bkash/{$key}", [], [], [], ['CONTENT_TYPE' => 'text/plain'], json_encode([
            'Type' => 'Notification', 'MessageId' => 'm2', 'Message' => json_encode(['merchantInvoiceNumber' => $id, 'trxID' => 'X', 'customerMsisdn' => '01700000000']),
        ]))->assertOk();
        $this->assertSame('confirmed', $this->orderRow($tenant, $r->json('data.order.number'))->status);
        $this->inTenant($tenant, fn () => $this->assertSame('[redacted]', WebhookEvent::query()->where('event_id', 'm2')->firstOrFail()->payload['customerMsisdn']));
    }

    /** S29: unsigned / expired / tampered → 403 page, no redirect; extra ?next= ignored. */
    public function test_return_signature_and_redirect_rules(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant)->assertCreated();
        $id = $r->json('data.payment.payment_id');
        $url = $this->pressFake($tenant, $id);
        [$path] = explode('?', $url, 2);

        $this->gatewayReturn($path.'?paymentID=x&status=success')->assertForbidden()->assertHeaderMissing('Location');
        $this->gatewayReturn(str_replace('signature=', 'signature=0', $url))->assertForbidden();
        $this->gatewayReturn($url.'&next=https://evil.example')->assertStatus(303)
            ->assertHeader('Location', 'https://'.$this->host($store).'/checkout/payment-result?payment='.$id);
        $this->travel(27)->hours();
        $this->gatewayReturn($url)->assertForbidden()->assertSee('expired');
    }

    /** Tenancy: B's payment id with A's signature → 403; A's route key can't touch B's payment; result of another store → 404. */
    public function test_cross_store_payment_ids_and_route_keys(): void
    {
        [, $tenantA, $storeA, , $variantA] = $this->onlineShop('shopa');
        [, $tenantB, $storeB, , $variantB] = $this->onlineShop('shopb');
        $a = $this->onlineCheckout($storeA, $variantA, 'sslcommerz')->assertCreated()->json('data.payment.payment_id');
        $b = $this->onlineCheckout($storeB, $variantB, 'sslcommerz')->assertCreated()->json('data.payment.payment_id');
        $urlA = $this->pressFake($tenantA, $a);
        $this->pressFake($tenantB, $b);

        $this->gatewayReturn(str_replace($a, $b, $urlA))->assertForbidden();
        $this->assertSame('pending', $this->paymentRow($tenantB, $b)->status);

        $keyA = $this->inTenant($tenantA, fn () => PaymentGatewayAccount::query()->where('provider', 'sslcommerz')->value('route_key'));
        $this->flushHeaders()->post("/api/v1/webhooks/sslcommerz/{$keyA}", $this->ipnFields($b, 'VB'))->assertOk();
        $this->assertSame('pending', $this->paymentRow($tenantB, $b)->status);
        $this->inTenant($tenantA, fn () => $this->assertSame(['ignored', 'unknown_payment'], [WebhookEvent::query()->value('status'), WebhookEvent::query()->value('error_code')]));
        $this->inTenant($tenantB, fn () => $this->assertSame(0, WebhookEvent::query()->count()));

        $this->sf($storeA, 'GET', "/payments/{$b}/result")->assertNotFound();
        $this->sf($storeA, 'GET', '/payments/not-a-ulid/result')->assertNotFound();
    }

    /** S39: checkout ignores injected status/amount/payment fields. */
    public function test_checkout_mass_assignment_probe(): void
    {
        [, $tenant, $store, , $variant] = $this->onlineShop();
        $r = $this->onlineCheckout($store, $variant, 'bkash', [
            'status' => 'confirmed', 'payment_status' => 'paid', 'paid_amount' => 107000, 'payment_expires_at' => '2099-01-01T00:00:00Z',
            'amount' => 1, 'payment' => ['status' => 'succeeded', 'amount' => 1],
        ])->assertCreated()->assertJsonPath('data.payment.amount', 107000);
        $order = $this->orderRow($tenant, $r->json('data.order.number'));
        $this->assertSame(['pending_payment', 'unpaid', 0], [$order->status, $order->payment_status, $order->paid_amount]);
        $this->assertTrue($order->payment_expires_at->lt(now()->addHour()));
        $this->assertSame(Order::PENDING_PAYMENT, $order->status);
    }
}

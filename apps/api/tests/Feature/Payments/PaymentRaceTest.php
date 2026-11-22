<?php

declare(strict_types=1);

namespace Tests\Feature\Payments;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\FakeGateway;
use App\Domain\Payments\Gateways\Initiation;
use App\Domain\Payments\Gateways\PaymentGateway;
use App\Domain\Payments\Gateways\RefundResult;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\Models\WebhookEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\Support\OnlinePaymentFixtures;
use Tests\TestCase;

/** S24 on Postgres (fork-based, like CommerceSecurityTest): IPN + return + replays at once → one effect. */
#[Group('security')]
#[Group('payments')]
class PaymentRaceTest extends TestCase
{
    use ForksRaces, OnlinePaymentFixtures, RefreshDatabase;

    #[Group('perf')]
    #[Group('race')]
    public function test_concurrent_ipn_and_return_apply_the_payment_once(): void
    {
        $this->requirePostgresRace();
        try {
            $this->withoutMiddleware(ThrottleRequests::class);
            Mail::fake();
            [, $tenant, $store, , $variant] = $this->onlineShop();
            $r = $this->onlineCheckout($store, $variant, 'sslcommerz')->assertCreated();
            $id = $r->json('data.payment.payment_id');
            $url = $this->pressFake($tenant, $id);
            $key = $this->inTenant($tenant, fn () => PaymentGatewayAccount::query()->where('provider', 'sslcommerz')->value('route_key'));
            $fields = $this->ipnFields($id, 'VAL-RACE');
            // Forked children drop the parent's (array) cache, where the fake page keeps its state: report "paid" directly.
            $this->app->bind(FakeGateway::class, fn () => new class implements PaymentGateway
            {
                public function checkCredentials(PaymentGatewayAccount $account): void {}

                public function initiate(Payment $payment, PaymentGatewayAccount $account, string $returnUrl, ?string $ipnUrl): Initiation
                {
                    return new Initiation('https://example.test', null);
                }

                public function complete(Payment $payment, PaymentGatewayAccount $account, array $params): Verification
                {
                    return $this->query($payment, $account);
                }

                public function query(Payment $payment, PaymentGatewayAccount $account): Verification
                {
                    usleep(random_int(0, 20000));

                    return new Verification('succeeded', $payment->amount, 'BDT', $payment->id, 'TRX-RACE', null);
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

            // 3 browser returns + 3 copies of the same IPN, all at once.
            $results = $this->parallel(6, fn (int $i) => $i % 2 === 0
                ? $this->gatewayReturn($url)->status()
                : $this->flushHeaders()->post("/api/v1/webhooks/sslcommerz/{$key}", $fields)->status());
            $this->assertSame([303, 200, 303, 200, 303, 200], $results);

            $order = Order::withoutTenancy()->where('store_id', $store->id)->firstOrFail();
            $this->assertSame(['confirmed', 107000, 'paid'], [$order->status, $order->paid_amount, $order->payment_status]);
            $this->assertSame('succeeded', Payment::withoutTenancy()->whereKey($id)->value('status'));
            $this->assertSame(1, WebhookEvent::withoutTenancy()->where('tenant_id', $tenant->id)->count());
            $this->assertSame(1, OrderEvent::withoutTenancy()->where('order_id', $order->id)->where('type', 'status_changed')->count());
            $this->assertSame(1, OrderEvent::withoutTenancy()->where('order_id', $order->id)->where('type', 'payment')->count());
        } finally {
            $this->raceCleanup();
        }
    }
}

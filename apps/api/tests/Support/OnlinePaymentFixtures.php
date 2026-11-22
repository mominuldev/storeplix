<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Inventory\Models\Inventory;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\FakeGateway;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Testing\TestResponse;

/** 5b-2 API-2 helpers: a live shop with fake bKash + SSLCommerz accounts, online checkout, the fake page's buttons. */
trait OnlinePaymentFixtures
{
    use CommerceFixtures;

    protected const SSL_PASSWD = 'qwerty-store-pass';

    /** @return array{0: mixed, 1: Tenant, 2: Store, 3: array<string, string>, 4: string} user, tenant, store, headers, variant */
    protected function onlineShop(string $slug = 'shop', int $price = 100000, int $stock = 10, array $providers = ['bkash', 'sslcommerz']): array
    {
        config(['payments.fake' => true]);
        [$user, $tenant, $store, $h] = $this->liveShop($slug);
        [, $variant] = $this->stocked($h, $store, $price, $stock);
        $this->inTenant($tenant, function () use ($store, $providers) {
            foreach ($providers as $provider) {
                $this->connectGateway($store, $provider);
            }
        });

        return [$user, $tenant, $store, $h, $variant];
    }

    /** Call inside the tenant. */
    protected function connectGateway(Store $store, string $provider, bool $enabled = true): PaymentGatewayAccount
    {
        $a = PaymentGatewayAccount::query()->where('store_id', $store->id)->where('provider', $provider)->first() ?? new PaymentGatewayAccount;
        $a->store_id = $store->id;
        $a->provider = $provider;
        $a->mode = 'sandbox';
        $a->status = 'connected';
        $a->enabled = $enabled;
        $a->credentials = $provider === 'bkash'
            ? ['app_key' => 'appkey-3f9a', 'app_secret' => 'secret', 'username' => 'user', 'password' => 'pass']
            : ['store_id' => 'testbox1234', 'store_passwd' => self::SSL_PASSWD];
        $a->route_key ??= PaymentGatewayAccount::newRouteKey();
        $a->save();

        return $a;
    }

    /** Online checkout of one unit at the cart total + the Dhaka delivery charge (7000). */
    protected function onlineCheckout(Store $store, string $variant, string $method = 'bkash', array $override = [], int $quantity = 1): TestResponse
    {
        $cart = $this->cartWith($store, $variant, $quantity);
        $total = $this->sf($store, 'GET', '/cart', [], $cart)->json('data.estimated_total_amount') + 7000;

        return $this->checkout($store, $cart, $this->checkoutBody($total, ['payment_method' => $method] + $override));
    }

    /** Presses a button on the fake hosted page; returns the gateway return URL (path + query) the browser goes to. */
    protected function pressFake(Tenant $tenant, string $paymentId, string $outcome = 'pay'): string
    {
        $url = (string) $this->inTenant($tenant, fn () => app(FakeGateway::class)->recordOutcome(Payment::query()->findOrFail($paymentId), $outcome));
        $parts = parse_url($url);

        return $parts['path'].'?'.$parts['query'];
    }

    protected function gatewayReturn(string $url, string $method = 'GET', array $form = []): TestResponse
    {
        return $this->flushHeaders()->withHeaders(['Origin' => 'https://sandbox.example'])->call($method, $url, $form);
    }

    protected function payOnline(Tenant $tenant, string $paymentId, string $outcome = 'pay'): TestResponse
    {
        return $this->gatewayReturn($this->pressFake($tenant, $paymentId, $outcome));
    }

    protected function orderRow(Tenant $tenant, string $number): Order
    {
        return $this->inTenant($tenant, fn () => Order::query()->where('number', $number)->firstOrFail());
    }

    protected function paymentRow(Tenant $tenant, string $id): Payment
    {
        return $this->inTenant($tenant, fn () => Payment::query()->findOrFail($id));
    }

    protected function committed(Tenant $tenant, string $variant): int
    {
        return (int) $this->inTenant($tenant, fn () => Inventory::query()->where('variant_id', $variant)->value('committed'));
    }

    protected function setCodAdvance(Tenant $tenant, Store $store, string $value = 'delivery_charge'): void
    {
        $this->inTenant($tenant, function () use ($store, $value) {
            $s = StoreSetting::query()->where('store_id', $store->id)->firstOrFail();
            $s->cod_advance = $value;
            $s->save();
        });
    }

    /** SSLCommerz IPN form fields with a valid verify_sign. @return array<string, string> */
    protected function ipnFields(string $tranId, string $valId, string $status = 'VALID', string $amount = '1070.00'): array
    {
        $fields = ['tran_id' => $tranId, 'val_id' => $valId, 'amount' => $amount, 'currency' => 'BDT', 'status' => $status, 'bank_tran_id' => 'BTX'.$valId];
        $fields['verify_key'] = implode(',', array_keys($fields));
        $data = array_intersect_key($fields, array_flip(explode(',', $fields['verify_key'])));
        $data['store_passwd'] = md5(self::SSL_PASSWD);
        ksort($data);
        $fields['verify_sign'] = md5(implode('&', array_map(fn ($k, $v) => "{$k}={$v}", array_keys($data), $data)));

        return $fields;
    }
}

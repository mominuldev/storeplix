<?php

declare(strict_types=1);

namespace Tests\Feature\FraudGuard;

use App\Domain\Customers\Models\Customer;
use App\Domain\FraudGuard\Models\BlockedPhone;
use App\Domain\FraudGuard\Models\FraudGuardEvent;
use App\Domain\FraudGuard\Models\OrderRiskCheck;
use App\Domain\Orders\Models\Order;
use App\Domain\Sms\SmsGateway;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Testing\TestResponse;
use Tests\Support\OnlinePaymentFixtures;
use Tests\Support\RoleFixtures;
use Tests\Support\ShipmentFixtures;

/**
 * Phase 8.8a helpers: a live Starter-trial shop (plan has `fake_order_guard`) with stock, a fake courier and fake
 * gateways; the guard turned on through the API (tests run with FRAUD_GUARD_DEFAULT_ENABLED=false); own-shop history
 * for a phone; storefront COD checkouts with a phone and an optional OTP.
 */
trait FraudGuardFixtures
{
    use OnlinePaymentFixtures, RoleFixtures, ShipmentFixtures {
        OnlinePaymentFixtures::orderRow insteadof ShipmentFixtures;
        ShipmentFixtures::liveShop insteadof OnlinePaymentFixtures;
        ShipmentFixtures::stocked insteadof OnlinePaymentFixtures;
        ShipmentFixtures::host insteadof OnlinePaymentFixtures;
        ShipmentFixtures::sf insteadof OnlinePaymentFixtures;
        ShipmentFixtures::cartWith insteadof OnlinePaymentFixtures;
        ShipmentFixtures::checkoutBody insteadof OnlinePaymentFixtures;
        ShipmentFixtures::checkout insteadof OnlinePaymentFixtures;
        ShipmentFixtures::placeOrder insteadof OnlinePaymentFixtures;
        ShipmentFixtures::manualBody insteadof OnlinePaymentFixtures;
        ShipmentFixtures::manual insteadof OnlinePaymentFixtures;
        ShipmentFixtures::shop insteadof OnlinePaymentFixtures;
        ShipmentFixtures::member insteadof OnlinePaymentFixtures;
        ShipmentFixtures::api insteadof OnlinePaymentFixtures;
        ShipmentFixtures::simpleProduct insteadof OnlinePaymentFixtures;
        ShipmentFixtures::variableProduct insteadof OnlinePaymentFixtures;
        ShipmentFixtures::createProduct insteadof OnlinePaymentFixtures;
        ShipmentFixtures::productImage insteadof OnlinePaymentFixtures;
        ShipmentFixtures::assertStoreIsolation insteadof OnlinePaymentFixtures;
    }

    protected function setUpGuard(bool $throttle = false): void
    {
        Mail::fake();
        config(['couriers.fake' => true, 'payments.fake' => true]);
        if (! $throttle) {
            $this->withoutMiddleware(ThrottleRequests::class);
        }
    }

    /**
     * A live guarded shop: stock, a connected fake courier, the guard on (and optionally a connected bKash).
     *
     * @return array{0: mixed, 1: Tenant, 2: Store, 3: array<string, string>, 4: string}
     */
    protected function guardShop(string $slug = 'shop', bool $gateway = true, array $settings = []): array
    {
        [$user, $tenant, $store, $h, $variant] = $this->courierShop(slug: $slug);
        if ($gateway) {
            $this->inTenant($tenant, fn () => $this->connectGateway($store, 'bkash'));
        }
        $this->guardSettings($h, $store, ['enabled' => true] + $settings)->assertOk();

        return [$user, $tenant, $store, $h, $variant];
    }

    protected function gUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/fraud-guard".$suffix;
    }

    /** @param array<string, mixed> $body */
    protected function guardSettings(array $h, Store $store, array $body): TestResponse
    {
        return $this->api($h, 'PATCH', $this->gUrl($store, '/settings'), $body);
    }

    /** Own-shop history for a phone: $delivered delivered + $returned returned orders (status set directly) and the customer counters. */
    protected function history(Tenant $tenant, Store $store, array $h, string $variant, string $phone, int $delivered, int $returned): void
    {
        $ids = [];
        for ($i = 0; $i < $delivered + $returned; $i++) {
            $ids[] = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false, 'contact' => ['phone' => $phone]]))->assertCreated()->json('data.id');
        }
        $this->inTenant($tenant, function () use ($ids, $delivered, $returned, $phone, $store) {
            foreach ($ids as $i => $id) {
                $status = $i < $delivered ? Order::DELIVERED : Order::RETURNED;
                Order::query()->whereKey($id)->update([
                    'status' => $status, 'placed_at' => now()->subDays(10), 'guard_hold' => null,
                    $status === Order::DELIVERED ? 'delivered_at' : 'returned_at' => now()->subDays(5 - min(4, $i)),
                ]);
            }
            Customer::query()->where('store_id', $store->id)->where('phone', self::msisdn($phone))
                ->update(['delivered_orders_count' => $delivered, 'returned_orders_count' => $returned]);
        });
    }

    protected static function msisdn(string $phone): string
    {
        return '88'.substr(preg_replace('/\D/', '', $phone) ?? '', -11);
    }

    /** Storefront COD checkout with a phone (and optional OTP / payment method). */
    protected function sfCheckout(Store $store, string $variant, string $phone, array $override = [], int $quantity = 1): TestResponse
    {
        $cart = $this->cartWith($store, $variant, $quantity);
        $total = $this->sf($store, 'GET', '/cart', [], $cart)->json('data.estimated_total_amount') + 7000;

        return $this->checkout($store, $cart, $this->checkoutBody($total, array_replace_recursive(['contact' => ['phone' => $phone]], $override)));
    }

    protected function orderOf(Tenant $tenant, string $number): Order
    {
        return $this->inTenant($tenant, fn () => Order::query()->where('number', $number)->firstOrFail());
    }

    protected function checkOf(Tenant $tenant, string $orderId): ?OrderRiskCheck
    {
        return $this->inTenant($tenant, fn () => OrderRiskCheck::query()->where('order_id', $orderId)->first());
    }

    /** @return list<string> */
    protected function guardEvents(Tenant $tenant, ?string $type = null): array
    {
        return $this->inTenant($tenant, fn () => FraudGuardEvent::query()->when($type !== null, fn ($q) => $q->where('type', $type))
            ->orderBy('created_at')->orderBy('id')->pluck('type')->all());
    }

    protected function blockedRows(Tenant $tenant): int
    {
        return $this->inTenant($tenant, fn () => BlockedPhone::query()->whereNull('unblocked_at')->count());
    }

    /** @return list<array{to: string, text: string}> */
    protected function smsSent(): array
    {
        return app(SmsGateway::class)->sent;
    }

    protected function lastCode(string $phone): ?string
    {
        return app(SmsGateway::class)->lastCodeFor(self::msisdn($phone));
    }

    protected function otp(Store $store, string $phone, array $extra = []): TestResponse
    {
        return $this->sf($store, 'POST', '/checkout/otp', ['phone' => $phone], null, $extra);
    }

    protected function oUrl(Store $store, string $orderId, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/orders/{$orderId}".$suffix;
    }
}

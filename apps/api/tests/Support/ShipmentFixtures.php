<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Couriers\CourierManager;
use App\Domain\Couriers\Drivers\FakeCourier;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Carbon\CarbonImmutable;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/**
 * 5b-3 API-C2 helpers: a live shop with a connected fake courier (COURIERS_FAKE), confirmed orders, booking calls,
 * signed fake webhooks and fake parcel moves.
 */
trait ShipmentFixtures
{
    use CommerceFixtures;

    protected const WEBHOOK_SECRET = 'test-webhook-secret-000000000000000000001';

    /** @return array{0: mixed, 1: Tenant, 2: Store, 3: array<string, string>, 4: string, 5: CourierAccount} user, tenant, store, headers, variant, account */
    protected function courierShop(string $provider = 'steadfast', string $slug = 'shop', int $price = 100000, int $stock = 20): array
    {
        config(['couriers.fake' => true]);
        [$user, $tenant, $store, $h] = $this->liveShop($slug);
        [, $variant] = $this->stocked($h, $store, $price, $stock);
        $account = $this->inTenant($tenant, fn () => $this->connectCourier($store, $provider));

        return [$user, $tenant, $store, $h, $variant, $account];
    }

    /** Call inside the tenant. */
    protected function connectCourier(Store $store, string $provider, string $secret = self::WEBHOOK_SECRET): CourierAccount
    {
        $a = CourierAccount::query()->where('store_id', $store->id)->where('provider', $provider)->first() ?? new CourierAccount;
        $credentials = match ($provider) {
            'pathao' => ['client_id' => 'client-7d1e', 'client_secret' => 'secret', 'username' => 'm@example.test', 'password' => 'pass'],
            'redx' => ['access_token' => 'token-9b2c'],
            default => ['api_key' => 'apikey-5c3d', 'secret_key' => 'secret'],
        };
        $a->forceFill([
            'store_id' => $store->id,
            'provider' => $provider,
            'mode' => 'sandbox',
            'status' => 'connected',
            'credentials' => $credentials,
            'credentials_hint' => CourierAccount::hintFor($provider, $credentials),
            'settings' => CourierAccount::DEFAULT_SETTINGS,
            'pickup_location_id' => PickupLocation::query()->where('store_id', $store->id)->value('id'),
            'connected_at' => now(),
        ]);
        $a->route_key ??= CourierAccount::newRouteKey();
        $a->setWebhookSecret($provider === 'redx' ? null : $secret);
        $a->save();

        return $a;
    }

    /** A COD order (manual, Gazipur) moved to `confirmed`; returns its id. */
    protected function confirmedOrder(array $h, Store $store, string $variant, int $quantity = 1, array $override = []): string
    {
        $id = $this->manual($h, $store, $this->manualBody($variant, $quantity, $override))->assertCreated()->json('data.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/confirm")->assertOk();

        return $id;
    }

    protected function book(array $h, Store $store, string $orderId, array $body = [], ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$orderId}/shipments",
            $body + ['provider' => 'steadfast']);
    }

    protected function fake(string $provider = 'steadfast'): FakeCourier
    {
        $fake = app(CourierManager::class)->fake($provider);
        $this->assertInstanceOf(FakeCourier::class, $fake);

        return $fake;
    }

    /** Move the fake parcel (courier side only) inside the tenant. */
    protected function courierSays(Tenant $tenant, string $shipmentId, string $status, ?int $cod = null, ?string $at = null): void
    {
        $this->inTenant($tenant, function () use ($shipmentId, $status, $cod, $at) {
            $s = Shipment::query()->findOrFail($shipmentId);
            $this->fake($s->provider)->advance($s, $status, $cod, at: $at !== null ? CarbonImmutable::parse($at) : null);
        });
    }

    /** POST a signed fake webhook for the shipment. */
    protected function webhook(CourierAccount $account, array $payload, ?string $secret = self::WEBHOOK_SECRET): TestResponse
    {
        $headers = $secret === null ? [] : FakeCourier::webhookHeaders($account->provider, $secret);

        return $this->flushHeaders()->withHeaders($headers)->postJson("/api/v1/webhooks/{$account->provider}/{$account->route_key}", $payload);
    }

    protected function shipmentRow(Tenant $tenant, string $id): Shipment
    {
        return $this->inTenant($tenant, fn () => Shipment::query()->findOrFail($id));
    }

    protected function orderRow2(Tenant $tenant, string $id): Order
    {
        return $this->inTenant($tenant, fn () => Order::query()->findOrFail($id));
    }
}

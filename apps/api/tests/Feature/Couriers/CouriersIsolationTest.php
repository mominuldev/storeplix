<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Couriers\AreaMapper;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\CourierAreaMapping;
use App\Domain\Couriers\Models\ShipmentBatch;
use App\Domain\Couriers\Models\ShipmentEvent;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\IntegrationLookup;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use LogicException;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * §13 tenancy group for the 5b-3 models: assertTenantIsolation-style model checks + assertStoreIsolation for
 * CourierAccount, CourierAreaMapping, ShipmentEvent, ShipmentBatch and the extended Shipment; the shipment_events
 * append-only guard; route keys resolve only for their provider; 5a manual shipments still work after 000800.
 */
#[Group('tenancy')]
#[Group('couriers')]
class CouriersIsolationTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    /** @return array{0: Tenant, 1: Store, 2: array<string, string>, 3: string} tenant, store, headers, order id */
    private function shopWithOrder(string $slug): array
    {
        [, $tenant, $store, $h] = $this->liveShop($slug);
        [, $variant] = $this->stocked($h, $store);
        $order = $this->manual($h, $store, $this->manualBody($variant, 1))->assertCreated()->json('data.id');

        return [$tenant, $store, $h, $order];
    }

    /** One row of every 5b-3 model in the store (call inside the tenant). @return array<class-string, string> */
    private function rows(Store $store, string $orderId): array
    {
        $a = new CourierAccount;
        $a->forceFill(['store_id' => $store->id, 'provider' => 'steadfast', 'mode' => 'sandbox', 'status' => 'connected', 'credentials' => ['api_key' => 'k', 'secret_key' => 's'], 'route_key' => CourierAccount::newRouteKey()]);
        $a->setWebhookSecret(CourierAccount::newWebhookSecret());
        $a->save();

        $s = new Shipment;
        $s->forceFill(['store_id' => $store->id, 'order_id' => $orderId, 'provider' => 'steadfast', 'status' => Shipment::BOOKED, 'courier_account_id' => $a->id,
            'consignment_id' => 'C-'.$store->id, 'booked_at' => now(), 'weight_grams' => 500, 'raw' => ['status' => 'in_review']])->save();

        $e = new ShipmentEvent;
        $e->forceFill(['store_id' => $store->id, 'shipment_id' => $s->id, 'status' => Shipment::BOOKED, 'provider_status' => 'in_review', 'source' => ShipmentEvent::SYSTEM, 'occurred_at' => now()])->save();

        $b = new ShipmentBatch;
        $b->forceFill(['store_id' => $store->id, 'provider' => 'steadfast', 'total' => 1, 'results' => [['order_id' => $orderId, 'status' => 'booked']]])->save();

        app(AreaMapper::class)->remember($a, 'dhaka', 'dhaka-dhanmondi', ['city_id' => null, 'zone_id' => null, 'area_id' => '1'], 'Dhanmondi');

        return [CourierAccount::class => $a->id, Shipment::class => $s->id, ShipmentEvent::class => $e->id, ShipmentBatch::class => $b->id, 'route_key' => $a->route_key];
    }

    public function test_every_courier_model_is_tenant_and_store_isolated(): void
    {
        [$tenantA, $storeA, , $orderA] = $this->shopWithOrder('a');
        [$tenantB, $storeB, , $orderB] = $this->shopWithOrder('b');
        $a = $this->inTenant($tenantA, fn () => $this->rows($storeA, $orderA));
        $b = $this->inTenant($tenantB, fn () => $this->rows($storeB, $orderB));

        foreach ([CourierAccount::class, Shipment::class, ShipmentEvent::class, ShipmentBatch::class, CourierAreaMapping::class] as $model) {
            $this->assertStoreIsolation($model, $tenantA, $storeA, $storeB);
            $this->inTenant($tenantA, function () use ($model, $a, $b) {
                $this->assertSame(1, $model::query()->count(), "{$model} count in A");
                if (isset($a[$model])) {
                    $this->assertNotNull($model::query()->find($a[$model]));
                    $this->assertNull($model::query()->find($b[$model]), "{$model} of B visible in A");
                }
            });
        }
        // auto-filled tenant_id
        $this->inTenant($tenantA, fn () => $this->assertSame($tenantA->id, ShipmentEvent::query()->value('tenant_id')));
        $this->inTenant($tenantA, fn () => $this->assertSame($tenantA->id, CourierAreaMapping::query()->value('tenant_id')));

        // Route keys resolve to their owner only, and only for their provider (definer function with RLS on).
        $lookup = app(IntegrationLookup::class);
        $this->assertSame(['tenant_id' => $tenantB->id, 'store_id' => $storeB->id, 'account_id' => $b[CourierAccount::class]], $lookup->routeKeyOwner('steadfast', $b['route_key']));
        $this->assertNull($lookup->routeKeyOwner('pathao', $b['route_key']));
        $this->assertNull($lookup->routeKeyOwner('bkash', $b['route_key']));
        $this->assertNull($lookup->routeKeyOwner('steadfast', CourierAccount::newRouteKey()));
    }

    public function test_shipment_events_are_append_only_and_deduplicated(): void
    {
        [$tenant, $store, , $order] = $this->shopWithOrder('a');
        $this->inTenant($tenant, function () use ($store, $order) {
            $ids = $this->rows($store, $order);
            $event = ShipmentEvent::query()->findOrFail($ids[ShipmentEvent::class]);
            $this->assertSame(['id', 'status', 'provider_status', 'description', 'location', 'source', 'occurred_at'], array_keys($event->toContract()));
            try {
                $event->description = 'changed';
                $event->save();
                $this->fail('update allowed');
            } catch (LogicException) {
            }
            try {
                $event->delete();
                $this->fail('delete allowed');
            } catch (LogicException) {
            }
            $dupe = new ShipmentEvent;
            $dupe->forceFill(['store_id' => $store->id, 'shipment_id' => $event->shipment_id, 'status' => 'booked', 'provider_status' => 'in_review', 'source' => 'poll', 'occurred_at' => $event->occurred_at]);
            $this->assertThrows(fn () => DB::transaction(fn () => $dupe->save()));
        });
    }

    public function test_manual_shipments_keep_working_and_one_active_shipment_per_order(): void
    {
        [$tenant, $store, $h, $order] = $this->shopWithOrder('a');
        $this->inTenant($tenant, function () use ($store, $order) {
            $failed = new Shipment;
            $failed->forceFill(['store_id' => $store->id, 'order_id' => $order, 'provider' => 'steadfast', 'status' => Shipment::BOOKING_FAILED])->save();
            $manual = new Shipment;
            $manual->forceFill(['store_id' => $store->id, 'order_id' => $order, 'status' => Shipment::SHIPPED, 'carrier_name' => 'Sundarban', 'cod_amount' => 1000])->save();
            $this->assertSame('manual', $manual->fresh()->provider);
            $this->assertSame(0, $manual->fresh()->attempts);
            $this->assertFalse($manual->fresh()->cod_overridden);
            $this->assertFalse($manual->isCourier());
            $second = new Shipment;
            $second->forceFill(['store_id' => $store->id, 'order_id' => $order, 'provider' => 'pathao', 'status' => Shipment::BOOKING]);
            $this->assertThrows(fn () => DB::transaction(fn () => $second->save()));
            $this->assertArrayNotHasKey('raw', $manual->toArray());
            $this->assertSame(Order::class, get_class($manual->order));
        });
    }
}

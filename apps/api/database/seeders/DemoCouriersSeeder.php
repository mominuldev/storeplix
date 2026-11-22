<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Domain\Couriers\BookingService;
use App\Domain\Couriers\Drivers\BookingResult;
use App\Domain\Couriers\Drivers\FakeCourier;
use App\Domain\Couriers\Drivers\NormalisedStatus;
use App\Domain\Couriers\Drivers\StatusUpdate;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\ShipmentSync;
use App\Domain\Geo\AddressValidator;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Orders\OrderPlacementService;
use App\Domain\Orders\OrderService;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Carbon\CarbonImmutable;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Phase 5b-3 demo data (idempotent): a connected Steadfast account (sandbox, fake-driver shaped credentials, webhook
 * secret `demo-steadfast-webhook-secret-0000000001`) and 2 shipments: one `booked` (order ready_to_ship) and one
 * `in_transit` (order shipped, stock left on_hand). Rows are written through BookingService::markBooked and
 * ShipmentSync::apply with fake consignments — no courier is ever called.
 */
class DemoCouriersSeeder extends Seeder
{
    public const TAG = 'demo-courier';

    public const WEBHOOK_SECRET = 'demo-steadfast-webhook-secret-0000000001';

    public function run(TenantContext $context, OrderPlacementService $placement, AddressValidator $addresses): void
    {
        $store = Store::withoutTenancy()->where('slug', 'demo')->first();
        if ($store === null) {
            return;
        }
        $ownerId = TenantUser::query()->where('tenant_id', $store->tenant_id)->where('role', TenantUser::ROLE_OWNER)->value('user_id');
        $user = $ownerId ? User::query()->find($ownerId) : null;

        $context->run($store->tenant_id, function () use ($store, $user, $placement, $addresses) {
            $account = CourierAccount::query()->where('store_id', $store->id)->where('provider', CourierAccount::STEADFAST)->first();
            if ($account === null) {
                $account = new CourierAccount;
                $credentials = ['api_key' => 'demo-steadfast-key-0001', 'secret_key' => 'demo-steadfast-secret'];
                $account->forceFill([
                    'store_id' => $store->id,
                    'provider' => CourierAccount::STEADFAST,
                    'mode' => CourierAccount::SANDBOX,
                    'status' => CourierAccount::CONNECTED,
                    'credentials' => $credentials,
                    'credentials_hint' => CourierAccount::hintFor(CourierAccount::STEADFAST, $credentials),
                    'route_key' => CourierAccount::newRouteKey(),
                    'settings' => CourierAccount::DEFAULT_SETTINGS,
                    'pickup_location_id' => PickupLocation::query()->where('store_id', $store->id)->orderByDesc('is_default')->value('id'),
                    'is_default' => true,
                    'last_checked_at' => now(),
                    'connected_by' => $user?->getKey(),
                    'connected_at' => now(),
                ]);
                $account->setWebhookSecret(self::WEBHOOK_SECRET);
                $account->save();
            }
            if (Order::query()->where('store_id', $store->id)->whereJsonContains('tags', self::TAG)->exists()) {
                return;
            }
            $variant = DB::table('product_variants')->join('products', 'products.id', '=', 'product_variants.product_id')
                ->where('product_variants.store_id', $store->id)->where('products.status', 'active')->where('product_variants.is_enabled', true)
                ->whereNull('products.deleted_at')->whereNull('product_variants.deleted_at')->orderBy('products.created_at')->value('product_variants.id');
            if ($variant === null) {
                return;
            }
            $booking = app(BookingService::class);
            $sync = app(ShipmentSync::class);
            $orders = app(OrderService::class);
            OrderNotifier::muted(function () use ($store, $user, $placement, $addresses, $account, $variant, $booking, $sync, $orders) {
                foreach ([['Mehedi Hasan', '8801711400001', 'booked'], ['Farzana Akter', '8801711400002', 'in_transit']] as [$name, $phone, $status]) {
                    $order = $placement->manual($store, [
                        'items' => [['variant_id' => $variant, 'quantity' => 1]],
                        'channel' => 'facebook',
                        'contact' => ['name' => $name, 'phone' => $phone, 'email' => null],
                        'address' => $addresses->snapshot(['district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'House 14, Road 3, Section 10']),
                        'payment_method' => 'cod',
                        'notify' => false,
                        'user' => $user,
                    ]);
                    Order::query()->whereKey($order->id)->update(['tags' => json_encode([self::TAG])]);
                    $order = $orders->confirm($order->refresh(), $user, false);
                    $shipment = DB::transaction(function () use ($order, $account, $booking, $user) {
                        $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
                        $s = $booking->newShipment($o, $account, [], $user, null, null);
                        $booking->save($s);

                        return $s;
                    });
                    $consignment = FakeCourier::consignmentFor(CourierAccount::STEADFAST, $shipment->id);
                    $shipment = $booking->markBooked($shipment, new BookingResult($consignment, $consignment, null, FakeCourier::DELIVERY_FEE, null, 'in_review', ['_demo' => true]));
                    if ($status === 'in_transit') {
                        $sync->apply($shipment, new StatusUpdate('in_transit', 'pending', CarbonImmutable::now()->startOfSecond(), 'Picked up from the merchant', 'Dhaka hub',
                            null, NormalisedStatus::of('in_transit')->problem), 'system');
                    }
                }
            });
        });
    }
}

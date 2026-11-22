<?php

namespace Database\Seeders;

use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\CouponService;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Geo\AddressValidator;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Orders\OrderPlacementService;
use App\Domain\Orders\OrderService;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Shipping\ShippingService;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Seeder;

/**
 * Phase 5a demo commerce for store "demo" (idempotent): default delivery zones, one pickup address, coupons WELCOME10
 * and FREEDELIVERY, and 6 manual orders across statuses (tagged `demo-seed`; other orders on the store are left alone).
 * Orders go through the real placement / state-machine services, with notifications muted.
 */
class DemoCommerceSeeder extends Seeder
{
    public const TAG = 'demo-seed';

    /** [product slug, quantity, channel, name, phone, district, thana, coupon, final status] */
    private const ORDERS = [
        ['plush-elephant', 1, 'facebook', 'Farhana Rahman', '01556120987', 'narayanganj', 'narayanganj-narayanganj-sadar', null, 'pending'],
        ['bamboo-meal-set', 2, 'instagram', 'Rakib Hasan', '01712345678', 'dhaka', 'dhaka-mirpur', null, 'confirmed'],
        ['cotton-summer-set', 1, 'whatsapp', 'Nusrat Jahan', '01811223344', 'chattogram', 'chattogram-panchlaish', 'WELCOME10', 'ready_to_ship'],
        ['knit-cardigan', 1, 'phone', 'Tanvir Ahmed', '01911556677', 'sylhet', 'sylhet-sylhet-sadar', null, 'shipped'],
        ['plush-elephant', 2, 'facebook', 'Sadia Islam', '01611998877', 'dhaka', 'dhaka-dhanmondi', 'FREEDELIVERY', 'delivered'],
        ['bamboo-meal-set', 1, 'walk_in', 'Farhana Rahman', '01556120987', 'narayanganj', 'narayanganj-narayanganj-sadar', null, 'cancelled'],
    ];

    public function run(TenantContext $context, ShippingService $shipping, CouponService $coupons, OrderPlacementService $placement, OrderService $orders, AddressValidator $addresses): void
    {
        $store = Store::withoutTenancy()->where('slug', 'demo')->first();
        if ($store === null) {
            return;
        }
        $ownerId = TenantUser::query()->where('tenant_id', $store->tenant_id)->where('role', TenantUser::ROLE_OWNER)->value('user_id');
        $user = $ownerId ? User::query()->find($ownerId) : null;

        $context->run($store->tenant_id, function () use ($store, $user, $shipping, $coupons, $placement, $orders, $addresses) {
            $shipping->provisionDefaults($store);
            if (! PickupLocation::query()->where('store_id', $store->id)->exists()) {
                $shipping->createPickup($store, ['name' => 'Demo warehouse', 'contact_name' => 'Demo Merchant', 'contact_phone' => '01700000000',
                    'district_code' => 'dhaka', 'thana_code' => 'dhaka-mirpur', 'address_line' => 'House 1, Road 1, Section 10']);
            }
            foreach ([
                ['code' => 'WELCOME10', 'type' => 'percentage', 'percent_bps' => 1000, 'max_discount_amount' => 20000, 'status' => 'active'],
                ['code' => 'FREEDELIVERY', 'type' => 'free_shipping', 'min_subtotal_amount' => 150000, 'status' => 'active', 'usage_per_customer' => null],
            ] as $coupon) {
                if (! Coupon::query()->where('store_id', $store->id)->where('code', $coupon['code'])->exists()) {
                    $coupons->create($store, $coupon + ['starts_at' => now()->subDay()], $user);
                }
            }

            if (Order::query()->where('store_id', $store->id)->whereJsonContains('tags', self::TAG)->exists()) {
                return;
            }
            OrderNotifier::muted(function () use ($store, $user, $placement, $orders, $addresses) {
                foreach (self::ORDERS as [$slug, $quantity, $channel, $name, $phone, $district, $thana, $code, $final]) {
                    $variant = Product::query()->where('store_id', $store->id)->where('slug', $slug)->first()?->variants()->where('is_enabled', true)->first();
                    if ($variant === null) {
                        continue;
                    }
                    $order = $placement->manual($store, [
                        'items' => [['variant_id' => $variant->id, 'quantity' => $quantity]],
                        'channel' => $channel,
                        'contact' => ['name' => $name, 'phone' => '88'.$phone, 'email' => null],
                        'address' => $addresses->snapshot(['district_code' => $district, 'thana_code' => $thana, 'address_line' => 'House 7, Road 3']),
                        'payment_method' => 'cod',
                        'coupon_code' => $code,
                        'notify' => false,
                        'user' => $user,
                    ]);
                    Order::query()->whereKey($order->id)->update(['tags' => json_encode([self::TAG])]);
                    $path = match ($final) {
                        'confirmed' => ['confirm'],
                        'ready_to_ship' => ['confirm', 'ready'],
                        'shipped' => ['confirm', 'ready', 'ship'],
                        'delivered' => ['confirm', 'ship', 'deliver'],
                        'cancelled' => ['cancel'],
                        default => [],
                    };
                    foreach ($path as $step) {
                        match ($step) {
                            'confirm' => $orders->confirm($order, $user, false),
                            'ready' => $orders->ready($order, $user),
                            'ship' => $orders->ship($order, ['carrier_name' => 'Steadfast', 'tracking_code' => 'SF'.$order->sequence], $user, false),
                            'deliver' => $orders->deliver($order, $user),
                            'cancel' => $orders->cancel($order, 'customer_request', null, false, $user, TenantUser::ROLE_OWNER),
                        };
                    }
                }
            });
        });
    }
}

<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Domain\Geo\AddressValidator;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Orders\OrderPlacementService;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\PaymentLinkService;
use App\Domain\Payments\PaymentService;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Phase 5b-2 demo data (idempotent): a fake-driver bKash account (sandbox, connected, enabled) and 2 online orders
 * verified through PaymentService: one paid in full with bKash (confirmed), one COD order whose delivery charge was
 * paid with a payment link (confirmed, partially paid). Uses the fake gateway's shape only; no provider is called.
 */
class DemoPaymentsSeeder extends Seeder
{
    public const TAG = 'demo-online';

    public function run(TenantContext $context, OrderPlacementService $placement, AddressValidator $addresses): void
    {
        $store = Store::withoutTenancy()->where('slug', 'demo')->first();
        if ($store === null) {
            return;
        }
        $ownerId = TenantUser::query()->where('tenant_id', $store->tenant_id)->where('role', TenantUser::ROLE_OWNER)->value('user_id');
        $user = $ownerId ? User::query()->find($ownerId) : null;

        $context->run($store->tenant_id, function () use ($store, $user, $placement, $addresses) {
            $account = PaymentGatewayAccount::query()->where('store_id', $store->id)->where('provider', PaymentGatewayAccount::BKASH)->first();
            if ($account === null) {
                $account = new PaymentGatewayAccount;
                $account->store_id = $store->id;
                $account->provider = PaymentGatewayAccount::BKASH;
                $account->mode = PaymentGatewayAccount::SANDBOX;
                $account->status = PaymentGatewayAccount::CONNECTED;
                $account->credentials = ['app_key' => 'demo-app-key-0001', 'app_secret' => 'demo-secret', 'username' => 'demo', 'password' => 'demo'];
                $account->credentials_hint = '••••0001';
                $account->enabled = true;
                $account->is_default = true;
                $account->route_key = PaymentGatewayAccount::newRouteKey();
                $account->verified_at = now();
                $account->last_checked_at = now();
                $account->connected_by = $user?->getKey();
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
            $payments = app(PaymentService::class);
            OrderNotifier::muted(function () use ($store, $user, $placement, $addresses, $account, $variant, $payments) {
                $place = fn (string $name, string $phone) => $placement->manual($store, [
                    'items' => [['variant_id' => $variant, 'quantity' => 1]],
                    'channel' => 'website',
                    'contact' => ['name' => $name, 'phone' => $phone, 'email' => null],
                    'address' => $addresses->snapshot(['district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'House 9, Road 5']),
                    'payment_method' => 'cod',
                    'notify' => false,
                    'user' => $user,
                ]);

                // 1. Paid in full with bKash at checkout → confirmed.
                $order = $place('Sadia Islam', '8801711300001');
                $charge = DB::transaction(function () use ($order, $account, $payments) {
                    Payment::query()->where('order_id', $order->id)->where('provider', 'cod')->delete();
                    Order::query()->whereKey($order->id)->update([
                        'status' => Order::PENDING_PAYMENT, 'payment_method' => 'bkash', 'created_via' => 'storefront',
                        'payment_expires_at' => now()->addMinutes(30), 'tags' => json_encode([self::TAG]),
                    ]);

                    return $payments->newCharge($order->refresh(), $account, Payment::PURPOSE_ORDER, $order->total_amount, now()->addMinutes(30));
                });
                $payments->apply($charge, new Verification(Verification::SUCCEEDED, $charge->amount, 'BDT', $charge->id, 'DEMO'.strtoupper(substr($charge->id, -10)), null, ['demo' => true]), 'seed');

                // 2. COD order; the delivery charge paid with a bKash payment link → confirmed, partially paid.
                $order = $place('Tanvir Hasan', '8801711300002');
                Order::query()->whereKey($order->id)->update(['tags' => json_encode([self::TAG])]);
                $link = app(PaymentLinkService::class)->create($order, [
                    'amount_kind' => $order->shipping_amount > 0 ? 'delivery_charge' : 'percent', 'percent_bps' => 2500,
                    'provider' => 'bkash', 'expires_in_minutes' => 1440, 'cancel_if_unpaid' => false, 'send_sms' => false,
                ], $user);
                $charge = DB::transaction(fn () => $payments->newCharge($order->refresh(), $account, Payment::PURPOSE_LINK, $link->amount, $link->expires_at, $link));
                $payments->apply($charge, new Verification(Verification::SUCCEEDED, $charge->amount, 'BDT', $charge->id, 'DEMO'.strtoupper(substr($charge->id, -10)), null, ['demo' => true]), 'seed');
            });
        });
    }
}

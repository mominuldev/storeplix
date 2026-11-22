<?php

namespace Tests\Feature\Commerce;

use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Bus;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** §3.8 go-live (P5-25) and §3.9 dashboard orders block. */
class GoLiveDashboardTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    public function test_checklist_blocks_publish_until_hard_items_are_done(): void
    {
        [$owner, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'newshop', status: Store::STATUS_DRAFT);
        $h = $this->tenantHeaders($owner, $tenant);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);

        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/launch-checklist")->assertOk()
            ->assertJsonPath('data.status', 'draft')->assertJsonPath('data.can_publish', false)->assertJsonPath('data.published_at', null)
            ->assertJsonPath('data.shop_url', 'https://newshop.storeplix.test')
            ->assertJsonPath('data.items.0', ['key' => 'products', 'required' => true, 'done' => false, 'href' => '/products/new'])
            ->assertJsonPath('data.items.4.required', false);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/publish")->assertStatus(409)->assertJsonPath('error.code', 'launch_blocked')
            ->assertJsonPath('error.details', [
                'products' => ['Add at least one active product.'],
                'shipping' => ['Set your delivery charges.'],
                'contact_phone' => ['Add a phone number customers can call.'],
            ]);
        $this->api($staff, 'POST', "/api/v1/stores/{$store->id}/publish")->assertForbidden();
        $this->api($staff, 'GET', "/api/v1/stores/{$store->id}/launch-checklist")->assertOk();

        $this->stocked($h, $store);
        $this->artisan('shipping:provision-defaults')->assertSuccessful();
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/settings", ['contact' => ['phone' => '01712345678'], 'checkout' => ['cod_enabled' => false]])->assertOk();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/publish")->assertStatus(409)->assertJsonPath('error.details', ['payments' => ['Turn on at least one way to pay.']]);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/settings", ['checkout' => ['cod_enabled' => true]])->assertOk();

        Bus::fake([RevalidateStorefront::class]);
        Carbon::setTestNow('2026-11-22 08:00:00');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/publish")->assertOk()->assertJsonPath('data.status', 'active')->assertJsonPath('data.id', $store->id);
        Bus::assertDispatched(RevalidateStorefront::class);
        $this->assertTrue($this->platformTable('audit_logs')->where('action', 'store.published')->exists());
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/launch-checklist")->assertJsonPath('data.status', 'active')
            ->assertJsonPath('data.published_at', '2026-11-22T08:00:00Z')->assertJsonPath('data.can_publish', true);
        Carbon::setTestNow('2026-11-23 08:00:00');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/publish")->assertOk(); // idempotent no-op
        $this->assertSame('2026-11-22 08:00:00', $this->tenancy()->run($tenant, fn () => Store::query()->firstOrFail()->published_at->format('Y-m-d H:i:s')));
    }

    public function test_settings_commerce_fields_and_prefix_validation(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $url = "/api/v1/stores/{$store->id}/settings";
        $this->api($h, 'PATCH', $url, ['order_prefix' => 'gs'])->assertOk()->assertJsonPath('data.commerce.order_prefix', 'GS')
            ->assertJsonPath('data.commerce.next_order_number', 'GS-1001');
        $this->api($h, 'PATCH', $url, ['order_prefix' => 'G1'])->assertStatus(422)->assertJsonPath('error.details.order_prefix.0', 'Use 1–6 letters (A–Z).');
        $this->api($h, 'PATCH', $url, ['notifications' => ['customer_sms' => ['order_shipped' => 'yes']]])->assertStatus(422);
        $this->api($staff, 'PATCH', $url, ['order_prefix' => 'XX'])->assertForbidden();
        $this->tenancy()->run($tenant, fn () => $this->assertSame('GS', StoreSetting::query()->value('order_prefix')));
    }

    public function test_dashboard_orders_block_in_store_timezone(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, $tenant, $store, $h] = $this->liveShop();
        $url = "/api/v1/stores/{$store->id}/dashboard";
        $this->api($h, 'GET', $url)->assertOk()->assertJsonPath('data.orders', null);

        [$p, $variant] = $this->stocked($h, $store, 1000, 100, ['track_inventory' => false]);
        $make = fn (int $qty = 1) => $this->manual($h, $store, $this->manualBody($variant, $qty, ['notify_customer' => false]))->assertCreated()->json('data.id');
        $d1 = $make(3);
        $d2 = $make(1);
        $r1 = $make(1);
        $c1 = $make(1);
        $make(1); // pending
        $conf = $make(1);
        foreach ([$d1, $d2, $r1, $conf] as $id) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/confirm")->assertOk();
        }
        foreach ([$d1, $d2, $r1] as $id) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/ship")->assertOk();
        }
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$d1}/deliver")->assertOk();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$d2}/deliver")->assertOk();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$r1}/return", ['restock' => []])->assertOk();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$c1}/cancel", ['reason' => 'other'])->assertOk();
        // an order placed last month (store time) is not "this month"
        $this->tenancy()->run($tenant, fn () => Order::query()->whereKey($conf)->update(['placed_at' => now('Asia/Dhaka')->startOfMonth()->subMinute()->utc()]));

        $this->api($h, 'GET', $url)->assertOk()
            ->assertJsonPath('data.orders.this_month', [
                'count' => 5, 'sales_amount' => (3000 + 13000) + (1000 + 13000), 'delivered_count' => 2, 'returned_count' => 1,
                'cancelled_count' => 1, 'delivery_success_rate' => 0.6667,
            ])
            ->assertJsonPath('data.orders.waiting', ['pending' => 1, 'confirmed' => 1, 'ready_to_ship' => 0, 'pending_payment' => 0, 'to_book' => 1])
            ->assertJsonPath('data.orders.shipments', ['problems' => 0])
            ->assertJsonPath('data.orders.best_sellers.0.product_id', $p['id'])
            ->assertJsonPath('data.orders.best_sellers.0.units', 7)
            ->assertJsonPath('data.orders.plan.used', 5);
    }
}

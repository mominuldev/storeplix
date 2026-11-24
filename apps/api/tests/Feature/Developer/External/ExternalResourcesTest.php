<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\External;

use App\Domain\Catalog\Models\Product;
use App\Domain\Customers\Models\Customer;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Developer\ApiKeys\ApiKeyFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-8-4 §3 external routes: happy paths with merchant shapes, scope denials, cross-tenant/store 404 (S102), actors. */
#[Group('developer-api')]
class ExternalResourcesTest extends TestCase
{
    use ApiKeyFixtures, RefreshDatabase, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    public function test_orders_list_detail_and_updated_since_match_the_merchant_shapes(): void
    {
        [, , $store, $h] = $this->devShop();
        [$orderId] = $this->pendingOrder($h, $store);
        [, $plain] = $this->createKey($h, ['orders:read']);
        $base = "/stores/{$store->id}";

        $merchant = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders")->assertOk()->json();
        $external = $this->ext($plain, 'GET', "{$base}/orders")->assertOk()->json();
        $this->assertSame($merchant, $external);
        $this->ext($plain, 'GET', "{$base}/orders?filter[status]=pending")->assertOk()->assertJsonCount(1, 'data');
        $this->ext($plain, 'GET', "{$base}/orders?filter[status]=delivered")->assertOk()->assertJsonCount(0, 'data');
        $this->ext($plain, 'GET', "{$base}/orders?per_page=101")->assertStatus(422);

        $since = $this->ext($plain, 'GET', "{$base}/orders?filter[updated_since]=".urlencode(now()->subHour()->toIso8601String()))->assertOk();
        $this->assertSame([$orderId], array_column($since->json('data'), 'id'));
        $this->assertSame($merchant['meta']['counts'], $since->json('meta.counts'));
        $this->assertSame(1, $since->json('meta.total'));
        $this->ext($plain, 'GET', "{$base}/orders?filter[updated_since]=".urlencode(now()->addHour()->toIso8601String()))->assertOk()->assertJsonCount(0, 'data');
        $this->ext($plain, 'GET', "{$base}/orders?filter[updated_since]=yesterday-ish")->assertStatus(422);

        $detail = $this->ext($plain, 'GET', "{$base}/orders/{$orderId}")->assertOk()->json('data');
        $this->assertSame($orderId, $detail['id']);
        $this->assertArrayHasKey('events', $detail);
        // no costs without include_costs
        $this->assertNull($detail['items'][0]['unit_cost_amount'] ?? null);
    }

    public function test_status_change_records_the_key_as_actor_and_needs_an_idempotency_key(): void
    {
        [, , $store, $h] = $this->devShop();
        [$orderId] = $this->pendingOrder($h, $store);
        [$keyId, $plain] = $this->createKey($h, ['orders:write'], 'Warehouse');
        $url = "/stores/{$store->id}/orders/{$orderId}/status";

        $this->ext($plain, 'POST', $url, ['status' => 'confirmed'])->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');
        $this->extWrite($plain, 'POST', $url, ['status' => 'refunded'])->assertStatus(422);

        $res = $this->extWrite($plain, 'POST', $url, ['status' => 'confirmed'])->assertOk();
        $this->assertSame('confirmed', $res->json('data.status'));
        $event = collect($res->json('data.events'))->firstWhere('type', 'status_changed');
        $this->assertSame(['user' => null, 'type' => 'api_key', 'id' => $keyId, 'name' => 'API: Warehouse'], $event['actor']);
        $row = $this->platformQuery(OrderEvent::class)->where('order_id', $orderId)->where('type', 'status_changed')->sole();
        $this->assertSame('api_key', $row->actor_type);
        $this->assertNull($row->actor_user_id);
        $this->assertSame($keyId, $row->actor_api_key_id);

        $this->extWrite($plain, 'POST', $url, ['status' => 'delivered'])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->extWrite($plain, 'POST', $url, ['status' => 'shipped', 'carrier_name' => 'Own rider'])->assertOk()->assertJsonPath('data.status', 'shipped');
        $this->extWrite($plain, 'POST', $url, ['status' => 'delivered'])->assertOk()->assertJsonPath('data.status', 'delivered');
        // a stock movement written by the ship transition carries the key
        $this->assertSame(1, $this->platformQuery(InventoryMovement::class)->where('reference_id', $orderId)->where('actor_api_key_id', $keyId)->count());
    }

    public function test_cancelling_a_paid_order_is_refused_with_409(): void
    {
        [, $tenant, $store, $h] = $this->devShop();
        [$orderId] = $this->pendingOrder($h, $store);
        [, $plain] = $this->createKey($h, ['orders:write']);
        $this->inTenant($tenant, fn () => Order::query()->whereKey($orderId)->update(['paid_amount' => 1000]));

        $this->extWrite($plain, 'POST', "/stores/{$store->id}/orders/{$orderId}/status", ['status' => 'cancelled'])
            ->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->assertSame('pending', $this->platformQuery(Order::class)->findOrFail($orderId)->status);
    }

    public function test_unpaid_cancel_and_audit_actor(): void
    {
        [, , $store, $h] = $this->devShop();
        [$orderId] = $this->pendingOrder($h, $store);
        [$keyId, $plain] = $this->createKey($h, ['orders:write', 'products:write']);

        $this->extWrite($plain, 'POST', "/stores/{$store->id}/orders/{$orderId}/status", ['status' => 'cancelled', 'reason' => 'duplicate'])
            ->assertOk()->assertJsonPath('data.status', 'cancelled')->assertJsonPath('data.cancel_reason', 'duplicate');

        $this->ext($plain, 'POST', "/stores/{$store->id}/products", $this->simpleProduct('API product'))->assertCreated();
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'product.created')->latest('id')->firstOrFail();
        $this->assertSame('api_key', $audit->actor_type);
        $this->assertSame($keyId, $audit->actor_id);
        $logs = $this->api($h, 'GET', '/api/v1/audit-logs?filter[actor_type]=api_key')->assertOk()->json('data');
        $this->assertSame(['type' => 'api_key', 'id' => $keyId, 'name' => 'API: Zapier'], $logs[0]['actor']);
    }

    public function test_products_and_categories(): void
    {
        [, , $store, $h] = $this->devShop();
        [$product] = $this->stocked($h, $store, 100000, 5, ['sku' => 'PJ-1', 'cost_amount' => 60000]);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Panjabi'])->assertCreated();
        [, $read] = $this->createKey($h, ['products:read'], 'Reader');
        [, $costs] = $this->createKey($h, ['products:write'], 'Costs', true);
        $base = "/stores/{$store->id}";

        $this->assertSame(
            $this->api($h, 'GET', "/api/v1/stores/{$store->id}/products")->json('data.0.id'),
            $this->ext($read, 'GET', "{$base}/products")->assertOk()->json('data.0.id'),
        );
        $this->ext($read, 'GET', "{$base}/products")->assertJsonStructure(['meta' => ['counts', 'summary', 'plan', 'total']]);
        $this->ext($read, 'GET', "{$base}/products?q=Item")->assertOk()->assertJsonCount(1, 'data');
        $since = $this->ext($read, 'GET', "{$base}/products?filter[updated_since]=".urlencode(now()->subMinute()->toIso8601String()))->assertOk();
        $this->assertSame([$product['id']], array_column($since->json('data'), 'id'));
        $this->assertArrayHasKey('summary', $since->json('meta'));

        $plain = $this->ext($read, 'GET', "{$base}/products/{$product['id']}")->assertOk()->json('data');
        $this->assertNull($plain['variants'][0]['cost_amount']);
        $this->assertSame(60000, $this->ext($costs, 'GET', "{$base}/products/{$product['id']}")->assertOk()->json('data.variants.0.cost_amount'));

        $this->ext($read, 'GET', "{$base}/categories")->assertOk()->assertJsonPath('data.0.name', 'Panjabi');
        $this->ext($read, 'POST', "{$base}/products", $this->simpleProduct())->assertForbidden()->assertJsonPath('error.code', 'api_key_scope_missing');

        $created = $this->ext($costs, 'POST', "{$base}/products", $this->simpleProduct('From API'))->assertCreated()->json('data');
        $this->ext($costs, 'PATCH', "{$base}/products/{$created['id']}", ['revision' => $created['revision'], 'name' => 'Renamed'])
            ->assertOk()->assertJsonPath('data.name', 'Renamed');
        $this->ext($costs, 'POST', "{$base}/products", ['name' => ''])->assertStatus(422);
        $this->ext($costs, 'DELETE', "{$base}/products/{$created['id']}")->assertStatus(405);
    }

    public function test_inventory_list_filters_and_adjustment_ledger(): void
    {
        [, $tenant, $store, $h] = $this->devShop();
        [, $variant] = $this->stocked($h, $store, 100000, 5, ['sku' => 'INV-1']);
        $this->stocked($h, $store, 100000, 5, ['sku' => 'INV-2']);
        [$keyId, $plain] = $this->createKey($h, ['inventory:write'], 'Stock sync');
        $base = "/stores/{$store->id}";

        $all = $this->ext($plain, 'GET', "{$base}/inventory")->assertOk();
        $this->assertSame($this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory")->json('data'), $all->json('data'));
        $this->assertNull($all->json('meta.summary.stock_value_cost_amount')); // no include_costs
        $one = $this->ext($plain, 'GET', "{$base}/inventory?filter[sku]=INV-1")->assertOk();
        $this->assertSame([$variant], array_column($one->json('data'), 'variant_id'));
        $this->assertSame(1, $one->json('meta.total'));
        $this->assertArrayHasKey('summary', $one->json('meta'));

        $body = ['reason' => 'received', 'items' => [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 3]]];
        $this->ext($plain, 'POST', "{$base}/inventory/adjustments", $body)->assertStatus(400);
        $res = $this->extWrite($plain, 'POST', "{$base}/inventory/adjustments", $body)->assertOk();
        $this->assertSame(8, $res->json('data.items.0.on_hand'));
        $this->assertSame(['type' => 'api_key', 'id' => $keyId, 'name' => 'API: Stock sync'], $res->json('data.movements.0.actor'));
        $movement = $this->platformQuery(InventoryMovement::class)->where('variant_id', $variant)->where('reason', 'received')->sole();
        $this->assertSame($keyId, $movement->actor_api_key_id);
        $this->assertNull($movement->actor_user_id);

        Carbon::setTestNow(now()->addMinutes(10));
        $this->ext($plain, 'GET', "{$base}/inventory?filter[updated_since]=".urlencode(now()->subMinutes(5)->toIso8601String()))->assertOk()->assertJsonCount(0, 'data');
        Carbon::setTestNow();
        $this->extWrite($plain, 'POST', "{$base}/inventory/adjustments", ['reason' => 'received', 'items' => [['variant_id' => $variant, 'mode' => 'set', 'quantity' => -1]]])
            ->assertStatus(422);
        $this->assertSame(1, $this->inTenant($tenant, fn () => InventoryMovement::query()->where('reason', 'received')->count()));
    }

    public function test_customers(): void
    {
        [, $tenant, $store, $h] = $this->devShop();
        $this->pendingOrder($h, $store);
        $customer = $this->inTenant($tenant, fn () => Customer::query()->firstOrFail());
        [, $plain] = $this->createKey($h, ['customers:read']);
        $base = "/stores/{$store->id}";

        $this->assertSame($this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers")->json(), $this->ext($plain, 'GET', "{$base}/customers")->assertOk()->json());
        $this->ext($plain, 'GET', "{$base}/customers?q=01811223344")->assertOk()->assertJsonCount(1, 'data');
        $this->ext($plain, 'GET', "{$base}/customers?q=01999999999")->assertOk()->assertJsonCount(0, 'data');
        $this->ext($plain, 'GET', "{$base}/customers?filter[updated_since]=".urlencode(now()->subMinute()->toIso8601String()))
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonStructure(['meta' => ['counts' => ['all', 'new_this_month'], 'total']]);
        $this->ext($plain, 'GET', "{$base}/customers/{$customer->id}")->assertOk()->assertJsonPath('data.id', $customer->id);
    }

    /** @return array<string, array{0: string, 1: string, 2: string}> route → [method, path, required scope] */
    public static function scopedRoutes(): array
    {
        return [
            'orders.index' => ['GET', '/orders', 'orders:read'],
            'orders.show' => ['GET', '/orders/{order}', 'orders:read'],
            'orders.status' => ['POST', '/orders/{order}/status', 'orders:write'],
            'products.index' => ['GET', '/products', 'products:read'],
            'products.show' => ['GET', '/products/{product}', 'products:read'],
            'products.store' => ['POST', '/products', 'products:write'],
            'products.update' => ['PATCH', '/products/{product}', 'products:write'],
            'categories.index' => ['GET', '/categories', 'products:read'],
            'inventory.index' => ['GET', '/inventory', 'inventory:read'],
            'inventory.adjust' => ['POST', '/inventory/adjustments', 'inventory:write'],
            'customers.index' => ['GET', '/customers', 'customers:read'],
            'customers.show' => ['GET', '/customers/{customer}', 'customers:read'],
        ];
    }

    /** S103: a key without the route's scope → 403 (before any write); S102: another tenant's store / ids → 404. */
    #[DataProvider('scopedRoutes')]
    public function test_scope_denial_and_cross_tenant_404(string $method, string $path, string $scope): void
    {
        [, , $storeA, $ha] = $this->devShop('alpha');
        [, $tenantB, $storeB, $hb] = $this->devShop('beta');
        [$orderA] = $this->pendingOrder($ha, $storeA);
        [$orderB] = $this->pendingOrder($hb, $storeB);
        $productA = $this->platformQuery(Product::class)->where('store_id', $storeA->id)->value('id');
        $productB = $this->platformQuery(Product::class)->where('store_id', $storeB->id)->value('id');
        $customerA = $this->platformQuery(Customer::class)->where('store_id', $storeA->id)->value('id');
        $customerB = $this->platformQuery(Customer::class)->where('store_id', $storeB->id)->value('id');

        $all = ['orders:write', 'products:write', 'inventory:write', 'customers:read'];
        $without = array_values(array_filter(['orders:read', 'orders:write', 'products:read', 'products:write', 'inventory:read', 'inventory:write', 'customers:read'],
            fn ($s) => $s !== $scope && ! (str_ends_with($scope, ':read') && str_starts_with($s, explode(':', $scope)[0]))));
        [, $narrow] = $this->createKey($ha, $without === [] ? ['customers:read'] : $without, 'Narrow');
        [, $full] = $this->createKey($ha, $all, 'Full');

        $fill = fn (string $p, string $o, string $pr, string $c) => strtr($p, ['{order}' => $o, '{product}' => $pr, '{customer}' => $c]);
        $headers = ['Idempotency-Key' => 'idem-'.md5($path.$method)];

        $this->ext($narrow, $method, "/stores/{$storeA->id}".$fill($path, $orderA, $productA, $customerA), [], $headers)
            ->assertForbidden()->assertJsonPath('error.code', 'api_key_scope_missing')->assertJsonPath('error.details.required_scope', [$scope]);

        // store of tenant B with tenant A's key
        $this->ext($full, $method, "/stores/{$storeB->id}".$fill($path, $orderB, $productB, $customerB), [], $headers + ['X-Tenant-Id' => $tenantB->id])
            ->assertNotFound()->assertJsonPath('error.code', 'not_found');
        // own store, B's ids
        if (str_contains($path, '{')) {
            $this->ext($full, $method, "/stores/{$storeA->id}".$fill($path, $orderB, $productB, $customerB), [], $headers)
                ->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
        $this->assertSame('pending', $this->platformQuery(Order::class)->findOrFail($orderB)->status);
    }

    public function test_tenant_and_store_isolation_of_api_keys(): void
    {
        [, $tenantA, $storeA, $ha] = $this->devShop('alpha');
        [, , $storeB, $hb] = $this->devShop('beta');
        $this->createKey($ha, ['orders:read']);
        $this->createKey($hb, ['orders:read']);

        $this->tenancy()->run($tenantA, function () use ($tenantA) {
            $this->assertSame(1, ApiKey::query()->count());
            $this->assertSame([$tenantA->id], ApiKey::query()->pluck('tenant_id')->unique()->values()->all());
        });
        $this->assertStoreIsolation(OrderEvent::class, $tenantA, $storeA, $storeB);
    }
}

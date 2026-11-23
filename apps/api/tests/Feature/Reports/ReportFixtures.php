<?php

declare(strict_types=1);

namespace Tests\Feature\Reports;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/** Direct row fixtures for the report tests: deterministic orders, items, shipments and returns. */
trait ReportFixtures
{
    private int $seq = 0;

    protected function onPlan(Tenant $tenant, string $code): void
    {
        $this->inTenant($tenant, fn () => Subscription::query()->update([
            'plan_id' => Plan::query()->where('code', $code)->value('id'), 'status' => Subscription::ACTIVE,
        ]));
        FeatureGate::forget($tenant->id);
    }

    protected function setTimezone(Tenant $tenant, Store $store, string $tz): void
    {
        $this->inTenant($tenant, fn () => DB::table('stores')->where('id', $store->id)->update(['timezone' => $tz]));
        $store->timezone = $tz;
    }

    /**
     * @param  array<string, mixed>  $o  status, placed_at (UTC), total, refunded, channel, district, cancel_reason, delivered_at, customer_name
     */
    protected function order(Tenant $tenant, Store $store, array $o): string
    {
        $id = strtolower((string) Str::ulid());
        $seq = ++$this->seq;
        $this->inTenant($tenant, fn () => DB::table('orders')->insert([
            'id' => $id, 'tenant_id' => $tenant->id, 'store_id' => $store->id,
            'number' => 'R'.$seq, 'sequence' => 9000 + $seq,
            'status' => $o['status'], 'payment_method' => 'cod',
            'created_via' => 'storefront', 'channel' => $o['channel'] ?? 'website',
            'customer_name' => $o['customer_name'] ?? 'Rahim', 'customer_phone' => '8801711000000',
            'shipping_address' => json_encode(['district_code' => $o['district'] ?? 'dhaka', 'address_line' => 'Secret Road 1']),
            'district_code' => $o['district'] ?? 'dhaka', 'currency' => 'BDT',
            'subtotal_amount' => $o['total'] ?? 0, 'total_amount' => $o['total'] ?? 0, 'refunded_amount' => $o['refunded'] ?? 0,
            // Postgres orders_refund_check: refunded_amount <= paid_amount (QA M-1). A refunded order was paid first.
            'paid_amount' => ($o['refunded'] ?? 0) > 0 ? max($o['total'] ?? 0, $o['refunded']) : 0,
            'payment_status' => ($o['refunded'] ?? 0) > 0 ? (($o['refunded'] >= ($o['total'] ?? 0)) ? 'refunded' : 'partially_refunded') : 'unpaid',
            'shipping_zone_name' => 'Zone', 'tags' => '[]', 'cancel_reason' => $o['cancel_reason'] ?? null,
            'placed_at' => $o['placed_at'], 'delivered_at' => $o['delivered_at'] ?? null,
            'created_at' => $o['placed_at'], 'updated_at' => $o['placed_at'],
        ]));

        return $id;
    }

    protected function item(Tenant $tenant, Store $store, string $orderId, array $i): string
    {
        $id = strtolower((string) Str::ulid());
        $qty = $i['qty'] ?? 1;
        $this->inTenant($tenant, fn () => DB::table('order_items')->insert([
            'id' => $id, 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'order_id' => $orderId,
            'product_id' => $i['product_id'] ?? null, 'product_name' => $i['name'] ?? 'Item', 'variant_title' => 'Default',
            'option_values' => '[]', 'unit_price_amount' => intdiv($i['total'], $qty), 'unit_cost_amount' => $i['cost'] ?? null,
            'subtotal_amount' => $i['total'], 'discount_amount' => 0, 'total_amount' => $i['total'], 'quantity' => $qty,
            'tracked' => false, 'created_at' => now(), 'updated_at' => now(),
        ]));

        return $id;
    }

    protected function event(Tenant $tenant, Store $store, string $orderId, string $from, string $to): void
    {
        $this->inTenant($tenant, fn () => DB::table('order_events')->insert([
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'order_id' => $orderId,
            'type' => 'status_changed', 'from_status' => $from, 'to_status' => $to, 'actor_type' => 'system', 'meta' => '{}',
            'created_at' => now(),
        ]));
    }

    /** @param array<string, mixed> $s provider, status, booked_at, picked_up_at, delivered_at, fee, cod_charge, cod_collected, settled_at, problem, last_location, last_event_at */
    protected function shipment(Tenant $tenant, Store $store, string $orderId, array $s): string
    {
        $id = strtolower((string) Str::ulid());
        $this->inTenant($tenant, fn () => DB::table('shipments')->insert([
            'id' => $id, 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'order_id' => $orderId,
            'provider' => $s['provider'] ?? 'steadfast', 'status' => $s['status'], 'cod_amount' => 0,
            'delivery_fee_amount' => $s['fee'] ?? null, 'cod_charge_amount' => $s['cod_charge'] ?? null,
            'cod_collected_amount' => $s['cod_collected'] ?? null, 'settled_at' => $s['settled_at'] ?? null,
            'booked_at' => $s['booked_at'] ?? null, 'picked_up_at' => $s['picked_up_at'] ?? null,
            'delivered_at' => $s['delivered_at'] ?? null, 'problem' => $s['problem'] ?? null,
            'last_location' => $s['last_location'] ?? null, 'last_event_at' => $s['last_event_at'] ?? null,
            'created_at' => now(), 'updated_at' => now(),
        ]));

        return $id;
    }

    protected function returnRequest(Tenant $tenant, Store $store, string $orderId, string $reason, string $status, string $createdAt, array $items = []): string
    {
        $id = strtolower((string) Str::ulid());
        $seq = ++$this->seq;
        $this->inTenant($tenant, function () use ($id, $seq, $tenant, $store, $orderId, $reason, $status, $createdAt, $items) {
            DB::table('return_requests')->insert([
                'id' => $id, 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'order_id' => $orderId,
                'number' => 'RT'.$seq, 'sequence' => 9000 + $seq, 'type' => 'return', 'status' => $status, 'reason' => $reason,
                'checks' => '{}', 'created_at' => $createdAt, 'updated_at' => $createdAt,
            ]);
            foreach ($items as $orderItemId => $qty) {
                DB::table('return_items')->insert([
                    'id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id,
                    'return_request_id' => $id, 'order_item_id' => $orderItemId, 'quantity' => $qty, 'amount' => 0,
                    'created_at' => $createdAt, 'updated_at' => $createdAt,
                ]);
            }
        });

        return $id;
    }

    protected function report(array $h, Store $store, string $type, array $query = []): TestResponse
    {
        $qs = $query === [] ? '' : '?'.http_build_query($query);

        return $this->flushHeaders()->withHeaders($h)->getJson("/api/v1/stores/{$store->id}/reports/{$type}{$qs}");
    }
}

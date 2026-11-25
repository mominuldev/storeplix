<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Billing\Models\Plan;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\Locations\LocationFixtures;

/**
 * Phase 8.8d part A helpers: a live Growth shop (plan has `pos`) with a stocked product at the default (online)
 * location and a "Mirpur shop" location holding its own stock, a register there, and the POS calls.
 */
trait PosFixtures
{
    use LocationFixtures;

    /**
     * @return array{tenant: Tenant, store: Store, h: array<string, string>, main: string, shop: string, variant: string, register: string, price: int}
     */
    protected function posShop(int $shopStock = 5, int $onlineStock = 10, int $price = 100000, string $slug = 'shop', string $plan = Plan::GROWTH): array
    {
        [, $tenant, $store, $h] = $this->growthShop($slug);
        [, $variant] = $this->stocked($h, $store, price: $price, stock: $onlineStock, variant: ['sku' => 'TEE-'.strtoupper(Str::random(4)), 'barcode' => '890'.random_int(1000000, 9999999)]);
        $main = $this->defaultLocation($tenant, $store)->id;
        $shop = $this->addLocation($h, $store, 'Mirpur shop', 'shop')['id'];
        if ($shopStock > 0) {
            $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => $shopStock, 'location_id' => $shop]])->assertOk();
        }
        $register = $this->addRegister($h, $store, 'Register 1', $shop)->assertCreated()->json('data.id');
        if ($plan !== Plan::GROWTH) {
            $this->planFor($tenant, $plan);
        }

        return ['tenant' => $tenant, 'store' => $store, 'h' => $h, 'main' => $main, 'shop' => $shop, 'variant' => $variant, 'register' => $register, 'price' => $price];
    }

    protected function pUrl(Store $store, string $suffix): string
    {
        return "/api/v1/stores/{$store->id}/pos".$suffix;
    }

    protected function addRegister(array $h, Store $store, string $name, string $location): TestResponse
    {
        return $this->api($h, 'POST', $this->pUrl($store, '/registers'), ['name' => $name, 'location_id' => $location]);
    }

    protected function openRegister(array $h, Store $store, string $register, array $body = ['opening_cash_amount' => 100000], ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->pUrl($store, "/registers/{$register}/open"), $body);
    }

    /** Opens the shop's register and returns the session id. */
    protected function posSession(array $s, int $opening = 100000): string
    {
        return $this->openRegister($s['h'], $s['store'], $s['register'], ['opening_cash_amount' => $opening])->assertCreated()->json('data.id');
    }

    protected function closeRegister(array $h, Store $store, string $session, array $body, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->pUrl($store, "/sessions/{$session}/close"), $body);
    }

    protected function quote(array $h, Store $store, string $session, array $lines, array $extra = []): TestResponse
    {
        return $this->api($h, 'POST', $this->pUrl($store, '/quote'), ['session_id' => $session, 'lines' => $lines] + $extra);
    }

    /**
     * A sale body: by default a cash payment of $total with $tendered (or exact) cash.
     *
     * @param  list<array{variant_id: string, quantity: int}>  $lines
     * @return array<string, mixed>
     */
    protected function saleBody(string $session, array $lines, int $total, array $extra = []): array
    {
        return array_merge([
            'session_id' => $session,
            'lines' => $lines,
            'expected_total_amount' => $total,
            'payments' => [['method' => 'cash', 'amount' => $total]],
            'tendered_cash_amount' => $total,
            'sms_receipt' => false,
        ], $extra);
    }

    protected function sell(array $h, Store $store, array $body, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->pUrl($store, '/sales'), $body);
    }

    /** One cash sale of $quantity of the shop's variant; returns the PosSale payload. @return array<string, mixed> */
    protected function cashSale(array $s, string $session, int $quantity = 1, array $extra = []): array
    {
        $total = $s['price'] * $quantity;

        return $this->sell($s['h'], $s['store'], $this->saleBody($session, [['variant_id' => $s['variant'], 'quantity' => $quantity]], $total, $extra))
            ->assertCreated()->json('data');
    }

    protected function onHand(Tenant $tenant, string $variant, string $location): int
    {
        return $this->row($tenant, $variant, $location)['on_hand'] ?? 0;
    }

    /** @return list<array{reason: string, delta: int, location_id: string, reference_type: string|null, reference_id: string|null}> */
    protected function posLedger(Tenant $tenant, string $variant): array
    {
        return $this->platformQuery(InventoryMovement::class)->where('tenant_id', $tenant->id)->where('variant_id', $variant)->where('reason', 'pos_sale')
            ->orderBy('created_at')->orderBy('id')->get()
            ->map(fn ($m) => ['reason' => $m->reason, 'delta' => (int) $m->delta, 'location_id' => $m->location_id, 'reference_type' => $m->reference_type, 'reference_id' => $m->reference_id])
            ->all();
    }
}

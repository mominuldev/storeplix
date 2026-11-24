<?php

declare(strict_types=1);

namespace Tests\Feature\StockTransfers;

use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\Locations\LocationFixtures;

/**
 * Phase 8.8c part B helpers: a Growth shop with a stocked variant at the default (online) location and a second
 * location, transfer and count calls, and ledger reads.
 */
trait StockTransferFixtures
{
    use LocationFixtures;

    /**
     * @return array{tenant: Tenant, store: Store, h: array<string, string>, main: string, shop: string, variant: string}
     */
    protected function transferShop(int $stock = 10, string $slug = 'shop', array $variant = []): array
    {
        [, $tenant, $store, $h] = $this->growthShop($slug);
        [, $variantId] = $this->stocked($h, $store, stock: $stock, variant: $variant);
        $main = $this->defaultLocation($tenant, $store)->id;
        $shop = $this->addLocation($h, $store)['id'];

        return ['tenant' => $tenant, 'store' => $store, 'h' => $h, 'main' => $main, 'shop' => $shop, 'variant' => $variantId];
    }

    /** @param list<array{variant_id: string, quantity: int}> $lines */
    protected function createTransfer(array $h, Store $store, string $from, string $to, array $lines, array $extra = [], ?string $key = null): TestResponse
    {
        $headers = $key === null ? $h : $h + ['Idempotency-Key' => $key];

        return $this->api($headers, 'POST', $this->lUrl($store, '/stock-transfers'), ['from_location_id' => $from, 'to_location_id' => $to, 'lines' => $lines] + $extra);
    }

    protected function sendTransfer(array $h, Store $store, string $id, ?string $key = null, array $body = []): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->lUrl($store, "/stock-transfers/{$id}/send"), $body);
    }

    /** @param list<array{item_id: string, received: int}> $lines */
    protected function receiveTransfer(array $h, Store $store, string $id, array $lines, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->lUrl($store, "/stock-transfers/{$id}/receive"), ['lines' => $lines]);
    }

    protected function startCount(array $h, Store $store, string $location, array $extra = []): TestResponse
    {
        return $this->api($h, 'POST', $this->lUrl($store, '/stock-counts'), ['location_id' => $location] + $extra);
    }

    protected function scan(array $h, Store $store, string $count, string $code): TestResponse
    {
        return $this->api($h, 'POST', $this->lUrl($store, "/stock-counts/{$count}/scan"), ['code' => $code]);
    }

    protected function setCounted(array $h, Store $store, string $count, string $line, ?int $counted, array $extra = []): TestResponse
    {
        return $this->api($h, 'PUT', $this->lUrl($store, "/stock-counts/{$count}/lines/{$line}"), ['counted' => $counted] + $extra);
    }

    protected function finishCount(array $h, Store $store, string $count, bool $zero = false, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->lUrl($store, "/stock-counts/{$count}/finish"), ['zero_uncounted' => $zero]);
    }

    /** @return array<string, string> variant id → line id */
    protected function countLines(array $h, Store $store, string $count): array
    {
        $out = [];
        foreach ($this->api($h, 'GET', $this->lUrl($store, "/stock-counts/{$count}/lines"))->assertOk()->json('data') as $line) {
            $out[$line['variant']['id']] = $line['id'];
        }

        return $out;
    }

    /** @return list<array{reason: string, delta: int, location_id: string, reference_type: string|null, note: string|null}> */
    protected function ledger(Tenant $tenant, string $variant, ?string $reason = null): array
    {
        return $this->platformQuery(InventoryMovement::class)->where('tenant_id', $tenant->id)->where('variant_id', $variant)
            ->when($reason !== null, fn ($q) => $q->where('reason', $reason))->orderBy('created_at')->orderBy('id')->get()
            ->map(fn ($m) => ['reason' => $m->reason, 'delta' => (int) $m->delta, 'location_id' => $m->location_id, 'reference_type' => $m->reference_type, 'note' => $m->note])
            ->all();
    }

    protected function onHand(Tenant $tenant, string $variant, string $location): int
    {
        return $this->row($tenant, $variant, $location)['on_hand'] ?? 0;
    }
}

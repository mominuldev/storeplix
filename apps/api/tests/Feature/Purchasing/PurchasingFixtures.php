<?php

declare(strict_types=1);

namespace Tests\Feature\Purchasing;

use App\Domain\Billing\Models\Plan;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Carbon\CarbonImmutable;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\Reports\ReportFixtures;
use Tests\Support\CommerceFixtures;
use Tests\Support\RoleFixtures;

/**
 * Phase 8.8b helpers: a live Starter-trial shop (plan has `purchasing`) at 12:00 Dhaka on Fri 20 Nov 2026, suppliers
 * and purchase orders through the API, receipts with an Idempotency-Key, and direct reads of variant cost / stock.
 */
trait PurchasingFixtures
{
    use CommerceFixtures, ReportFixtures, RoleFixtures;

    protected const NOW_UTC = '2026-11-20 06:00:00';

    protected const TODAY = '2026-11-20';

    protected function setUpPurchasing(bool $throttle = false): void
    {
        Mail::fake();
        if (! $throttle) {
            $this->withoutMiddleware(ThrottleRequests::class);
        }
        $this->travelTo(CarbonImmutable::parse(self::NOW_UTC, 'UTC'));
        Storage::fake('local');
        Storage::fake('public');
    }

    /** @return array{0: mixed, 1: Tenant, 2: Store, 3: array<string, string>} */
    protected function buyer(string $slug = 'shop', ?string $plan = null): array
    {
        [$user, $tenant, $store, $h] = $this->liveShop($slug);
        if ($plan !== null) {
            $this->planFor($tenant, $plan);
        }

        return [$user, $tenant, $store, $h];
    }

    protected function freeBuyer(string $slug = 'free'): array
    {
        return $this->buyer($slug, Plan::FREE);
    }

    protected function pUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}".$suffix;
    }

    /** A tracked simple product with stock and (optionally) a cost. @return string variant id */
    protected function variant(array $h, Store $store, int $stock = 10, ?int $cost = null, int $price = 100000, string $name = ''): string
    {
        $product = $this->createProduct($h, $store, $this->simpleProduct($name !== '' ? $name : 'Item '.Str::random(5), $price, ['status' => 'active'],
            ['initial_on_hand' => $stock] + ($cost === null ? [] : ['cost_amount' => $cost])));

        return $product['variants'][0]['id'];
    }

    /** @param array<string, mixed> $body @return array<string, mixed> */
    protected function addSupplier(array $h, Store $store, array $body = []): array
    {
        return $this->api($h, 'POST', $this->pUrl($store, '/suppliers'), $body + ['name' => 'Rahman Fabrics '.Str::random(4)])->assertCreated()->json('data');
    }

    /**
     * @param  list<array{0: string, 1: int, 2: int}>  $lines  [variant, unit cost, quantity]
     * @return array<string, mixed> PurchaseOrderDetail
     */
    protected function draft(array $h, Store $store, string $supplier, array $lines, array $extra = []): array
    {
        return $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), [
            'supplier_id' => $supplier,
            'lines' => array_map(fn ($l) => ['variant_id' => $l[0], 'unit_cost_amount' => $l[1], 'quantity' => $l[2]], $lines),
        ] + $extra)->assertCreated()->json('data');
    }

    /** A draft marked ordered. @return array<string, mixed> */
    protected function ordered(array $h, Store $store, string $supplier, array $lines, array $extra = []): array
    {
        $po = $this->draft($h, $store, $supplier, $lines, $extra);

        return $this->api($h, 'POST', $this->pUrl($store, "/purchase-orders/{$po['id']}/mark-ordered"))->assertOk()->json('data');
    }

    /** @param list<array{item_id: string, received: int, damaged?: int}> $lines */
    protected function receive(array $h, Store $store, string $po, array $lines, array $extra = [], ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->pUrl($store, "/purchase-orders/{$po}/receipts"),
            ['lines' => array_map(fn ($l) => $l + ['damaged' => 0], $lines)] + $extra);
    }

    protected function quick(array $h, Store $store, array $body, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->pUrl($store, '/purchase-orders/quick'), $body);
    }

    protected function getPo(array $h, Store $store, string $po): TestResponse
    {
        return $this->api($h, 'GET', $this->pUrl($store, "/purchase-orders/{$po}"));
    }

    protected function costOf(Tenant $tenant, string $variant): ?int
    {
        $v = $this->platformQuery(ProductVariant::class)->where('tenant_id', $tenant->id)->whereKey($variant)->value('cost_amount');

        return $v === null ? null : (int) $v;
    }

    protected function onHand(Tenant $tenant, string $variant): int
    {
        return (int) $this->platformQuery(Inventory::class)->where('tenant_id', $tenant->id)->where('variant_id', $variant)->value('on_hand');
    }

    protected function setOnHand(Tenant $tenant, string $variant, int $onHand): void
    {
        $this->platformQuery(Inventory::class)->where('tenant_id', $tenant->id)->where('variant_id', $variant)->update(['on_hand' => $onHand]);
    }

    protected function setCost(Tenant $tenant, string $variant, ?int $cost): void
    {
        $this->platformQuery(ProductVariant::class)->where('tenant_id', $tenant->id)->whereKey($variant)->update(['cost_amount' => $cost]);
    }

    /** @return list<array{action: string, actor_type: string, meta: mixed}> */
    protected function purchasingAudit(Tenant $tenant): array
    {
        return $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'like', 'purchasing.%')
            ->orderBy('created_at')->orderBy('id')->get()
            ->map(fn ($r) => ['action' => $r->action, 'actor_type' => $r->actor_type, 'meta' => json_decode((string) $r->meta, true)])->all();
    }

    protected function uploadInvoice(array $h, Store $store, string $name = 'bill.pdf', ?string $bytes = null): TestResponse
    {
        $file = UploadedFile::fake()->createWithContent($name, $bytes ?? "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

        return $this->flushHeaders()->withHeaders($h)->post($this->pUrl($store, '/purchasing/invoices'), ['file' => $file], ['Accept' => 'application/json']);
    }
}

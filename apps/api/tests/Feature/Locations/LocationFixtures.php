<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use App\Domain\Billing\Models\Plan;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\Location;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Testing\TestResponse;
use Tests\Support\CommerceFixtures;
use Tests\Support\RoleFixtures;

/**
 * Phase 8.8c part A helpers: a live Growth shop (plan has `multi_warehouse`), locations through the API, stock
 * adjustments at a location, and direct reads of one stock row.
 */
trait LocationFixtures
{
    use CommerceFixtures, RoleFixtures;

    protected function setUpLocations(): void
    {
        Mail::fake();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    /** @return array{0: mixed, 1: Tenant, 2: Store, 3: array<string, string>} */
    protected function growthShop(string $slug = 'shop', string $plan = Plan::GROWTH): array
    {
        [$user, $tenant, $store, $h] = $this->liveShop($slug);
        $this->planFor($tenant, $plan);

        return [$user, $tenant, $store, $h];
    }

    protected function lUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}".$suffix;
    }

    /** @return array<string, mixed> Location */
    protected function addLocation(array $h, Store $store, string $name = 'Dhanmondi shop', string $type = 'shop', array $extra = []): array
    {
        return $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => $name, 'type' => $type] + $extra)->assertCreated()->json('data');
    }

    protected function defaultLocation(Tenant $tenant, Store $store): Location
    {
        return $this->inTenant($tenant, fn () => Location::query()->where('store_id', $store->id)->where('is_default', true)->firstOrFail());
    }

    /** @param list<array<string, mixed>> $items */
    protected function adjustAt(array $h, Store $store, array $items, string $reason = 'received'): TestResponse
    {
        return $this->api($h, 'POST', $this->lUrl($store, '/inventory/adjustments'), ['reason' => $reason, 'items' => $items]);
    }

    /** @return array{on_hand: int, committed: int}|null */
    protected function row(Tenant $tenant, string $variant, string $location): ?array
    {
        $r = $this->platformQuery(Inventory::class)->where('tenant_id', $tenant->id)->where('variant_id', $variant)->where('location_id', $location)->first();

        return $r === null ? null : ['on_hand' => (int) $r->on_hand, 'committed' => (int) $r->committed];
    }

    /**
     * Cross-tenant resource access (MULTI-TENANCY §10a): every URL of tenant B's resource → 404 `not_found` for A.
     *
     * @param  list<array{0: string, 1: string, 2?: array<string, mixed>}>  $requests
     */
    protected function assertTenantIsolation(array $headersA, array $requests): void
    {
        foreach ($requests as $request) {
            $this->flushHeaders()->withHeaders($headersA)->json($request[0], $request[1], $request[2] ?? [])
                ->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
    }

    protected function makeDefault(array $h, Store $store, string $location): TestResponse
    {
        return $this->api($h, 'POST', $this->lUrl($store, "/locations/{$location}/make-default"));
    }
}

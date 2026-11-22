<?php

namespace Tests\Support;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\UploadedFile;
use Illuminate\Testing\TestResponse;

/** Phase 4 helpers: a merchant with a store, product payloads, and the store-isolation assertion. */
trait CatalogFixtures
{
    /** @return array{0: User, 1: Tenant, 2: Store, 3: array<string, string>} */
    protected function shop(string $role = TenantUser::ROLE_OWNER, string $slug = 'shop'): array
    {
        [$user, $tenant] = $this->merchant($role);
        $store = $this->storeFor($tenant, $slug.strtolower(substr((string) $tenant->id, -6)));

        return [$user, $tenant, $store, $this->tenantHeaders($user, $tenant)];
    }

    /** Another member (role) of the same tenant. @return array{0: User, 1: array<string, string>} */
    protected function member(Tenant $tenant, string $role): array
    {
        [$user] = $this->merchant($role, $tenant);

        return [$user, $this->tenantHeaders($user, $tenant)];
    }

    protected function api(array $headers, string $method, string $url, array $body = []): TestResponse
    {
        return $this->flushHeaders()->withHeaders($headers)->json($method, $url, $body);
    }

    /** @return array<string, mixed> */
    protected function simpleProduct(string $name = 'Cotton Panjabi', int $price = 150000, array $extra = [], array $variant = []): array
    {
        return ['name' => $name, 'variants' => [['price_amount' => $price] + $variant]] + $extra;
    }

    /** @return array<string, mixed> 2 options × (sizes × colours) */
    protected function variableProduct(string $name = 'Jamdani Three-Piece', array $sizes = ['M', 'L'], array $colours = ['Red'], string $skuPrefix = 'JT'): array
    {
        $variants = [];
        foreach ($sizes as $size) {
            foreach ($colours as $colour) {
                $variants[] = ['option_values' => [$size, $colour], 'sku' => "{$skuPrefix}-{$colour}-{$size}", 'price_amount' => 345000, 'initial_on_hand' => 10];
            }
        }

        return [
            'name' => $name,
            'status' => 'active',
            'options' => [['name' => 'Size', 'values' => $sizes], ['name' => 'Colour', 'values' => $colours]],
            'variants' => $variants,
        ];
    }

    protected function createProduct(array $headers, Store $store, array $payload): array
    {
        return $this->api($headers, 'POST', "/api/v1/stores/{$store->id}/products", $payload)->assertCreated()->json('data');
    }

    protected function productImage(array $headers, string $purpose = 'product_image'): string
    {
        return $this->flushHeaders()->withHeaders($headers)
            ->post('/api/v1/media', [
                'file' => UploadedFile::fake()->createWithContent('p.png', $this->imageBytes(300, 300)),
                'purpose' => $purpose,
            ], ['Accept' => 'application/json'])
            ->assertCreated()->json('data.id');
    }

    /**
     * Store isolation: with tenant A's context, a model row of store B (another tenant) is invisible, and a row
     * created in A never carries B's ids.
     *
     * @param  class-string<Model>  $model
     */
    protected function assertStoreIsolation(string $model, Tenant $tenantA, Store $storeA, Store $storeB): void
    {
        $this->tenancy()->run($tenantA, function () use ($model, $storeA, $storeB) {
            $this->assertSame(0, $model::query()->where('store_id', $storeB->id)->count(), "{$model} leaks store B rows");
            $this->assertSame(
                $model::query()->count(),
                $model::query()->where('store_id', $storeA->id)->count(),
                "{$model} returns rows of another store",
            );
        });
    }
}

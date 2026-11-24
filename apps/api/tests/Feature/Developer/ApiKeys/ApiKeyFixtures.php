<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\ApiKeys;

use App\Domain\Billing\Models\Plan;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\CommerceFixtures;
use Tests\Support\RoleFixtures;

/** PHASE-8-4 test helpers: a Growth shop with delivery zones, API keys through the merchant API, external calls. */
trait ApiKeyFixtures
{
    use CommerceFixtures, RoleFixtures;

    /** @return array{0: User, 1: Tenant, 2: Store, 3: array<string, string>} owner, tenant, store, owner headers */
    protected function devShop(string $slug = 'shop', string $plan = Plan::GROWTH): array
    {
        [$owner, $tenant, $store, $h] = $this->liveShop($slug);
        $this->planFor($tenant, $plan);

        return [$owner, $tenant, $store, $h];
    }

    /**
     * @param  list<string>  $scopes
     * @return array{0: string, 1: string} key id, plain key
     */
    protected function createKey(array $h, array $scopes, string $name = 'Zapier', bool $includeCosts = false): array
    {
        $body = ['name' => $name, 'scopes' => $scopes] + ($includeCosts ? ['include_costs' => true] : []);
        $data = $this->api($h, 'POST', '/api/v1/api-keys', $body)->assertCreated()->json('data');

        return [$data['id'], $data['plain_key']];
    }

    /** A key with every scope. @return array{0: string, 1: string} */
    protected function fullKey(array $h, bool $includeCosts = false): array
    {
        return $this->createKey($h, ['orders:write', 'products:write', 'inventory:write', 'customers:read'], 'Full', $includeCosts);
    }

    /**
     * External API call as a server would make it: Bearer key, a non-SPA Origin (no session, no CSRF).
     *
     * @param  array<string, mixed>  $body
     * @param  array<string, string>  $headers
     */
    protected function ext(?string $plain, string $method, string $path, array $body = [], array $headers = []): TestResponse
    {
        $headers += ['Origin' => 'https://integrations.example.test'];
        if ($plain !== null) {
            $headers['Authorization'] = 'Bearer '.$plain;
        }

        return $this->flushHeaders()->withHeaders($headers)->json($method, '/api/v1/external'.$path, $body);
    }

    /** @param array<string, mixed> $body */
    protected function extWrite(string $plain, string $method, string $path, array $body = []): TestResponse
    {
        return $this->ext($plain, $method, $path, $body, ['Idempotency-Key' => (string) Str::uuid()]);
    }

    /** A pending manual order. @return array{0: string, 1: string} order id, variant id */
    protected function pendingOrder(array $h, Store $store, int $stock = 10): array
    {
        [, $variant] = $this->stocked($h, $store, 100000, $stock, ['sku' => 'SKU-'.Str::upper(Str::random(6))]);
        $order = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');

        return [$order, $variant];
    }
}

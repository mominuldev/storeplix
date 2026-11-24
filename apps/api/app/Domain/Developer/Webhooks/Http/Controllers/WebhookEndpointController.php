<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Controllers;

use App\Domain\Developer\Webhooks\Http\Requests\StoreWebhookEndpointRequest;
use App\Domain\Developer\Webhooks\Http\Requests\UpdateWebhookEndpointRequest;
use App\Domain\Developer\Webhooks\Http\Resources\WebhookPresenter;
use App\Domain\Developer\Webhooks\Models\WebhookEndpoint;
use App\Domain\Developer\Webhooks\WebhookEndpoints;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Response;

/**
 * PHASE-8-4 §6.1 `/stores/{store}/webhook-endpoints…` (perm:developers.manage on each route). `{endpoint}` resolves
 * inside the store and the tenant: another store's or tenant's id → 404 `not_found`.
 */
class WebhookEndpointController
{
    public function __construct(private readonly WebhookEndpoints $endpoints) {}

    public function index(Store $store): JsonResponse
    {
        $rows = WebhookEndpoint::query()->where('store_id', $store->id)->orderBy('created_at')->orderBy('id')->get();
        $rates = WebhookPresenter::successRates($rows->pluck('id')->all());

        return new JsonResponse(['data' => $rows->map(fn (WebhookEndpoint $e) => WebhookPresenter::endpoint($e, $rates[$e->id] ?? null))->all()]);
    }

    public function store(StoreWebhookEndpointRequest $request, Store $store): JsonResponse
    {
        $endpoint = $this->endpoints->create($store, $request->endpointInput());

        return $this->one($endpoint, 201);
    }

    public function update(UpdateWebhookEndpointRequest $request, Store $store, string $endpoint): JsonResponse
    {
        $row = self::find($store, $endpoint);

        return $this->one($this->endpoints->update($row, $request->changes()));
    }

    public function destroy(Store $store, string $endpoint): Response
    {
        $row = self::find($store, $endpoint);
        $this->endpoints->assertFeature();
        $this->endpoints->delete($row);

        return response()->noContent();
    }

    public function test(Store $store, string $endpoint): JsonResponse
    {
        $row = self::find($store, $endpoint);
        $this->endpoints->assertFeature();
        $delivery = $this->endpoints->test($row);

        return new JsonResponse(['data' => WebhookPresenter::delivery($delivery->refresh())], 202);
    }

    public static function find(Store $store, string $id): WebhookEndpoint
    {
        return WebhookEndpoint::query()->where('store_id', $store->id)->whereKey(strtolower($id))->firstOrFail();
    }

    private function one(WebhookEndpoint $endpoint, int $status = 200): JsonResponse
    {
        $rate = WebhookPresenter::successRates([$endpoint->id])[$endpoint->id] ?? null;

        return new JsonResponse(['data' => WebhookPresenter::endpoint($endpoint->refresh(), $rate)], $status);
    }
}

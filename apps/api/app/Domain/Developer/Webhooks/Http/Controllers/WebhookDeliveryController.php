<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Controllers;

use App\Domain\Developer\Webhooks\Http\Requests\ListWebhookDeliveriesRequest;
use App\Domain\Developer\Webhooks\Http\Resources\WebhookPresenter;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\WebhookDeliveries;
use App\Domain\Developer\Webhooks\WebhookEndpoints;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;

/**
 * PHASE-8-4 §6.1 `/stores/{store}/webhook-deliveries…`: newest-first cursor pages of 25 without payload; detail with
 * payload, redacted request headers and the response excerpt; resend / resend-failed (writes, api_webhooks; not
 * audited). `{delivery}` of another store or tenant → 404.
 */
class WebhookDeliveryController
{
    public function __construct(
        private readonly WebhookDeliveries $deliveries,
        private readonly WebhookEndpoints $endpoints,
    ) {}

    public function index(ListWebhookDeliveriesRequest $request, Store $store): JsonResponse
    {
        $filter = (array) ($request->validated()['filter'] ?? []);
        $query = WebhookDelivery::query()->where('store_id', $store->id)
            ->select(['id', 'tenant_id', 'store_id', 'endpoint_id', 'event_id', 'event_type', 'subject_label', 'status', 'attempts',
                'next_attempt_at', 'last_attempt_at', 'response_status', 'error_code', 'duration_ms', 'created_at']);
        if (isset($filter['endpoint_id'])) {
            $query->where('endpoint_id', strtolower((string) $filter['endpoint_id']));
        }
        if (isset($filter['status'])) {
            $query->where('status', $filter['status']);
        }
        if (isset($filter['event_type'])) {
            $query->where('event_type', $filter['event_type']);
        }
        $page = $query->orderByDesc('created_at')->orderByDesc('id')
            ->cursorPaginate(25, ['*'], 'cursor', $request->validated()['cursor'] ?? null);

        return new JsonResponse([
            'data' => collect($page->items())->map(fn (WebhookDelivery $d) => WebhookPresenter::delivery($d))->values()->all(),
            'meta' => [
                'next_cursor' => $page->nextCursor()?->encode(),
                'prev_cursor' => $page->previousCursor()?->encode(),
                'per_page' => $page->perPage(),
            ],
        ]);
    }

    public function show(Store $store, string $delivery): JsonResponse
    {
        return new JsonResponse(['data' => WebhookPresenter::detail(self::find($store, $delivery))]);
    }

    public function resend(Store $store, string $delivery): JsonResponse
    {
        $row = self::find($store, $delivery);
        $this->endpoints->assertFeature();
        $copy = $this->deliveries->resend($row);

        return new JsonResponse(['data' => WebhookPresenter::delivery($copy->refresh())], 202);
    }

    public function resendFailed(Store $store): JsonResponse
    {
        $this->endpoints->assertFeature();

        return new JsonResponse(['data' => ['count' => $this->deliveries->resendFailed($store)]], 202);
    }

    private static function find(Store $store, string $id): WebhookDelivery
    {
        return WebhookDelivery::query()->where('store_id', $store->id)->whereKey(strtolower($id))->firstOrFail();
    }
}

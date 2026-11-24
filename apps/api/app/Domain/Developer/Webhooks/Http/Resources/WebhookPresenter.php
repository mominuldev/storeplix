<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Resources;

use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\Models\WebhookEndpoint;
use App\Domain\Developer\Webhooks\WebhookDeliveries;
use App\Domain\Developer\Webhooks\WebhookEventType;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Support\Facades\DB;

/** WebhookEndpoint / WebhookDelivery / WebhookDeliveryDetail / WebhookEventTypeInfo (PHASE-8-4 §6.2, openapi 1.12.0). */
final class WebhookPresenter
{
    /**
     * success_rate_7d per endpoint: succeeded / attempted deliveries of the last 7 days (0–100, one decimal).
     *
     * @param  list<string>  $endpointIds
     * @return array<string, float>
     */
    public static function successRates(array $endpointIds): array
    {
        if ($endpointIds === []) {
            return [];
        }
        $rows = WebhookDelivery::query()
            ->whereIn('endpoint_id', $endpointIds)
            ->where('created_at', '>=', now()->subDays(7))
            ->whereIn('status', [WebhookDelivery::SUCCEEDED, WebhookDelivery::RETRYING, WebhookDelivery::FAILED])
            ->groupBy('endpoint_id')
            ->select('endpoint_id', DB::raw('COUNT(*) AS total'), DB::raw("SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS ok"))
            ->toBase()->get();
        $rates = [];
        foreach ($rows as $row) {
            if ((int) $row->total > 0) {
                $rates[(string) $row->endpoint_id] = round(100 * (int) $row->ok / (int) $row->total, 1);
            }
        }

        return $rates;
    }

    /** @return array<string, mixed> */
    public static function endpoint(WebhookEndpoint $e, ?float $rate): array
    {
        return [
            'id' => $e->id,
            'url' => $e->url,
            'description' => $e->description,
            'events' => array_values($e->events ?? []),
            'is_active' => $e->is_active,
            'disabled_reason' => $e->disabled_reason,
            'failing_since' => UserRef::iso($e->failing_since),
            'last_delivery_at' => UserRef::iso($e->last_delivery_at),
            'last_status' => $e->last_status,
            'success_rate_7d' => $rate,
            'created_at' => UserRef::iso($e->created_at),
            'updated_at' => UserRef::iso($e->updated_at),
        ];
    }

    /** @return array<string, mixed> */
    public static function delivery(WebhookDelivery $d): array
    {
        return [
            'id' => $d->id,
            'endpoint_id' => $d->endpoint_id,
            'event_id' => $d->event_id,
            'event_type' => $d->event_type,
            'subject_label' => $d->subject_label,
            'status' => $d->status,
            'attempts' => $d->attempts,
            'next_attempt_at' => UserRef::iso($d->next_attempt_at),
            'last_attempt_at' => UserRef::iso($d->last_attempt_at),
            'response_status' => $d->response_status,
            'error_code' => $d->error_code,
            'duration_ms' => $d->duration_ms,
            'created_at' => UserRef::iso($d->created_at),
        ];
    }

    /** @return array<string, mixed> */
    public static function detail(WebhookDelivery $d): array
    {
        $payload = $d->payload;
        if (isset($payload['data']) && is_array($payload['data']) && ($payload['data']['object'] ?? null) === []) {
            $payload['data']['object'] = (object) [];
        }

        return self::delivery($d) + [
            'payload' => $payload,
            'request_headers' => WebhookDeliveries::loggedHeaders($d),
            'response_body_excerpt' => $d->response_body_excerpt,
        ];
    }

    /** @return list<array{key: string, label: string, description: string}> */
    public static function eventTypes(): array
    {
        return array_map(fn (WebhookEventType $t) => ['key' => $t->value, 'label' => $t->label(), 'description' => $t->description()], WebhookEventType::subscribable());
    }
}

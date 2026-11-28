<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Shared\Http\UserRef;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/** PHASE-8-9D §5.6 TrackingEventLogEntry: never a payload, hashed data, IP or user agent. */
final class TrackingPresenter
{
    /**
     * @param  Collection<int, TrackingEvent>  $rows
     * @return list<array<string, mixed>>
     */
    public static function log(Collection $rows): array
    {
        $orders = DB::table('orders')->whereIn('id', $rows->pluck('order_id')->filter()->unique()->values()->all())->pluck('number', 'id');
        $ids = $rows->pluck('event_id')->unique()->values()->all();
        $integrationIds = $rows->pluck('store_integration_id')->unique()->values()->all();
        $channels = DB::table('tracking_events')->whereIn('store_integration_id', $integrationIds)->whereIn('event_id', $ids)
            ->select(['event_id', 'channel'])->get()->groupBy('event_id')->map(fn ($g) => $g->pluck('channel')->unique()->count());
        $max = (int) config('tracking.max_attempts', 5);

        return $rows->map(fn (TrackingEvent $e) => [
            'id' => $e->id,
            'event' => $e->event_name,
            'provider_event_name' => $e->provider_event_name,
            'event_id' => $e->event_id,
            'channel' => $e->channel,
            'source' => $e->source,
            'test' => $e->test,
            'status' => $e->status,
            'skip_reason' => $e->skip_reason,
            'attempts' => $e->attempts,
            'max_attempts' => $max,
            'next_attempt_at' => in_array($e->status, TrackingEvent::OPEN, true) ? UserRef::iso($e->next_attempt_at) : null,
            'http_status' => $e->http_status,
            'error_code' => $e->error_code,
            'order' => $e->order_id !== null && isset($orders[$e->order_id]) ? ['id' => $e->order_id, 'number' => (string) $orders[$e->order_id]] : null,
            'page_path' => $e->page_path,
            'value_amount' => $e->value_amount,
            'currency' => $e->currency,
            'deduplicated' => ($channels[$e->event_id] ?? 1) > 1,
            'created_at' => UserRef::iso($e->created_at),
            'delivered_at' => UserRef::iso($e->delivered_at),
        ])->values()->all();
    }
}

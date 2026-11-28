<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Http\Controllers;

use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\IntegrationService;
use App\Domain\Stores\Models\Store;
use App\Domain\Tracking\Models\TrackingDailyStat;
use App\Domain\Tracking\Models\TrackingEvent;
use App\Domain\Tracking\TrackingEventNames;
use App\Domain\Tracking\TrackingPresenter;
use App\Domain\Tracking\TrackingTestService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Validation\ValidationException;
use Throwable;

/** PHASE-8-9D §5.6 – §5.8: event log, stats, send test event, test mode. Tracking providers only (others 404). */
final class TrackingController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(private readonly TrackingTestService $tests) {}

    public function testEvent(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::TRACKING);
        $input = $request->validate([
            'event' => ['sometimes', 'string', 'in:'.implode(',', TrackingEventNames::ALL)],
            'test_event_code' => ['sometimes', 'nullable', 'string', 'regex:/^[A-Za-z0-9]{4,32}$/'],
        ]);
        $row = IntegrationService::requireConnected($store, $provider);

        return new JsonResponse(['data' => $this->tests->send($store, $row, (string) ($input['event'] ?? 'purchase'), $input['test_event_code'] ?? null)], 200, self::NO_STORE);
    }

    public function testMode(Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, [IntegrationProvider::META_PIXEL, IntegrationProvider::TIKTOK_PIXEL]);
        $row = IntegrationService::requireConnected($store, $provider);

        return new JsonResponse(['data' => $this->tests->testMode($store, $row)], 200, self::NO_STORE);
    }

    public function events(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::TRACKING);
        $input = $request->validate([
            'status' => ['sometimes', 'string', 'max:100', 'regex:/^(pending|retrying|delivered|failed|skipped)(,(pending|retrying|delivered|failed|skipped))*$/'],
            'event' => ['sometimes', 'string', 'max:200', 'regex:/^(page_view|view_item|add_to_cart|begin_checkout|purchase|refund)(,(page_view|view_item|add_to_cart|begin_checkout|purchase|refund))*$/'],
            'channel' => ['sometimes', 'string', 'in:browser,server'],
            'test' => ['sometimes', 'in:0,1'],
            'since' => ['sometimes', 'string', 'max:40'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);
        $since = now()->subDays(7);
        if (isset($input['since'])) {
            try {
                $since = Carbon::parse($input['since']);
            } catch (Throwable) {
                throw ValidationException::withMessages(['since' => ['Use an ISO-8601 time.']]);
            }
            if ($since->lessThan(now()->subDays((int) config('tracking.retention.failed', 30)))) {
                throw ValidationException::withMessages(['since' => ['Events are kept for 30 days at most.']]);
            }
        }
        $row = IntegrationService::find($store, $provider);
        $query = TrackingEvent::query()->where('store_id', $store->id)->where('store_integration_id', $row?->id ?? '')
            ->where('created_at', '>=', $since)
            // browser rows are logged only in test mode (P89D-19); server rows always
            ->where(fn ($q) => $q->where('channel', TrackingEvent::SERVER)->orWhere('test', true));
        if (isset($input['status'])) {
            $query->whereIn('status', explode(',', $input['status']));
        }
        if (isset($input['event'])) {
            $query->whereIn('event_name', explode(',', $input['event']));
        }
        if (isset($input['channel'])) {
            $query->where('channel', $input['channel']);
        }
        if (isset($input['test'])) {
            $query->where('test', $input['test'] === '1');
        }
        $page = $query->orderByDesc('created_at')->orderByDesc('id')->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);

        return new JsonResponse([
            'data' => TrackingPresenter::log(collect($page->items())),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ], 200, self::NO_STORE);
    }

    public function stats(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::TRACKING);
        $input = $request->validate(['days' => ['sometimes', 'integer', 'in:7,30']]);
        $days = (int) ($input['days'] ?? 7);
        $zone = $store->timezone ?: 'Asia/Dhaka';
        $to = now($zone)->toDateString();
        $from = now($zone)->subDays($days - 1)->toDateString();
        $row = IntegrationService::find($store, $provider);
        $stats = TrackingDailyStat::query()->where('store_integration_id', $row?->id ?? '')->where('date', '>=', $from)->where('date', '<=', $to)->get()->groupBy('event_name');
        $events = $row !== null ? TrackingEventNames::received($row) : array_values(array_filter(TrackingEventNames::ALL, fn ($e) => TrackingEventNames::for($provider, $e) !== null));
        $rows = [];
        $totals = ['browser' => 0, 'server_sent' => 0, 'server_failed' => 0];
        foreach ($events as $event) {
            $g = $stats->get($event, collect());
            $r = [
                'event' => $event, 'provider_event_name' => TrackingEventNames::for($provider, $event),
                'browser' => (int) $g->sum('browser_count'), 'server_sent' => (int) $g->sum('server_sent'),
                'server_failed' => (int) $g->sum('server_failed'), 'server_skipped' => (int) $g->sum('server_skipped'),
                'last_at' => ($last = $g->max('last_at')) !== null ? Carbon::parse($last)->toIso8601ZuluString() : null,
            ];
            $totals['browser'] += $r['browser'];
            $totals['server_sent'] += $r['server_sent'];
            $totals['server_failed'] += $r['server_failed'];
            $rows[] = $r;
        }
        $sentFailed = $totals['server_sent'] + $totals['server_failed'];

        return new JsonResponse(['data' => [
            'provider' => $provider, 'days' => $days, 'from' => $from, 'to' => $to, 'rows' => $rows,
            'totals' => $totals + ['delivery_rate' => $sentFailed > 0 ? round($totals['server_sent'] / $sentFailed, 4) : null],
        ]], 200, self::NO_STORE);
    }
}

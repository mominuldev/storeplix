<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Integrations\IntegrationAttention;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Tracking\Drivers\DeliveryResult;
use App\Domain\Tracking\Drivers\TrackingDrivers;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-9D P89D-15 / P89D-16: one delivery attempt of one tracking_events row (inside its tenant). The row is claimed
 * with the 8.4 lease (`UPDATE … SET next_attempt_at = now + lease WHERE id AND status IN (pending, retrying) AND due`),
 * so the job and the minute sweep never double-send. 5 attempts (now, +1 min, +10 min, +1 h, +6 h; 429 honours
 * Retry-After ≤ 1 h) then `failed`. An auth failure stops at once (`failed`, `auth`), flags the integration
 * `token_invalid` (→ error, owner + admins emailed once) and later events are skipped `no_token` until the token is
 * replaced. The payload is nulled as soon as a row is final; stats count every final server row (tests excluded).
 */
final class TrackingDelivery
{
    public function __construct(private readonly TrackingDrivers $drivers) {}

    public function attempt(string $eventId): void
    {
        $now = now();
        $claimed = DB::table('tracking_events')->where('id', $eventId)->whereIn('status', TrackingEvent::OPEN)
            ->where(fn ($q) => $q->whereNull('next_attempt_at')->orWhere('next_attempt_at', '<=', $now))
            ->update(['next_attempt_at' => $now->copy()->addSeconds((int) config('tracking.lease_seconds', 120)), 'updated_at' => $now]);
        if ($claimed === 0) {
            return;
        }
        $row = TrackingEvent::query()->find($eventId);
        $integration = $row !== null ? StoreIntegration::query()->find($row->store_integration_id) : null;
        if ($row === null || $integration === null) {
            return;
        }
        $skip = TrackingRecorder::skipReason($integration, null, false);
        if ($skip !== null) {
            $this->finish($row, $integration, TrackingEvent::SKIPPED, ['skip_reason' => $skip]);

            return;
        }
        $payload = (array) ($row->payload ?? []);
        $testCode = $row->test ? $this->testCode($integration) : null;
        $result = $this->drivers->for($integration->provider)->send($integration, $row, $payload, $testCode);
        $attempts = $row->attempts + 1;
        $base = ['attempts' => $attempts, 'last_attempt_at' => now(), 'http_status' => $result->httpStatus];

        if ($result->delivered) {
            $this->finish($row, $integration, TrackingEvent::DELIVERED, $base + ['delivered_at' => now(), 'error_code' => null]);

            return;
        }
        if ($result->errorCode === DeliveryResult::AUTH) {
            $this->finish($row, $integration, TrackingEvent::FAILED, $base + ['error_code' => DeliveryResult::AUTH]);
            DB::transaction(function () use ($integration) {
                $locked = StoreIntegration::query()->whereKey($integration->id)->lockForUpdate()->first();
                if ($locked !== null && $locked->isActive()) {
                    IntegrationAttention::apply($locked, ['token_invalid' => null]);
                }
            });

            return;
        }
        $max = (int) config('tracking.max_attempts', 5);
        if ($result->retryable() && $attempts < $max) {
            $delays = (array) config('tracking.retry_delays', [60, 600, 3600, 21600]);
            $delay = $result->retryAfter ?? (int) ($delays[$attempts - 1] ?? end($delays));
            DB::table('tracking_events')->where('id', $row->id)->update($base + [
                'status' => TrackingEvent::RETRYING, 'error_code' => $result->errorCode, 'next_attempt_at' => now()->addSeconds($delay), 'updated_at' => now(),
            ]);

            return;
        }
        $this->finish($row, $integration, TrackingEvent::FAILED, $base + ['error_code' => $result->errorCode ?? DeliveryResult::REJECTED]);
    }

    /** @param array<string, mixed> $columns */
    private function finish(TrackingEvent $row, StoreIntegration $integration, string $status, array $columns): void
    {
        $updated = DB::table('tracking_events')->where('id', $row->id)->whereIn('status', TrackingEvent::OPEN)->update($columns + [
            'status' => $status, 'payload' => null, 'next_attempt_at' => null, 'updated_at' => now(),
        ]);
        if ($updated === 0 || $row->test) {
            return;
        }
        TrackingStats::add($integration, $row->event_name, match ($status) {
            TrackingEvent::DELIVERED => TrackingStats::SENT,
            TrackingEvent::FAILED => TrackingStats::FAILED,
            default => TrackingStats::SKIPPED,
        });
        if ($status !== TrackingEvent::SKIPPED) {
            self::recomputeFailing($integration);
        }
    }

    /** P89D-16: ≥ 20 failed of the last 50 final server events → `delivery_failing`; cleared below the threshold. */
    public static function recomputeFailing(StoreIntegration $integration): void
    {
        $window = (int) config('tracking.failing_window', 50);
        $statuses = DB::table('tracking_events')->where('store_integration_id', $integration->id)->where('channel', TrackingEvent::SERVER)
            ->where('test', false)->whereIn('status', [TrackingEvent::DELIVERED, TrackingEvent::FAILED])
            ->orderByDesc('created_at')->orderByDesc('id')->limit($window)->pluck('status');
        $failed = $statuses->filter(fn ($s) => $s === TrackingEvent::FAILED)->count();
        $failing = $failed >= (int) config('tracking.failing_threshold', 20);
        if ($failing === $integration->hasAttention('delivery_failing')) {
            return;
        }
        DB::transaction(function () use ($integration, $failing, $failed) {
            $locked = StoreIntegration::query()->whereKey($integration->id)->lockForUpdate()->first();
            if ($locked !== null && $locked->isActive()) {
                IntegrationAttention::apply($locked, $failing ? ['delivery_failing' => $failed] : [], $failing ? [] : ['delivery_failing']);
            }
        });
    }

    private function testCode(StoreIntegration $integration): ?string
    {
        $code = $integration->setting('test_event_code');

        return is_string($code) && $code !== '' ? $code : null;
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-9D §5.7: tracking_daily_stats increments — INSERT … ON CONFLICT (store_integration_id, date, event_name)
 * DO UPDATE SET x = x + excluded.x (Postgres and SQLite share the syntax). Day = the store's timezone. Test events never
 * count.
 */
final class TrackingStats
{
    public const BROWSER = 'browser_count';

    public const SENT = 'server_sent';

    public const FAILED = 'server_failed';

    public const SKIPPED = 'server_skipped';

    /** @var array<string, string> store id => timezone (per process) */
    private static array $zones = [];

    public static function add(StoreIntegration $integration, string $event, string $column, int $by = 1): void
    {
        $zone = self::$zones[$integration->store_id] ??= (string) (Store::query()->whereKey($integration->store_id)->value('timezone') ?: 'Asia/Dhaka');
        $now = now();
        $columns = [self::BROWSER => 0, self::SENT => 0, self::FAILED => 0, self::SKIPPED => 0];
        $columns[$column] = $by;
        DB::statement(
            'INSERT INTO tracking_daily_stats (id, tenant_id, store_id, store_integration_id, date, event_name, browser_count, server_sent, server_failed, server_skipped, last_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (store_integration_id, date, event_name) DO UPDATE SET
               browser_count = tracking_daily_stats.browser_count + excluded.browser_count,
               server_sent = tracking_daily_stats.server_sent + excluded.server_sent,
               server_failed = tracking_daily_stats.server_failed + excluded.server_failed,
               server_skipped = tracking_daily_stats.server_skipped + excluded.server_skipped,
               last_at = excluded.last_at',
            [strtolower((string) Str::ulid()), $integration->tenant_id, $integration->store_id, $integration->id, $now->copy()->setTimezone($zone)->toDateString(), $event,
                $columns[self::BROWSER], $columns[self::SENT], $columns[self::FAILED], $columns[self::SKIPPED], $now]
        );
    }
}

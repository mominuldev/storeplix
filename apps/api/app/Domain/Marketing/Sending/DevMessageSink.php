<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Sending;

use App\Domain\Tenancy\Support\TenantCache;

/**
 * TESTING-ONLY message sink (PHASE-8-5 §5.4, S125): with CAMPAIGNS_DEV_SINK=true (never in production — boot guard)
 * every rendered campaign / test message is kept in a capped tenant cache list (last 200 per store), newest first,
 * for e2e (GET /api/v1/dev/stores/{store}/message-sink). Must be called inside the tenant context.
 */
final class DevMessageSink
{
    public static function enabled(): bool
    {
        return (bool) config('campaigns.dev_sink') && ! app()->environment('production');
    }

    /** @param array{channel: string, to: string, subject: string|null, text: string, unsubscribe_url: string, campaign_id: string|null, is_test: bool} $message */
    public static function record(string $storeId, array $message): void
    {
        if (! self::enabled()) {
            return;
        }
        $cache = app(TenantCache::class);
        $key = self::key($storeId);
        $list = (array) $cache->get($key, []);
        array_unshift($list, $message + ['created_at' => now()->toIso8601ZuluString()]);
        $cache->put($key, array_slice($list, 0, (int) config('campaigns.dev_sink_size', 200)), now()->addDays(7));
    }

    /** @return list<array<string, mixed>> */
    public static function all(string $storeId): array
    {
        return array_values((array) app(TenantCache::class)->get(self::key($storeId), []));
    }

    private static function key(string $storeId): string
    {
        return 'campaigns:dev-sink:'.$storeId;
    }
}

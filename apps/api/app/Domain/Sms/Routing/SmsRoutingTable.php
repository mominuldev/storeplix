<?php

declare(strict_types=1);

namespace App\Domain\Sms\Routing;

use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Tenancy\Support\PlatformCache;
use Illuminate\Support\Facades\Cache;

/**
 * PHASE-8-9B §4.3: the routing rows — the database primary and failover (read through a 60 s platform cache, flushed on
 * every provider write) and the environment bootstrap (P89B-2): used only while no database primary exists and only
 * when `SMS_DRIVER=revesms` with both keys set; otherwise the source is `none`.
 */
final class SmsRoutingTable
{
    public static function cacheKey(): string
    {
        return PlatformCache::key('sms:routing');
    }

    public static function flush(): void
    {
        Cache::forget(self::cacheKey());
    }

    /** @return array{primary: ProviderRoute|null, failover: ProviderRoute|null} */
    public function database(): array
    {
        $rows = Cache::remember(self::cacheKey(), (int) config('sms.platform.routing_cache_seconds', 60), function () {
            $out = ['primary' => null, 'failover' => null];
            foreach (SmsProvider::query()->whereIn('role', [SmsProvider::PRIMARY, SmsProvider::FAILOVER])->get() as $p) {
                $out[$p->role] = ProviderRoute::fromModel($p)->toArray();
            }

            return $out;
        });

        return [
            'primary' => is_array($rows['primary'] ?? null) ? ProviderRoute::fromArray($rows['primary']) : null,
            'failover' => is_array($rows['failover'] ?? null) ? ProviderRoute::fromArray($rows['failover']) : null,
        ];
    }

    public static function environmentAvailable(): bool
    {
        $env = (array) config('sms.revesms', []);

        return config('sms.driver') === 'revesms' && (string) ($env['api_key'] ?? '') !== '' && (string) ($env['secret_key'] ?? '') !== '';
    }

    /** database | environment | none (SmsProviderSource). */
    public function source(): string
    {
        if ($this->database()['primary'] !== null) {
            return 'database';
        }

        return self::environmentAvailable() ? 'environment' : 'none';
    }

    /**
     * Ordered candidates for a group (before the breaker): [primary, failover] that carry it, else [environment].
     *
     * @return list<ProviderRoute>
     */
    public function candidates(string $group): array
    {
        $db = $this->database();
        if ($db['primary'] === null) {
            $list = self::environmentAvailable() ? [ProviderRoute::environment((array) config('sms.revesms', []))] : [];
            if ($db['failover'] !== null && $db['failover']->carries($group)) {
                $list[] = $db['failover'];
            }

            return $list;
        }

        return array_values(array_filter([$db['primary'], $db['failover']], fn (?ProviderRoute $r) => $r !== null && $r->carries($group)));
    }
}

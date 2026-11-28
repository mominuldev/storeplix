<?php

declare(strict_types=1);

namespace App\Domain\Feeds;

use App\Domain\Feeds\Drivers\FeedDrivers;
use App\Domain\Feeds\Drivers\FeedException;
use App\Domain\Integrations\IntegrationAttention;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-9D P89D-26: a usable OAuth access token. Google tokens are refreshed 5 minutes before expiry under a per-row
 * lock (tenant cache key); Meta long-lived tokens are re-exchanged when < 10 days remain (integrations:health), else
 * `token_expiring` (7 d) → `token_expired`. Tokens stay in the encrypted `credentials`; nothing here logs them.
 */
final class FeedTokens
{
    public function __construct(private readonly FeedDrivers $drivers, private readonly TenantCache $cache) {}

    /** Returns the row with a fresh token (refreshing it when due). @throws FeedException */
    public function fresh(StoreIntegration $integration): StoreIntegration
    {
        if (($integration->secrets()['access_token'] ?? null) === null) {
            throw new FeedException(FeedException::AUTH, 'Not connected.');
        }
        $expires = $integration->token_expires_at;
        if ($expires !== null && $expires->isPast() && $integration->provider === IntegrationProvider::META_CATALOG) {
            $this->flag($integration, 'token_expired');

            throw new FeedException(FeedException::AUTH, 'The access expired.');
        }
        if ($integration->provider !== IntegrationProvider::GOOGLE_MERCHANT || ($expires !== null && $expires->isAfter(now()->addMinutes(5)))) {
            return $integration;
        }

        return Cache::lock($this->cache->key('feeds-token:'.$integration->id), 30)->block(20, function () use ($integration) {
            $row = StoreIntegration::query()->findOrFail($integration->id);
            if ($row->token_expires_at !== null && $row->token_expires_at->isAfter(now()->addMinutes(5))) {
                return $row; // refreshed by someone else meanwhile
            }
            try {
                $tokens = $this->drivers->for($row->provider)->refresh($row);
            } catch (FeedException $e) {
                if ($e->reason === FeedException::AUTH || $e->reason === FeedException::REJECTED) {
                    $this->flag($row, 'token_invalid');

                    throw new FeedException(FeedException::AUTH, 'The refresh token was refused.');
                }

                throw $e;
            }
            $this->store($row, $tokens);

            return $row->refresh();
        });
    }

    /** @param array{access_token: string, refresh_token: string|null, expires_at: int|null} $tokens */
    public function store(StoreIntegration $row, array $tokens): void
    {
        DB::transaction(function () use ($row, $tokens) {
            $locked = StoreIntegration::query()->whereKey($row->id)->lockForUpdate()->firstOrFail();
            $locked->credentials = array_filter([
                ...$locked->secrets(),
                'access_token' => $tokens['access_token'],
                'refresh_token' => $tokens['refresh_token'] ?? ($locked->secrets()['refresh_token'] ?? null),
            ], fn ($v) => $v !== null);
            $locked->token_expires_at = $tokens['expires_at'] !== null ? now()->setTimestamp($tokens['expires_at']) : null;
            $locked->save();
            IntegrationAttention::apply($locked, [], ['token_invalid', 'token_expired', 'token_expiring']);
        });
    }

    public function flag(StoreIntegration $row, string $reason): void
    {
        DB::transaction(function () use ($row, $reason) {
            $locked = StoreIntegration::query()->whereKey($row->id)->lockForUpdate()->first();
            if ($locked !== null && $locked->status !== StoreIntegration::DISCONNECTED) {
                IntegrationAttention::apply($locked, [$reason => null]);
            }
        });
    }
}

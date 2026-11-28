<?php

declare(strict_types=1);

namespace App\Domain\Sms\Routing;

use App\Domain\Sms\Drivers\RevesmsDriver;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsRoute;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\PlatformCache;
use Illuminate\Support\Facades\RateLimiter;

/**
 * PHASE-8-9B §4.3 — the `SmsGateway` binding (SMS_DRIVER=revesms). Per message:
 *  1. candidates = [primary, failover] carrying the route, minus providers whose breaker is open and cooling down;
 *     no database primary → [environment REVE] (+ a database failover); none → `no_route`;
 *  2. sender: promotional → the candidate's APPROVED promotional mask (else the candidate is skipped); shop → the shop's
 *     masked sender only on the primary (P89B-9), else the candidate's default; other routes → the default;
 *  3. `unavailable` / `auth` → record the failure and try the next candidate in the same call (not accepted);
 *     `timeout` → record (opens the breaker), NO second try (S225); `rejected` → throw, no breaker count;
 *  4. success → reset the count, return the result with `provider_id`.
 * Every send counts toward the carrying provider's per-minute rate (P89B-28); only the promotional route waits for it
 * (the broadcast batch checks `promotionalSlot()` first).
 */
final class RoutingSmsGateway implements SmsGateway
{
    public function __construct(
        private readonly SmsRoutingTable $table,
        private readonly SmsBreaker $breaker,
        private readonly SmsDriverFactory $factory,
    ) {}

    public function send(string $msisdn, string $text, ?string $senderId = null, SmsRoute $route = SmsRoute::Shop): SmsResult
    {
        $candidates = $this->table->candidates($route->value);
        $open = array_values(array_filter($candidates, fn (ProviderRoute $c) => ! $this->breaker->blocks($c->id)));
        // Every provider is cooling down: still try the first (better a probe than certain failure).
        $tries = $open !== [] ? $open : array_slice($candidates, 0, 1);

        $first = null;
        $last = null;
        foreach ($tries as $i => $candidate) {
            $sender = $this->senderFor($candidate, $route, $senderId);
            if ($sender === null) {
                continue; // promotional mask missing / pending on this provider
            }
            $started = microtime(true);
            try {
                $driver = $this->factory->driver($candidate->driver);
                $result = $driver->send($this->factory->connection($candidate), $msisdn, $text, $sender);
            } catch (SmsSendFailed $e) {
                $e = $e->withProvider($candidate->id);
                $this->breaker->recordFailure($candidate, $e, $tries[$i + 1] ?? null);
                $first ??= $e;
                $last = $e;
                if ($e->providerLevel()) {
                    continue; // certainly not accepted: next candidate
                }

                throw $e; // timeout (maybe accepted) or rejected: never sent again
            }
            $this->breaker->recordSuccess($candidate);
            $this->count($candidate);

            return $result->withRoute($candidate->id, (int) ((microtime(true) - $started) * 1000),
                $first?->errorCode(), $first?->detail);
        }

        throw $last ?? SmsSendFailed::noRoute();
    }

    public function status(string $messageId): array
    {
        $primary = $this->table->candidates(SmsRoute::Shop->value)[0] ?? null;
        if ($primary === null || $primary->driver !== 'revesms') {
            return [];
        }

        return app(RevesmsDriver::class)->status($this->factory->connection($primary), $messageId);
    }

    /** The caller ID for this candidate and route, or null when the candidate can't carry it. */
    public function senderFor(ProviderRoute $candidate, SmsRoute $route, ?string $shopSender): ?string
    {
        return match ($route) {
            SmsRoute::Promotional => $candidate->promotionalStatus === 'approved' && ($candidate->promotionalSender ?? '') !== ''
                ? $candidate->promotionalSender : null,
            SmsRoute::Shop => $candidate->role === SmsProvider::PRIMARY && $shopSender !== null ? $shopSender : $candidate->defaultSender,
            default => $candidate->defaultSender,
        };
    }

    /**
     * P89B-28: the provider that would carry promotional SMS now, and whether it has a free slot this minute.
     *
     * @return array{route: ProviderRoute|null, wait: int} wait = seconds until a slot frees (0 = send now)
     */
    public function promotionalSlot(): array
    {
        foreach ($this->table->candidates(SmsRoute::Promotional->value) as $c) {
            if ($this->breaker->blocks($c->id) || $this->senderFor($c, SmsRoute::Promotional, null) === null) {
                continue;
            }
            $key = self::rateKey($c->id);

            return ['route' => $c, 'wait' => RateLimiter::tooManyAttempts($key, max(1, $c->rateLimitPerMinute)) ? max(1, RateLimiter::availableIn($key)) : 0];
        }

        return ['route' => null, 'wait' => 0];
    }

    public static function rateKey(?string $providerId): string
    {
        return PlatformCache::key('sms:rate:'.($providerId ?? 'env'));
    }

    private function count(ProviderRoute $c): void
    {
        RateLimiter::hit(self::rateKey($c->id), 60);
    }
}

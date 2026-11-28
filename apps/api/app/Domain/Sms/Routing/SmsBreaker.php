<?php

declare(strict_types=1);

namespace App\Domain\Sms\Routing;

use App\Domain\Sms\Mail\PlatformSmsMail;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PlatformCache;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * PHASE-8-9B P89B-8 circuit breaker per provider (state in the platform cache `sms:breaker:{id}`). Opens after
 * `failover_after_failures` consecutive provider-level failures (`unavailable`, `auth`) or one `timeout`; while open the
 * provider is skipped. 5 minutes after the last failure it half-opens: the next message probes it, a success closes it.
 * Opening / closing are audited (system actor) and opening emails the super admins. `rejected` never counts.
 */
final class SmsBreaker
{
    public static function key(?string $providerId): string
    {
        return PlatformCache::key('sms:breaker:'.($providerId ?? 'env'));
    }

    /** @return array{failures: int, open: bool, last_failure_at: int|null, last_success_at: int|null, last_error: string|null} */
    public function state(?string $providerId): array
    {
        $s = Cache::get(self::key($providerId));

        return (is_array($s) ? $s : []) + ['failures' => 0, 'open' => false, 'last_failure_at' => null, 'last_success_at' => null, 'last_error' => null];
    }

    /** Open and still cooling down (skip it). An open breaker past the cooldown is half-open: allowed as a probe. */
    public function blocks(?string $providerId): bool
    {
        $s = $this->state($providerId);

        return $s['open'] && $s['last_failure_at'] !== null && (now()->getTimestamp() - $s['last_failure_at']) < $this->cooldown();
    }

    public function isOpen(?string $providerId): bool
    {
        return $this->state($providerId)['open'];
    }

    /** healthy | failing | failed_over | unknown (SmsProviderHealth). */
    public function health(?string $providerId): string
    {
        $s = $this->state($providerId);

        return match (true) {
            $s['open'] => 'failed_over',
            $s['failures'] > 0 => 'failing',
            $s['last_success_at'] !== null => 'healthy',
            default => 'unknown',
        };
    }

    public function recordFailure(ProviderRoute $route, SmsSendFailed $e, ?ProviderRoute $next = null): void
    {
        if ($e->reason === SmsSendFailed::REJECTED) {
            return;
        }
        $s = $this->state($route->id);
        $wasOpen = $s['open'];
        $s['failures']++;
        $s['last_failure_at'] = now()->getTimestamp();
        $s['last_error'] = $e->errorCode();
        if ($e->reason === SmsSendFailed::TIMEOUT || $s['failures'] >= max(1, $route->failAfter)) {
            $s['open'] = true;
        }
        Cache::forever(self::key($route->id), $s);
        if ($s['open'] && ! $wasOpen) {
            $this->opened($route, $e, $next);
        }
    }

    public function recordSuccess(ProviderRoute $route): void
    {
        $s = $this->state($route->id);
        $wasOpen = $s['open'];
        if (! $wasOpen && $s['failures'] === 0 && $s['last_success_at'] !== null && now()->getTimestamp() - $s['last_success_at'] < 60) {
            return; // nothing changed; keep the hot path cheap
        }
        Cache::forever(self::key($route->id), ['failures' => 0, 'open' => false, 'last_failure_at' => $s['last_failure_at'],
            'last_success_at' => now()->getTimestamp(), 'last_error' => null]);
        if ($wasOpen) {
            $this->audit('sms_provider.failover_ended', $route, []);
        }
    }

    /** Rotation / activation / removal: a fresh start. */
    public function reset(?string $providerId): void
    {
        Cache::forget(self::key($providerId));
    }

    private function opened(ProviderRoute $route, SmsSendFailed $e, ?ProviderRoute $next): void
    {
        $this->audit('sms_provider.failover_started', $route, ['error_code' => $e->errorCode(), 'failover_id' => $next?->id]);
        try {
            PlatformSmsMail::toSuperAdmins(PlatformSmsMail::FAILOVER_STARTED, [
                'provider' => $route->name, 'error_code' => $e->errorCode(), 'failover' => $next?->name,
            ]);
        } catch (Throwable $mail) {
            Log::warning('platform_sms.failover_mail_failed', ['provider_id' => $route->id, 'error' => $mail::class]);
        }
    }

    /** @param array<string, mixed> $meta */
    private function audit(string $action, ProviderRoute $route, array $meta): void
    {
        try {
            $subject = $route->id !== null ? (new SmsProvider)->forceFill(['id' => $route->id]) : null;
            app(AuditLogger::class)->log($action, $subject, $meta + ['provider' => $route->name], tenantId: false, system: true);
        } catch (Throwable $t) {
            Log::warning('platform_sms.breaker_audit_failed', ['action' => $action, 'error' => $t::class]);
        }
    }

    private function cooldown(): int
    {
        return (int) config('sms.platform.breaker_cooldown_seconds', 300);
    }
}

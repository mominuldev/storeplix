<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.8d POS limiters (PHASE-8-8D §10), per user (and tenant): `pos-write` 120/min on every POS write,
 * `pos-lookup` 30/min on the customer phone lookup (S203), `pos-sms` 10/min on the SMS receipt (S204).
 * Registered from AppServiceProvider.
 */
final class PosServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $by = fn (string $name, Request $r) => $name.':'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'));

        RateLimiter::for('pos-write', fn (Request $r) => Limit::perMinute(120)->by($by('pos-write', $r)));
        RateLimiter::for('pos-lookup', fn (Request $r) => Limit::perMinute(30)->by($by('pos-lookup', $r)));
        RateLimiter::for('pos-sms', fn (Request $r) => Limit::perMinute(10)->by($by('pos-sms', $r)));
    }
}

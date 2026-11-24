<?php

declare(strict_types=1);

namespace App\Domain\Inventory;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.8c locations / stock writes: the `stock-write` limiter (PHASE-8-8C §9) — 120/min per user (and tenant).
 * Registered from AppServiceProvider.
 */
final class InventoryServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        RateLimiter::for('stock-write', fn (Request $r) => Limit::perMinute(120)
            ->by('stock-write:'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'))));
    }
}

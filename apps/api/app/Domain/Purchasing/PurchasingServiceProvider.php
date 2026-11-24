<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.8b purchasing: the limiters (PHASE-8-8B §8.4) — `purchasing-write` 60/min and `purchase-invoices` 20/min per
 * user (and tenant). No scheduler, no queue (§9). Registered from AppServiceProvider.
 */
final class PurchasingServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $by = fn (string $name, Request $r) => $name.':'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'));
        RateLimiter::for('purchasing-write', fn (Request $r) => Limit::perMinute(60)->by($by('purchasing-write', $r)));
        RateLimiter::for('purchase-invoices', fn (Request $r) => Limit::perMinute(20)->by($by('purchase-invoices', $r)));
    }
}

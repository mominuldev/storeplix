<?php

/*
 * PHASE-8-2 §6.1 (owner API): platform analytics. Included from routes/api.php inside the `v1` prefix. Stack: see
 * routes/admin.php. Platform-wide pages need `view_analytics`; one shop's metrics stay under `view_merchants` (P82-18).
 */

use App\Domain\Admin\Analytics\Http\AnalyticsController;
use App\Domain\Admin\Analytics\Http\DevAnalyticsController;
use Illuminate\Support\Facades\Route;

Route::prefix('admin')->middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin'])->group(function (): void {
    Route::middleware('platform.can:view_analytics')->group(function (): void {
        Route::get('analytics/overview', [AnalyticsController::class, 'overview'])->name('admin.analytics.overview');
        Route::get('analytics/revenue', [AnalyticsController::class, 'revenue'])->name('admin.analytics.revenue');
    });
    Route::get('tenants/{tenant}/metrics', [AnalyticsController::class, 'tenant'])
        ->middleware('platform.can:view_merchants')->name('admin.tenants.metrics');
});

// §4.3 TESTING-ONLY: never registered outside APP_ENV local/testing (S90); super-admin admin-surface session.
if (app()->environment(['local', 'testing'])) {
    Route::post('dev/analytics/aggregate', DevAnalyticsController::class)
        ->middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:10,1,dev.analytics'])
        ->name('dev.analytics.aggregate');
}

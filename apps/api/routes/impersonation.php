<?php

/*
 * PHASE-8-1 P8-9 – P8-11 (owner API-3): POST/DELETE /api/v1/auth/impersonation (merchant origin) and
 * /api/v1/admin/tenants/{tenant}/impersonations, /admin/impersonations[/{impersonation}/revoke].
 * Included from routes/api.php inside the `v1` prefix.
 */

use App\Domain\Admin\Impersonation\Http\Controllers\AdminImpersonationController;
use App\Domain\Admin\Impersonation\Http\Controllers\ImpersonationSessionController;
use Illuminate\Support\Facades\Route;

Route::prefix('admin')->middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin'])->group(function (): void {
    Route::post('tenants/{tenant}/impersonations', [AdminImpersonationController::class, 'store'])
        ->middleware(['throttle:admin-write', 'platform.can:impersonate'])->name('admin.impersonations.store');
    Route::get('impersonations', [AdminImpersonationController::class, 'index'])
        ->middleware('platform.can:view_merchants')->name('admin.impersonations.index');
    Route::post('impersonations/{impersonation}/revoke', [AdminImpersonationController::class, 'revoke'])
        ->middleware(['throttle:admin-write', 'platform.can:suspend'])->name('admin.impersonations.revoke');
});

// Merchant origin. Consume: guest or any session (it replaces the session), SPA-only (CSRF), ADMIN_IP_ALLOWLIST,
// 10/min per IP (in the controller: keyed by IP, not by the session user). End: the impersonation session itself (ReadOnlyImpersonation lets this DELETE through).
Route::post('auth/impersonation', [ImpersonationSessionController::class, 'store'])
    ->middleware(['stateful', 'platform.ip'])->name('auth.impersonation.store');
Route::delete('auth/impersonation', [ImpersonationSessionController::class, 'destroy'])
    ->middleware(['auth:sanctum', 'stateful'])->name('auth.impersonation.destroy');

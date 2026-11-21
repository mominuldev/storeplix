<?php

use App\Domain\Identity\Http\Controllers\AuthController;
use App\Domain\Shared\Http\HealthController;
use App\Domain\Stores\Http\Controllers\PreviewTokenController;
use App\Domain\Stores\Http\Controllers\StoreController;
use App\Domain\Stores\Http\Controllers\StorefrontConfigController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function (): void {
    Route::get('health', HealthController::class)->name('health');

    // --- Merchant auth (Sanctum personal access tokens) ---
    Route::prefix('auth')->group(function (): void {
        Route::middleware('throttle:auth')->group(function (): void {
            Route::post('register', [AuthController::class, 'register'])->name('auth.register');
            Route::post('login', [AuthController::class, 'login'])->name('auth.login');
            Route::post('forgot-password', [AuthController::class, 'forgotPassword'])->name('auth.forgot-password');
        });

        Route::middleware('auth:sanctum')->group(function (): void {
            Route::post('logout', [AuthController::class, 'logout'])->name('auth.logout');
            Route::get('me', [AuthController::class, 'me'])->name('auth.me');
        });
    });

    // --- Merchant APIs: authenticated + tenant context from X-Tenant-Id ---
    Route::middleware(['auth:sanctum', 'tenant'])->group(function (): void {
        Route::get('stores', [StoreController::class, 'index'])->name('stores.index');
        Route::post('stores', [StoreController::class, 'store'])->name('stores.store');
        Route::get('stores/{store}', [StoreController::class, 'show'])->name('stores.show');
        Route::post('stores/{store}/preview-token', PreviewTokenController::class)
            ->middleware('throttle:30,1')
            ->name('stores.preview-token');
    });

    // --- Public storefront API (server-to-server; tenant from validated X-Storefront-Host) ---
    Route::prefix('storefront')->middleware(['storefront', 'throttle:storefront'])->group(function (): void {
        Route::get('config', StorefrontConfigController::class)->name('storefront.config');
    });
});

<?php

declare(strict_types=1);

// Phase 8.8a (PHASE-8-8-CONTRACT §8.1): owned by API. Required from routes/api.php inside the `v1` prefix (NOT inside
// the merchant group): this file declares its own merchant and storefront groups.

use App\Domain\FraudGuard\Http\Controllers\BlockedNumberController;
use App\Domain\FraudGuard\Http\Controllers\FraudGuardController;
use App\Domain\FraudGuard\Http\Controllers\OrderGuardController;
use App\Domain\FraudGuard\Http\Controllers\StorefrontCheckoutOtpController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404); perm:fraud.manage on the guard routes (P88-14),
// orders.process on the release. Plan (`fake_order_guard`) on settings writes, block and check (402, P88-15).
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}')->group(function (): void {
        $m = 'perm:fraud.manage';

        Route::get('fraud-guard/settings', [FraudGuardController::class, 'show'])->middleware($m)->name('stores.fraud-guard.settings.show');
        Route::patch('fraud-guard/settings', [FraudGuardController::class, 'update'])->middleware($m)->name('stores.fraud-guard.settings.update');
        Route::post('fraud-guard/settings/reset', [FraudGuardController::class, 'reset'])->middleware($m)->name('stores.fraud-guard.settings.reset');
        Route::get('fraud-guard/overview', [FraudGuardController::class, 'overview'])->middleware($m)->name('stores.fraud-guard.overview');
        Route::get('fraud-guard/events', [FraudGuardController::class, 'events'])->middleware($m)->name('stores.fraud-guard.events');
        Route::post('fraud-guard/check', [FraudGuardController::class, 'check'])->middleware('throttle:fraud-check')->middleware($m)->name('stores.fraud-guard.check');

        Route::get('fraud-guard/blocked-numbers', [BlockedNumberController::class, 'index'])->middleware($m)->name('stores.fraud-guard.blocked-numbers.index');
        Route::post('fraud-guard/blocked-numbers', [BlockedNumberController::class, 'store'])->middleware($m)->name('stores.fraud-guard.blocked-numbers.store');
        Route::delete('fraud-guard/blocked-numbers/{entry}', [BlockedNumberController::class, 'destroy'])->where('entry', '[0-9A-Za-z]{26}')->middleware($m)->name('stores.fraud-guard.blocked-numbers.destroy');

        Route::post('orders/{order}/guard/release', [OrderGuardController::class, 'release'])->where('order', '[0-9A-Za-z]{26}')->middleware('perm:orders.process')->name('stores.orders.guard.release');
    });

// §7 storefront checkout code (tenant from X-Storefront-Host + X-Storefront-Key).
Route::prefix('storefront')->middleware(['storefront', 'throttle:storefront'])->group(function (): void {
    Route::post('checkout/otp', [StorefrontCheckoutOtpController::class, 'send'])->middleware('throttle:checkout-otp')->name('storefront.checkout.otp');
});

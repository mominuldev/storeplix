<?php

declare(strict_types=1);

// Phase 8.6 (PHASE-8-6-CONTRACT §9.1, §7): owned by API. Required from routes/api.php inside the `v1` prefix (NOT
// inside the merchant group): this file declares its own merchant and storefront groups.

use App\Domain\Automations\Http\Controllers\AutomationController;
use App\Domain\Automations\Http\Controllers\AutomationRunController;
use App\Domain\Cart\Http\StorefrontCartRecoveryController;
use Illuminate\Support\Facades\Route;

// §9.1 merchant routes: auth:sanctum + surface + tenant (+ {store} of the tenant, else 404); perm:marketing.manage.
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}')->group(function (): void {
        $id = ['automation' => '[0-9A-Za-z]{26}'];
        $m = 'perm:marketing.manage';

        Route::get('automations', [AutomationController::class, 'index'])->middleware($m)->name('stores.automations.index');
        Route::post('automations', [AutomationController::class, 'store'])->middleware('throttle:60,1,stores.automations.store')->middleware($m)->name('stores.automations.store');
        Route::get('automations/{automation}', [AutomationController::class, 'show'])->where($id)->middleware($m)->name('stores.automations.show');
        Route::patch('automations/{automation}', [AutomationController::class, 'update'])->where($id)->middleware($m)->name('stores.automations.update');
        Route::delete('automations/{automation}', [AutomationController::class, 'destroy'])->where($id)->middleware($m)->name('stores.automations.destroy');
        Route::post('automations/{automation}/enable', [AutomationController::class, 'enable'])->where($id)->middleware($m)->name('stores.automations.enable');
        Route::post('automations/{automation}/disable', [AutomationController::class, 'disable'])->where($id)->middleware($m)->name('stores.automations.disable');
        Route::post('automations/{automation}/dry-run', [AutomationController::class, 'dryRun'])->where($id)
            ->middleware('throttle:automations-dry-run')->middleware($m)->name('stores.automations.dry-run');
        Route::post('automations/{automation}/test-message', [AutomationController::class, 'testMessage'])->where($id)->middleware($m)->name('stores.automations.test-message');
        Route::get('automations/{automation}/stats', [AutomationController::class, 'stats'])->where($id)->middleware($m)->name('stores.automations.stats');

        Route::get('automation-runs', [AutomationRunController::class, 'index'])->middleware($m)->name('stores.automation-runs.index');
        Route::get('automation-runs/{run}', [AutomationRunController::class, 'show'])->where('run', '[0-9A-Za-z]{26}')->middleware($m)->name('stores.automation-runs.show');
    });

// §7 storefront checkout recovery (tenant from X-Storefront-Host + X-Storefront-Key; limiters per shopper IP).
Route::prefix('storefront')->middleware(['storefront', 'throttle:storefront'])->group(function (): void {
    Route::put('cart/contact', [StorefrontCartRecoveryController::class, 'contact'])->middleware('throttle:storefront-cart-contact')->name('storefront.cart.contact.update');
    Route::post('carts/recover', [StorefrontCartRecoveryController::class, 'recover'])->middleware('throttle:storefront-cart-recover')->name('storefront.carts.recover');
});

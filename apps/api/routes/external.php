<?php

declare(strict_types=1);

// Phase 8.4 (PHASE-8-4-CONTRACT §11): owned by API-KEYS.
// Required from routes/api.php (inside the /api/v1 group, outside the merchant group).

use App\Domain\Developer\External\Http\Controllers\ExternalCatalogController;
use App\Domain\Developer\External\Http\Controllers\ExternalCustomerController;
use App\Domain\Developer\External\Http\Controllers\ExternalInventoryController;
use App\Domain\Developer\External\Http\Controllers\ExternalMeController;
use App\Domain\Developer\External\Http\Controllers\ExternalOrderController;
use Illuminate\Support\Facades\Route;

// PHASE-8-4 §3 (P84-4): API-key authentication only (no auth:sanctum, no tenant header); every route declares exactly
// one `scope:` (S103). `apikey` runs before the throttle and route-model binding; `scope:` after binding (foreign → 404).
Route::prefix('external')->middleware(['apikey', 'throttle:external-api'])->group(function (): void {
    Route::get('me', ExternalMeController::class)->middleware('scope:any')->name('external.me');

    Route::prefix('stores/{store}')->scopeBindings()->group(function (): void {
        Route::get('orders', [ExternalOrderController::class, 'index'])->middleware('scope:orders:read')->name('external.orders.index');
        Route::get('orders/{order}', [ExternalOrderController::class, 'show'])->middleware('scope:orders:read')->name('external.orders.show');
        Route::post('orders/{order}/status', [ExternalOrderController::class, 'status'])
            ->middleware(['scope:orders:write', 'idempotent:external.orders.status'])->name('external.orders.status');

        Route::get('products', [ExternalCatalogController::class, 'products'])->middleware('scope:products:read')->name('external.products.index');
        Route::post('products', [ExternalCatalogController::class, 'storeProduct'])->middleware('scope:products:write')->name('external.products.store');
        Route::get('products/{product}', [ExternalCatalogController::class, 'product'])->middleware('scope:products:read')->name('external.products.show');
        Route::patch('products/{product}', [ExternalCatalogController::class, 'updateProduct'])->middleware('scope:products:write')->name('external.products.update');
        Route::get('categories', [ExternalCatalogController::class, 'categories'])->middleware('scope:products:read')->name('external.categories.index');

        Route::get('inventory', [ExternalInventoryController::class, 'index'])->middleware('scope:inventory:read')->name('external.inventory.index');
        Route::post('inventory/adjustments', [ExternalInventoryController::class, 'adjust'])
            ->middleware(['scope:inventory:write', 'idempotent:external.inventory.adjust'])->name('external.inventory.adjust');

        Route::get('customers', [ExternalCustomerController::class, 'index'])->middleware('scope:customers:read')->name('external.customers.index');
        Route::get('customers/{customer}', [ExternalCustomerController::class, 'show'])->middleware('scope:customers:read')->name('external.customers.show');
    });
});

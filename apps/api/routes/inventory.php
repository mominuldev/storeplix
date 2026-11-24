<?php

declare(strict_types=1);

// Phase 8.8c part A (PHASE-8-8C-CONTRACT §4, §9): owned by API. Required from routes/api.php inside the `v1` prefix
// (NOT inside the merchant group): this file declares its own merchant group. The inventory list / movements /
// adjust / threshold routes stay in api.php (they only gained `location_id`).

use App\Domain\Inventory\Http\Controllers\LocationController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404). Reads perm:base; writes perm:settings.manage
// (P88C-14) and the `stock-write` limiter (120/min per user). Plan `multi_warehouse` for a 2nd+ active location
// (create / unarchive, 402).
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}')->group(function (): void {
        $w = 'throttle:stock-write';
        $m = 'perm:settings.manage';
        $loc = ['location' => '[0-9A-Za-z]{26}'];

        Route::get('locations', [LocationController::class, 'index'])->middleware('perm:base')->name('stores.locations.index');
        Route::post('locations', [LocationController::class, 'store'])->middleware($w)->middleware($m)->name('stores.locations.store');
        Route::patch('locations/{location}', [LocationController::class, 'update'])->where($loc)->middleware($w)->middleware($m)->name('stores.locations.update');
        Route::post('locations/{location}/archive', [LocationController::class, 'archive'])->where($loc)->middleware($w)->middleware($m)->name('stores.locations.archive');
        Route::post('locations/{location}/unarchive', [LocationController::class, 'unarchive'])->where($loc)->middleware($w)->middleware($m)->name('stores.locations.unarchive');
        Route::post('locations/{location}/make-default', [LocationController::class, 'makeDefault'])->where($loc)->middleware($w)->middleware($m)->name('stores.locations.make-default');
    });

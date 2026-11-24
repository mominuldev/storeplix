<?php

declare(strict_types=1);

// Phase 8.8c parts A + B (PHASE-8-8C-CONTRACT §4, §7–§9): owned by API. Required from routes/api.php inside the `v1` prefix
// (NOT inside the merchant group): this file declares its own merchant group. The inventory list / movements /
// adjust / threshold routes stay in api.php (they only gained `location_id`).

use App\Domain\Inventory\Counts\Http\StockCountController;
use App\Domain\Inventory\Http\Controllers\LocationController;
use App\Domain\Inventory\Transfers\Http\IdempotentWhenKeyed;
use App\Domain\Inventory\Transfers\Http\StockTransferController;
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

        // Part B (§7–§9): transfers and counts. Reads perm:base; writes perm:inventory.adjust (P88C-14) + `stock-write`.
        // Plan `multi_warehouse` on transfer create / update / send (Form Requests, 402). Idempotency-Key required on
        // send, receive and count finish; optional on create (honoured when sent).
        $a = 'perm:inventory.adjust';
        $tr = ['transfer' => '[0-9A-Za-z]{26}'];
        $ct = ['count' => '[0-9A-Za-z]{26}'];
        Route::get('stock-transfers/summary', [StockTransferController::class, 'summary'])->middleware('perm:base')->name('stores.stock-transfers.summary');
        Route::get('stock-transfers', [StockTransferController::class, 'index'])->middleware('perm:base')->name('stores.stock-transfers.index');
        Route::post('stock-transfers', [StockTransferController::class, 'store'])
            ->middleware([$w, IdempotentWhenKeyed::class.':stock-transfers.create'])->middleware($a)->name('stores.stock-transfers.store');
        Route::get('stock-transfers/{transfer}', [StockTransferController::class, 'show'])->where($tr)->middleware('perm:base')->name('stores.stock-transfers.show');
        Route::patch('stock-transfers/{transfer}', [StockTransferController::class, 'update'])->where($tr)->middleware($w)->middleware($a)->name('stores.stock-transfers.update');
        Route::delete('stock-transfers/{transfer}', [StockTransferController::class, 'destroy'])->where($tr)->middleware($w)->middleware($a)->name('stores.stock-transfers.destroy');
        Route::post('stock-transfers/{transfer}/send', [StockTransferController::class, 'send'])->where($tr)
            ->middleware([$w, 'idempotent:stock-transfers.send'])->middleware($a)->name('stores.stock-transfers.send');
        Route::post('stock-transfers/{transfer}/receive', [StockTransferController::class, 'receive'])->where($tr)
            ->middleware([$w, 'idempotent:stock-transfers.receive'])->middleware($a)->name('stores.stock-transfers.receive');
        Route::post('stock-transfers/{transfer}/cancel', [StockTransferController::class, 'cancel'])->where($tr)->middleware($w)->middleware($a)->name('stores.stock-transfers.cancel');

        Route::get('stock-counts', [StockCountController::class, 'index'])->middleware('perm:base')->name('stores.stock-counts.index');
        Route::post('stock-counts', [StockCountController::class, 'store'])->middleware($w)->middleware($a)->name('stores.stock-counts.store');
        Route::get('stock-counts/{count}', [StockCountController::class, 'show'])->where($ct)->middleware('perm:base')->name('stores.stock-counts.show');
        Route::get('stock-counts/{count}/lines', [StockCountController::class, 'lines'])->where($ct)->middleware('perm:base')->name('stores.stock-counts.lines.index');
        Route::put('stock-counts/{count}/lines/{line}', [StockCountController::class, 'setLine'])->where($ct + ['line' => '[0-9A-Za-z]{26}'])
            ->middleware($w)->middleware($a)->name('stores.stock-counts.lines.update');
        Route::post('stock-counts/{count}/scan', [StockCountController::class, 'scan'])->where($ct)->middleware($w)->middleware($a)->name('stores.stock-counts.scan');
        Route::post('stock-counts/{count}/finish', [StockCountController::class, 'finish'])->where($ct)
            ->middleware([$w, 'idempotent:stock-counts.finish'])->middleware($a)->name('stores.stock-counts.finish');
        Route::post('stock-counts/{count}/cancel', [StockCountController::class, 'cancel'])->where($ct)->middleware($w)->middleware($a)->name('stores.stock-counts.cancel');
    });

<?php

declare(strict_types=1);

// Phase 8.7 (PHASE-8-7-CONTRACT §8.1): owned by API. Required from routes/api.php inside the `v1` prefix (NOT inside the
// merchant group): this file declares its own merchant group. The public signed receipt download stays in api.php.

use App\Domain\Expenses\Http\Controllers\ExpenseController;
use App\Domain\Expenses\Http\Controllers\ExpenseReceiptController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404); perm:expenses.manage on every route; no plan gate (P87-6).
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}')->group(function (): void {
        $id = ['expense' => '[0-9A-Za-z]{26}'];
        $m = 'perm:expenses.manage';

        // Fixed paths before /expenses/{expense} (§8.1).
        Route::get('expenses/summary', [ExpenseController::class, 'summary'])->middleware($m)->name('stores.expenses.summary');
        Route::get('expenses/export', [ExpenseController::class, 'export'])->middleware($m)->name('stores.expenses.export');
        Route::post('expenses/receipts', [ExpenseReceiptController::class, 'store'])->middleware('throttle:expense-receipts')->middleware($m)->name('stores.expenses.receipts.store');

        Route::get('expenses', [ExpenseController::class, 'index'])->middleware($m)->name('stores.expenses.index');
        Route::post('expenses', [ExpenseController::class, 'store'])->middleware('throttle:expenses-write')->middleware($m)->name('stores.expenses.store');
        Route::get('expenses/{expense}', [ExpenseController::class, 'show'])->where($id)->middleware($m)->name('stores.expenses.show');
        Route::patch('expenses/{expense}', [ExpenseController::class, 'update'])->where($id)->middleware('throttle:expenses-write')->middleware($m)->name('stores.expenses.update');
        Route::delete('expenses/{expense}', [ExpenseController::class, 'destroy'])->where($id)->middleware('throttle:expenses-write')->middleware($m)->name('stores.expenses.destroy');
        Route::get('expenses/{expense}/receipt', [ExpenseReceiptController::class, 'link'])->where($id)->middleware($m)->name('stores.expenses.receipt');
    });

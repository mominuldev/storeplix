<?php

declare(strict_types=1);

// Phase 8.8b (PHASE-8-8B-CONTRACT §8.1): owned by API. Required from routes/api.php inside the `v1` prefix (NOT inside
// the merchant group): this file declares its own merchant group. The public signed invoice download stays in api.php.

use App\Domain\Purchasing\Http\Controllers\PurchaseOrderController;
use App\Domain\Purchasing\Http\Controllers\PurchasingController;
use App\Domain\Purchasing\Http\Controllers\SupplierController;
use App\Domain\Purchasing\Http\Controllers\SupplierPaymentController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404). perm:purchasing.manage, except PO list/detail,
// receipts and invoice upload (purchasing.manage OR inventory.adjust, P88B-11). Plan `purchasing` on every write
// (402 in the Form Request, before validation). Writes limited by `purchasing-write` (60/min per user).
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}')->group(function (): void {
        $m = 'perm:purchasing.manage';
        $recv = 'perm:purchasing.manage|inventory.adjust';
        $w = 'throttle:purchasing-write';
        $sup = ['supplier' => '[0-9A-Za-z]{26}'];
        $po = ['purchase_order' => '[0-9A-Za-z]{26}'];

        // Suppliers (§4, §6.1). Fixed paths before /suppliers/{supplier}.
        Route::get('suppliers/summary', [SupplierController::class, 'summary'])->middleware($m)->name('stores.suppliers.summary');
        Route::get('suppliers', [SupplierController::class, 'index'])->middleware($m)->name('stores.suppliers.index');
        Route::post('suppliers', [SupplierController::class, 'store'])->middleware($w)->middleware($m)->name('stores.suppliers.store');
        Route::get('suppliers/{supplier}', [SupplierController::class, 'show'])->where($sup)->middleware($m)->name('stores.suppliers.show');
        Route::patch('suppliers/{supplier}', [SupplierController::class, 'update'])->where($sup)->middleware($w)->middleware($m)->name('stores.suppliers.update');
        Route::delete('suppliers/{supplier}', [SupplierController::class, 'destroy'])->where($sup)->middleware($w)->middleware($m)->name('stores.suppliers.destroy');
        Route::post('suppliers/{supplier}/archive', [SupplierController::class, 'archive'])->where($sup)->middleware($w)->middleware($m)->name('stores.suppliers.archive');
        Route::post('suppliers/{supplier}/unarchive', [SupplierController::class, 'unarchive'])->where($sup)->middleware($w)->middleware($m)->name('stores.suppliers.unarchive');
        Route::get('suppliers/{supplier}/payments', [SupplierController::class, 'payments'])->where($sup)->middleware($m)->name('stores.suppliers.payments.index');
        Route::post('suppliers/{supplier}/payments', [SupplierController::class, 'recordPayment'])->where($sup)->middleware($w)->middleware($m)->name('stores.suppliers.payments.store');
        Route::delete('supplier-payments/{payment}', [SupplierPaymentController::class, 'destroy'])->where('payment', '[0-9A-Za-z]{26}')->middleware($w)->middleware($m)->name('stores.supplier-payments.destroy');

        // Purchase orders (§5, §6.2). Fixed paths before /purchase-orders/{purchase_order}.
        Route::get('purchase-orders/summary', [PurchaseOrderController::class, 'summary'])->middleware($m)->name('stores.purchase-orders.summary');
        Route::post('purchase-orders/quick', [PurchaseOrderController::class, 'quick'])
            ->middleware([$w, 'idempotent:purchase-orders.quick'])->middleware($m)->name('stores.purchase-orders.quick');
        Route::get('purchase-orders', [PurchaseOrderController::class, 'index'])->middleware($recv)->name('stores.purchase-orders.index');
        Route::post('purchase-orders', [PurchaseOrderController::class, 'store'])->middleware($w)->middleware($m)->name('stores.purchase-orders.store');
        Route::get('purchase-orders/{purchase_order}', [PurchaseOrderController::class, 'show'])->where($po)->middleware($recv)->name('stores.purchase-orders.show');
        Route::patch('purchase-orders/{purchase_order}', [PurchaseOrderController::class, 'update'])->where($po)->middleware($w)->middleware($m)->name('stores.purchase-orders.update');
        Route::delete('purchase-orders/{purchase_order}', [PurchaseOrderController::class, 'destroy'])->where($po)->middleware($w)->middleware($m)->name('stores.purchase-orders.destroy');
        Route::post('purchase-orders/{purchase_order}/send', [PurchaseOrderController::class, 'send'])->where($po)->middleware($w)->middleware($m)->name('stores.purchase-orders.send');
        Route::post('purchase-orders/{purchase_order}/mark-ordered', [PurchaseOrderController::class, 'markOrdered'])->where($po)->middleware($w)->middleware($m)->name('stores.purchase-orders.mark-ordered');
        Route::post('purchase-orders/{purchase_order}/close', [PurchaseOrderController::class, 'close'])->where($po)->middleware($w)->middleware($m)->name('stores.purchase-orders.close');
        Route::post('purchase-orders/{purchase_order}/cancel', [PurchaseOrderController::class, 'cancel'])->where($po)->middleware($w)->middleware($m)->name('stores.purchase-orders.cancel');
        Route::post('purchase-orders/{purchase_order}/receipts', [PurchaseOrderController::class, 'receive'])->where($po)
            ->middleware([$w, 'idempotent:purchase-orders.receive'])->middleware($recv)->name('stores.purchase-orders.receipts.store');
        Route::get('purchase-orders/{purchase_order}/pdf', [PurchaseOrderController::class, 'pdf'])->where($po)->middleware($m)->name('stores.purchase-orders.pdf');

        // Helpers (§7, §8.1).
        Route::get('purchasing/reorder-suggestions', [PurchasingController::class, 'reorderSuggestions'])->middleware($m)->name('stores.purchasing.reorder-suggestions');
        Route::post('purchasing/invoices', [PurchasingController::class, 'uploadInvoice'])->middleware('throttle:purchase-invoices')->middleware($recv)->name('stores.purchasing.invoices.store');
    });

<?php

declare(strict_types=1);

// Phase 8.8d part A (PHASE-8-8D-CONTRACT §4, §5, §7, §10): owned by API. Required from routes/api.php inside the `v1`
// prefix (NOT inside the merchant group): this file declares its own merchant group. Part B (§9): sales history,
// returns at the till and held sales.

use App\Domain\Pos\Http\Controllers\PosHeldSaleController;
use App\Domain\Pos\Http\Controllers\PosRegisterController;
use App\Domain\Pos\Http\Controllers\PosSaleController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404). Every route perm:pos.sell except register writes
// (perm:settings.manage, P88D-18). Plan `pos` on register create / unarchive, open, quote, sale and SMS (402, P88D-19);
// close and register edit / archive work after a downgrade. Writes: `pos-write` (120/min per user); customer lookup
// `pos-lookup` (30/min); SMS receipt `pos-sms` (10/min). Idempotency-Key required on open, close and sale (S200).
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}/pos')->group(function (): void {
        $w = 'throttle:pos-write';
        $sell = 'perm:pos.sell';
        $m = 'perm:settings.manage';
        $reg = ['register' => '[0-9A-Za-z]{26}'];
        $ses = ['session' => '[0-9A-Za-z]{26}'];
        $sale = ['sale' => '[0-9A-Za-z]{26}'];

        // Registers and sessions (§4).
        Route::get('registers', [PosRegisterController::class, 'index'])->middleware($sell)->name('stores.pos.registers.index');
        Route::post('registers', [PosRegisterController::class, 'store'])->middleware($w)->middleware($m)->name('stores.pos.registers.store');
        Route::patch('registers/{register}', [PosRegisterController::class, 'update'])->where($reg)->middleware($w)->middleware($m)->name('stores.pos.registers.update');
        Route::post('registers/{register}/archive', [PosRegisterController::class, 'archive'])->where($reg)->middleware($w)->middleware($m)->name('stores.pos.registers.archive');
        Route::post('registers/{register}/unarchive', [PosRegisterController::class, 'unarchive'])->where($reg)->middleware($w)->middleware($m)->name('stores.pos.registers.unarchive');
        Route::post('registers/{register}/open', [PosRegisterController::class, 'open'])->where($reg)
            ->middleware([$w, 'idempotent:pos.open'])->middleware($sell)->name('stores.pos.registers.open');
        Route::get('sessions/{session}', [PosRegisterController::class, 'session'])->where($ses)->middleware($sell)->name('stores.pos.sessions.show');
        Route::post('sessions/{session}/close', [PosRegisterController::class, 'close'])->where($ses)
            ->middleware([$w, 'idempotent:pos.close'])->middleware($sell)->name('stores.pos.sessions.close');

        // Catalog, scan, customer, quote, sale, receipt (§5, §7).
        Route::get('catalog', [PosSaleController::class, 'catalog'])->middleware($sell)->name('stores.pos.catalog');
        Route::get('lookup', [PosSaleController::class, 'lookup'])->middleware($sell)->name('stores.pos.lookup');
        Route::get('customers/lookup', [PosSaleController::class, 'customer'])->middleware('throttle:pos-lookup')->middleware($sell)->name('stores.pos.customers.lookup');
        Route::post('quote', [PosSaleController::class, 'quote'])->middleware($sell)->name('stores.pos.quote');
        Route::post('sales', [PosSaleController::class, 'store'])->middleware([$w, 'idempotent:pos.sale'])->middleware($sell)->name('stores.pos.sales.store');
        Route::get('sales', [PosSaleController::class, 'index'])->middleware($sell)->name('stores.pos.sales.index');
        Route::get('sales/{sale}', [PosSaleController::class, 'show'])->where($sale)->middleware($sell)->name('stores.pos.sales.show');
        Route::post('sales/{sale}/sms-receipt', [PosSaleController::class, 'smsReceipt'])->where($sale)
            ->middleware([$w, 'throttle:pos-sms'])->middleware($sell)->name('stores.pos.sales.sms-receipt');

        // Part B (§9): returns at the till (pos.sell here + orders.refund in the Form Request), held sales.
        $held = ['held' => '[0-9A-Za-z]{26}'];
        Route::post('sales/{sale}/returns', [PosSaleController::class, 'returnItems'])->where($sale)
            ->middleware([$w, 'idempotent:pos.return'])->middleware($sell)->name('stores.pos.sales.returns.store');
        Route::get('held-sales', [PosHeldSaleController::class, 'index'])->middleware($sell)->name('stores.pos.held-sales.index');
        Route::post('held-sales', [PosHeldSaleController::class, 'store'])->middleware($w)->middleware($sell)->name('stores.pos.held-sales.store');
        Route::get('held-sales/{held}', [PosHeldSaleController::class, 'show'])->where($held)->middleware($sell)->name('stores.pos.held-sales.show');
        Route::delete('held-sales/{held}', [PosHeldSaleController::class, 'destroy'])->where($held)->middleware($w)->middleware($sell)->name('stores.pos.held-sales.destroy');
    });

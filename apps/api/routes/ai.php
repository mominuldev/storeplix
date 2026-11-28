<?php

declare(strict_types=1);

// Phase 8.9d part B (PHASE-8-9D-CONTRACT §10, §11, §13.1): owned by API. Required from routes/api.php inside the `v1`
// prefix (NOT inside the merchant group): this file declares its own merchant, admin and signed-download groups.

use App\Domain\Ai\Http\Controllers\AdminAiCreditController;
use App\Domain\Ai\Http\Controllers\AiCreditController;
use App\Domain\Ai\Http\Controllers\AiGenerationController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404). P89D-41: AI generate / apply / undo / history
// `products.edit`; impersonation → every write 403 impersonation_read_only (ResolveTenant, P89D-42).
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])->group(function (): void {
    $g = ['generation' => '[0-9A-Za-z]{26}'];

    Route::prefix('stores/{store}/ai')->middleware('perm:products.edit')->group(function () use ($g): void {
        Route::post('product-descriptions', [AiGenerationController::class, 'describe'])->middleware('throttle:ai-generate')->name('stores.ai.product-descriptions');
        Route::post('photo-edits', [AiGenerationController::class, 'editPhoto'])->middleware('throttle:ai-generate')->name('stores.ai.photo-edits');
        Route::post('photo-edits/{generation}/apply', [AiGenerationController::class, 'apply'])->where($g)->name('stores.ai.photo-edits.apply');
        Route::post('photo-edits/{generation}/undo', [AiGenerationController::class, 'undo'])->where($g)->name('stores.ai.photo-edits.undo');
        Route::get('generations', [AiGenerationController::class, 'index'])->name('stores.ai.generations.index');
        Route::get('generations/{generation}', [AiGenerationController::class, 'show'])->where($g)->name('stores.ai.generations.show');
    });

    // §10.1 / §10.3 tenant-level AI credits.
    Route::get('billing/ai-credits', [AiCreditController::class, 'show'])->middleware('perm:products.edit|integrations.manage|billing.view')->name('billing.ai-credits.show');
    Route::get('billing/ai-credits/ledger', [AiCreditController::class, 'ledger'])->middleware('perm:billing.view|integrations.manage')->name('billing.ai-credits.ledger');
});

// §10.4 Store Plix staff: reads `view_merchants`, adjust `manage_billing` (`// cross-tenant: AI credit adjustment`).
Route::prefix('admin')->middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin'])->group(function (): void {
    Route::middleware('platform.can:view_merchants')->group(function (): void {
        Route::get('tenants/{tenant}/ai-credits', [AdminAiCreditController::class, 'show'])->name('admin.tenants.ai-credits.show');
        Route::get('tenants/{tenant}/ai-credits/ledger', [AdminAiCreditController::class, 'ledger'])->name('admin.tenants.ai-credits.ledger');
    });
    Route::post('tenants/{tenant}/ai-credits/adjust', [AdminAiCreditController::class, 'adjust'])
        ->middleware(['throttle:admin-write', 'platform.can:manage_billing'])->name('admin.tenants.ai-credits.adjust');
});

// P89D-58 (S346): signed 30-minute link to a private AI photo result (no session; tenant from the signature).
Route::get('ai-photos/{media}/download', [AiGenerationController::class, 'download'])->where('media', '[0-9A-Za-z]{26}')
    ->middleware(['signed', 'throttle:60,1,ai-photos.download'])->name('ai-photos.download');

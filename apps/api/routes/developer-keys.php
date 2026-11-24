<?php

declare(strict_types=1);

// Phase 8.4 (PHASE-8-4-CONTRACT §11): owned by API-KEYS.
// Required from routes/api.php inside the merchant group (auth:sanctum + surface + tenant already applied).

use App\Domain\Developer\ApiKeys\Http\Controllers\ApiKeyController;
use Illuminate\Support\Facades\Route;

// PHASE-8-4 §6.1: tenant-level API keys (P84-1). Writes also need `api_webhooks` (ApiKeyService::assertFeature, 402).
Route::middleware('throttle:merchant')->group(function (): void {
    Route::get('api-keys', [ApiKeyController::class, 'index'])->middleware('perm:developers.manage')->name('api-keys.index');
    Route::post('api-keys', [ApiKeyController::class, 'store'])->middleware('throttle:20,1,api-keys.store')->middleware('perm:developers.manage')->name('api-keys.store');
    Route::patch('api-keys/{key}', [ApiKeyController::class, 'update'])->middleware('perm:developers.manage')->name('api-keys.update');
    Route::delete('api-keys/{key}', [ApiKeyController::class, 'destroy'])->middleware('perm:developers.manage')->name('api-keys.destroy');
    Route::get('api-scopes', [ApiKeyController::class, 'scopes'])->middleware('perm:developers.manage')->name('api-scopes.index');
});

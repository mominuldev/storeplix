<?php

declare(strict_types=1);

// Phase 8.4 (PHASE-8-4-CONTRACT §11): owned by API-HOOKS.
// Required from routes/api.php inside the merchant group (auth:sanctum + surface + tenant already applied).

use App\Domain\Developer\Webhooks\Http\Controllers\DevWebhookSinkController;
use App\Domain\Developer\Webhooks\Http\Controllers\WebhookDeliveryController;
use App\Domain\Developer\Webhooks\Http\Controllers\WebhookEndpointController;
use App\Domain\Developer\Webhooks\Http\Controllers\WebhookEventTypeController;
use App\Domain\Developer\Webhooks\Http\Controllers\WebhookSecretController;
use Illuminate\Support\Facades\Route;

// PHASE-8-4 §6.1: outbound webhooks (store-scoped, P84-7). Writes also need `api_webhooks` (402, P84-13).
Route::middleware('throttle:merchant')->group(function (): void {
    Route::get('webhook-event-types', WebhookEventTypeController::class)->middleware('perm:developers.manage')->name('webhook-event-types.index');

    Route::prefix('stores/{store}')->group(function (): void {
        Route::get('webhook-endpoints', [WebhookEndpointController::class, 'index'])->middleware('perm:developers.manage')->name('stores.webhook-endpoints.index');
        Route::post('webhook-endpoints', [WebhookEndpointController::class, 'store'])->middleware('throttle:30,1,stores.webhook-endpoints.store')->middleware('perm:developers.manage')->name('stores.webhook-endpoints.store');
        Route::patch('webhook-endpoints/{endpoint}', [WebhookEndpointController::class, 'update'])->where('endpoint', '[0-9A-Za-z]{26}')->middleware('perm:developers.manage')->name('stores.webhook-endpoints.update');
        Route::delete('webhook-endpoints/{endpoint}', [WebhookEndpointController::class, 'destroy'])->where('endpoint', '[0-9A-Za-z]{26}')->middleware('perm:developers.manage')->name('stores.webhook-endpoints.destroy');
        Route::post('webhook-endpoints/{endpoint}/test', [WebhookEndpointController::class, 'test'])->where('endpoint', '[0-9A-Za-z]{26}')
            ->middleware('throttle:30,1,stores.webhook-endpoints.test')->middleware('perm:developers.manage')->name('stores.webhook-endpoints.test');

        Route::get('webhook-secret', [WebhookSecretController::class, 'show'])->middleware('perm:developers.manage')->name('stores.webhook-secret.show');
        Route::post('webhook-secret/reveal', [WebhookSecretController::class, 'reveal'])->middleware('throttle:10,1,stores.webhook-secret.reveal')->middleware('perm:developers.manage')->name('stores.webhook-secret.reveal');
        Route::post('webhook-secret/rotate', [WebhookSecretController::class, 'rotate'])->middleware('throttle:10,1,stores.webhook-secret.rotate')->middleware('perm:developers.manage')->name('stores.webhook-secret.rotate');

        Route::get('webhook-deliveries', [WebhookDeliveryController::class, 'index'])->middleware('perm:developers.manage')->name('stores.webhook-deliveries.index');
        Route::post('webhook-deliveries/resend-failed', [WebhookDeliveryController::class, 'resendFailed'])->middleware('throttle:10,1,stores.webhook-deliveries.resend-failed')->middleware('perm:developers.manage')->name('stores.webhook-deliveries.resend-failed');
        Route::get('webhook-deliveries/{delivery}', [WebhookDeliveryController::class, 'show'])->where('delivery', '[0-9A-Za-z]{26}')->middleware('perm:developers.manage')->name('stores.webhook-deliveries.show');
        Route::post('webhook-deliveries/{delivery}/resend', [WebhookDeliveryController::class, 'resend'])->where('delivery', '[0-9A-Za-z]{26}')
            ->middleware('throttle:60,1,stores.webhook-deliveries.resend')->middleware('perm:developers.manage')->name('stores.webhook-deliveries.resend');
    });

    // §4.3: TESTING-ONLY fake-sender sink (404 unless WEBHOOKS_OUT_FAKE=true; never registered in production).
    if (! app()->environment('production')) {
        Route::get('dev/webhook-sink', DevWebhookSinkController::class)->middleware('perm:developers.manage')->name('dev.webhook-sink');
    }
});

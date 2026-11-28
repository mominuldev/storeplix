<?php

declare(strict_types=1);

// Phase 8.9d part A (PHASE-8-9D-CONTRACT §13.1): owned by API. Required from routes/api.php inside the `v1` prefix (NOT
// inside the merchant group): this file declares its own merchant, storefront and public OAuth callback groups.

use App\Domain\Feeds\Http\Controllers\FeedController;
use App\Domain\Feeds\Http\Controllers\OauthCallbackController;
use App\Domain\Integrations\Http\Controllers\IntegrationController;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Tracking\Http\Controllers\StorefrontTrackingController;
use App\Domain\Tracking\Http\Controllers\TrackingController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404). P89D-41: reads integrations.manage |
// marketing.manage (the list also products.edit: AI rows only); writes, OAuth, test, sync-now, disconnect
// integrations.manage. Impersonation → every write 403 impersonation_read_only (ResolveTenant). Plan gates in code (402).
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}/integrations')->group(function (): void {
        $read = 'perm:integrations.manage|marketing.manage';
        $write = 'perm:integrations.manage';
        $p = ['provider' => IntegrationProvider::PATTERN];

        Route::get('/', [IntegrationController::class, 'index'])->middleware('perm:integrations.manage|marketing.manage|products.edit')->name('stores.integrations.index');
        Route::get('{provider}', [IntegrationController::class, 'show'])->where($p)->middleware($read)->name('stores.integrations.show');
        Route::put('{provider}', [IntegrationController::class, 'update'])->where($p)->middleware($write)->name('stores.integrations.update');
        Route::patch('{provider}', [IntegrationController::class, 'patch'])->where($p)->middleware($write)->name('stores.integrations.patch');
        Route::post('{provider}/disconnect', [IntegrationController::class, 'disconnect'])->where($p)->middleware($write)->name('stores.integrations.disconnect');
        Route::post('{provider}/verify', [IntegrationController::class, 'verify'])->where($p)->middleware('throttle:integration-verify')->middleware($read)->name('stores.integrations.verify');

        Route::post('{provider}/test-event', [TrackingController::class, 'testEvent'])->where($p)->middleware('throttle:integration-test')->middleware($write)->name('stores.integrations.test-event');
        Route::post('{provider}/test-mode', [TrackingController::class, 'testMode'])->where($p)->middleware('throttle:integration-test')->middleware($write)->name('stores.integrations.test-mode');
        Route::get('{provider}/events', [TrackingController::class, 'events'])->where($p)->middleware($read)->name('stores.integrations.events');
        Route::get('{provider}/stats', [TrackingController::class, 'stats'])->where($p)->middleware($read)->name('stores.integrations.stats');

        Route::post('{provider}/oauth/start', [FeedController::class, 'oauthStart'])->where($p)->middleware($write)->name('stores.integrations.oauth.start');
        Route::get('{provider}/accounts', [FeedController::class, 'accounts'])->where($p)->middleware($write)->name('stores.integrations.accounts');
        Route::put('{provider}/account', [FeedController::class, 'account'])->where($p)->middleware($write)->name('stores.integrations.account');
        Route::get('{provider}/feed', [FeedController::class, 'overview'])->where($p)->middleware($read)->name('stores.integrations.feed');
        Route::post('{provider}/sync', [FeedController::class, 'sync'])->where($p)->middleware('throttle:feed-sync-now')->middleware($write)->name('stores.integrations.sync');
        Route::get('{provider}/sync-runs', [FeedController::class, 'runs'])->where($p)->middleware($read)->name('stores.integrations.sync-runs');
        Route::get('{provider}/items', [FeedController::class, 'items'])->where($p)->middleware($read)->name('stores.integrations.items');
        Route::post('{provider}/claim-website', [FeedController::class, 'claimWebsite'])->where($p)->middleware($write)->name('stores.integrations.claim-website');
    });

// §7.1: the public OAuth callback (browser redirect from Meta / Google; signed single-use state, no tenant header).
Route::get('integrations/oauth/{provider}/callback', OauthCallbackController::class)->where('provider', 'meta_catalog|google_merchant')
    ->middleware('throttle:oauth-callback')->name('integrations.oauth.callback');

// §6.2 storefront beacon (tenant from X-Storefront-Host + X-Storefront-Key).
Route::prefix('storefront')->middleware(['storefront', 'throttle:storefront'])->group(function (): void {
    Route::post('tracking/events', StorefrontTrackingController::class)->middleware('throttle:tracking-beacon')->name('storefront.tracking.events');
});

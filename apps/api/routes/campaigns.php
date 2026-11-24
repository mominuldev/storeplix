<?php

declare(strict_types=1);

// Phase 8.5 (PHASE-8-5-CONTRACT §6.1, §4.2, §12): owned by API. Required from routes/api.php inside the `v1` prefix
// (NOT inside the merchant group): this file declares its own merchant and storefront groups.

use App\Domain\Marketing\Http\Controllers\CampaignController;
use App\Domain\Marketing\Http\Controllers\CustomerMarketingController;
use App\Domain\Marketing\Http\Controllers\DevMessageSinkController;
use App\Domain\Marketing\Http\Controllers\MarketingOverviewController;
use App\Domain\Marketing\Http\Controllers\StorefrontUnsubscribeController;
use Illuminate\Support\Facades\Route;

// §6.1 merchant routes: auth:sanctum + surface + tenant (+ {store} of the tenant, else 404); perm per §2.1.
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}')->group(function (): void {
        $id = ['campaign' => '[0-9A-Za-z]{26}'];
        $m = 'perm:marketing.manage';

        Route::get('marketing/overview', MarketingOverviewController::class)->middleware($m)->name('stores.marketing.overview');

        Route::get('campaigns', [CampaignController::class, 'index'])->middleware($m)->name('stores.campaigns.index');
        Route::post('campaigns', [CampaignController::class, 'store'])->middleware('throttle:60,1,stores.campaigns.store')->middleware($m)->name('stores.campaigns.store');
        Route::post('campaigns/audience-preview', [CampaignController::class, 'preview'])->middleware('throttle:campaigns-preview')->middleware($m)->name('stores.campaigns.audience-preview');
        Route::post('campaigns/estimate', [CampaignController::class, 'estimate'])->middleware('throttle:campaigns-preview')->middleware($m)->name('stores.campaigns.estimate');
        Route::get('campaigns/{campaign}', [CampaignController::class, 'show'])->where($id)->middleware($m)->name('stores.campaigns.show');
        Route::patch('campaigns/{campaign}', [CampaignController::class, 'update'])->where($id)->middleware($m)->name('stores.campaigns.update');
        Route::delete('campaigns/{campaign}', [CampaignController::class, 'destroy'])->where($id)->middleware($m)->name('stores.campaigns.destroy');
        Route::post('campaigns/{campaign}/test', [CampaignController::class, 'test'])->where($id)->middleware($m)->name('stores.campaigns.test');
        Route::post('campaigns/{campaign}/schedule', [CampaignController::class, 'schedule'])->where($id)
            ->middleware('idempotent:campaigns.schedule')->middleware($m)->name('stores.campaigns.schedule');
        Route::post('campaigns/{campaign}/send', [CampaignController::class, 'send'])->where($id)
            ->middleware('idempotent:campaigns.send')->middleware($m)->name('stores.campaigns.send');
        Route::post('campaigns/{campaign}/unschedule', [CampaignController::class, 'unschedule'])->where($id)->middleware($m)->name('stores.campaigns.unschedule');
        Route::post('campaigns/{campaign}/cancel', [CampaignController::class, 'cancel'])->where($id)->middleware($m)->name('stores.campaigns.cancel');
        Route::post('campaigns/{campaign}/duplicate', [CampaignController::class, 'duplicate'])->where($id)->middleware($m)->name('stores.campaigns.duplicate');
        Route::get('campaigns/{campaign}/recipients', [CampaignController::class, 'recipients'])->where($id)
            ->middleware('perm:marketing.manage,customers.view')->name('stores.campaigns.recipients');

        Route::post('customers/{customer}/marketing-opt-out', [CustomerMarketingController::class, 'store'])->where('customer', '[0-9A-Za-z]{26}')
            ->middleware('perm:customers.edit')->name('stores.customers.marketing-opt-out.store');
        Route::delete('customers/{customer}/marketing-opt-out/{channel}', [CustomerMarketingController::class, 'destroy'])
            ->where(['customer' => '[0-9A-Za-z]{26}', 'channel' => 'sms|email'])
            ->middleware('perm:customers.edit')->name('stores.customers.marketing-opt-out.destroy');
    });

// §5.4: TESTING-ONLY rendered-message sink (404 unless CAMPAIGNS_DEV_SINK=true; never registered in production).
if (! app()->environment('production')) {
    Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
        ->get('dev/stores/{store}/message-sink', DevMessageSinkController::class)->middleware('perm:marketing.manage')->name('dev.message-sink');
}

// §4.2 storefront unsubscribe (tenant from X-Storefront-Host + X-Storefront-Key; 20/min per shopper IP).
Route::prefix('storefront')->middleware(['storefront', 'throttle:storefront', 'throttle:storefront-unsubscribe'])->group(function (): void {
    Route::get('unsubscribe/{code}', [StorefrontUnsubscribeController::class, 'show'])->where('code', '[^/]{1,64}')->name('storefront.unsubscribe.show');
    Route::post('unsubscribe/{code}', [StorefrontUnsubscribeController::class, 'update'])->where('code', '[^/]{1,64}')->name('storefront.unsubscribe.update');
});

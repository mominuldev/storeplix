<?php

declare(strict_types=1);

/*
 * PHASE-8-9A §10.3 (owner API): sender-ID review queue and merchant SMS credits. Included from routes/api.php inside the
 * `v1` prefix. Stack: see routes/admin.php. Never reads X-Tenant-Id; cross-tenant reads on the admin connection, writes
 * inside TenantContext::run($tenant) (`// cross-tenant: sender-ID review` / `SMS credit adjustment`).
 *
 * PHASE-8-9B §9.1: the platform SMS provider, message types, broadcasts and platform SMS log — every route
 * `platform.can:manage_settings` (super_admin only, P89B-25); writes add `throttle:admin-write`; test sends
 * `throttle:admin-sms-test` (10/h), preview 60/min, refresh-balance 6/h per provider, CSV export 5/h.
 */

use App\Domain\Admin\SenderIds\Http\AdminSenderIdController;
use App\Domain\Admin\SmsCredits\Http\AdminSmsCreditController;
use App\Domain\Sms\Http\Controllers\Platform\PlatformSmsBroadcastController;
use App\Domain\Sms\Http\Controllers\Platform\PlatformSmsLogController;
use App\Domain\Sms\Http\Controllers\Platform\PlatformSmsMessageTypeController;
use App\Domain\Sms\Http\Controllers\Platform\PlatformSmsProviderController;
use Illuminate\Support\Facades\Route;

Route::prefix('admin')->middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin'])->group(function (): void {
    $id = ['sender_id' => '[0-9A-Za-z]{26}'];

    Route::middleware('platform.can:manage_domains')->group(function () use ($id): void {
        Route::get('sender-ids', [AdminSenderIdController::class, 'index'])->name('admin.sender-ids.index');
        Route::get('sender-ids/{sender_id}', [AdminSenderIdController::class, 'show'])->where($id)->name('admin.sender-ids.show');
        Route::get('sender-ids/{sender_id}/document', [AdminSenderIdController::class, 'document'])->where($id)->name('admin.sender-ids.document');
        Route::middleware('throttle:admin-write')->group(function () use ($id): void {
            Route::post('sender-ids/{sender_id}/approve', [AdminSenderIdController::class, 'approve'])->where($id)->name('admin.sender-ids.approve');
            Route::post('sender-ids/{sender_id}/reject', [AdminSenderIdController::class, 'reject'])->where($id)->name('admin.sender-ids.reject');
            Route::post('sender-ids/{sender_id}/revoke', [AdminSenderIdController::class, 'revoke'])->where($id)->name('admin.sender-ids.revoke');
        });
    });

    Route::middleware('platform.can:view_merchants')->group(function (): void {
        Route::get('tenants/{tenant}/sms-credits', [AdminSmsCreditController::class, 'show'])->name('admin.tenants.sms-credits.show');
        Route::get('tenants/{tenant}/sms-credits/ledger', [AdminSmsCreditController::class, 'ledger'])->name('admin.tenants.sms-credits.ledger');
    });
    Route::post('tenants/{tenant}/sms-credits/adjust', [AdminSmsCreditController::class, 'adjust'])
        ->middleware(['throttle:admin-write', 'platform.can:manage_billing'])->name('admin.tenants.sms-credits.adjust');

    // ---------- PHASE-8-9B platform SMS ----------
    Route::middleware('platform.can:manage_settings')->prefix('sms')->group(function (): void {
        $p = ['provider' => '[0-9A-Za-z]{26}'];
        $b = ['broadcast' => '[0-9A-Za-z]{26}'];

        Route::get('drivers', [PlatformSmsProviderController::class, 'drivers'])->name('admin.sms.drivers');
        Route::get('alerts', [PlatformSmsProviderController::class, 'alerts'])->name('admin.sms.alerts');
        Route::get('providers', [PlatformSmsProviderController::class, 'index'])->name('admin.sms.providers.index');
        Route::get('providers/{provider}', [PlatformSmsProviderController::class, 'show'])->where($p)->name('admin.sms.providers.show');
        Route::get('message-types', [PlatformSmsMessageTypeController::class, 'index'])->name('admin.sms.message-types.index');
        Route::get('broadcasts', [PlatformSmsBroadcastController::class, 'index'])->name('admin.sms.broadcasts.index');
        Route::get('broadcasts/audiences', [PlatformSmsBroadcastController::class, 'audiences'])->name('admin.sms.broadcasts.audiences');
        Route::get('broadcasts/{broadcast}', [PlatformSmsBroadcastController::class, 'show'])->where($b)->name('admin.sms.broadcasts.show');
        Route::get('broadcasts/{broadcast}/recipients', [PlatformSmsBroadcastController::class, 'recipients'])->where($b)->name('admin.sms.broadcasts.recipients');
        Route::get('messages', [PlatformSmsLogController::class, 'index'])->name('admin.sms.messages.index');
        Route::get('messages/export', [PlatformSmsLogController::class, 'export'])->middleware('throttle:admin-sms-export')->name('admin.sms.messages.export');

        Route::middleware('throttle:admin-write')->group(function () use ($p, $b): void {
            Route::post('providers', [PlatformSmsProviderController::class, 'store'])->name('admin.sms.providers.store');
            Route::patch('providers/{provider}', [PlatformSmsProviderController::class, 'update'])->where($p)->name('admin.sms.providers.update');
            Route::post('providers/{provider}/test', [PlatformSmsProviderController::class, 'test'])->where($p)->middleware('throttle:admin-sms-test')->name('admin.sms.providers.test');
            Route::post('providers/{provider}/activate', [PlatformSmsProviderController::class, 'activate'])->where($p)->name('admin.sms.providers.activate');
            Route::post('providers/{provider}/rotate', [PlatformSmsProviderController::class, 'rotate'])->where($p)->middleware('throttle:admin-sms-test')->name('admin.sms.providers.rotate');
            Route::post('providers/{provider}/remove', [PlatformSmsProviderController::class, 'remove'])->where($p)->name('admin.sms.providers.remove');
            Route::post('providers/{provider}/refresh-balance', [PlatformSmsProviderController::class, 'refreshBalance'])->where($p)->middleware('throttle:admin-sms-refresh-balance')->name('admin.sms.providers.refresh-balance');

            Route::post('message-types/preview', [PlatformSmsMessageTypeController::class, 'preview'])->middleware('throttle:admin-sms-preview')->name('admin.sms.message-types.preview');
            Route::patch('message-types/{type}', [PlatformSmsMessageTypeController::class, 'update'])->name('admin.sms.message-types.update');
            Route::post('message-types/{type}/test', [PlatformSmsMessageTypeController::class, 'test'])->middleware('throttle:admin-sms-test')->name('admin.sms.message-types.test');
            Route::put('message-types/{type}/templates/{language}', [PlatformSmsMessageTypeController::class, 'updateTemplate'])->name('admin.sms.message-types.templates.update');
            Route::delete('message-types/{type}/templates/{language}', [PlatformSmsMessageTypeController::class, 'resetTemplate'])->name('admin.sms.message-types.templates.reset');

            Route::post('broadcasts', [PlatformSmsBroadcastController::class, 'store'])->name('admin.sms.broadcasts.store');
            Route::post('broadcasts/estimate', [PlatformSmsBroadcastController::class, 'estimate'])->name('admin.sms.broadcasts.estimate');
            Route::post('broadcasts/test', [PlatformSmsBroadcastController::class, 'test'])->middleware('throttle:admin-sms-test')->name('admin.sms.broadcasts.test');
            Route::patch('broadcasts/{broadcast}', [PlatformSmsBroadcastController::class, 'update'])->where($b)->name('admin.sms.broadcasts.update');
            Route::delete('broadcasts/{broadcast}', [PlatformSmsBroadcastController::class, 'destroy'])->where($b)->name('admin.sms.broadcasts.destroy');
            Route::post('broadcasts/{broadcast}/schedule', [PlatformSmsBroadcastController::class, 'schedule'])->where($b)->name('admin.sms.broadcasts.schedule');
            Route::post('broadcasts/{broadcast}/cancel', [PlatformSmsBroadcastController::class, 'cancel'])->where($b)->name('admin.sms.broadcasts.cancel');
        });
    });
});

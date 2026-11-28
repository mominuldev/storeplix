<?php

declare(strict_types=1);

// Phase 8.9a (PHASE-8-9A-CONTRACT §10.1): owned by API. Required from routes/api.php inside the `v1` prefix (NOT inside
// the merchant group): this file declares its own merchant group. Tenant-level credit routes live in the billing group
// of routes/api.php.

use App\Domain\Sms\Http\Controllers\SmsLogController;
use App\Domain\Sms\Http\Controllers\SmsOverviewController;
use App\Domain\Sms\Http\Controllers\SmsSenderIdController;
use App\Domain\Sms\Http\Controllers\SmsTemplateController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404). Permissions P89A-25; impersonation → every write
// 403 impersonation_read_only (ResolveTenant). Limiters: sms-test 5/h, sms-template-preview 60/min, sms-sender-id 5/day.
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}/sms')->group(function (): void {
        $read = 'perm:settings.manage|integrations.manage|billing.view';
        $ops = 'perm:settings.manage|integrations.manage';
        $key = ['key' => 'order_placed|order_confirmed|order_shipped|order_cancelled|order_updated|payment_link|pos_receipt|checkout_otp', 'language' => 'bn|en'];

        Route::get('/', [SmsOverviewController::class, 'show'])->middleware($read)->name('stores.sms.show');
        Route::post('test', [SmsOverviewController::class, 'test'])->middleware('throttle:sms-test')->middleware($ops)->name('stores.sms.test');

        Route::get('templates', [SmsTemplateController::class, 'index'])->middleware($read)->name('stores.sms.templates.index');
        Route::post('templates/preview', [SmsTemplateController::class, 'preview'])->middleware('throttle:sms-template-preview')
            ->middleware('perm:settings.manage')->name('stores.sms.templates.preview');
        Route::put('templates/{key}/{language}', [SmsTemplateController::class, 'update'])->where($key)->middleware('perm:settings.manage')->name('stores.sms.templates.update');
        Route::delete('templates/{key}/{language}', [SmsTemplateController::class, 'destroy'])->where($key)->middleware('perm:settings.manage')->name('stores.sms.templates.destroy');

        Route::get('sender-ids', [SmsSenderIdController::class, 'index'])->middleware($ops)->name('stores.sms.sender-ids.index');
        Route::post('sender-ids', [SmsSenderIdController::class, 'store'])->middleware('throttle:sms-sender-id')
            ->middleware('perm:integrations.manage')->name('stores.sms.sender-ids.store');
        Route::post('sender-ids/{sender_id}/cancel', [SmsSenderIdController::class, 'cancel'])->where(['sender_id' => '[0-9A-Za-z]{26}'])
            ->middleware('perm:integrations.manage')->name('stores.sms.sender-ids.cancel');

        Route::get('messages', [SmsLogController::class, 'index'])->middleware($ops)->name('stores.sms.messages.index');
    });

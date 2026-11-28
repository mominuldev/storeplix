<?php

declare(strict_types=1);

/*
 * PHASE-8-9B §9.2 (owner API): the signed-in user's Store Plix SMS preferences (merchant surface, no tenant; impersonation
 * sessions are read-only, ReadOnlyImpersonation) and the public promotional-SMS opt-out link (limiter 30/min per IP).
 * Included from routes/api.php inside the `v1` prefix.
 */

use App\Domain\Sms\Http\Controllers\Platform\PlatformSmsOptOutController;
use Illuminate\Support\Facades\Route;

Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'throttle:60,1,account-sms-preferences'])->group(function (): void {
    Route::get('account/sms-preferences', [PlatformSmsOptOutController::class, 'preferences'])->name('account.sms-preferences.show');
    Route::patch('account/sms-preferences', [PlatformSmsOptOutController::class, 'updatePreferences'])->name('account.sms-preferences.update');
});

Route::middleware('throttle:platform-sms-opt-out')->group(function (): void {
    Route::get('platform-sms/opt-out/{code}', [PlatformSmsOptOutController::class, 'show'])->where('code', '[0-9A-Za-z]{1,32}')->name('platform-sms.opt-out.show');
    Route::post('platform-sms/opt-out/{code}', [PlatformSmsOptOutController::class, 'store'])->where('code', '[0-9A-Za-z]{1,32}')->name('platform-sms.opt-out.store');
});

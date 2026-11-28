<?php

declare(strict_types=1);

/*
 * PHASE-8-9A §10.3 (owner API): sender-ID review queue and merchant SMS credits. Included from routes/api.php inside the
 * `v1` prefix. Stack: see routes/admin.php. Never reads X-Tenant-Id; cross-tenant reads on the admin connection, writes
 * inside TenantContext::run($tenant) (`// cross-tenant: sender-ID review` / `SMS credit adjustment`).
 */

use App\Domain\Admin\SenderIds\Http\AdminSenderIdController;
use App\Domain\Admin\SmsCredits\Http\AdminSmsCreditController;
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
});

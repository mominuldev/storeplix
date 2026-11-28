<?php

declare(strict_types=1);

/*
 * PHASE-8-9C §9, §11.2 (owner API): the support queue. Included from routes/api.php inside the `v1` prefix. Stack: see
 * routes/admin.php; every route `platform.can:manage_support` (super_admin, support, billing). Never reads X-Tenant-Id:
 * the queue reads on the platform connection, per-ticket actions run inside TenantContext::run (SupportQueue). Writes add
 * `throttle:admin-write` (own 120/min bucket); replies also `throttle:support-staff-reply` (120/min per staff).
 */

use App\Domain\Support\Admin\AdminSupportController;
use Illuminate\Support\Facades\Route;

Route::prefix('admin/support')->middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin', 'platform.can:manage_support'])
    ->group(function (): void {
        $t = ['ticket' => '[0-9A-Za-z]{26}'];
        $ta = ['ticket' => '[0-9A-Za-z]{26}', 'attachment' => '[0-9A-Za-z]{26}'];

        Route::get('tickets', [AdminSupportController::class, 'index'])->name('admin.support.tickets.index');
        Route::get('assignees', [AdminSupportController::class, 'assignees'])->name('admin.support.assignees');
        Route::get('tickets/{ticket}', [AdminSupportController::class, 'show'])->where($t)->name('admin.support.tickets.show');
        Route::get('tickets/{ticket}/messages', [AdminSupportController::class, 'messages'])->where($t)->name('admin.support.tickets.messages.index');
        Route::get('tickets/{ticket}/attachments/{attachment}', [AdminSupportController::class, 'attachment'])->where($ta)->name('admin.support.tickets.attachments.show');

        Route::middleware('throttle:admin-write')->group(function () use ($t): void {
            Route::patch('tickets/{ticket}', [AdminSupportController::class, 'update'])->where($t)->name('admin.support.tickets.update');
            Route::post('tickets/{ticket}/messages', [AdminSupportController::class, 'send'])->where($t)->middleware('throttle:support-staff-reply')->name('admin.support.tickets.messages.store');
            Route::post('tickets/{ticket}/assign', [AdminSupportController::class, 'assign'])->where($t)->name('admin.support.tickets.assign');
            Route::post('tickets/{ticket}/status', [AdminSupportController::class, 'status'])->where($t)->name('admin.support.tickets.status');
            Route::post('tickets/{ticket}/attachments', [AdminSupportController::class, 'upload'])->where($t)->middleware('throttle:support-upload')->name('admin.support.tickets.attachments.store');
        });
    });

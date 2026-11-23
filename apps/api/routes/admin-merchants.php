<?php

/*
 * PHASE-8-1 §6.2 – §6.5 audit (owner API-2): overview, search, tenants, invoices, domains, audit logs, suspension, billing
 * actions. Included from routes/api.php inside the `v1` prefix. Stack: see routes/admin.php.
 */

use App\Domain\Admin\Audit\Http\AdminAuditLogController;
use App\Domain\Admin\Domains\Http\AdminDomainController;
use App\Domain\Admin\Invoices\Http\AdminInvoiceController;
use App\Domain\Admin\Overview\Http\AdminOverviewController;
use App\Domain\Admin\Search\Http\AdminSearchController;
use App\Domain\Admin\Suspension\Http\SuspensionController;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Admin\Tenants\Http\AdminTenantController;
use Illuminate\Support\Facades\Route;

Route::prefix('admin')->middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin'])->group(function (): void {
    // Reads (view_merchants), on the admin connection (P8-6).
    Route::middleware('platform.can:view_merchants')->group(function (): void {
        Route::get('overview', AdminOverviewController::class)->name('admin.overview');
        Route::get('search', AdminSearchController::class)->name('admin.search');
        Route::get('tenants', [AdminTenantController::class, 'index'])->name('admin.tenants.index');
        Route::get('tenants/{tenant}', [AdminTenantController::class, 'show'])->name('admin.tenants.show');
        Route::get('tenants/{tenant}/members', [AdminTenantController::class, 'members'])->name('admin.tenants.members');
        Route::get('tenants/{tenant}/domains', [AdminTenantController::class, 'domains'])->name('admin.tenants.domains');
        Route::get('tenants/{tenant}/invoices', [AdminTenantController::class, 'invoices'])->name('admin.tenants.invoices');
        Route::get('tenants/{tenant}/audit-logs', [AdminAuditLogController::class, 'forTenant'])->name('admin.tenants.audit-logs');
        Route::get('invoices', [AdminInvoiceController::class, 'index'])->name('admin.invoices.index');
        Route::get('invoices/{invoice}', [AdminInvoiceController::class, 'show'])->name('admin.invoices.show');
        Route::get('invoices/{invoice}/pdf', [AdminInvoiceController::class, 'pdf'])->name('admin.invoices.pdf');
        Route::get('domains', [AdminDomainController::class, 'index'])->name('admin.domains.index');
        Route::get('audit-logs', [AdminAuditLogController::class, 'index'])->name('admin.audit-logs.index');
    });

    // Writes: run as the tenant on the app connection (P8-7), reason required (S76).
    Route::middleware('throttle:admin-write')->group(function (): void {
        Route::middleware('platform.can:manage_billing')->group(function (): void {
            Route::post('tenants/{tenant}/billing/quote', [AdminBillingController::class, 'quote'])->name('admin.tenants.billing.quote');
            Route::post('tenants/{tenant}/billing/change-plan', [AdminBillingController::class, 'changePlan'])->name('admin.tenants.billing.change-plan');
            Route::post('tenants/{tenant}/subscription/extend', [AdminBillingController::class, 'extend'])->name('admin.tenants.subscription.extend');
            Route::post('invoices/{invoice}/mark-paid', [AdminInvoiceController::class, 'markPaid'])->name('admin.invoices.mark-paid');
            Route::post('invoices/{invoice}/void', [AdminInvoiceController::class, 'void'])->name('admin.invoices.void');
            Route::post('invoices/{invoice}/resend', [AdminInvoiceController::class, 'resend'])->name('admin.invoices.resend');
        });
        Route::post('domains/{domain}/recheck', [AdminDomainController::class, 'recheck'])
            ->middleware('platform.can:manage_domains')->name('admin.domains.recheck');
        Route::middleware('platform.can:suspend')->group(function (): void {
            Route::post('domains/{domain}/suspend', [AdminDomainController::class, 'suspend'])->name('admin.domains.suspend');
            Route::post('domains/{domain}/reinstate', [AdminDomainController::class, 'reinstate'])->name('admin.domains.reinstate');
            Route::post('tenants/{tenant}/suspend', [SuspensionController::class, 'suspend'])->name('admin.tenants.suspend');
            Route::post('tenants/{tenant}/reactivate', [SuspensionController::class, 'reactivate'])->name('admin.tenants.reactivate');
        });
    });
});

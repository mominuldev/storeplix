<?php

/*
 * PHASE-8-1 §6.1 + §6.5 team (owner API-1): /api/v1/admin/auth/*, /admin/invitations/*, /admin/team/*,
 * /admin/settings/security (amendment A1-4).
 * Included from routes/api.php inside the `v1` prefix. Admin-surface stack for authenticated routes:
 * ['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin'] (+ 'throttle:admin-write', 'platform.can:<perm>').
 * Guest routes (sign-in steps, invitation lookup/accept): 'platform.ip' + 'throttle:admin-login'; the ones that read or
 * create a session are SPA-only ('stateful': session + CSRF).
 */

use App\Domain\Admin\Auth\Http\AdminAuthController;
use App\Domain\Admin\Settings\Http\PlatformSettingsController;
use App\Domain\Admin\Team\Http\PlatformInvitationController;
use App\Domain\Admin\Team\Http\TeamController;
use Illuminate\Support\Facades\Route;

Route::prefix('admin')->group(function (): void {
    // --- Guest: sign-in (§3.1) and invitation acceptance (P8-16) ---
    Route::middleware(['platform.ip', 'throttle:admin-login', 'stateful'])->group(function (): void {
        Route::post('auth/login', [AdminAuthController::class, 'login'])->name('admin.auth.login');
        Route::get('auth/enroll', [AdminAuthController::class, 'enrolment'])->name('admin.auth.enroll.show');
        Route::post('auth/enroll', [AdminAuthController::class, 'confirmEnrolment'])->name('admin.auth.enroll');
        Route::post('auth/totp', [AdminAuthController::class, 'totp'])->name('admin.auth.totp');
        Route::get('invitations/{token}', [PlatformInvitationController::class, 'show'])->name('admin.invitations.show');
        Route::post('invitations/{token}/accept', [PlatformInvitationController::class, 'accept'])->name('admin.invitations.accept');
    });

    // --- Signed in on the admin surface ---
    Route::middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin'])->group(function (): void {
        Route::get('auth/me', [AdminAuthController::class, 'me'])->name('admin.auth.me');
        Route::post('auth/logout', [AdminAuthController::class, 'logout'])->name('admin.auth.logout');

        Route::get('team', [TeamController::class, 'index'])->middleware('platform.can:view_merchants')->name('admin.team.index');
        Route::middleware(['throttle:admin-write', 'platform.can:manage_team'])->group(function (): void {
            Route::post('team/invitations', [TeamController::class, 'invite'])->name('admin.team.invitations.store');
            Route::delete('team/invitations/{invitation}', [TeamController::class, 'revokeInvitation'])->name('admin.team.invitations.destroy');
            Route::patch('team/members/{user}', [TeamController::class, 'updateRole'])->name('admin.team.members.update');
            Route::post('team/members/{user}/disable', [TeamController::class, 'disable'])->name('admin.team.members.disable');
            Route::post('team/members/{user}/enable', [TeamController::class, 'enable'])->name('admin.team.members.enable');
            Route::post('team/members/{user}/reset-2fa', [TeamController::class, 'resetTotp'])->name('admin.team.members.reset-2fa');
        });

        // Amendment A1-4: platform settings (super_admin only).
        Route::middleware('platform.can:manage_settings')->group(function (): void {
            Route::get('settings/security', [PlatformSettingsController::class, 'showSecurity'])->name('admin.settings.security.show');
            Route::patch('settings/security', [PlatformSettingsController::class, 'updateSecurity'])->middleware('throttle:admin-write')->name('admin.settings.security.update');
        });
    });
});

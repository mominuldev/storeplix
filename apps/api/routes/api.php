<?php

use App\Domain\Audit\Http\Controllers\AuditLogController;
use App\Domain\Billing\Http\Controllers\BillingController;
use App\Domain\Identity\Http\Controllers\AccountController;
use App\Domain\Identity\Http\Controllers\AuthController;
use App\Domain\Identity\Http\Controllers\OtpController;
use App\Domain\Media\Http\Controllers\MediaController;
use App\Domain\Navigation\Http\Controllers\NavigationController;
use App\Domain\Pages\Http\Controllers\PageController;
use App\Domain\Shared\Http\HealthController;
use App\Domain\Staff\Http\Controllers\InvitationAcceptanceController;
use App\Domain\Staff\Http\Controllers\InvitationController;
use App\Domain\Staff\Http\Controllers\StaffController;
use App\Domain\Stores\Http\Controllers\PreviewTokenController;
use App\Domain\Stores\Http\Controllers\StoreController;
use App\Domain\Stores\Http\Controllers\StorefrontConfigController;
use App\Domain\Stores\Http\Controllers\StorefrontPageController;
use App\Domain\Stores\Http\Controllers\StoreSettingsController;
use App\Domain\Themes\Http\Controllers\StoreThemeController;
use App\Domain\Themes\Http\Controllers\ThemeCatalogController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function (): void {
    Route::get('health', HealthController::class)->name('health');
    Route::get('plans', [BillingController::class, 'plans'])->name('plans.index');

    // --- Merchant auth (Sanctum personal access tokens) ---
    Route::prefix('auth')->group(function (): void {
        Route::post('register', [AuthController::class, 'register'])->middleware('throttle:register')->name('auth.register');
        Route::post('login', [AuthController::class, 'login'])->middleware('throttle:login')->name('auth.login');
        Route::middleware('throttle:password-reset')->group(function (): void {
            Route::post('forgot-password', [AuthController::class, 'forgotPassword'])->name('auth.forgot-password');
            Route::post('reset-password', [AuthController::class, 'resetPassword'])->name('auth.reset-password');
        });

        // Phone OTP (Addendum A). Per-phone / per-IP limits live in OtpService (429 otp_rate_limited).
        Route::middleware('throttle:otp')->group(function (): void {
            Route::post('otp/send', [OtpController::class, 'send'])->name('auth.otp.send');
            Route::post('login/otp', [OtpController::class, 'login'])->name('auth.login.otp');
            Route::post('reset-password/otp', [OtpController::class, 'resetPassword'])->name('auth.reset-password.otp');
            Route::post('phone/verify', [OtpController::class, 'verifyPhone'])->middleware('auth:sanctum')->name('auth.phone.verify');
        });

        Route::middleware('auth:sanctum')->group(function (): void {
            Route::post('logout', [AuthController::class, 'logout'])->name('auth.logout');
            Route::get('me', [AuthController::class, 'me'])->name('auth.me');
            Route::patch('me', [AccountController::class, 'update'])->name('auth.me.update');
            Route::put('password', [AccountController::class, 'changePassword'])->name('auth.password');
        });
    });

    // --- Staff invitation acceptance (public or Bearer; no tenant header: tenant comes from the token) ---
    Route::middleware('throttle:invitation')->group(function (): void {
        Route::get('invitations/{token}', [InvitationAcceptanceController::class, 'show'])->name('invitations.show');
        Route::post('invitations/{token}/accept', [InvitationAcceptanceController::class, 'accept'])->name('invitations.accept');
    });

    // --- Merchant APIs: authenticated + tenant context from X-Tenant-Id ---
    Route::middleware(['auth:sanctum', 'tenant'])->group(function (): void {
        Route::get('stores', [StoreController::class, 'index'])->name('stores.index');
        Route::post('stores', [StoreController::class, 'store'])->name('stores.store');
        Route::get('stores/{store}', [StoreController::class, 'show'])->name('stores.show');
        Route::get('stores/{store}/settings', [StoreSettingsController::class, 'show'])->name('stores.settings.show');
        Route::patch('stores/{store}/settings', [StoreSettingsController::class, 'update'])->name('stores.settings.update');
        Route::post('stores/{store}/preview-token', PreviewTokenController::class)
            ->middleware('throttle:30,1')
            ->name('stores.preview-token');

        // --- Phase 3: storefront engine (themes, pages, navigation) ---
        Route::get('themes', ThemeCatalogController::class)->name('themes.index');
        Route::get('page-templates', [PageController::class, 'templates'])->name('page-templates.index');

        Route::prefix('stores/{store}')->group(function (): void {
            Route::get('themes', [StoreThemeController::class, 'index'])->name('stores.themes.index');
            Route::prefix('themes/{code}')->where(['code' => '[a-z0-9-]{1,64}'])->group(function (): void {
                Route::get('/', [StoreThemeController::class, 'show'])->name('stores.themes.show');
                Route::put('draft', [StoreThemeController::class, 'saveDraft'])->middleware('throttle:120,1')->name('stores.themes.draft');
                Route::middleware('throttle:20,1')->group(function (): void {
                    Route::post('publish', [StoreThemeController::class, 'publish'])->name('stores.themes.publish');
                    Route::post('discard', [StoreThemeController::class, 'discard'])->name('stores.themes.discard');
                    Route::post('apply', [StoreThemeController::class, 'apply'])->name('stores.themes.apply');
                });
            });

            Route::scopeBindings()->group(function (): void {
                Route::get('pages', [PageController::class, 'index'])->name('stores.pages.index');
                Route::post('pages', [PageController::class, 'store'])->name('stores.pages.store');
                Route::get('pages/{page}', [PageController::class, 'show'])->name('stores.pages.show');
                Route::patch('pages/{page}', [PageController::class, 'update'])->name('stores.pages.update');
                Route::delete('pages/{page}', [PageController::class, 'destroy'])->name('stores.pages.destroy');
            });

            Route::get('navigation', [NavigationController::class, 'index'])->name('stores.navigation.index');
            Route::put('navigation/{handle}', [NavigationController::class, 'update'])->name('stores.navigation.update');
        });

        Route::get('staff', [StaffController::class, 'index'])->name('staff.index');
        Route::post('staff/invitations', [InvitationController::class, 'store'])->name('staff.invitations.store');
        Route::post('staff/invitations/{invitation}/resend', [InvitationController::class, 'resend'])
            ->middleware('throttle:invitation-resend')
            ->name('staff.invitations.resend');
        Route::delete('staff/invitations/{invitation}', [InvitationController::class, 'destroy'])->name('staff.invitations.destroy');
        Route::patch('staff/{member}', [StaffController::class, 'update'])->name('staff.update');
        Route::delete('staff/{member}', [StaffController::class, 'destroy'])->name('staff.destroy');

        Route::get('media', [MediaController::class, 'index'])->name('media.index');
        Route::post('media', [MediaController::class, 'store'])->middleware('throttle:60,1')->name('media.store');
        Route::get('media/{media}', [MediaController::class, 'show'])->name('media.show');
        Route::delete('media/{media}', [MediaController::class, 'destroy'])->name('media.destroy');

        Route::get('subscription', [BillingController::class, 'subscription'])->name('subscription.show');
        Route::get('features', [BillingController::class, 'features'])->name('features.index');

        Route::get('audit-logs', AuditLogController::class)->name('audit-logs.index');
    });

    // --- Public storefront API (server-to-server; tenant from validated X-Storefront-Host) ---
    Route::prefix('storefront')->middleware(['storefront', 'throttle:storefront'])->group(function (): void {
        Route::get('config', StorefrontConfigController::class)->name('storefront.config');
        Route::get('pages', [StorefrontPageController::class, 'index'])->name('storefront.pages.index');
        Route::get('pages/{slug}', [StorefrontPageController::class, 'show'])->name('storefront.pages.show');
    });
});

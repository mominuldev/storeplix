<?php

declare(strict_types=1);

/*
 * PHASE-8-9C §7, §11.2 (owner API): help content admin. Included from routes/api.php inside the `v1` prefix. Stack: see
 * routes/admin.php; every route `platform.can:manage_help_content` (super_admin, support). Writes add
 * `throttle:admin-write` (own 120/min bucket for help routes); image uploads also `throttle:help-media-upload`.
 * Platform content: never reads X-Tenant-Id.
 */

use App\Domain\Help\Admin\AdminHelpArticleController;
use App\Domain\Help\Admin\AdminHelpCategoryController;
use App\Domain\Help\Admin\AdminHelpMediaController;
use Illuminate\Support\Facades\Route;

Route::prefix('admin')->middleware(['auth:sanctum', 'surface:admin', 'platform', 'platform.ip', 'throttle:admin', 'platform.can:manage_help_content'])
    ->group(function (): void {
        $a = ['article' => '[0-9A-Za-z]{26}'];
        $c = ['category' => '[0-9A-Za-z]{26}'];

        Route::get('help-articles', [AdminHelpArticleController::class, 'index'])->name('admin.help-articles.index');
        Route::get('help-articles/{article}', [AdminHelpArticleController::class, 'show'])->where($a)->name('admin.help-articles.show');
        Route::get('help-articles/{article}/feedback', [AdminHelpArticleController::class, 'feedback'])->where($a)->name('admin.help-articles.feedback');
        Route::get('help-categories', [AdminHelpCategoryController::class, 'index'])->name('admin.help-categories.index');

        Route::middleware('throttle:admin-write')->group(function () use ($a, $c): void {
            Route::post('help-articles', [AdminHelpArticleController::class, 'store'])->name('admin.help-articles.store');
            Route::patch('help-articles/{article}', [AdminHelpArticleController::class, 'update'])->where($a)->name('admin.help-articles.update');
            Route::delete('help-articles/{article}', [AdminHelpArticleController::class, 'destroy'])->where($a)->name('admin.help-articles.destroy');
            foreach (['publish', 'unpublish', 'archive', 'restore'] as $action) {
                Route::post("help-articles/{article}/{$action}", [AdminHelpArticleController::class, $action])->where($a)->name("admin.help-articles.{$action}");
            }
            Route::post('help-categories', [AdminHelpCategoryController::class, 'store'])->name('admin.help-categories.store');
            Route::post('help-categories/reorder', [AdminHelpCategoryController::class, 'reorder'])->name('admin.help-categories.reorder');
            Route::patch('help-categories/{category}', [AdminHelpCategoryController::class, 'update'])->where($c)->name('admin.help-categories.update');
            Route::delete('help-categories/{category}', [AdminHelpCategoryController::class, 'destroy'])->where($c)->name('admin.help-categories.destroy');
            Route::post('help-media', [AdminHelpMediaController::class, 'store'])->middleware('throttle:help-media-upload')->name('admin.help-media.store');
        });
    });

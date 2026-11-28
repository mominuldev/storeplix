<?php

declare(strict_types=1);

// Phase 8.9c (PHASE-8-9C-CONTRACT §11.1): owned by API. Required from routes/api.php inside the `v1` prefix. Tenant-level
// merchant routes (no {store}: the tenant's single store is attached server-side). Guides: every member (`perm:base`);
// tickets, replies, ratings and attachments: `support.manage`. Impersonation → every write 403 impersonation_read_only
// (ResolveTenant). The public signed attachment download stays in api.php.

use App\Domain\Help\Http\Controllers\HelpController;
use App\Domain\Support\Http\Controllers\SupportAttachmentController;
use App\Domain\Support\Http\Controllers\SupportTicketController;
use Illuminate\Support\Facades\Route;

Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('help')->group(function (): void {
        $slug = ['slug' => '[A-Za-z0-9-]{1,80}'];
        $t = ['ticket' => '[0-9A-Za-z]{26}'];
        $a = ['attachment' => '[0-9A-Za-z]{26}'];
        $m = 'perm:support.manage';

        Route::middleware(['perm:base', 'throttle:help-read'])->group(function () use ($slug): void {
            Route::get('home', [HelpController::class, 'home'])->name('help.home');
            Route::get('categories', [HelpController::class, 'categories'])->name('help.categories.index');
            Route::get('categories/{slug}', [HelpController::class, 'category'])->where($slug)->name('help.categories.show');
            Route::get('articles/{slug}', [HelpController::class, 'article'])->where($slug)->name('help.articles.show');
        });
        Route::get('articles', [HelpController::class, 'search'])->middleware(['perm:base', 'throttle:help-search'])->name('help.articles.index');
        Route::put('articles/{slug}/feedback', [HelpController::class, 'vote'])->where($slug)->middleware(['perm:base', 'throttle:help-feedback'])->name('help.articles.feedback.update');
        Route::delete('articles/{slug}/feedback', [HelpController::class, 'unvote'])->where($slug)->middleware(['perm:base', 'throttle:help-feedback'])->name('help.articles.feedback.destroy');

        Route::get('tickets', [SupportTicketController::class, 'index'])->middleware($m)->name('help.tickets.index');
        Route::post('tickets', [SupportTicketController::class, 'store'])->middleware([$m, 'throttle:support-ticket-create'])->name('help.tickets.store');
        Route::get('tickets/{ticket}', [SupportTicketController::class, 'show'])->where($t)->middleware($m)->name('help.tickets.show');
        Route::get('tickets/{ticket}/messages', [SupportTicketController::class, 'messages'])->where($t)->middleware($m)->name('help.tickets.messages.index');
        Route::post('tickets/{ticket}/messages', [SupportTicketController::class, 'reply'])->where($t)->middleware([$m, 'throttle:support-reply'])->name('help.tickets.messages.store');
        Route::post('tickets/{ticket}/resolve', [SupportTicketController::class, 'resolve'])->where($t)->middleware([$m, 'throttle:support-reply'])->name('help.tickets.resolve');
        Route::put('tickets/{ticket}/rating', [SupportTicketController::class, 'rate'])->where($t)->middleware([$m, 'throttle:support-reply'])->name('help.tickets.rating');

        Route::post('attachments', [SupportAttachmentController::class, 'store'])->middleware([$m, 'throttle:support-upload'])->name('help.attachments.store');
        Route::get('attachments/{attachment}/link', [SupportAttachmentController::class, 'link'])->where($a)->middleware($m)->name('help.attachments.link');
    });

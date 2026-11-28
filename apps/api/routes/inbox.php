<?php

declare(strict_types=1);

// Phase 8.8e (PHASE-8-8E-CONTRACT §13): owned by API. Required from routes/api.php inside the `v1` prefix (NOT inside
// the merchant group): this file declares its own merchant, storefront and webhook groups. The public signed attachment
// download stays in api.php.

use App\Domain\Inbox\Http\Controllers\InboundEmailController;
use App\Domain\Inbox\Http\Controllers\InboxAttachmentController;
use App\Domain\Inbox\Http\Controllers\InboxConversationController;
use App\Domain\Inbox\Http\Controllers\InboxSavedReplyController;
use App\Domain\Inbox\Http\Controllers\InboxSettingsController;
use App\Domain\Inbox\Http\Controllers\StorefrontInboxController;
use App\Domain\Inbox\Http\Controllers\StorefrontOrderMessagesController;
use Illuminate\Support\Facades\Route;

// auth:sanctum + surface + tenant (+ {store} of the tenant, else 404). P88E-3: inbox.manage everywhere; delete also
// customers.delete; the order link also orders.view; channel writes settings.manage. Impersonation → every write 403
// impersonation_read_only (ResolveTenant). Writes: limiter inbox-write 120/min per member.
Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant', 'throttle:merchant'])
    ->prefix('stores/{store}/inbox')->group(function (): void {
        $m = 'perm:inbox.manage';
        $w = 'throttle:inbox-write';
        $c = ['conversation' => '[0-9A-Za-z]{26}'];
        $r = ['saved_reply' => '[0-9A-Za-z]{26}'];
        $a = ['attachment' => '[0-9A-Za-z]{26}'];

        Route::get('summary', [InboxConversationController::class, 'summary'])->middleware($m)->name('stores.inbox.summary');
        Route::get('conversations', [InboxConversationController::class, 'index'])->middleware($m)->name('stores.inbox.conversations.index');
        Route::get('conversations/{conversation}', [InboxConversationController::class, 'show'])->where($c)->middleware($m)->name('stores.inbox.conversations.show');
        Route::delete('conversations/{conversation}', [InboxConversationController::class, 'destroy'])->where($c)->middleware($w)
            ->middleware('perm:inbox.manage,customers.delete')->name('stores.inbox.conversations.destroy');
        Route::get('conversations/{conversation}/messages', [InboxConversationController::class, 'messages'])->where($c)->middleware($m)->name('stores.inbox.conversations.messages.index');
        Route::post('conversations/{conversation}/messages', [InboxConversationController::class, 'send'])->where($c)->middleware($w)->middleware($m)->name('stores.inbox.conversations.messages.store');
        foreach (['assign', 'status', 'block', 'unblock', 'read'] as $action) {
            Route::post("conversations/{conversation}/{$action}", [InboxConversationController::class, $action])->where($c)->middleware($w)->middleware($m)
                ->name("stores.inbox.conversations.{$action}");
        }
        Route::put('conversations/{conversation}/order', [InboxConversationController::class, 'order'])->where($c)->middleware($w)
            ->middleware('perm:inbox.manage,orders.view')->name('stores.inbox.conversations.order');
        Route::post('conversations/{conversation}/saved-replies/{saved_reply}/render', [InboxSavedReplyController::class, 'render'])->where($c + $r)
            ->middleware($w)->middleware($m)->name('stores.inbox.conversations.saved-replies.render');
        Route::get('assignees', [InboxConversationController::class, 'assignees'])->middleware($m)->name('stores.inbox.assignees');

        Route::post('attachments', [InboxAttachmentController::class, 'store'])->middleware('throttle:inbox-upload')->middleware($m)->name('stores.inbox.attachments.store');
        Route::get('attachments/{attachment}/link', [InboxAttachmentController::class, 'link'])->where($a)->middleware($m)->name('stores.inbox.attachments.link');

        Route::get('saved-replies', [InboxSavedReplyController::class, 'index'])->middleware($m)->name('stores.inbox.saved-replies.index');
        Route::post('saved-replies', [InboxSavedReplyController::class, 'store'])->middleware($w)->middleware($m)->name('stores.inbox.saved-replies.store');
        Route::post('saved-replies/reorder', [InboxSavedReplyController::class, 'reorder'])->middleware($w)->middleware($m)->name('stores.inbox.saved-replies.reorder');
        Route::patch('saved-replies/{saved_reply}', [InboxSavedReplyController::class, 'update'])->where($r)->middleware($w)->middleware($m)->name('stores.inbox.saved-replies.update');
        Route::delete('saved-replies/{saved_reply}', [InboxSavedReplyController::class, 'destroy'])->where($r)->middleware($w)->middleware($m)->name('stores.inbox.saved-replies.destroy');

        Route::get('settings', [InboxSettingsController::class, 'show'])->middleware('perm:inbox.manage|settings.manage')->name('stores.inbox.settings.show');
        Route::patch('settings', [InboxSettingsController::class, 'update'])->middleware($w)->middleware('perm:settings.manage')->name('stores.inbox.settings.update');
        Route::post('settings/email-address/rotate', [InboxSettingsController::class, 'rotate'])->middleware($w)->middleware('perm:settings.manage')->name('stores.inbox.settings.rotate');
    });

// §9.2 / §10 storefront (tenant from X-Storefront-Host + X-Storefront-Key).
Route::prefix('storefront')->middleware(['storefront', 'throttle:storefront'])->group(function (): void {
    Route::get('inbox/session', [StorefrontInboxController::class, 'session'])->name('storefront.inbox.session');
    Route::post('inbox/sessions', [StorefrontInboxController::class, 'start'])
        ->middleware(['throttle:inbox-widget-start', 'throttle:inbox-widget-code'])->name('storefront.inbox.sessions.store');
    Route::post('inbox/sessions/verify', [StorefrontInboxController::class, 'verify'])->name('storefront.inbox.sessions.verify');
    Route::post('inbox/sessions/resend', [StorefrontInboxController::class, 'resend'])->middleware('throttle:inbox-widget-code')->name('storefront.inbox.sessions.resend');
    Route::get('inbox/messages', [StorefrontInboxController::class, 'messages'])->name('storefront.inbox.messages.index');
    Route::post('inbox/messages', [StorefrontInboxController::class, 'send'])->middleware('throttle:inbox-widget-message')->name('storefront.inbox.messages.store');
    Route::post('inbox/messages/seen', [StorefrontInboxController::class, 'seen'])->name('storefront.inbox.messages.seen');
    Route::get('inbox/attachments/{attachment}', [StorefrontInboxController::class, 'attachment'])->where('attachment', '[0-9A-Za-z]{26}')->name('storefront.inbox.attachments.show');
    Route::post('inbox/links/{code}', [StorefrontInboxController::class, 'link'])->where('code', '[A-Za-z0-9]{1,64}')->middleware('throttle:inbox-link')->name('storefront.inbox.links.redeem');

    Route::get('orders/access', [StorefrontOrderMessagesController::class, 'access'])->middleware('throttle:order-track')->name('storefront.orders.access');
    Route::get('orders/messages', [StorefrontOrderMessagesController::class, 'messages'])->name('storefront.orders.messages.index');
    Route::post('orders/messages', [StorefrontOrderMessagesController::class, 'send'])->middleware('throttle:inbox-widget-message')->name('storefront.orders.messages.store');
    Route::post('orders/messages/seen', [StorefrontOrderMessagesController::class, 'seen'])->name('storefront.orders.messages.seen');
});

// §11.2 inbound email (public, signature-verified by the driver).
Route::post('webhooks/inbound-email/{driver}', InboundEmailController::class)->where('driver', 'mailgun|fake')
    ->middleware('throttle:webhooks')->name('webhooks.inbound-email');

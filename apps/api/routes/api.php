<?php

use App\Domain\Audit\Http\Controllers\AuditLogController;
use App\Domain\Billing\Http\Controllers\BillingChangeController;
use App\Domain\Billing\Http\Controllers\BillingController;
use App\Domain\Billing\Http\Controllers\BillingInvoiceController;
use App\Domain\Billing\Http\Controllers\BillingReturnController;
use App\Domain\Billing\Http\Controllers\BillingWebhookController;
use App\Domain\Billing\Http\Controllers\DevBillingController;
use App\Domain\Billing\Http\Controllers\FakeBillingGatewayController;
use App\Domain\Cart\Http\StorefrontCartController;
use App\Domain\Catalog\Http\Controllers\CategoryController;
use App\Domain\Catalog\Http\Controllers\ProductController;
use App\Domain\Coupons\Http\CouponController;
use App\Domain\Couriers\Http\Controllers\CourierAccountController;
use App\Domain\Couriers\Http\Controllers\CourierWebhookController;
use App\Domain\Couriers\Http\Controllers\DevShipmentController;
use App\Domain\Couriers\Http\Controllers\ShipmentController;
use App\Domain\Customers\Http\Controllers\CustomerController;
use App\Domain\Dashboard\Http\Controllers\DashboardController;
use App\Domain\DataTransfer\Http\Controllers\ExportController;
use App\Domain\DataTransfer\Http\Controllers\ImportController;
use App\Domain\Documents\Http\DocumentController;
use App\Domain\Domains\Http\DevDomainController;
use App\Domain\Domains\Http\DomainAskController;
use App\Domain\Domains\Http\DomainController;
use App\Domain\Geo\Http\GeoController;
use App\Domain\Identity\Http\Controllers\AccountController;
use App\Domain\Identity\Http\Controllers\AuthController;
use App\Domain\Identity\Http\Controllers\OtpController;
use App\Domain\Inventory\Http\Controllers\InventoryController;
use App\Domain\Media\Http\Controllers\MediaController;
use App\Domain\Navigation\Http\Controllers\NavigationController;
use App\Domain\Orders\Http\OrderChangeController;
use App\Domain\Orders\Http\OrderController;
use App\Domain\Orders\Http\StorefrontOrderController;
use App\Domain\Pages\Http\Controllers\PageController;
use App\Domain\Payments\Http\Controllers\DevPaymentController;
use App\Domain\Payments\Http\Controllers\FakeGatewayController;
use App\Domain\Payments\Http\Controllers\PaymentGatewayController;
use App\Domain\Payments\Http\Controllers\PaymentLinkController;
use App\Domain\Payments\Http\Controllers\PaymentReturnController;
use App\Domain\Payments\Http\Controllers\PaymentWebhookController;
use App\Domain\Payments\Http\Controllers\StorefrontPaymentController;
use App\Domain\Reports\Http\ReportController;
use App\Domain\Returns\Http\ReturnController;
use App\Domain\Shared\Http\HealthController;
use App\Domain\Shipping\Http\ShippingController;
use App\Domain\Staff\Http\Controllers\InvitationAcceptanceController;
use App\Domain\Staff\Http\Controllers\InvitationController;
use App\Domain\Staff\Http\Controllers\StaffController;
use App\Domain\Stores\Http\Controllers\LaunchController;
use App\Domain\Stores\Http\Controllers\PreviewTokenController;
use App\Domain\Stores\Http\Controllers\StoreController;
use App\Domain\Stores\Http\Controllers\StorefrontCatalogController;
use App\Domain\Stores\Http\Controllers\StorefrontConfigController;
use App\Domain\Stores\Http\Controllers\StorefrontPageController;
use App\Domain\Stores\Http\Controllers\StorefrontProductController;
use App\Domain\Stores\Http\Controllers\StoreSettingsController;
use App\Domain\Themes\Http\Controllers\StoreThemeController;
use App\Domain\Themes\Http\Controllers\ThemeCatalogController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function (): void {
    Route::get('health', HealthController::class)->name('health');
    Route::get('plans', [BillingController::class, 'plans'])->name('plans.index');
    Route::get('geo/bd', GeoController::class)->middleware('throttle:geo')->name('geo.bd');

    // --- Merchant auth (same-origin cookie sessions, Phase 4.7; sign-in is stateful-only) ---
    Route::prefix('auth')->group(function (): void {
        Route::post('register', [AuthController::class, 'register'])->middleware(['throttle:register', 'stateful'])->name('auth.register');
        Route::post('login', [AuthController::class, 'login'])->middleware(['throttle:login', 'stateful'])->name('auth.login');
        Route::middleware('throttle:password-reset')->group(function (): void {
            Route::post('forgot-password', [AuthController::class, 'forgotPassword'])->name('auth.forgot-password');
            Route::post('reset-password', [AuthController::class, 'resetPassword'])->name('auth.reset-password');
        });

        // Phone OTP (Addendum A). Per-phone / per-IP limits live in OtpService (429 otp_rate_limited).
        Route::middleware('throttle:otp')->group(function (): void {
            Route::post('otp/send', [OtpController::class, 'send'])->name('auth.otp.send');
            Route::post('login/otp', [OtpController::class, 'login'])->middleware('stateful')->name('auth.login.otp');
            Route::post('reset-password/otp', [OtpController::class, 'resetPassword'])->name('auth.reset-password.otp');
            Route::post('phone/verify', [OtpController::class, 'verifyPhone'])->middleware('auth:sanctum')->name('auth.phone.verify');
        });

        Route::middleware('auth:sanctum')->group(function (): void {
            Route::post('logout', [AuthController::class, 'logout'])->name('auth.logout');
            Route::get('me', [AuthController::class, 'me'])->name('auth.me');
            Route::patch('me', [AccountController::class, 'update'])->name('auth.me.update');
            Route::put('password', [AccountController::class, 'changePassword'])->middleware('stateful')->name('auth.password');
        });
    });

    // --- Staff invitation acceptance (public or Bearer; no tenant header: tenant comes from the token) ---
    Route::middleware('throttle:invitation')->group(function (): void {
        Route::get('invitations/{token}', [InvitationAcceptanceController::class, 'show'])->name('invitations.show');
        Route::post('invitations/{token}/accept', [InvitationAcceptanceController::class, 'accept'])->middleware('stateful')->name('invitations.accept');
    });

    // --- Merchant APIs: authenticated + tenant context from X-Tenant-Id ---
    // Phase 8.1 (P8-1, S68): merchant routes refuse admin-surface sessions.
    Route::middleware(['auth:sanctum', 'surface:merchant,impersonation', 'tenant'])->group(function (): void {
        Route::get('stores', [StoreController::class, 'index'])->name('stores.index');
        Route::post('stores', [StoreController::class, 'store'])->name('stores.store');
        Route::get('stores/{store}', [StoreController::class, 'show'])->name('stores.show');
        Route::get('stores/{store}/settings', [StoreSettingsController::class, 'show'])->name('stores.settings.show');
        Route::patch('stores/{store}/settings', [StoreSettingsController::class, 'update'])->name('stores.settings.update');
        Route::post('stores/{store}/preview-token', PreviewTokenController::class)
            ->middleware('throttle:30,1,stores.preview-token')
            ->name('stores.preview-token');

        // --- Phase 3: storefront engine (themes, pages, navigation) ---
        Route::get('themes', ThemeCatalogController::class)->name('themes.index');
        Route::get('page-templates', [PageController::class, 'templates'])->name('page-templates.index');

        Route::prefix('stores/{store}')->group(function (): void {
            Route::get('themes', [StoreThemeController::class, 'index'])->name('stores.themes.index');
            Route::prefix('themes/{code}')->where(['code' => '[a-z0-9-]{1,64}'])->group(function (): void {
                Route::get('/', [StoreThemeController::class, 'show'])->name('stores.themes.show');
                Route::put('draft', [StoreThemeController::class, 'saveDraft'])->middleware('throttle:120,1,stores.themes.draft')->name('stores.themes.draft');
                Route::middleware('throttle:20,1,stores.themes.publish')->group(function (): void {
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

            // --- Phase 4: catalog, inventory, customers, bulk data, dashboard ---
            Route::middleware('throttle:merchant')->scopeBindings()->group(function (): void {
                Route::get('dashboard', DashboardController::class)->name('stores.dashboard');

                // Phase 7 (7.4): reports in the store timezone (PHASE-7-CONTRACT §6.3).
                Route::get('reports/sales', [ReportController::class, 'sales'])->name('stores.reports.sales');
                Route::get('reports/profit', [ReportController::class, 'profit'])->name('stores.reports.profit');
                Route::get('reports/delivery', [ReportController::class, 'delivery'])->name('stores.reports.delivery');

                Route::get('categories', [CategoryController::class, 'index'])->name('stores.categories.index');
                Route::post('categories', [CategoryController::class, 'store'])->name('stores.categories.store');
                Route::put('categories/order', [CategoryController::class, 'reorder'])->name('stores.categories.reorder');
                Route::get('categories/{category}', [CategoryController::class, 'show'])->name('stores.categories.show');
                Route::patch('categories/{category}', [CategoryController::class, 'update'])->name('stores.categories.update');
                Route::delete('categories/{category}', [CategoryController::class, 'destroy'])->name('stores.categories.destroy');

                Route::get('products', [ProductController::class, 'index'])->name('stores.products.index');
                Route::post('products', [ProductController::class, 'store'])->name('stores.products.store');
                Route::post('products/bulk', [ProductController::class, 'bulk'])->name('stores.products.bulk');
                Route::get('products/{product}', [ProductController::class, 'show'])->name('stores.products.show');
                Route::patch('products/{product}', [ProductController::class, 'update'])->name('stores.products.update');
                Route::delete('products/{product}', [ProductController::class, 'destroy'])->name('stores.products.destroy');
                Route::post('products/{product}/duplicate', [ProductController::class, 'duplicate'])->name('stores.products.duplicate');

                Route::get('inventory', [InventoryController::class, 'index'])->name('stores.inventory.index');
                Route::post('inventory/adjustments', [InventoryController::class, 'adjust'])->name('stores.inventory.adjust');
                Route::get('inventory/movements', [InventoryController::class, 'movements'])->name('stores.inventory.movements');
                Route::patch('inventory/{variant}', [InventoryController::class, 'update'])->name('stores.inventory.update');

                Route::get('customers', [CustomerController::class, 'index'])->name('stores.customers.index');
                Route::post('customers', [CustomerController::class, 'store'])->name('stores.customers.store');
                Route::get('customers/{customer}', [CustomerController::class, 'show'])->name('stores.customers.show');
                Route::patch('customers/{customer}', [CustomerController::class, 'update'])->name('stores.customers.update');
                Route::delete('customers/{customer}', [CustomerController::class, 'destroy'])->name('stores.customers.destroy');
                Route::post('customers/{customer}/notes', [CustomerController::class, 'addNote'])->name('stores.customers.notes.store');
                Route::delete('customers/{customer}/notes/{note}', [CustomerController::class, 'deleteNote'])->name('stores.customers.notes.destroy');

                Route::get('imports/template', [ImportController::class, 'template'])->name('stores.imports.template');
                Route::post('imports', [ImportController::class, 'store'])->middleware('throttle:merchant-bulk')->name('stores.imports.store');
                Route::get('imports/{import}', [ImportController::class, 'show'])->name('stores.imports.show');
                Route::post('imports/{import}/validate', [ImportController::class, 'validateImport'])->name('stores.imports.validate');
                Route::get('imports/{import}/rows', [ImportController::class, 'rows'])->name('stores.imports.rows');
                Route::get('imports/{import}/error-report', [ImportController::class, 'errorReport'])->name('stores.imports.error-report');
                Route::post('imports/{import}/run', [ImportController::class, 'run'])->middleware('throttle:merchant-bulk')->name('stores.imports.run');
                Route::delete('imports/{import}', [ImportController::class, 'destroy'])->name('stores.imports.destroy');
                Route::post('exports', [ExportController::class, 'store'])->middleware('throttle:merchant-bulk')->name('stores.exports.store');
                Route::get('exports/{export}', [ExportController::class, 'show'])->name('stores.exports.show');

                // --- Phase 5a: shipping, coupons, orders, go-live ---
                Route::get('shipping', [ShippingController::class, 'show'])->name('stores.shipping.show');
                Route::put('shipping', [ShippingController::class, 'update'])->name('stores.shipping.update');
                Route::post('pickup-locations', [ShippingController::class, 'storePickup'])->name('stores.pickup-locations.store');
                Route::patch('pickup-locations/{location}', [ShippingController::class, 'updatePickup'])->name('stores.pickup-locations.update');
                Route::delete('pickup-locations/{location}', [ShippingController::class, 'destroyPickup'])->name('stores.pickup-locations.destroy');

                Route::get('coupons', [CouponController::class, 'index'])->name('stores.coupons.index');
                Route::post('coupons', [CouponController::class, 'store'])->name('stores.coupons.store');
                Route::get('coupons/{coupon}', [CouponController::class, 'show'])->name('stores.coupons.show');
                Route::patch('coupons/{coupon}', [CouponController::class, 'update'])->name('stores.coupons.update');
                Route::delete('coupons/{coupon}', [CouponController::class, 'destroy'])->name('stores.coupons.destroy');

                Route::get('orders', [OrderController::class, 'index'])->name('stores.orders.index');
                Route::post('orders/quote', [OrderController::class, 'quote'])->name('stores.orders.quote');
                Route::post('orders/bulk', [OrderController::class, 'bulk'])->name('stores.orders.bulk');
                Route::post('orders', [OrderController::class, 'store'])->middleware('idempotent:orders.create')->name('stores.orders.store');
                Route::get('orders/{order}', [OrderController::class, 'show'])->name('stores.orders.show');
                Route::patch('orders/{order}', [OrderController::class, 'update'])->name('stores.orders.update');
                Route::post('orders/{order}/confirm', [OrderController::class, 'confirm'])->name('stores.orders.confirm');
                Route::post('orders/{order}/ready', [OrderController::class, 'ready'])->name('stores.orders.ready');
                Route::post('orders/{order}/ship', [OrderController::class, 'ship'])->name('stores.orders.ship');
                Route::post('orders/{order}/deliver', [OrderController::class, 'deliver'])->name('stores.orders.deliver');
                Route::post('orders/{order}/return', [OrderController::class, 'return'])->name('stores.orders.return');
                Route::post('orders/{order}/cancel', [OrderController::class, 'cancel'])->name('stores.orders.cancel');
                Route::post('orders/{order}/notes', [OrderController::class, 'addNote'])->name('stores.orders.notes.store');
                Route::post('orders/{order}/refunds', [OrderController::class, 'refund'])->middleware('idempotent:orders.refund')->name('stores.orders.refunds.store');

                // --- Phase 5b-2: payment links (O A S) ---
                Route::get('orders/{order}/payment-links', [PaymentLinkController::class, 'index'])->name('stores.orders.payment-links.index');
                Route::post('orders/{order}/payment-links', [PaymentLinkController::class, 'store'])->middleware('idempotent:payment-links.create')->name('stores.orders.payment-links.store');
                Route::post('orders/{order}/payment-links/{link}/resend', [PaymentLinkController::class, 'resend'])->name('stores.orders.payment-links.resend');
                Route::delete('orders/{order}/payment-links/{link}', [PaymentLinkController::class, 'destroy'])->name('stores.orders.payment-links.destroy');

                // --- Phase 5b-5: order changes (edit items, restock), returns & exchanges ---
                Route::post('orders/{order}/items/quote', [OrderChangeController::class, 'quoteItems'])->name('stores.orders.items.quote');
                Route::put('orders/{order}/items', [OrderChangeController::class, 'updateItems'])->name('stores.orders.items.update');
                Route::post('orders/{order}/restock', [OrderChangeController::class, 'restock'])->name('stores.orders.restock');
                Route::post('orders/{order}/returns', [ReturnController::class, 'store'])->name('stores.orders.returns.store');
                Route::get('returns', [ReturnController::class, 'index'])->name('stores.returns.index');
                Route::get('returns/{return}', [ReturnController::class, 'show'])->name('stores.returns.show');
                Route::post('returns/{return}/approve', [ReturnController::class, 'approve'])->name('stores.returns.approve');
                Route::post('returns/{return}/reject', [ReturnController::class, 'reject'])->name('stores.returns.reject');
                Route::post('returns/{return}/receive', [ReturnController::class, 'receive'])->name('stores.returns.receive');
                Route::post('returns/{return}/close', [ReturnController::class, 'close'])->name('stores.returns.close');
                Route::post('returns/{return}/exchange-order', [ReturnController::class, 'exchangeOrder'])->middleware('idempotent:returns.exchange')->name('stores.returns.exchange-order');
                Route::post('returns/{return}/notes', [ReturnController::class, 'addNote'])->name('stores.returns.notes.store');

                // --- Phase 5b-4: documents (invoices, receipts, packing slips, courier labels) ---
                Route::get('document-templates', [DocumentController::class, 'templates'])->name('stores.document-templates.index');
                Route::put('document-templates/{kind}', [DocumentController::class, 'updateTemplate'])
                    ->where('kind', 'invoice_a4|receipt_80mm|invoice_a5_two_up|packing_slip|label_4x6')->name('stores.document-templates.update');
                Route::post('documents', [DocumentController::class, 'store'])->name('stores.documents.store');
                Route::post('documents/preview', [DocumentController::class, 'preview'])->middleware('throttle:30,1,stores.documents.preview')->name('stores.documents.preview');
                Route::get('documents/{document}', [DocumentController::class, 'show'])->name('stores.documents.show');

                // --- Phase 5b-3: shipments (courier booking, list, detail, sync; O A S) ---
                Route::post('orders/{order}/shipments', [ShipmentController::class, 'store'])->middleware('idempotent:shipments.book')->name('stores.orders.shipments.store');
                Route::post('shipments/bulk', [ShipmentController::class, 'bulk'])->middleware('throttle:20,1,stores.shipments.bulk')->name('stores.shipments.bulk');
                Route::get('shipment-batches/{batch}', [ShipmentController::class, 'batch'])->where('batch', '[0-9A-Za-z]{26}')->name('stores.shipment-batches.show');
                Route::get('shipments', [ShipmentController::class, 'index'])->name('stores.shipments.index');
                Route::post('shipments/sync', [ShipmentController::class, 'syncNow'])->name('stores.shipments.sync');
                Route::get('shipments/{shipment}', [ShipmentController::class, 'show'])->where('shipment', '[0-9A-Za-z]{26}')->name('stores.shipments.show');
                Route::post('shipments/{shipment}/refresh', [ShipmentController::class, 'refresh'])->where('shipment', '[0-9A-Za-z]{26}')->name('stores.shipments.refresh');
                Route::post('shipments/{shipment}/cancel', [ShipmentController::class, 'cancel'])->where('shipment', '[0-9A-Za-z]{26}')->name('stores.shipments.cancel');
                Route::post('shipments/{shipment}/mark-cancelled', [ShipmentController::class, 'markCancelled'])->where('shipment', '[0-9A-Za-z]{26}')->name('stores.shipments.mark-cancelled');

                // --- Phase 5b-2: payment gateways (reads O A S, writes O A ManageIntegrations) ---
                Route::get('payment-gateways', [PaymentGatewayController::class, 'index'])->name('stores.payment-gateways.index');
                Route::put('payment-gateways/{provider}', [PaymentGatewayController::class, 'connect'])->where('provider', 'bkash|sslcommerz')
                    ->middleware('throttle:20,1,stores.payment-gateways.connect')->name('stores.payment-gateways.connect');
                Route::patch('payment-gateways/{provider}', [PaymentGatewayController::class, 'update'])->where('provider', 'bkash|sslcommerz')->name('stores.payment-gateways.update');
                Route::delete('payment-gateways/{provider}', [PaymentGatewayController::class, 'disconnect'])->where('provider', 'bkash|sslcommerz')->name('stores.payment-gateways.disconnect');
                Route::post('payment-gateways/{provider}/test-payment', [PaymentGatewayController::class, 'testPayment'])->where('provider', 'bkash|sslcommerz')
                    ->middleware(['throttle:20,1,stores.payment-gateways.test-payment', 'idempotent:payment-gateways.test'])->name('stores.payment-gateways.test-payment');

                // --- Phase 5b-3: couriers (reads O A S, writes O A ManageIntegrations) ---
                Route::get('couriers', [CourierAccountController::class, 'index'])->name('stores.couriers.index');
                Route::put('couriers/{provider}', [CourierAccountController::class, 'connect'])->where('provider', 'steadfast|pathao|redx')
                    ->middleware('throttle:20,1,stores.couriers.connect')->name('stores.couriers.connect');
                Route::patch('couriers/{provider}', [CourierAccountController::class, 'update'])->where('provider', 'steadfast|pathao|redx')->name('stores.couriers.update');
                Route::delete('couriers/{provider}', [CourierAccountController::class, 'disconnect'])->where('provider', 'steadfast|pathao|redx')->name('stores.couriers.disconnect');
                Route::post('couriers/{provider}/test', [CourierAccountController::class, 'test'])->where('provider', 'steadfast|pathao|redx')
                    ->middleware('throttle:20,1,stores.couriers.test')->name('stores.couriers.test');
                Route::post('couriers/{provider}/webhook-secret', [CourierAccountController::class, 'rotateWebhookSecret'])->where('provider', 'steadfast|pathao|redx')
                    ->middleware('throttle:20,1,stores.couriers.webhook-secret')->name('stores.couriers.webhook-secret');
                Route::get('couriers/{provider}/areas', [CourierAccountController::class, 'areas'])->where('provider', 'steadfast|pathao|redx')
                    ->middleware('throttle:120,1,stores.couriers.areas')->name('stores.couriers.areas');
                Route::get('couriers/{provider}/pickup-stores', [CourierAccountController::class, 'pickupStores'])->where('provider', 'steadfast|pathao|redx')
                    ->middleware('throttle:30,1,stores.couriers.pickup-stores')->name('stores.couriers.pickup-stores');

                // --- Phase 6: custom domains (reads O A S, writes O A ManageDomains; PHASE-6 §4.1) ---
                Route::get('domains', [DomainController::class, 'index'])->name('stores.domains.index');
                Route::post('domains', [DomainController::class, 'store'])->middleware('throttle:domains')->name('stores.domains.store');
                Route::get('domains/{domain}', [DomainController::class, 'show'])->where('domain', '[0-9A-Za-z]{26}')->name('stores.domains.show');
                Route::delete('domains/{domain}', [DomainController::class, 'destroy'])->where('domain', '[0-9A-Za-z]{26}')
                    ->middleware('throttle:domains')->name('stores.domains.destroy');
                Route::post('domains/{domain}/verify', [DomainController::class, 'verify'])->where('domain', '[0-9A-Za-z]{26}')
                    ->middleware('throttle:domains')->name('stores.domains.verify');
                Route::post('domains/{domain}/primary', [DomainController::class, 'primary'])->where('domain', '[0-9A-Za-z]{26}')
                    ->middleware('throttle:domains')->name('stores.domains.primary');

                Route::get('launch-checklist', [LaunchController::class, 'checklist'])->name('stores.launch-checklist');
                Route::post('publish', [LaunchController::class, 'publish'])->middleware('throttle:20,1,stores.publish')->name('stores.publish');
            });
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
        Route::post('media', [MediaController::class, 'store'])->middleware('throttle:60,1,media.store')->name('media.store');
        Route::get('media/{media}', [MediaController::class, 'show'])->name('media.show');
        Route::delete('media/{media}', [MediaController::class, 'destroy'])->name('media.destroy');

        Route::get('subscription', [BillingController::class, 'subscription'])->name('subscription.show');
        Route::get('features', [BillingController::class, 'features'])->name('features.index');

        // --- Phase 7 (7.2): platform billing (PHASE-7-CONTRACT §6.1; tenant-level, no {store}) ---
        Route::prefix('billing')->group(function (): void {
            Route::middleware('throttle:billing')->group(function (): void {
                Route::post('quote', [BillingChangeController::class, 'quote'])->name('billing.quote');
                Route::post('change-plan', [BillingChangeController::class, 'change'])->name('billing.change-plan');
                Route::delete('scheduled-change', [BillingChangeController::class, 'cancelScheduled'])->name('billing.scheduled-change.destroy');
                Route::post('invoices/{invoice}/pay', [BillingInvoiceController::class, 'pay'])->name('billing.invoices.pay');
            });
            Route::middleware('throttle:merchant')->group(function (): void {
                Route::get('invoices', [BillingInvoiceController::class, 'index'])->name('billing.invoices.index');
                Route::get('invoices/{invoice}', [BillingInvoiceController::class, 'show'])->name('billing.invoices.show');
                Route::get('invoices/{invoice}/pdf', [BillingInvoiceController::class, 'pdf'])->name('billing.invoices.pdf');
                Route::get('payments/{payment}', [BillingInvoiceController::class, 'payment'])->name('billing.payments.show');
            });
        });
        // Phase 7 (§4.6): TESTING-ONLY billing clock (404 unless BILLING_FAKE=true; never registered in production).
        if (! app()->environment('production')) {
            Route::post('dev/billing/clock', DevBillingController::class)->middleware('throttle:60,1,dev.billing')->name('dev.billing.clock');
        }

        Route::get('audit-logs', AuditLogController::class)->name('audit-logs.index');
    });

    // --- Public storefront API (server-to-server; tenant from validated X-Storefront-Host) ---
    Route::prefix('storefront')->middleware(['storefront', 'throttle:storefront'])->group(function (): void {
        Route::get('config', StorefrontConfigController::class)->name('storefront.config');
        Route::get('pages', [StorefrontPageController::class, 'index'])->name('storefront.pages.index');
        Route::get('pages/{slug}', [StorefrontPageController::class, 'show'])->name('storefront.pages.show');
        Route::get('products', StorefrontProductController::class)->name('storefront.products');

        // --- Phase 5a: PDP, availability, categories, cart, checkout, confirmation, tracking ---
        Route::get('products/{slug}', [StorefrontCatalogController::class, 'product'])->where('slug', '[a-z0-9-]{1,220}')->name('storefront.products.show');
        Route::get('products/{slug}/availability', [StorefrontCatalogController::class, 'availability'])->where('slug', '[a-z0-9-]{1,220}')->name('storefront.products.availability');
        Route::get('categories', [StorefrontCatalogController::class, 'categories'])->name('storefront.categories.index');
        Route::get('categories/{slug}', [StorefrontCatalogController::class, 'category'])->where('slug', '[a-z0-9-]{1,140}')->name('storefront.categories.show');

        Route::middleware('throttle:cart')->group(function (): void {
            Route::get('cart', [StorefrontCartController::class, 'show'])->name('storefront.cart.show');
            Route::post('cart/items', [StorefrontCartController::class, 'addItem'])->name('storefront.cart.items.store');
            Route::patch('cart/items/{item}', [StorefrontCartController::class, 'updateItem'])->name('storefront.cart.items.update');
            Route::delete('cart/items/{item}', [StorefrontCartController::class, 'removeItem'])->name('storefront.cart.items.destroy');
            Route::put('cart/coupon', [StorefrontCartController::class, 'applyCoupon'])->name('storefront.cart.coupon.update');
            Route::delete('cart/coupon', [StorefrontCartController::class, 'removeCoupon'])->name('storefront.cart.coupon.destroy');
            Route::get('cart/shipping-options', [StorefrontCartController::class, 'shippingOptions'])->name('storefront.cart.shipping-options');
            Route::get('orders/confirmation', [StorefrontOrderController::class, 'confirmation'])->name('storefront.orders.confirmation');
        });
        Route::post('checkout', [StorefrontOrderController::class, 'checkout'])
            ->middleware(['throttle:checkout', 'idempotent:storefront.checkout'])->name('storefront.checkout');
        Route::post('orders/track', [StorefrontOrderController::class, 'track'])->middleware('throttle:order-track')->name('storefront.orders.track');

        // --- Phase 5b-2: online payments (retry / switch to COD, result polling, payment links) ---
        Route::post('orders/pay', [StorefrontPaymentController::class, 'pay'])
            ->middleware(['throttle:checkout', 'idempotent:storefront.pay'])->name('storefront.orders.pay');
        Route::get('payments/{payment}/result', [StorefrontPaymentController::class, 'result'])->name('storefront.payments.result');
        Route::middleware('throttle:pay-link')->group(function (): void {
            Route::get('payment-links/{token}', [StorefrontPaymentController::class, 'showLink'])->name('storefront.payment-links.show');
            Route::post('payment-links/{token}/pay', [StorefrontPaymentController::class, 'payLink'])
                ->middleware('idempotent:storefront.link-pay')->name('storefront.payment-links.pay');
        });
    });

    // Phase 5b-2 (§4.3): gateway browser returns (signed 26 h; tenant from the payment id) and provider webhooks
    // (tenant from the route key). Public; no tenant header; responses carry no tenant data.
    Route::match(['GET', 'POST'], 'payments/return/{provider}/{payment}', PaymentReturnController::class)
        ->where(['provider' => 'bkash|sslcommerz', 'payment' => '[0-9A-Za-z]{26}'])->middleware('throttle:payment-returns')->name('payments.return');
    // Phase 7 (§6.2, B22/B23): platform billing returns (signed 26 h; tenant from the payment id) and the ONE platform
    // SSLCommerz IPN. Public; no tenant header; no CSRF; answers carry no tenant data.
    Route::match(['GET', 'POST'], 'billing/payments/return/{provider}/{payment}', BillingReturnController::class)
        ->where(['provider' => 'bkash|sslcommerz', 'payment' => '[0-9A-Za-z]{26}'])->middleware('throttle:payment-returns')->name('billing.payments.return');
    Route::post('billing/webhooks/sslcommerz', [BillingWebhookController::class, 'sslcommerz'])->middleware('throttle:webhooks')->name('billing.webhooks.sslcommerz');

    Route::middleware('throttle:webhooks')->group(function (): void {
        Route::post('webhooks/sslcommerz/{routeKey}', [PaymentWebhookController::class, 'sslcommerz'])->where('routeKey', '[A-Za-z0-9]{32}')->name('webhooks.sslcommerz');
        Route::post('webhooks/bkash/{routeKey}', [PaymentWebhookController::class, 'bkash'])->where('routeKey', '[A-Za-z0-9]{32}')->name('webhooks.bkash');
        // Phase 5b-3 (P5B-37): courier webhooks (Steadfast bearer, Pathao X-PATHAO-Signature; RedX 404 until verified).
        Route::post('webhooks/{provider}/{routeKey}', CourierWebhookController::class)
            ->where(['provider' => 'steadfast|pathao|redx', 'routeKey' => '[A-Za-z0-9]{32}'])->name('webhooks.couriers');
    });
    // Phase 5b-2: TESTING-ONLY time travel for the expiry e2e (404 unless PAYMENTS_FAKE=true; never in production).
    if (! app()->environment('production')) {
        Route::post('dev/payments/{payment}/expire-now', [DevPaymentController::class, 'expireNow'])
            ->where('payment', '[0-9A-Za-z]{26}')->middleware('throttle:60,1,dev.payments.expire-now')->name('dev.payments.expire-now');
    }

    // Phase 5b-3: TESTING-ONLY fake courier event (404 unless COURIERS_FAKE=true; never registered in production).
    if (! app()->environment('production')) {
        Route::post('dev/shipments/{shipment}/advance', DevShipmentController::class)
            ->where('shipment', '[0-9A-Za-z]{26}')->middleware('throttle:60,1,dev.shipments.advance')->name('dev.shipments.advance');
    }

    // Phase 6 (P6-17, roadmap 6.5): Caddy `ask` allowlist. Internal network only (never through the public Nginx);
    // shared key in the query string (never logged); no tenant header, no session.
    Route::get('internal/domains/allowed', DomainAskController::class)->middleware('throttle:domains-ask')->name('internal.domains.allowed');

    // Phase 6: TESTING-ONLY fake DNS / provider / clock for custom domains (404 unless DOMAINS_FAKE=true; never in production).
    if (! app()->environment('production')) {
        Route::prefix('dev/domains/{domain}')->where(['domain' => '[0-9A-Za-z]{26}'])->middleware('throttle:60,1,dev.domains')->group(function (): void {
            Route::post('dns', [DevDomainController::class, 'dns'])->name('dev.domains.dns');
            Route::post('provider', [DevDomainController::class, 'provider'])->name('dev.domains.provider');
            Route::post('age', [DevDomainController::class, 'age'])->name('dev.domains.age');
        });
    }

    // Phase 5b-4: signed 5-minute document download (PDF; HTML with DOCUMENTS_DRIVER=html). Tenant from the signature.
    // Phase 5b-2 (P5B-29): fake hosted payment page. Never registered in production; 404 unless PAYMENTS_FAKE=true.
    if (! app()->environment('production')) {
        Route::get('dev/fake-gateway/{payment}', [FakeGatewayController::class, 'show'])
            ->middleware(['signed', 'throttle:60,1,dev.fake-gateway.show'])->name('dev.fake-gateway.show');
        Route::post('dev/fake-gateway/{payment}/{outcome}', [FakeGatewayController::class, 'outcome'])->where('outcome', 'pay|fail|cancel')
            ->middleware(['signed', 'throttle:60,1,dev.fake-gateway.outcome'])->name('dev.fake-gateway.outcome');
    }

    // Phase 7 (P7-20): fake hosted billing payment page. Never registered in production; 404 unless BILLING_FAKE=true.
    if (! app()->environment('production')) {
        Route::get('dev/fake-billing-gateway/{payment}', [FakeBillingGatewayController::class, 'show'])
            ->middleware(['signed:relative', 'throttle:60,1,dev.fake-billing-gateway.show'])->name('dev.fake-billing-gateway.show');
        Route::post('dev/fake-billing-gateway/{payment}/{outcome}', [FakeBillingGatewayController::class, 'outcome'])
            ->where('outcome', 'pay|wrong_amount|fail|cancel|timeout')
            ->middleware(['signed:relative', 'throttle:60,1,dev.fake-billing-gateway.outcome'])->name('dev.fake-billing-gateway.outcome');
    }

    Route::get('documents/{document}/download', [DocumentController::class, 'download'])
        ->middleware(['signed', 'throttle:60,1,documents.download'])->name('documents.download');

    // Phase 4: signed 5-minute export download for local/private disks (S3 uses its own pre-signed URL).
    Route::get('exports/{export}/download', [ExportController::class, 'download'])
        ->middleware(['signed', 'throttle:60,1,exports.download'])->name('exports.download');
    // Phase 8.1 (PHASE-8-1-CONTRACT §6): one file per owner agent.
    require __DIR__.'/admin.php';
    require __DIR__.'/admin-merchants.php';
    require __DIR__.'/impersonation.php';
});

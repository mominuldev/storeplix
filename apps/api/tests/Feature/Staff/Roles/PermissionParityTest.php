<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Customers\Models\CustomerNote;
use App\Domain\Developer\Webhooks\Sending\HostResolver;
use App\Domain\Documents\TemplateConfig;
use App\Domain\Help\HelpArticleService;
use App\Domain\Help\HelpCategoryService;
use App\Domain\Identity\Models\User;
use App\Domain\Inbox\ConversationService;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Themes\ThemeRegistry;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Routing\Route;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Developer\Webhooks\FakeHostResolver;
use Tests\Support\BillingFixtures;
use Tests\Support\OnlinePaymentFixtures;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/**
 * PHASE-8-3 §10 "PermissionParityTest" (AC 2): the status code of every merchant tenant route for owner, admin and
 * staff, recorded on the pre-8.3 code (tests/Fixtures/permission-parity.json) and compared after the refactor.
 *
 * One seeded Growth shop; every case runs inside a savepoint that is rolled back, so each request sees the same state
 * (no state leaks between roles or cases). Throttles are off: parity is about authorization, not rate limits.
 *
 * Re-record ONLY on unchanged authorization code: `PARITY_RECORD=1 php artisan test --filter=PermissionParityTest`.
 */
#[Group('roles')]
class PermissionParityTest extends TestCase
{
    use BillingFixtures, OnlinePaymentFixtures, RefreshDatabase, ShipmentFixtures {
        OnlinePaymentFixtures::orderRow insteadof ShipmentFixtures;
        BillingFixtures::api insteadof ShipmentFixtures, OnlinePaymentFixtures;
        BillingFixtures::shop insteadof ShipmentFixtures, OnlinePaymentFixtures;
        BillingFixtures::member insteadof ShipmentFixtures, OnlinePaymentFixtures;
        BillingFixtures::simpleProduct insteadof ShipmentFixtures, OnlinePaymentFixtures;
        BillingFixtures::variableProduct insteadof ShipmentFixtures, OnlinePaymentFixtures;
        BillingFixtures::createProduct insteadof ShipmentFixtures, OnlinePaymentFixtures;
        BillingFixtures::productImage insteadof ShipmentFixtures, OnlinePaymentFixtures;
        BillingFixtures::assertStoreIsolation insteadof ShipmentFixtures, OnlinePaymentFixtures;
        ShipmentFixtures::liveShop insteadof OnlinePaymentFixtures;
        ShipmentFixtures::stocked insteadof OnlinePaymentFixtures;
        ShipmentFixtures::host insteadof OnlinePaymentFixtures;
        ShipmentFixtures::sf insteadof OnlinePaymentFixtures;
        ShipmentFixtures::cartWith insteadof OnlinePaymentFixtures;
        ShipmentFixtures::checkoutBody insteadof OnlinePaymentFixtures;
        ShipmentFixtures::checkout insteadof OnlinePaymentFixtures;
        ShipmentFixtures::placeOrder insteadof OnlinePaymentFixtures;
        ShipmentFixtures::manualBody insteadof OnlinePaymentFixtures;
        ShipmentFixtures::manual insteadof OnlinePaymentFixtures;
    }

    public const FIXTURE = __DIR__.'/../../../Fixtures/permission-parity.json';

    public const ROLES = [TenantUser::ROLE_OWNER, TenantUser::ROLE_ADMIN, TenantUser::ROLE_STAFF];

    /** Routes added by Phase 8.3 (not in the pre-8.3 fixture): staff.manage → O and A allowed, S 403. */
    public const NEW_ROUTES = [
        'GET api/v1/permissions' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/roles' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/roles' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/roles/{role}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PATCH api/v1/roles/{role}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/roles/{role}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        // Phase 8.4 (PHASE-8-4 §6.1): developers.manage → O and A allowed, S 403.
        'GET api/v1/api-keys' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/api-keys' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'PATCH api/v1/api-keys/{key}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/api-keys/{key}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/api-scopes' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/webhook-event-types' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/webhook-endpoints' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/webhook-endpoints' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'PATCH api/v1/stores/{store}/webhook-endpoints/{endpoint}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/stores/{store}/webhook-endpoints/{endpoint}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'POST api/v1/stores/{store}/webhook-endpoints/{endpoint}/test' => ['owner' => 202, 'admin' => 202, 'staff' => 403],
        'GET api/v1/stores/{store}/webhook-secret' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/webhook-secret/reveal' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/webhook-secret/rotate' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/webhook-deliveries' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/webhook-deliveries/{delivery}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/webhook-deliveries/{delivery}/resend' => ['owner' => 202, 'admin' => 202, 'staff' => 403],
        'POST api/v1/stores/{store}/webhook-deliveries/resend-failed' => ['owner' => 202, 'admin' => 202, 'staff' => 403],
        'GET api/v1/dev/webhook-sink' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        // Phase 8.5 (PHASE-8-5 §6.1): marketing.manage → O and A allowed, S 403; recipients also need customers.view;
        // the opt-out toggle is customers.edit (staff has it). The dev sink is off in tests (404 past the perm check).
        'GET api/v1/stores/{store}/marketing/overview' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/campaigns' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns/audience-preview' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns/estimate' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/campaigns/{campaign}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PATCH api/v1/stores/{store}/campaigns/{campaign}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/stores/{store}/campaigns/{campaign}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns/{campaign}/test' => ['owner' => 202, 'admin' => 202, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns/{campaign}/schedule' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns/{campaign}/send' => ['owner' => 202, 'admin' => 202, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns/{campaign}/unschedule' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns/{campaign}/cancel' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/campaigns/{campaign}/duplicate' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/stores/{store}/campaigns/{campaign}/recipients' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/customers/{customer}/marketing-opt-out' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'DELETE api/v1/stores/{store}/customers/{customer}/marketing-opt-out/{channel}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/dev/stores/{store}/message-sink' => ['owner' => 404, 'admin' => 404, 'staff' => 403],
        // Phase 8.6 (PHASE-8-6 §2.1, §9.1): marketing.manage → O and A allowed, S 403.
        'GET api/v1/stores/{store}/automations' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/automations' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/stores/{store}/automations/{automation}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PATCH api/v1/stores/{store}/automations/{automation}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/stores/{store}/automations/{automation}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'POST api/v1/stores/{store}/automations/{automation}/enable' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/automations/{automation}/disable' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/automations/{automation}/dry-run' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/automations/{automation}/test-message' => ['owner' => 202, 'admin' => 202, 'staff' => 403],
        'GET api/v1/stores/{store}/automations/{automation}/stats' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/automation-runs' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/automation-runs/{run}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        // Phase 8.7 (PHASE-8-7 §2.1, §8.1): expenses.manage → O and A allowed, S 403.
        'GET api/v1/stores/{store}/expenses' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/expenses' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/stores/{store}/expenses/summary' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/expenses/export' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/expenses/receipts' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/stores/{store}/expenses/{expense}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PATCH api/v1/stores/{store}/expenses/{expense}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/stores/{store}/expenses/{expense}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'GET api/v1/stores/{store}/expenses/{expense}/receipt' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        // Phase 8.8a (PHASE-8-8 §2.1, §8.1): fraud.manage → O and A allowed, S 403; the hold release is orders.process.
        'GET api/v1/stores/{store}/fraud-guard/settings' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PATCH api/v1/stores/{store}/fraud-guard/settings' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/fraud-guard/settings/reset' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/fraud-guard/overview' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/fraud-guard/events' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/fraud-guard/blocked-numbers' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/fraud-guard/blocked-numbers' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'DELETE api/v1/stores/{store}/fraud-guard/blocked-numbers/{entry}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'POST api/v1/stores/{store}/fraud-guard/check' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/orders/{order}/guard/release' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        // Phase 8.8b (PHASE-8-8B §2.1, §8.1): purchasing.manage → O and A, S 403; PO list/detail, receipts and invoice
        // upload also with inventory.adjust (staff has it, P88B-11).
        'GET api/v1/stores/{store}/suppliers' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/suppliers/summary' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/suppliers' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/stores/{store}/suppliers/{supplier}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PATCH api/v1/stores/{store}/suppliers/{supplier}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/stores/{store}/suppliers/{supplier}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'POST api/v1/stores/{store}/suppliers/{supplier}/archive' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/suppliers/{supplier}/unarchive' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/suppliers/{supplier}/payments' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/suppliers/{supplier}/payments' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'DELETE api/v1/stores/{store}/supplier-payments/{payment}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'GET api/v1/stores/{store}/purchase-orders' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/purchase-orders/summary' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/purchase-orders' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'POST api/v1/stores/{store}/purchase-orders/quick' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/stores/{store}/purchase-orders/{purchase_order}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'PATCH api/v1/stores/{store}/purchase-orders/{purchase_order}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/stores/{store}/purchase-orders/{purchase_order}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/send' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/mark-ordered' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/close' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/cancel' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/receipts' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'GET api/v1/stores/{store}/purchase-orders/{purchase_order}/pdf' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/purchasing/reorder-suggestions' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/purchasing/invoices' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        // Phase 8.8c part A (PHASE-8-8C §2.1, §9): locations read for every member, writes settings.manage (S 403).
        'GET api/v1/stores/{store}/locations' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/locations' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'PATCH api/v1/stores/{store}/locations/{location}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/locations/{location}/archive' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/locations/{location}/unarchive' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/locations/{location}/make-default' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        // Phase 8.8c part B (PHASE-8-8C §2.1, §9): reads every member, writes inventory.adjust (staff has it).
        'GET api/v1/stores/{store}/stock-transfers' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/stock-transfers/summary' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/stock-transfers' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'GET api/v1/stores/{store}/stock-transfers/{transfer}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'PATCH api/v1/stores/{store}/stock-transfers/{transfer}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'DELETE api/v1/stores/{store}/stock-transfers/{transfer}' => ['owner' => 204, 'admin' => 204, 'staff' => 204],
        'POST api/v1/stores/{store}/stock-transfers/{transfer}/send' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/stock-transfers/{transfer}/receive' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/stock-transfers/{transfer}/cancel' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/stock-counts' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/stock-counts' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'GET api/v1/stores/{store}/stock-counts/{count}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/stock-counts/{count}/lines' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'PUT api/v1/stores/{store}/stock-counts/{count}/lines/{line}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/stock-counts/{count}/scan' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/stock-counts/{count}/finish' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/stock-counts/{count}/cancel' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        // Phase 8.8d part A (PHASE-8-8D §2.1, §10): POS needs pos.sell (staff has it); register writes settings.manage (S 403).
        'GET api/v1/stores/{store}/pos/registers' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/pos/registers' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'PATCH api/v1/stores/{store}/pos/registers/{register}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/pos/registers/{register}/archive' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/pos/registers/{register}/unarchive' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/pos/registers/{register}/open' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'GET api/v1/stores/{store}/pos/sessions/{session}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/pos/sessions/{session}/close' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/pos/catalog' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/pos/lookup' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/pos/customers/lookup' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/pos/quote' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/pos/sales' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'GET api/v1/stores/{store}/pos/sales/{sale}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/pos/sales/{sale}/sms-receipt' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        // Phase 8.8d part B: returns also need orders.refund (S 403); held sales and history pos.sell.
        'GET api/v1/stores/{store}/pos/sales' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/pos/sales/{sale}/returns' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/stores/{store}/pos/held-sales' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/pos/held-sales' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'GET api/v1/stores/{store}/pos/held-sales/{held}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'DELETE api/v1/stores/{store}/pos/held-sales/{held}' => ['owner' => 204, 'admin' => 204, 'staff' => 204],
        // Phase 8.9a (PHASE-8-9A §2, §10.1, P89A-25): Admin (Manager) has settings.manage, integrations.manage and
        // billing.view → everything except the purchase; Staff has none of them. A pending sender-ID request is seeded,
        // so a new request answers 409 sender_id_request_pending.
        'GET api/v1/stores/{store}/sms' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/sms/test' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/sms/templates' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/sms/templates/preview' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PUT api/v1/stores/{store}/sms/templates/{key}/{language}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'DELETE api/v1/stores/{store}/sms/templates/{key}/{language}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/sms/sender-ids' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/sms/sender-ids' => ['owner' => 409, 'admin' => 409, 'staff' => 403],
        'POST api/v1/stores/{store}/sms/sender-ids/{sender_id}/cancel' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/stores/{store}/sms/messages' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/billing/sms-credits' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PATCH api/v1/billing/sms-credits' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/billing/sms-credits/ledger' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/billing/sms-credits/purchase' => ['owner' => 201, 'admin' => 403, 'staff' => 403],
        // Phase 8.8e (PHASE-8-8E §2, §13.1, P88E-3): Staff holds inbox.manage (and orders.view) but not customers.delete or
        // settings.manage → delete conversation and channel writes 403 for staff.
        'GET api/v1/stores/{store}/inbox/summary' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/inbox/conversations' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/inbox/conversations/{conversation}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'DELETE api/v1/stores/{store}/inbox/conversations/{conversation}' => ['owner' => 204, 'admin' => 204, 'staff' => 403],
        'GET api/v1/stores/{store}/inbox/conversations/{conversation}/messages' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/inbox/conversations/{conversation}/messages' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'POST api/v1/stores/{store}/inbox/conversations/{conversation}/assign' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/inbox/conversations/{conversation}/status' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/inbox/conversations/{conversation}/block' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/inbox/conversations/{conversation}/unblock' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/inbox/conversations/{conversation}/read' => ['owner' => 204, 'admin' => 204, 'staff' => 204],
        'PUT api/v1/stores/{store}/inbox/conversations/{conversation}/order' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/inbox/conversations/{conversation}/saved-replies/{saved_reply}/render' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/inbox/assignees' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/inbox/attachments' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'GET api/v1/stores/{store}/inbox/attachments/{attachment}/link' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/stores/{store}/inbox/saved-replies' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'POST api/v1/stores/{store}/inbox/saved-replies' => ['owner' => 201, 'admin' => 201, 'staff' => 201],
        'POST api/v1/stores/{store}/inbox/saved-replies/reorder' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'PATCH api/v1/stores/{store}/inbox/saved-replies/{saved_reply}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'DELETE api/v1/stores/{store}/inbox/saved-replies/{saved_reply}' => ['owner' => 204, 'admin' => 204, 'staff' => 204],
        'GET api/v1/stores/{store}/inbox/settings' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'PATCH api/v1/stores/{store}/inbox/settings' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/stores/{store}/inbox/settings/email-address/rotate' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        // Phase 8.9c (PHASE-8-9C §2.1, P89C-13): guides for every member; tickets need support.manage (Owner, Admin).
        'GET api/v1/help/home' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/help/categories' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/help/categories/{slug}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/help/articles' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'GET api/v1/help/articles/{slug}' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'PUT api/v1/help/articles/{slug}/feedback' => ['owner' => 200, 'admin' => 200, 'staff' => 200],
        'DELETE api/v1/help/articles/{slug}/feedback' => ['owner' => 204, 'admin' => 204, 'staff' => 204],
        'GET api/v1/help/tickets' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/help/tickets' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/help/tickets/{ticket}' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'GET api/v1/help/tickets/{ticket}/messages' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/help/tickets/{ticket}/messages' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'POST api/v1/help/tickets/{ticket}/resolve' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'PUT api/v1/help/tickets/{ticket}/rating' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
        'POST api/v1/help/attachments' => ['owner' => 201, 'admin' => 201, 'staff' => 403],
        'GET api/v1/help/attachments/{attachment}/link' => ['owner' => 200, 'admin' => 200, 'staff' => 403],
    ];

    /** @var array<string, mixed> */
    private array $s = [];

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        config(['couriers.fake' => true, 'payments.fake' => true, 'webhooks_out.fake' => true]);
        $this->app->instance(HostResolver::class, new FakeHostResolver(['hooks.example.com' => ['93.184.216.34']]));
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    public function test_owner_admin_and_staff_get_the_recorded_status_on_every_merchant_route(): void
    {
        $this->seedShop();
        $cases = $this->cases();

        // Every merchant tenant route has a case (and every case is a real route).
        $routes = self::tenantRoutes();
        $this->assertSame([], array_values(array_diff($routes, array_keys($cases))), 'tenant routes without a parity case');
        $this->assertSame([], array_values(array_diff(array_keys($cases), $routes)), 'parity cases without a route');

        $actual = [];
        $detail = [];
        foreach ($cases as $key => $case) {
            foreach (self::ROLES as $role) {
                $response = $this->runCase($case, $this->s['headers'][$role]);
                $actual[$key][$role] = $response->status();
                $detail[$key][$role] = $response->status().' '.self::errorCode($response);
            }
        }
        ksort($actual);

        if (getenv('PARITY_RECORD') === '1') {
            $actual = array_diff_key($actual, self::NEW_ROUTES);
            file_put_contents(self::FIXTURE, json_encode($actual, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)."\n");
            if (($dump = getenv('PARITY_DETAIL')) !== false && $dump !== '') {
                ksort($detail);
                file_put_contents($dump, json_encode($detail, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)."\n");
            }
            $this->markTestIncomplete('Recorded '.count($actual).' routes to '.self::FIXTURE);
        }

        $this->assertFileExists(self::FIXTURE);
        $expected = json_decode((string) file_get_contents(self::FIXTURE), true) + self::NEW_ROUTES;
        ksort($expected);
        $diff = [];
        foreach ($expected as $key => $codes) {
            foreach ($codes as $role => $code) {
                if (($actual[$key][$role] ?? null) !== $code) {
                    $diff[] = "{$key} [{$role}] expected {$code}, got ".($detail[$key][$role] ?? 'nothing');
                }
            }
        }
        $this->assertSame([], $diff, 'Permission parity broken');
        $this->assertSame(array_keys($expected), array_keys($actual));
    }

    /** 12:00 Dhaka (06:00 UTC) of the next day: outside campaign quiet hours (P85-15). */
    private static function campaignNoon(): Carbon
    {
        return Carbon::now('UTC')->addDay()->setTime(6, 0);
    }

    /** Runs a campaign case at a pinned daytime clock (sending is refused 21:00–09:00 Dhaka). */
    private function atCampaignNoon(\Closure $fn): TestResponse
    {
        $previous = Carbon::getTestNow();
        Carbon::setTestNow(self::campaignNoon());
        try {
            return $fn();
        } finally {
            Carbon::setTestNow($previous);
        }
    }

    private static function errorCode(TestResponse $response): string
    {
        $body = json_decode((string) $response->getContent(), true);

        return is_array($body) ? (string) ($body['error']['code'] ?? '') : '';
    }

    /** @return list<string> "METHOD uri" of every route behind the `tenant` middleware */
    public static function tenantRoutes(): array
    {
        $out = [];
        /** @var Route $route */
        foreach (app('router')->getRoutes() as $route) {
            if (! in_array('tenant', $route->gatherMiddleware(), true)) {
                continue;
            }
            $method = collect($route->methods())->reject(fn ($m) => $m === 'HEAD')->first();
            $out[] = $method.' '.$route->uri();
        }
        sort($out);

        return $out;
    }

    /** Each case in its own savepoint: the request sees the seeded state and leaves nothing behind. */
    private function runCase(\Closure $case, array $headers): TestResponse
    {
        Cache::flush(); // in-code rate limits / cooldowns (array store) must not leak between roles
        $connection = DB::connection();
        $connection->beginTransaction();
        try {
            return $case($headers);
        } finally {
            $connection->rollBack();
            $this->tenancy()->clear();
        }
    }

    private function req(array $h, string $method, string $uri, array $body = [], bool $idempotent = false): TestResponse
    {
        if ($idempotent) {
            $h['Idempotency-Key'] = (string) Str::uuid();
        }

        return $this->flushHeaders()->withHeaders($h)->json($method, $uri, $body);
    }

    private function seedShop(): void
    {
        [$owner, $tenant, $store, $h, $variant] = $this->courierShop();
        $this->connectGatewayIn($tenant, $store);
        $this->onPaidPlan($tenant, 'growth');
        // An open invoice (Growth monthly → yearly) for the invoice routes.
        $invoice = $this->changePlan($h, 'growth', 'year')->json('data.invoice.id');

        [$admin] = $this->merchant(TenantUser::ROLE_ADMIN, $tenant);
        [$staff] = $this->merchant(TenantUser::ROLE_STAFF, $tenant);
        // Phase 8.9a: verified phones, so the test SMS reaches the provider.
        foreach ([$owner, $admin, $staff] as $i => $member) {
            $member->forceFill(['phone' => '88017110000'.($i + 10), 'phone_verified_at' => now()])->save();
        }
        [$victim] = $this->merchant(TenantUser::ROLE_STAFF, $tenant);
        $victimMembership = $this->platformQuery(TenantUser::class)->where('tenant_id', $tenant->id)->where('user_id', $victim->id)->value('id');
        $invitation = $this->req($h, 'POST', '/api/v1/staff/invitations', ['email' => 'invitee@example.test', 'role' => 'staff', 'name' => 'Invitee'])
            ->assertCreated()->json('data.id');

        $base = "/api/v1/stores/{$store->id}";
        $category = $this->req($h, 'POST', "{$base}/categories", ['name' => 'Panjabi'])->assertCreated()->json('data.id');
        $product = $this->inTenant($tenant, fn () => ProductVariant::query()->whereKey($variant)->value('product_id'));
        $customer = $this->req($h, 'POST', "{$base}/customers", ['name' => 'Karim Uddin', 'phone' => '01712345678'])->assertCreated()->json('data.id');
        // Phase 8.5: an email campaign (draft) and a scheduled one; a customer with an email who may be messaged.
        $this->req($h, 'POST', "{$base}/customers", ['name' => 'Nusrat Jahan', 'email' => 'nusrat@example.test', 'accepts_marketing' => true])->assertCreated();
        $campaignBody = ['name' => 'Parity', 'channel' => 'email', 'language' => 'en', 'subject' => 'Hello', 'body' => 'Hi {name}',
            'audience' => ['segment' => 'all', 'params' => [], 'exclude' => ['risky' => false, 'ordered_within_days' => null]]];
        $campaign = $this->req($h, 'POST', "{$base}/campaigns", $campaignBody)->assertCreated()->json('data.id');
        $scheduledCampaign = $this->req($h, 'POST', "{$base}/campaigns", $campaignBody)->assertCreated()->json('data.id');
        $this->req($h, 'POST', "{$base}/campaigns/{$scheduledCampaign}/schedule", ['scheduled_at' => self::campaignNoon()->addDay()->toIso8601ZuluString()], true)->assertOk();
        // Phase 8.6: a draft thank-you automation (email message, so the test message goes to the account email) and a run.
        $automation = $this->req($h, 'POST', "{$base}/automations", ['recipe' => 'thank_you'])->assertCreated()->json('data');
        $this->req($h, 'PATCH', "{$base}/automations/{$automation['id']}", ['settings' => ['delay_hours' => 0, 'conditions' => [],
            'message' => ['channel' => 'email', 'language' => 'en', 'subject' => 'Thanks', 'body' => 'Thanks {name}']], 'revision' => 1])->assertOk();
        $draftAutomation = $this->req($h, 'POST', "{$base}/automations", ['recipe' => 'return_flag'])->assertCreated()->json('data.id');
        $run = $this->inTenant($tenant, function () use ($store, $automation) {
            $row = new AutomationRun;
            $row->store_id = $store->id;
            $row->automation_id = $automation['id'];
            $row->trigger = 'order.delivered';
            $row->dedupe_key = 'order:parity';
            $row->subject_type = 'order';
            $row->subject_id = strtolower((string) Str::ulid());
            $row->status = AutomationRun::COMPLETED;
            $row->context = ['order_number' => 'SP-1'];
            $row->started_at = now();
            $row->save();

            return $row->id;
        });
        // Phase 8.7: an expense with a (PDF, ready at upload) receipt.
        $receipt = $this->flushHeaders()->withHeaders($h)->post("{$base}/expenses/receipts", [
            'file' => UploadedFile::fake()->createWithContent('r.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
        ], ['Accept' => 'application/json'])->assertCreated()->json('data.id');
        $expense = $this->req($h, 'POST', "{$base}/expenses", ['amount' => 50000, 'category' => 'rent_bills', 'paid_from' => 'cash',
            'spent_on' => now('Asia/Dhaka')->format('Y-m-d'), 'receipt_id' => $receipt])->assertCreated()->json('data.id');
        // Phase 8.8a: a blocked number and an order held for a call.
        $blocked = $this->req($h, 'POST', "{$base}/fraud-guard/blocked-numbers", ['phone' => '01712000999', 'note' => 'Parity'])->assertCreated()->json('data.id');
        $held = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $this->inTenant($tenant, fn () => Order::query()->whereKey($held)->update(['guard_hold' => 'call_first', 'guard_hold_at' => now()]));
        // Phase 8.8b: two suppliers (one deletable), a draft PO, an ordered PO and a supplier payment.
        $supplier = $this->req($h, 'POST', "{$base}/suppliers", ['name' => 'Parity Supplier'])->assertCreated()->json('data.id');
        $spareSupplier = $this->req($h, 'POST', "{$base}/suppliers", ['name' => 'Spare Supplier'])->assertCreated()->json('data.id');
        $poBody = ['supplier_id' => $supplier, 'lines' => [['variant_id' => $variant, 'unit_cost_amount' => 1000, 'quantity' => 5]]];
        $draftPo = $this->req($h, 'POST', "{$base}/purchase-orders", $poBody)->assertCreated()->json('data.id');
        $orderedPo = $this->req($h, 'POST', "{$base}/purchase-orders", $poBody)->assertCreated()->json('data.id');
        $orderedItem = $this->req($h, 'POST', "{$base}/purchase-orders/{$orderedPo}/mark-ordered")->assertOk()->json('data.lines.0.id');
        $supplierPayment = $this->req($h, 'POST', "{$base}/suppliers/{$supplier}/payments", ['amount' => 1000, 'method' => 'cash',
            'paid_on' => now('Asia/Dhaka')->format('Y-m-d')])->assertCreated()->json('data.id');
        $this->req($h, 'POST', "{$base}/customers/{$customer}/notes", ['body' => 'VIP'])->assertSuccessful();
        $note = $this->inTenant($tenant, fn () => CustomerNote::query()->where('customer_id', $customer)->value('id'));
        $coupon = $this->req($h, 'POST', "{$base}/coupons", ['code' => 'PARITY', 'type' => 'fixed', 'amount' => 100])->assertCreated()->json('data.id');

        $pending = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $confirmed = $this->confirmedOrder($h, $store, $variant);
        $confirmed2 = $this->confirmedOrder($h, $store, $variant);
        $bookedOrder = $this->confirmedOrder($h, $store, $variant);
        $shipment = $this->book($h, $store, $bookedOrder)->assertCreated()->json('data.id');
        $batch = $this->req($h, 'POST', "{$base}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => [$confirmed2]])->json('data.id');

        $delivered = $this->manual($h, $store, $this->manualBody($variant, 2, ['notify_customer' => false]))->assertCreated()->json('data');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $delivered = $this->req($h, 'POST', "{$base}/orders/{$delivered['id']}/{$step}", ['notify_customer' => false])->assertOk()->json('data');
        }
        $deliveredItem = $delivered['items'][0]['id'];
        $return = $this->req($h, 'POST', "{$base}/orders/{$delivered['id']}/returns", ['type' => 'return', 'reason' => 'wrong_size', 'lines' => [['order_item_id' => $deliveredItem, 'quantity' => 1]]])
            ->assertCreated()->json('data.id');
        $pendingItem = $this->inTenant($tenant, fn () => Order::query()->with('items')->findOrFail($pending)->items->first()->id);

        $link = $this->req($h, 'POST', "{$base}/orders/{$pending}/payment-links", [
            'amount_kind' => 'full', 'provider' => 'bkash', 'expires_in_minutes' => 120, 'cancel_if_unpaid' => false, 'send_sms' => false,
        ], true)->json('data.id');
        $document = $this->req($h, 'POST', "{$base}/documents", ['kind' => 'invoice_a4', 'order_ids' => [$confirmed]])->json('data.id');
        $domain = $this->addDomain($h, $store, 'shop-parity.example.com')->json('data.id');
        $page = $this->req($h, 'GET', "{$base}/pages")->json('data.0.id');
        $media = $this->productImage($h);
        $import = $this->flushHeaders()->withHeaders($h)->post("{$base}/imports", [
            'type' => 'products', 'file' => UploadedFile::fake()->createWithContent('p.csv', "name,price\nA,1\n"),
        ], ['Accept' => 'application/json'])->json('data.id');
        $export = $this->req($h, 'POST', "{$base}/exports", ['type' => 'customers'])->json('data.id');
        $customRole = $this->req($h, 'POST', '/api/v1/roles', ['name' => 'Packer', 'permissions' => ['shipments.manage']])->json('data.id');
        $apiKey = $this->req($h, 'POST', '/api/v1/api-keys', ['name' => 'Parity key', 'scopes' => ['orders:read']])->assertCreated()->json('data.id');
        $endpoint = $this->req($h, 'POST', "{$base}/webhook-endpoints", ['url' => 'https://hooks.example.com/parity', 'events' => ['order.created']])->assertCreated()->json('data.id');
        $delivery = $this->req($h, 'POST', "{$base}/webhook-endpoints/{$endpoint}/test")->assertStatus(202)->json('data.id');
        $pickup = $this->req($h, 'POST', "{$base}/pickup-locations", ['name' => 'Warehouse 1', 'contact_name' => 'Rafi', 'phone' => '01711000008', 'district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'Road 1'])
            ->assertCreated()->json('data.id');
        // Phase 8.8c: an empty second location and an archived third one (Growth has multi_warehouse).
        $location = $this->req($h, 'POST', "{$base}/locations", ['name' => 'Dhanmondi shop', 'type' => 'shop'])->assertCreated()->json('data.id');
        $archivedLocation = $this->req($h, 'POST', "{$base}/locations", ['name' => 'Old godown', 'type' => 'warehouse'])->assertCreated()->json('data.id');
        $this->req($h, 'POST', "{$base}/locations/{$archivedLocation}/archive")->assertOk();
        // Phase 8.8c part B: stock at a hub, a draft and an in-transit transfer hub → default, a count in progress at the
        // hub (the "Dhanmondi shop" location above stays free of them so its archive case keeps its status).
        $hub = $this->req($h, 'POST', "{$base}/locations", ['name' => 'Transfer hub', 'type' => 'warehouse'])->assertCreated()->json('data.id');
        $this->req($h, 'POST', "{$base}/inventory/adjustments", ['reason' => 'received', 'items' => [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 10, 'location_id' => $hub]]])->assertOk();
        $this->inTenant($tenant, fn () => ProductVariant::query()->whereKey($variant)->whereNull('sku')->update(['sku' => 'PARITY-SKU']));
        $sku = $this->inTenant($tenant, fn () => ProductVariant::query()->whereKey($variant)->value('sku'));
        $transferBody = ['from_location_id' => $hub, 'to_location_id' => $this->req($h, 'GET', "{$base}/locations")->json('data.0.id'), 'lines' => [['variant_id' => $variant, 'quantity' => 1]]];
        $draftTransfer = $this->req($h, 'POST', "{$base}/stock-transfers", $transferBody)->assertCreated()->json('data.id');
        $transit = $this->req($h, 'POST', "{$base}/stock-transfers", $transferBody + ['send' => true], true)->assertCreated()->json('data');
        $count = $this->req($h, 'POST', "{$base}/stock-counts", ['location_id' => $hub])->assertCreated()->json('data.id');
        $countLine = $this->req($h, 'GET', "{$base}/stock-counts/{$count}/lines")->assertOk()->json('data.0.id');
        // Phase 8.8d part A: a till shop with stock, an open register with one sale, a closed spare and an archived one.
        $till = $this->req($h, 'POST', "{$base}/locations", ['name' => 'Till shop', 'type' => 'shop'])->assertCreated()->json('data.id');
        $this->req($h, 'POST', "{$base}/inventory/adjustments", ['reason' => 'received', 'items' => [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 5, 'location_id' => $till]]])->assertOk();
        $register = $this->req($h, 'POST', "{$base}/pos/registers", ['name' => 'Register 1', 'location_id' => $till])->assertCreated()->json('data.id');
        $spareRegister = $this->req($h, 'POST', "{$base}/pos/registers", ['name' => 'Register 2', 'location_id' => $till])->assertCreated()->json('data.id');
        $archivedRegister = $this->req($h, 'POST', "{$base}/pos/registers", ['name' => 'Old till', 'location_id' => $till])->assertCreated()->json('data.id');
        $this->req($h, 'POST', "{$base}/pos/registers/{$archivedRegister}/archive")->assertOk();
        $posSession = $this->req($h, 'POST', "{$base}/pos/registers/{$register}/open", ['opening_cash_amount' => 100000], true)->assertCreated()->json('data.id');
        $posLines = [['variant_id' => $variant, 'quantity' => 1]];
        $posTotal = $this->req($h, 'POST', "{$base}/pos/quote", ['session_id' => $posSession, 'lines' => $posLines])->assertOk()->json('data.total_amount');
        $posSale = $this->req($h, 'POST', "{$base}/pos/sales", [
            'session_id' => $posSession, 'lines' => $posLines, 'customer' => ['phone' => '01711000077', 'name' => 'Till buyer'],
            'expected_total_amount' => $posTotal, 'payments' => [['method' => 'cash', 'amount' => $posTotal]], 'tendered_cash_amount' => $posTotal,
            'sms_receipt' => false,
        ], true)->assertCreated()->json('data');
        $posItem = $posSale['order']['items'][0]['id'];
        $posSale = $posSale['id'];
        // Phase 8.8d part B: one held sale on Register 1.
        $posHeld = $this->req($h, 'POST', "{$base}/pos/held-sales", ['session_id' => $posSession, 'lines' => $posLines, 'note' => 'Back in 5'])->assertCreated()->json('data.id');
        // Phase 8.9a: one pending sender-ID request (trade licence PDF).
        $senderId = $this->flushHeaders()->withHeaders($h)->post("{$base}/sms/sender-ids", [
            'sender_id' => 'ParityBD', 'business_name' => 'Parity Traders', 'uses' => ['order_updates'], 'rights_confirmed' => '1',
            'document' => UploadedFile::fake()->createWithContent('licence.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
        ], ['Accept' => 'application/json'])->assertCreated()->json('data.id');
        // Phase 8.8e: chat + order channels on, one web-chat conversation with a customer message, a saved reply with a PDF.
        $this->req($h, 'PATCH', "{$base}/inbox/settings", ['revision' => 1, 'web_chat_enabled' => true, 'order_messages_enabled' => true])->assertOk();
        [$conversation, $inboxMessage] = $this->inTenant($tenant, function () use ($store) {
            return DB::transaction(function () use ($store) {
                $service = app(ConversationService::class);
                $c = $service->lockOrCreate($store->id, 'web_chat', 'phone:8801711000555', ['identity' => 'verified_phone', 'contact_name' => 'Parity Shopper', 'contact_phone' => '8801711000555']);
                $m = $service->appendCustomer($c, 'Parity question', collect());

                return [$c->id, $m->id];
            });
        });
        $inboxFile = $this->flushHeaders()->withHeaders($h)->post("{$base}/inbox/attachments", [
            'file' => UploadedFile::fake()->createWithContent('list.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
        ], ['Accept' => 'application/json'])->assertCreated()->json('data.id');
        $savedReply = $this->req($h, 'POST', "{$base}/inbox/saved-replies", ['title' => 'Parity', 'shortcut' => 'parity', 'body' => 'Hi {customer_name}', 'attachment_id' => $inboxFile])
            ->assertCreated()->json('data.id');
        // Phase 8.9c: one published guide in one topic; an open ticket with a PDF and a resolved one (for the rating).
        $author = User::factory()->create();
        $author->forceFill(['platform_role' => 'support'])->save();
        $helpCategory = app(HelpCategoryService::class)->create($author, ['slug' => 'parity-topic', 'name_en' => 'Parity topic', 'icon' => 'box']);
        $articles = app(HelpArticleService::class);
        $article = $articles->create($author, 'parity-guide', $helpCategory->id, 'Parity guide');
        $article = $articles->update($article->id, $author, ['revision' => $article->revision, 'translations' => ['en' => [
            'title' => 'Parity guide', 'summary' => 'Parity summary', 'keywords' => [],
            'body' => ['type' => 'doc', 'content' => [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'Parity body text']]]]],
        ]]]);
        $articles->publish($article->id, $author, $article->revision, null);
        $ticketFile = $this->flushHeaders()->withHeaders($h)->post('/api/v1/help/attachments', [
            'file' => UploadedFile::fake()->createWithContent('proof.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
        ], ['Accept' => 'application/json'])->assertCreated()->json('data.id');
        $ticket = $this->req($h, 'POST', '/api/v1/help/tickets', ['category' => 'bug', 'subject' => 'Parity ticket', 'description' => 'Parity ticket description text.',
            'attachment_ids' => [$ticketFile], 'client_id' => (string) Str::uuid()])->assertCreated()->json('data.id');
        $solved = $this->req($h, 'POST', '/api/v1/help/tickets', ['category' => 'bug', 'subject' => 'Parity solved', 'description' => 'Parity solved description text.',
            'client_id' => (string) Str::uuid()])->assertCreated()->json('data.id');
        $this->req($h, 'POST', "/api/v1/help/tickets/{$solved}/resolve")->assertOk();
        $payment = $this->inTenant($tenant, fn () => BillingPayment::query()->value('id'));
        $invoice ??= $this->inTenant($tenant, fn () => BillingInvoice::query()->value('id'));

        $this->s = [
            'tenant' => $tenant, 'store' => $store, 'base' => $base, 'variant' => $variant, 'product' => $product,
            'category' => $category, 'customer' => $customer, 'note' => $note, 'coupon' => $coupon,
            'pending' => $pending, 'pending_item' => $pendingItem, 'confirmed' => $confirmed, 'booked' => $bookedOrder,
            'shipment' => $shipment, 'batch' => $batch, 'delivered' => $delivered['id'], 'delivered_item' => $deliveredItem,
            'return' => $return, 'link' => $link, 'document' => $document, 'domain' => $domain, 'page' => $page,
            'media' => $media, 'import' => $import, 'export' => $export, 'pickup' => $pickup, 'invoice' => $invoice,
            'payment' => $payment, 'invitation' => $invitation, 'role' => $customRole, 'api_key' => $apiKey, 'endpoint' => $endpoint, 'delivery' => $delivery, 'victim' => $victimMembership,
            'campaign' => $campaign, 'scheduled_campaign' => $scheduledCampaign, 'automation' => $automation['id'], 'draft_automation' => $draftAutomation, 'run' => $run,
            'expense' => $expense, 'blocked' => $blocked, 'held' => $held,
            'supplier' => $supplier, 'spare_supplier' => $spareSupplier, 'draft_po' => $draftPo, 'ordered_po' => $orderedPo,
            'ordered_item' => $orderedItem, 'supplier_payment' => $supplierPayment,
            'location' => $location, 'archived_location' => $archivedLocation,
            'transfer_body' => $transferBody, 'draft_transfer' => $draftTransfer, 'transit' => $transit['id'], 'transit_item' => $transit['lines'][0]['id'],
            'count' => $count, 'count_line' => $countLine, 'sku' => $sku,
            'till' => $till, 'register' => $register, 'spare_register' => $spareRegister, 'archived_register' => $archivedRegister,
            'pos_session' => $posSession, 'pos_lines' => $posLines, 'pos_total' => $posTotal, 'pos_sale' => $posSale,
            'pos_item' => $posItem, 'pos_held' => $posHeld, 'sender_id' => $senderId,
            'conversation' => $conversation, 'inbox_message' => $inboxMessage, 'inbox_file' => $inboxFile, 'saved_reply' => $savedReply,
            'ticket' => $ticket, 'solved_ticket' => $solved, 'ticket_file' => $ticketFile,
            'headers' => [
                TenantUser::ROLE_OWNER => $this->tenantHeaders($owner, $tenant),
                TenantUser::ROLE_ADMIN => $this->tenantHeaders($admin, $tenant),
                TenantUser::ROLE_STAFF => $this->tenantHeaders($staff, $tenant),
            ],
        ];
    }

    private function connectGatewayIn(Tenant $tenant, Store $store): void
    {
        $this->inTenant($tenant, fn () => $this->connectGateway($store, 'bkash'));
    }

    /** @return array<string, \Closure(array<string, string>): TestResponse> keyed "METHOD uri" (route uri) */
    private function cases(): array
    {
        $s = $this->s;
        $b = $s['base'];
        $r = fn (string $method, string $uri, array $body = [], bool $idem = false) => fn (array $h) => $this->req($h, $method, $uri, $body, $idem);
        $theme = 'modern-commerce';
        $pageUrl = "{$b}/pages/{$s['page']}";

        return [
            // --- tenant level ---
            'GET api/v1/audit-logs' => $r('GET', '/api/v1/audit-logs'),
            'POST api/v1/billing/change-plan' => $r('POST', '/api/v1/billing/change-plan', ['plan_code' => 'starter', 'interval' => 'month'], true),
            'GET api/v1/billing/invoices' => $r('GET', '/api/v1/billing/invoices'),
            'GET api/v1/billing/invoices/{invoice}' => $r('GET', "/api/v1/billing/invoices/{$s['invoice']}"),
            'POST api/v1/billing/invoices/{invoice}/pay' => $r('POST', "/api/v1/billing/invoices/{$s['invoice']}/pay", ['provider' => 'bkash'], true),
            'GET api/v1/billing/invoices/{invoice}/pdf' => $r('GET', "/api/v1/billing/invoices/{$s['invoice']}/pdf"),
            'GET api/v1/billing/payments/{payment}' => $r('GET', '/api/v1/billing/payments/'.($s['payment'] ?? Str::ulid())),
            'POST api/v1/billing/quote' => $r('POST', '/api/v1/billing/quote', ['plan_code' => 'starter', 'interval' => 'month']),
            'DELETE api/v1/billing/scheduled-change' => $r('DELETE', '/api/v1/billing/scheduled-change'),
            'POST api/v1/dev/billing/clock' => $r('POST', '/api/v1/dev/billing/clock', ['advance_days' => 1]),
            'GET api/v1/features' => $r('GET', '/api/v1/features'),
            'GET api/v1/media' => $r('GET', '/api/v1/media'),
            'POST api/v1/media' => fn (array $h) => $this->flushHeaders()->withHeaders($h)->post('/api/v1/media', [
                'file' => UploadedFile::fake()->createWithContent('p.png', $this->imageBytes(300, 300)), 'purpose' => 'product_image',
            ], ['Accept' => 'application/json']),
            'GET api/v1/media/{media}' => $r('GET', "/api/v1/media/{$s['media']}"),
            'DELETE api/v1/media/{media}' => $r('DELETE', "/api/v1/media/{$s['media']}"),
            'GET api/v1/page-templates' => $r('GET', '/api/v1/page-templates'),
            'GET api/v1/staff' => $r('GET', '/api/v1/staff'),
            'POST api/v1/staff/invitations' => $r('POST', '/api/v1/staff/invitations', ['email' => 'new-person@example.test', 'role' => 'staff', 'name' => 'New']),
            'DELETE api/v1/staff/invitations/{invitation}' => $r('DELETE', "/api/v1/staff/invitations/{$s['invitation']}"),
            'POST api/v1/staff/invitations/{invitation}/resend' => $r('POST', "/api/v1/staff/invitations/{$s['invitation']}/resend"),
            'PATCH api/v1/staff/{member}' => $r('PATCH', "/api/v1/staff/{$s['victim']}", ['role' => 'admin']),
            'DELETE api/v1/staff/{member}' => $r('DELETE', "/api/v1/staff/{$s['victim']}"),
            'GET api/v1/stores' => $r('GET', '/api/v1/stores'),
            'POST api/v1/stores' => $r('POST', '/api/v1/stores', ['name' => 'Second', 'slug' => 'second-parity']),
            'GET api/v1/stores/{store}' => $r('GET', $b),
            'GET api/v1/subscription' => $r('GET', '/api/v1/subscription'),
            'GET api/v1/themes' => $r('GET', '/api/v1/themes'),

            // --- Phase 8.3 roles ---
            'GET api/v1/permissions' => $r('GET', '/api/v1/permissions'),
            'GET api/v1/roles' => $r('GET', '/api/v1/roles'),
            'POST api/v1/roles' => $r('POST', '/api/v1/roles', ['name' => 'Order staff', 'permissions' => ['orders.view']]),
            'GET api/v1/roles/{role}' => $r('GET', '/api/v1/roles/'.$s['role']),
            'PATCH api/v1/roles/{role}' => $r('PATCH', '/api/v1/roles/'.$s['role'], ['revision' => 1, 'name' => 'Packers']),
            'DELETE api/v1/roles/{role}' => $r('DELETE', '/api/v1/roles/'.$s['role'].'?revision=1'),
            // --- Phase 8.4 API keys ---
            'GET api/v1/api-keys' => $r('GET', '/api/v1/api-keys'),
            'POST api/v1/api-keys' => $r('POST', '/api/v1/api-keys', ['name' => 'Zapier', 'scopes' => ['orders:read']]),
            'PATCH api/v1/api-keys/{key}' => $r('PATCH', '/api/v1/api-keys/'.$s['api_key'], ['name' => 'Renamed']),
            'DELETE api/v1/api-keys/{key}' => $r('DELETE', '/api/v1/api-keys/'.$s['api_key']),
            'GET api/v1/api-scopes' => $r('GET', '/api/v1/api-scopes'),
            // --- Phase 8.4 webhooks (API-HOOKS routes) ---
            'GET api/v1/webhook-event-types' => $r('GET', '/api/v1/webhook-event-types'),
            'GET api/v1/stores/{store}/webhook-endpoints' => $r('GET', "{$b}/webhook-endpoints"),
            'POST api/v1/stores/{store}/webhook-endpoints' => $r('POST', "{$b}/webhook-endpoints", ['url' => 'https://hooks.example.com/second', 'events' => ['order.paid']]),
            'PATCH api/v1/stores/{store}/webhook-endpoints/{endpoint}' => $r('PATCH', "{$b}/webhook-endpoints/{$s['endpoint']}", ['description' => 'ERP']),
            'DELETE api/v1/stores/{store}/webhook-endpoints/{endpoint}' => $r('DELETE', "{$b}/webhook-endpoints/{$s['endpoint']}"),
            'POST api/v1/stores/{store}/webhook-endpoints/{endpoint}/test' => $r('POST', "{$b}/webhook-endpoints/{$s['endpoint']}/test"),
            'GET api/v1/stores/{store}/webhook-secret' => $r('GET', "{$b}/webhook-secret"),
            'POST api/v1/stores/{store}/webhook-secret/reveal' => $r('POST', "{$b}/webhook-secret/reveal"),
            'POST api/v1/stores/{store}/webhook-secret/rotate' => $r('POST', "{$b}/webhook-secret/rotate"),
            'GET api/v1/stores/{store}/webhook-deliveries' => $r('GET', "{$b}/webhook-deliveries"),
            'GET api/v1/stores/{store}/webhook-deliveries/{delivery}' => $r('GET', "{$b}/webhook-deliveries/{$s['delivery']}"),
            'POST api/v1/stores/{store}/webhook-deliveries/{delivery}/resend' => $r('POST', "{$b}/webhook-deliveries/{$s['delivery']}/resend"),
            'POST api/v1/stores/{store}/webhook-deliveries/resend-failed' => $r('POST', "{$b}/webhook-deliveries/resend-failed"),
            'GET api/v1/dev/webhook-sink' => $r('GET', '/api/v1/dev/webhook-sink'),

            // --- Phase 8.5 campaigns (sending needs daytime in Dhaka: the clock is pinned for those cases) ---
            'GET api/v1/stores/{store}/marketing/overview' => $r('GET', "{$b}/marketing/overview?range=7d"),
            'GET api/v1/stores/{store}/campaigns' => $r('GET', "{$b}/campaigns"),
            'POST api/v1/stores/{store}/campaigns' => $r('POST', "{$b}/campaigns", ['name' => 'New', 'channel' => 'sms', 'language' => 'bn', 'body' => 'ঈদ মোবারক',
                'audience' => ['segment' => 'all', 'params' => [], 'exclude' => ['risky' => false, 'ordered_within_days' => null]]]),
            'POST api/v1/stores/{store}/campaigns/audience-preview' => $r('POST', "{$b}/campaigns/audience-preview", ['channel' => 'sms', 'audience' => ['segment' => 'all']]),
            'POST api/v1/stores/{store}/campaigns/estimate' => $r('POST', "{$b}/campaigns/estimate", ['channel' => 'sms', 'language' => 'en', 'body' => 'Hi', 'audience' => ['segment' => 'all']]),
            'GET api/v1/stores/{store}/campaigns/{campaign}' => $r('GET', "{$b}/campaigns/{$s['campaign']}"),
            'PATCH api/v1/stores/{store}/campaigns/{campaign}' => $r('PATCH', "{$b}/campaigns/{$s['campaign']}", ['name' => 'Renamed', 'revision' => 1]),
            'DELETE api/v1/stores/{store}/campaigns/{campaign}' => $r('DELETE', "{$b}/campaigns/{$s['campaign']}"),
            'POST api/v1/stores/{store}/campaigns/{campaign}/test' => $r('POST', "{$b}/campaigns/{$s['campaign']}/test"),
            'POST api/v1/stores/{store}/campaigns/{campaign}/schedule' => $r('POST', "{$b}/campaigns/{$s['campaign']}/schedule", ['scheduled_at' => self::campaignNoon()->addDays(2)->toIso8601ZuluString()], true),
            'POST api/v1/stores/{store}/campaigns/{campaign}/send' => fn (array $h) => $this->atCampaignNoon(fn () => $this->req($h, 'POST', "{$b}/campaigns/{$s['campaign']}/send", [], true)),
            'POST api/v1/stores/{store}/campaigns/{campaign}/unschedule' => $r('POST', "{$b}/campaigns/{$s['scheduled_campaign']}/unschedule"),
            'POST api/v1/stores/{store}/campaigns/{campaign}/cancel' => $r('POST', "{$b}/campaigns/{$s['campaign']}/cancel"),
            'POST api/v1/stores/{store}/campaigns/{campaign}/duplicate' => $r('POST', "{$b}/campaigns/{$s['campaign']}/duplicate"),
            'GET api/v1/stores/{store}/campaigns/{campaign}/recipients' => $r('GET', "{$b}/campaigns/{$s['campaign']}/recipients"),
            'POST api/v1/stores/{store}/customers/{customer}/marketing-opt-out' => $r('POST', "{$b}/customers/{$s['customer']}/marketing-opt-out", ['channel' => 'sms']),
            'DELETE api/v1/stores/{store}/customers/{customer}/marketing-opt-out/{channel}' => $r('DELETE', "{$b}/customers/{$s['customer']}/marketing-opt-out/sms"),
            'GET api/v1/dev/stores/{store}/message-sink' => $r('GET', "/api/v1/dev/stores/{$s['store']->id}/message-sink"),

            // --- Phase 8.6 automations ---
            'GET api/v1/stores/{store}/automations' => $r('GET', "{$b}/automations"),
            'POST api/v1/stores/{store}/automations' => $r('POST', "{$b}/automations", ['recipe' => 'low_stock']),
            'GET api/v1/stores/{store}/automations/{automation}' => $r('GET', "{$b}/automations/{$s['automation']}"),
            'PATCH api/v1/stores/{store}/automations/{automation}' => $r('PATCH', "{$b}/automations/{$s['automation']}", ['name' => 'Renamed', 'revision' => 2]),
            'DELETE api/v1/stores/{store}/automations/{automation}' => $r('DELETE', "{$b}/automations/{$s['draft_automation']}"),
            'POST api/v1/stores/{store}/automations/{automation}/enable' => $r('POST', "{$b}/automations/{$s['automation']}/enable"),
            'POST api/v1/stores/{store}/automations/{automation}/disable' => $r('POST', "{$b}/automations/{$s['automation']}/disable"),
            'POST api/v1/stores/{store}/automations/{automation}/dry-run' => $r('POST', "{$b}/automations/{$s['automation']}/dry-run"),
            'POST api/v1/stores/{store}/automations/{automation}/test-message' => $r('POST', "{$b}/automations/{$s['automation']}/test-message", ['step' => 1]),
            'GET api/v1/stores/{store}/automations/{automation}/stats' => $r('GET', "{$b}/automations/{$s['automation']}/stats"),
            'GET api/v1/stores/{store}/automation-runs' => $r('GET', "{$b}/automation-runs"),
            'GET api/v1/stores/{store}/automation-runs/{run}' => $r('GET', "{$b}/automation-runs/{$s['run']}"),

            // --- Phase 8.7 expenses ---
            'GET api/v1/stores/{store}/expenses' => $r('GET', "{$b}/expenses"),
            'POST api/v1/stores/{store}/expenses' => $r('POST', "{$b}/expenses", ['amount' => 1000, 'category' => 'ads', 'paid_from' => 'card', 'spent_on' => now('Asia/Dhaka')->format('Y-m-d')]),
            'GET api/v1/stores/{store}/expenses/summary' => $r('GET', "{$b}/expenses/summary"),
            'GET api/v1/stores/{store}/expenses/export' => $r('GET', "{$b}/expenses/export"),
            'POST api/v1/stores/{store}/expenses/receipts' => fn (array $h) => $this->flushHeaders()->withHeaders($h)->post("{$b}/expenses/receipts", [
                'file' => UploadedFile::fake()->createWithContent('r.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
            ], ['Accept' => 'application/json']),
            'GET api/v1/stores/{store}/expenses/{expense}' => $r('GET', "{$b}/expenses/{$s['expense']}"),
            'PATCH api/v1/stores/{store}/expenses/{expense}' => $r('PATCH', "{$b}/expenses/{$s['expense']}", ['note' => 'June rent']),
            'DELETE api/v1/stores/{store}/expenses/{expense}' => $r('DELETE', "{$b}/expenses/{$s['expense']}"),
            'GET api/v1/stores/{store}/expenses/{expense}/receipt' => $r('GET', "{$b}/expenses/{$s['expense']}/receipt"),

            // --- Phase 8.8a fake-order guard ---
            'GET api/v1/stores/{store}/fraud-guard/settings' => $r('GET', "{$b}/fraud-guard/settings"),
            'PATCH api/v1/stores/{store}/fraud-guard/settings' => $r('PATCH', "{$b}/fraud-guard/settings", ['hold_below' => 55]),
            'POST api/v1/stores/{store}/fraud-guard/settings/reset' => $r('POST', "{$b}/fraud-guard/settings/reset"),
            'GET api/v1/stores/{store}/fraud-guard/overview' => $r('GET', "{$b}/fraud-guard/overview"),
            'GET api/v1/stores/{store}/fraud-guard/events' => $r('GET', "{$b}/fraud-guard/events"),
            'GET api/v1/stores/{store}/fraud-guard/blocked-numbers' => $r('GET', "{$b}/fraud-guard/blocked-numbers"),
            'POST api/v1/stores/{store}/fraud-guard/blocked-numbers' => $r('POST', "{$b}/fraud-guard/blocked-numbers", ['phone' => '01712000888']),
            'DELETE api/v1/stores/{store}/fraud-guard/blocked-numbers/{entry}' => $r('DELETE', "{$b}/fraud-guard/blocked-numbers/{$s['blocked']}"),
            'POST api/v1/stores/{store}/fraud-guard/check' => $r('POST', "{$b}/fraud-guard/check", ['phone' => '01712000777']),
            'POST api/v1/stores/{store}/orders/{order}/guard/release' => $r('POST', "{$b}/orders/{$s['held']}/guard/release"),

            // --- Phase 8.8b purchasing ---
            'GET api/v1/stores/{store}/suppliers' => $r('GET', "{$b}/suppliers"),
            'GET api/v1/stores/{store}/suppliers/summary' => $r('GET', "{$b}/suppliers/summary"),
            'POST api/v1/stores/{store}/suppliers' => $r('POST', "{$b}/suppliers", ['name' => 'New Supplier', 'phone' => '01712000555']),
            'GET api/v1/stores/{store}/suppliers/{supplier}' => $r('GET', "{$b}/suppliers/{$s['supplier']}"),
            'PATCH api/v1/stores/{store}/suppliers/{supplier}' => $r('PATCH', "{$b}/suppliers/{$s['supplier']}", ['city' => 'Dhaka']),
            'DELETE api/v1/stores/{store}/suppliers/{supplier}' => $r('DELETE', "{$b}/suppliers/{$s['spare_supplier']}"),
            'POST api/v1/stores/{store}/suppliers/{supplier}/archive' => $r('POST', "{$b}/suppliers/{$s['supplier']}/archive"),
            'POST api/v1/stores/{store}/suppliers/{supplier}/unarchive' => $r('POST', "{$b}/suppliers/{$s['supplier']}/unarchive"),
            'GET api/v1/stores/{store}/suppliers/{supplier}/payments' => $r('GET', "{$b}/suppliers/{$s['supplier']}/payments"),
            'POST api/v1/stores/{store}/suppliers/{supplier}/payments' => $r('POST', "{$b}/suppliers/{$s['supplier']}/payments", ['amount' => 500, 'method' => 'bkash', 'paid_on' => now('Asia/Dhaka')->format('Y-m-d')]),
            'DELETE api/v1/stores/{store}/supplier-payments/{payment}' => $r('DELETE', "{$b}/supplier-payments/{$s['supplier_payment']}"),
            'GET api/v1/stores/{store}/locations' => $r('GET', "{$b}/locations"),
            'POST api/v1/stores/{store}/locations' => $r('POST', "{$b}/locations", ['name' => 'Chattogram hub', 'type' => 'warehouse']),
            'PATCH api/v1/stores/{store}/locations/{location}' => $r('PATCH', "{$b}/locations/{$s['location']}", ['address' => 'Road 27, Dhanmondi']),
            'POST api/v1/stores/{store}/locations/{location}/archive' => $r('POST', "{$b}/locations/{$s['location']}/archive"),
            'POST api/v1/stores/{store}/locations/{location}/unarchive' => $r('POST', "{$b}/locations/{$s['archived_location']}/unarchive"),
            'POST api/v1/stores/{store}/locations/{location}/make-default' => $r('POST', "{$b}/locations/{$s['location']}/make-default"),
            'GET api/v1/stores/{store}/stock-transfers' => $r('GET', "{$b}/stock-transfers"),
            'GET api/v1/stores/{store}/stock-transfers/summary' => $r('GET', "{$b}/stock-transfers/summary"),
            'POST api/v1/stores/{store}/stock-transfers' => $r('POST', "{$b}/stock-transfers", $s['transfer_body']),
            'GET api/v1/stores/{store}/stock-transfers/{transfer}' => $r('GET', "{$b}/stock-transfers/{$s['transit']}"),
            'PATCH api/v1/stores/{store}/stock-transfers/{transfer}' => $r('PATCH', "{$b}/stock-transfers/{$s['draft_transfer']}", ['revision' => 1, 'note' => 'Parity']),
            'DELETE api/v1/stores/{store}/stock-transfers/{transfer}' => $r('DELETE', "{$b}/stock-transfers/{$s['draft_transfer']}"),
            'POST api/v1/stores/{store}/stock-transfers/{transfer}/send' => $r('POST', "{$b}/stock-transfers/{$s['draft_transfer']}/send", [], true),
            'POST api/v1/stores/{store}/stock-transfers/{transfer}/receive' => $r('POST', "{$b}/stock-transfers/{$s['transit']}/receive", ['lines' => [['item_id' => $s['transit_item'], 'received' => 1]]], true),
            'POST api/v1/stores/{store}/stock-transfers/{transfer}/cancel' => $r('POST', "{$b}/stock-transfers/{$s['transit']}/cancel"),
            'GET api/v1/stores/{store}/stock-counts' => $r('GET', "{$b}/stock-counts"),
            'POST api/v1/stores/{store}/stock-counts' => $r('POST', "{$b}/stock-counts", ['location_id' => $s['location']]),
            'GET api/v1/stores/{store}/stock-counts/{count}' => $r('GET', "{$b}/stock-counts/{$s['count']}"),
            'GET api/v1/stores/{store}/stock-counts/{count}/lines' => $r('GET', "{$b}/stock-counts/{$s['count']}/lines"),
            'PUT api/v1/stores/{store}/stock-counts/{count}/lines/{line}' => $r('PUT', "{$b}/stock-counts/{$s['count']}/lines/{$s['count_line']}", ['counted' => 3]),
            'POST api/v1/stores/{store}/stock-counts/{count}/scan' => $r('POST', "{$b}/stock-counts/{$s['count']}/scan", ['code' => $s['sku']]),
            'POST api/v1/stores/{store}/stock-counts/{count}/finish' => $r('POST', "{$b}/stock-counts/{$s['count']}/finish", ['zero_uncounted' => false], true),
            'POST api/v1/stores/{store}/stock-counts/{count}/cancel' => $r('POST', "{$b}/stock-counts/{$s['count']}/cancel"),
            // Phase 8.8d part A (POS).
            'GET api/v1/stores/{store}/pos/registers' => $r('GET', "{$b}/pos/registers"),
            'POST api/v1/stores/{store}/pos/registers' => $r('POST', "{$b}/pos/registers", ['name' => 'Register 3', 'location_id' => $s['till']]),
            'PATCH api/v1/stores/{store}/pos/registers/{register}' => $r('PATCH', "{$b}/pos/registers/{$s['register']}", ['name' => 'Front till']),
            'POST api/v1/stores/{store}/pos/registers/{register}/archive' => $r('POST', "{$b}/pos/registers/{$s['spare_register']}/archive"),
            'POST api/v1/stores/{store}/pos/registers/{register}/unarchive' => $r('POST', "{$b}/pos/registers/{$s['archived_register']}/unarchive"),
            'POST api/v1/stores/{store}/pos/registers/{register}/open' => $r('POST', "{$b}/pos/registers/{$s['spare_register']}/open", ['opening_cash_amount' => 0], true),
            'GET api/v1/stores/{store}/pos/sessions/{session}' => $r('GET', "{$b}/pos/sessions/{$s['pos_session']}"),
            'POST api/v1/stores/{store}/pos/sessions/{session}/close' => $r('POST', "{$b}/pos/sessions/{$s['pos_session']}/close", ['counted_cash_amount' => 100000, 'left_in_drawer_amount' => 0, 'note' => 'Parity', 'revision' => 1], true),
            'GET api/v1/stores/{store}/pos/catalog' => $r('GET', "{$b}/pos/catalog?register_id={$s['register']}"),
            'GET api/v1/stores/{store}/pos/lookup' => $r('GET', "{$b}/pos/lookup?register_id={$s['register']}&code={$s['sku']}"),
            'GET api/v1/stores/{store}/pos/customers/lookup' => $r('GET', "{$b}/pos/customers/lookup?phone=01711000077"),
            'POST api/v1/stores/{store}/pos/quote' => $r('POST', "{$b}/pos/quote", ['session_id' => $s['pos_session'], 'lines' => $s['pos_lines']]),
            'POST api/v1/stores/{store}/pos/sales' => $r('POST', "{$b}/pos/sales", [
                'session_id' => $s['pos_session'], 'lines' => $s['pos_lines'], 'expected_total_amount' => $s['pos_total'],
                'payments' => [['method' => 'card', 'amount' => $s['pos_total'], 'reference' => 'APP-1']], 'sms_receipt' => false,
            ], true),
            'GET api/v1/stores/{store}/pos/sales/{sale}' => $r('GET', "{$b}/pos/sales/{$s['pos_sale']}"),
            'POST api/v1/stores/{store}/pos/sales/{sale}/sms-receipt' => $r('POST', "{$b}/pos/sales/{$s['pos_sale']}/sms-receipt"),
            // Phase 8.8d part B.
            'GET api/v1/stores/{store}/pos/sales' => $r('GET', "{$b}/pos/sales"),
            'POST api/v1/stores/{store}/pos/sales/{sale}/returns' => $r('POST', "{$b}/pos/sales/{$s['pos_sale']}/returns", [
                'session_id' => $s['pos_session'], 'lines' => [['order_item_id' => $s['pos_item'], 'quantity' => 1]], 'refund_method' => 'card',
            ], true),
            'GET api/v1/stores/{store}/pos/held-sales' => $r('GET', "{$b}/pos/held-sales?register_id={$s['register']}"),
            // Phase 8.9a SMS.
            'GET api/v1/stores/{store}/sms' => $r('GET', "{$b}/sms"),
            'POST api/v1/stores/{store}/sms/test' => $r('POST', "{$b}/sms/test", ['language' => 'en']),
            'GET api/v1/stores/{store}/sms/templates' => $r('GET', "{$b}/sms/templates"),
            'POST api/v1/stores/{store}/sms/templates/preview' => $r('POST', "{$b}/sms/templates/preview", ['key' => 'order_confirmed', 'language' => 'en', 'body' => '{shop}: Order {number} is confirmed!']),
            'PUT api/v1/stores/{store}/sms/templates/{key}/{language}' => $r('PUT', "{$b}/sms/templates/order_confirmed/en", ['body' => '{shop}: Order {number} is confirmed!', 'revision' => 0]),
            'DELETE api/v1/stores/{store}/sms/templates/{key}/{language}' => $r('DELETE', "{$b}/sms/templates/order_confirmed/en"),
            'GET api/v1/stores/{store}/sms/sender-ids' => $r('GET', "{$b}/sms/sender-ids"),
            'POST api/v1/stores/{store}/sms/sender-ids' => fn (array $h) => $this->flushHeaders()->withHeaders($h)->post("{$b}/sms/sender-ids", [
                'sender_id' => 'OtherBD', 'business_name' => 'Parity Traders', 'uses' => ['otp'], 'rights_confirmed' => '1',
                'document' => UploadedFile::fake()->createWithContent('licence.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
            ], ['Accept' => 'application/json']),
            'POST api/v1/stores/{store}/sms/sender-ids/{sender_id}/cancel' => $r('POST', "{$b}/sms/sender-ids/{$s['sender_id']}/cancel"),
            'GET api/v1/stores/{store}/sms/messages' => $r('GET', "{$b}/sms/messages"),
            // Phase 8.8e Inbox.
            'GET api/v1/stores/{store}/inbox/summary' => $r('GET', "{$b}/inbox/summary"),
            'GET api/v1/stores/{store}/inbox/conversations' => $r('GET', "{$b}/inbox/conversations"),
            'GET api/v1/stores/{store}/inbox/conversations/{conversation}' => $r('GET', "{$b}/inbox/conversations/{$s['conversation']}"),
            'DELETE api/v1/stores/{store}/inbox/conversations/{conversation}' => $r('DELETE', "{$b}/inbox/conversations/{$s['conversation']}"),
            'GET api/v1/stores/{store}/inbox/conversations/{conversation}/messages' => $r('GET', "{$b}/inbox/conversations/{$s['conversation']}/messages"),
            'POST api/v1/stores/{store}/inbox/conversations/{conversation}/messages' => $r('POST', "{$b}/inbox/conversations/{$s['conversation']}/messages",
                ['kind' => 'note', 'body' => 'Parity note', 'client_id' => (string) Str::uuid()]),
            'POST api/v1/stores/{store}/inbox/conversations/{conversation}/assign' => $r('POST', "{$b}/inbox/conversations/{$s['conversation']}/assign", ['assignee_id' => null]),
            'POST api/v1/stores/{store}/inbox/conversations/{conversation}/status' => $r('POST', "{$b}/inbox/conversations/{$s['conversation']}/status", ['status' => 'pending']),
            'POST api/v1/stores/{store}/inbox/conversations/{conversation}/block' => $r('POST', "{$b}/inbox/conversations/{$s['conversation']}/block"),
            'POST api/v1/stores/{store}/inbox/conversations/{conversation}/unblock' => $r('POST', "{$b}/inbox/conversations/{$s['conversation']}/unblock"),
            'POST api/v1/stores/{store}/inbox/conversations/{conversation}/read' => $r('POST', "{$b}/inbox/conversations/{$s['conversation']}/read", ['last_read_message_id' => $s['inbox_message']]),
            'PUT api/v1/stores/{store}/inbox/conversations/{conversation}/order' => $r('PUT', "{$b}/inbox/conversations/{$s['conversation']}/order", ['order_id' => $s['pending']]),
            'POST api/v1/stores/{store}/inbox/conversations/{conversation}/saved-replies/{saved_reply}/render' => $r('POST', "{$b}/inbox/conversations/{$s['conversation']}/saved-replies/{$s['saved_reply']}/render"),
            'GET api/v1/stores/{store}/inbox/assignees' => $r('GET', "{$b}/inbox/assignees"),
            'POST api/v1/stores/{store}/inbox/attachments' => fn (array $h) => $this->flushHeaders()->withHeaders($h)->post("{$b}/inbox/attachments", [
                'file' => UploadedFile::fake()->createWithContent('photo.png', $this->imageBytes(120, 120)),
            ], ['Accept' => 'application/json']),
            'GET api/v1/stores/{store}/inbox/attachments/{attachment}/link' => $r('GET', "{$b}/inbox/attachments/{$s['inbox_file']}/link"),
            'GET api/v1/stores/{store}/inbox/saved-replies' => $r('GET', "{$b}/inbox/saved-replies"),
            'POST api/v1/stores/{store}/inbox/saved-replies' => $r('POST', "{$b}/inbox/saved-replies", ['title' => 'New', 'shortcut' => 'new-one', 'body' => 'Thanks from {shop_name}']),
            'POST api/v1/stores/{store}/inbox/saved-replies/reorder' => $r('POST', "{$b}/inbox/saved-replies/reorder", ['ids' => [$s['saved_reply']]]),
            'PATCH api/v1/stores/{store}/inbox/saved-replies/{saved_reply}' => $r('PATCH', "{$b}/inbox/saved-replies/{$s['saved_reply']}", ['title' => 'Renamed', 'revision' => 1]),
            'DELETE api/v1/stores/{store}/inbox/saved-replies/{saved_reply}' => $r('DELETE', "{$b}/inbox/saved-replies/{$s['saved_reply']}"),
            'GET api/v1/stores/{store}/inbox/settings' => $r('GET', "{$b}/inbox/settings"),
            'PATCH api/v1/stores/{store}/inbox/settings' => $r('PATCH', "{$b}/inbox/settings", ['revision' => 2, 'widget_reply_time' => 'hour']),
            'POST api/v1/stores/{store}/inbox/settings/email-address/rotate' => $r('POST', "{$b}/inbox/settings/email-address/rotate"),
            // --- Phase 8.9c help center + tickets ---
            'GET api/v1/help/home' => $r('GET', '/api/v1/help/home'),
            'GET api/v1/help/categories' => $r('GET', '/api/v1/help/categories'),
            'GET api/v1/help/categories/{slug}' => $r('GET', '/api/v1/help/categories/parity-topic'),
            'GET api/v1/help/articles' => $r('GET', '/api/v1/help/articles?q=parity'),
            'GET api/v1/help/articles/{slug}' => $r('GET', '/api/v1/help/articles/parity-guide'),
            'PUT api/v1/help/articles/{slug}/feedback' => $r('PUT', '/api/v1/help/articles/parity-guide/feedback', ['helpful' => true, 'language' => 'en']),
            'DELETE api/v1/help/articles/{slug}/feedback' => $r('DELETE', '/api/v1/help/articles/parity-guide/feedback'),
            'GET api/v1/help/tickets' => $r('GET', '/api/v1/help/tickets'),
            'POST api/v1/help/tickets' => fn (array $h) => $this->req($h, 'POST', '/api/v1/help/tickets', ['category' => 'other', 'subject' => 'Parity new', 'description' => 'Parity new ticket description.', 'client_id' => (string) Str::uuid()]),
            'GET api/v1/help/tickets/{ticket}' => $r('GET', "/api/v1/help/tickets/{$s['ticket']}"),
            'GET api/v1/help/tickets/{ticket}/messages' => $r('GET', "/api/v1/help/tickets/{$s['ticket']}/messages"),
            'POST api/v1/help/tickets/{ticket}/messages' => fn (array $h) => $this->req($h, 'POST', "/api/v1/help/tickets/{$s['ticket']}/messages", ['body' => 'Parity reply', 'client_id' => (string) Str::uuid()]),
            'POST api/v1/help/tickets/{ticket}/resolve' => $r('POST', "/api/v1/help/tickets/{$s['ticket']}/resolve"),
            'PUT api/v1/help/tickets/{ticket}/rating' => $r('PUT', "/api/v1/help/tickets/{$s['solved_ticket']}/rating", ['rating' => 5]),
            'POST api/v1/help/attachments' => fn (array $h) => $this->flushHeaders()->withHeaders($h)->post('/api/v1/help/attachments', [
                'file' => UploadedFile::fake()->createWithContent('p.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
            ], ['Accept' => 'application/json']),
            'GET api/v1/help/attachments/{attachment}/link' => $r('GET', "/api/v1/help/attachments/{$s['ticket_file']}/link"),
            'GET api/v1/billing/sms-credits' => $r('GET', '/api/v1/billing/sms-credits'),
            'PATCH api/v1/billing/sms-credits' => $r('PATCH', '/api/v1/billing/sms-credits', ['low_credit_threshold' => 500]),
            'GET api/v1/billing/sms-credits/ledger' => $r('GET', '/api/v1/billing/sms-credits/ledger'),
            'POST api/v1/billing/sms-credits/purchase' => $r('POST', '/api/v1/billing/sms-credits/purchase', ['pack' => 'credits_1000', 'provider' => 'bkash'], true),
            'POST api/v1/stores/{store}/pos/held-sales' => $r('POST', "{$b}/pos/held-sales", ['session_id' => $s['pos_session'], 'lines' => $s['pos_lines']]),
            'GET api/v1/stores/{store}/pos/held-sales/{held}' => $r('GET', "{$b}/pos/held-sales/{$s['pos_held']}"),
            'DELETE api/v1/stores/{store}/pos/held-sales/{held}' => $r('DELETE', "{$b}/pos/held-sales/{$s['pos_held']}"),
            'GET api/v1/stores/{store}/purchase-orders' => $r('GET', "{$b}/purchase-orders"),
            'GET api/v1/stores/{store}/purchase-orders/summary' => $r('GET', "{$b}/purchase-orders/summary"),
            'POST api/v1/stores/{store}/purchase-orders' => $r('POST', "{$b}/purchase-orders", ['supplier_id' => $s['supplier'], 'lines' => [['variant_id' => $s['variant'], 'quantity' => 2]]]),
            'POST api/v1/stores/{store}/purchase-orders/quick' => $r('POST', "{$b}/purchase-orders/quick", ['supplier_id' => $s['supplier'], 'lines' => [['variant_id' => $s['variant'], 'unit_cost_amount' => 900, 'quantity' => 2]]], true),
            'GET api/v1/stores/{store}/purchase-orders/{purchase_order}' => $r('GET', "{$b}/purchase-orders/{$s['ordered_po']}"),
            'PATCH api/v1/stores/{store}/purchase-orders/{purchase_order}' => $r('PATCH', "{$b}/purchase-orders/{$s['draft_po']}", ['revision' => 1, 'notes' => 'Parity']),
            'DELETE api/v1/stores/{store}/purchase-orders/{purchase_order}' => $r('DELETE', "{$b}/purchase-orders/{$s['draft_po']}"),
            'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/send' => $r('POST', "{$b}/purchase-orders/{$s['draft_po']}/send", ['sent_via' => 'pdf']),
            'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/mark-ordered' => $r('POST', "{$b}/purchase-orders/{$s['draft_po']}/mark-ordered"),
            'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/close' => $r('POST', "{$b}/purchase-orders/{$s['ordered_po']}/close"),
            'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/cancel' => $r('POST', "{$b}/purchase-orders/{$s['draft_po']}/cancel"),
            'POST api/v1/stores/{store}/purchase-orders/{purchase_order}/receipts' => $r('POST', "{$b}/purchase-orders/{$s['ordered_po']}/receipts", ['lines' => [['item_id' => $s['ordered_item'], 'received' => 1, 'damaged' => 0]]], true),
            'GET api/v1/stores/{store}/purchase-orders/{purchase_order}/pdf' => $r('GET', "{$b}/purchase-orders/{$s['ordered_po']}/pdf"),
            'GET api/v1/stores/{store}/purchasing/reorder-suggestions' => $r('GET', "{$b}/purchasing/reorder-suggestions"),
            'POST api/v1/stores/{store}/purchasing/invoices' => fn (array $h) => $this->flushHeaders()->withHeaders($h)->post("{$b}/purchasing/invoices", [
                'file' => UploadedFile::fake()->createWithContent('i.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
            ], ['Accept' => 'application/json']),

            // --- catalog ---
            'GET api/v1/stores/{store}/categories' => $r('GET', "{$b}/categories"),
            'POST api/v1/stores/{store}/categories' => $r('POST', "{$b}/categories", ['name' => 'Saree']),
            'PUT api/v1/stores/{store}/categories/order' => $r('PUT', "{$b}/categories/order", ['items' => [['id' => $s['category'], 'parent_id' => null, 'position' => 0]]]),
            'GET api/v1/stores/{store}/categories/{category}' => $r('GET', "{$b}/categories/{$s['category']}"),
            'PATCH api/v1/stores/{store}/categories/{category}' => $r('PATCH', "{$b}/categories/{$s['category']}", ['revision' => 1, 'name' => 'Panjabi 2']),
            'DELETE api/v1/stores/{store}/categories/{category}' => $r('DELETE', "{$b}/categories/{$s['category']}"),
            'GET api/v1/stores/{store}/products' => $r('GET', "{$b}/products"),
            'POST api/v1/stores/{store}/products' => $r('POST', "{$b}/products", $this->simpleProduct('Parity Shirt')),
            'POST api/v1/stores/{store}/products/bulk' => $r('POST', "{$b}/products/bulk", ['action' => 'delete', 'ids' => [$s['product']]]),
            'GET api/v1/stores/{store}/products/{product}' => $r('GET', "{$b}/products/{$s['product']}"),
            'PATCH api/v1/stores/{store}/products/{product}' => $r('PATCH', "{$b}/products/{$s['product']}", ['revision' => 1, 'name' => 'Renamed']),
            'DELETE api/v1/stores/{store}/products/{product}' => $r('DELETE', "{$b}/products/{$s['product']}"),
            'POST api/v1/stores/{store}/products/{product}/duplicate' => $r('POST', "{$b}/products/{$s['product']}/duplicate"),
            'GET api/v1/stores/{store}/inventory' => $r('GET', "{$b}/inventory"),
            'POST api/v1/stores/{store}/inventory/adjustments' => $r('POST', "{$b}/inventory/adjustments", ['reason' => 'received', 'items' => [['variant_id' => $s['variant'], 'mode' => 'delta', 'quantity' => 1]]]),
            'GET api/v1/stores/{store}/inventory/movements' => $r('GET', "{$b}/inventory/movements"),
            'PATCH api/v1/stores/{store}/inventory/{variant}' => $r('PATCH', "{$b}/inventory/{$s['variant']}", ['low_stock_threshold' => 3]),

            // --- customers ---
            'GET api/v1/stores/{store}/customers' => $r('GET', "{$b}/customers"),
            'POST api/v1/stores/{store}/customers' => $r('POST', "{$b}/customers", ['name' => 'Salma Begum', 'phone' => '01812345679']),
            'GET api/v1/stores/{store}/customers/{customer}' => $r('GET', "{$b}/customers/{$s['customer']}"),
            'PATCH api/v1/stores/{store}/customers/{customer}' => $r('PATCH', "{$b}/customers/{$s['customer']}", ['revision' => 1, 'name' => 'Karim U.']),
            'DELETE api/v1/stores/{store}/customers/{customer}' => $r('DELETE', "{$b}/customers/{$s['customer']}"),
            'POST api/v1/stores/{store}/customers/{customer}/notes' => $r('POST', "{$b}/customers/{$s['customer']}/notes", ['body' => 'Call first']),
            'DELETE api/v1/stores/{store}/customers/{customer}/notes/{note}' => $r('DELETE', "{$b}/customers/{$s['customer']}/notes/{$s['note']}"),

            // --- data ---
            'GET api/v1/stores/{store}/imports/template' => $r('GET', "{$b}/imports/template?type=products"),
            'POST api/v1/stores/{store}/imports' => fn (array $h) => $this->flushHeaders()->withHeaders($h)->post("{$b}/imports", [
                'type' => 'products', 'file' => UploadedFile::fake()->createWithContent('p.csv', "name,price\nB,2\n"),
            ], ['Accept' => 'application/json']),
            'GET api/v1/stores/{store}/imports/{import}' => $r('GET', "{$b}/imports/{$s['import']}"),
            'DELETE api/v1/stores/{store}/imports/{import}' => $r('DELETE', "{$b}/imports/{$s['import']}"),
            'GET api/v1/stores/{store}/imports/{import}/error-report' => $r('GET', "{$b}/imports/{$s['import']}/error-report"),
            'GET api/v1/stores/{store}/imports/{import}/rows' => $r('GET', "{$b}/imports/{$s['import']}/rows"),
            'POST api/v1/stores/{store}/imports/{import}/run' => $r('POST', "{$b}/imports/{$s['import']}/run"),
            'POST api/v1/stores/{store}/imports/{import}/validate' => $r('POST', "{$b}/imports/{$s['import']}/validate", ['column_map' => ['name' => 'name', 'price' => 'price']]),
            'POST api/v1/stores/{store}/exports' => $r('POST', "{$b}/exports", ['type' => 'products']),
            'GET api/v1/stores/{store}/exports/{export}' => $r('GET', "{$b}/exports/{$s['export']}"),

            // --- store, settings, content ---
            'GET api/v1/stores/{store}/dashboard' => $r('GET', "{$b}/dashboard"),
            'GET api/v1/stores/{store}/launch-checklist' => $r('GET', "{$b}/launch-checklist"),
            'POST api/v1/stores/{store}/publish' => $r('POST', "{$b}/publish"),
            'POST api/v1/stores/{store}/preview-token' => $r('POST', "{$b}/preview-token"),
            'GET api/v1/stores/{store}/settings' => $r('GET', "{$b}/settings"),
            'PATCH api/v1/stores/{store}/settings' => $r('PATCH', "{$b}/settings", ['seo' => ['hide_from_search' => true]]),
            'GET api/v1/stores/{store}/shipping' => $r('GET', "{$b}/shipping"),
            'PUT api/v1/stores/{store}/shipping' => fn (array $h) => $this->req($h, 'PUT', "{$b}/shipping", $this->shippingBody($h)),
            'POST api/v1/stores/{store}/pickup-locations' => $r('POST', "{$b}/pickup-locations", ['name' => 'Warehouse 2', 'contact_name' => 'Rafi', 'phone' => '01711000009', 'district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'Road 2']),
            'PATCH api/v1/stores/{store}/pickup-locations/{location}' => $r('PATCH', "{$b}/pickup-locations/{$s['pickup']}", ['name' => 'Main warehouse']),
            'DELETE api/v1/stores/{store}/pickup-locations/{location}' => $r('DELETE', "{$b}/pickup-locations/{$s['pickup']}"),
            'GET api/v1/stores/{store}/themes' => $r('GET', "{$b}/themes"),
            'GET api/v1/stores/{store}/themes/{code}' => $r('GET', "{$b}/themes/{$theme}"),
            'PUT api/v1/stores/{store}/themes/{code}/draft' => $r('PUT', "{$b}/themes/{$theme}/draft", ['config' => $this->defaultThemeConfig(), 'base_revision' => 1]),
            'POST api/v1/stores/{store}/themes/{code}/publish' => $r('POST', "{$b}/themes/{$theme}/publish", ['draft_revision' => 1]),
            'POST api/v1/stores/{store}/themes/{code}/discard' => $r('POST', "{$b}/themes/{$theme}/discard"),
            'POST api/v1/stores/{store}/themes/{code}/apply' => $r('POST', "{$b}/themes/{$theme}/apply"),
            'GET api/v1/stores/{store}/pages' => $r('GET', "{$b}/pages"),
            'POST api/v1/stores/{store}/pages' => $r('POST', "{$b}/pages", ['title' => 'Parity page']),
            'GET api/v1/stores/{store}/pages/{page}' => $r('GET', $pageUrl),
            'PATCH api/v1/stores/{store}/pages/{page}' => $r('PATCH', $pageUrl, ['revision' => 1, 'title' => 'Edited']),
            'DELETE api/v1/stores/{store}/pages/{page}' => $r('DELETE', $pageUrl),
            'GET api/v1/stores/{store}/navigation' => $r('GET', "{$b}/navigation"),
            'PUT api/v1/stores/{store}/navigation/{handle}' => $r('PUT', "{$b}/navigation/main", ['items' => [], 'revision' => 1]),
            'GET api/v1/stores/{store}/document-templates' => $r('GET', "{$b}/document-templates"),
            'PUT api/v1/stores/{store}/document-templates/{kind}' => $r('PUT', "{$b}/document-templates/invoice_a4", ['config' => TemplateConfig::defaults('invoice_a4')]),

            // --- integrations ---
            'GET api/v1/stores/{store}/payment-gateways' => $r('GET', "{$b}/payment-gateways"),
            'PUT api/v1/stores/{store}/payment-gateways/{provider}' => $r('PUT', "{$b}/payment-gateways/sslcommerz", ['mode' => 'sandbox', 'credentials' => ['store_id' => 'testbox1234', 'store_passwd' => 'testbox1234@ssl']]),
            'PATCH api/v1/stores/{store}/payment-gateways/{provider}' => $r('PATCH', "{$b}/payment-gateways/bkash", ['revision' => 1, 'enabled' => true]),
            'DELETE api/v1/stores/{store}/payment-gateways/{provider}' => $r('DELETE', "{$b}/payment-gateways/bkash"),
            'POST api/v1/stores/{store}/payment-gateways/{provider}/test-payment' => $r('POST', "{$b}/payment-gateways/bkash/test-payment", [], true),
            'GET api/v1/stores/{store}/couriers' => $r('GET', "{$b}/couriers"),
            'PUT api/v1/stores/{store}/couriers/{provider}' => $r('PUT', "{$b}/couriers/redx", ['mode' => 'sandbox', 'credentials' => ['access_token' => 'token-9b2c']]),
            'PATCH api/v1/stores/{store}/couriers/{provider}' => $r('PATCH', "{$b}/couriers/steadfast", ['revision' => 1, 'is_default' => true]),
            'DELETE api/v1/stores/{store}/couriers/{provider}' => $r('DELETE', "{$b}/couriers/steadfast"),
            'POST api/v1/stores/{store}/couriers/{provider}/test' => $r('POST', "{$b}/couriers/steadfast/test"),
            'POST api/v1/stores/{store}/couriers/{provider}/webhook-secret' => $r('POST', "{$b}/couriers/steadfast/webhook-secret"),
            'GET api/v1/stores/{store}/couriers/{provider}/areas' => $r('GET', "{$b}/couriers/steadfast/areas?level=city"),
            'GET api/v1/stores/{store}/couriers/{provider}/pickup-stores' => $r('GET', "{$b}/couriers/steadfast/pickup-stores"),

            // --- domains ---
            'GET api/v1/stores/{store}/domains' => $r('GET', "{$b}/domains"),
            'POST api/v1/stores/{store}/domains' => $r('POST', "{$b}/domains", ['hostname' => 'second-parity.example.com']),
            'GET api/v1/stores/{store}/domains/{domain}' => $r('GET', "{$b}/domains/{$s['domain']}"),
            'DELETE api/v1/stores/{store}/domains/{domain}' => $r('DELETE', "{$b}/domains/{$s['domain']}"),
            'POST api/v1/stores/{store}/domains/{domain}/primary' => $r('POST', "{$b}/domains/{$s['domain']}/primary"),
            'POST api/v1/stores/{store}/domains/{domain}/verify' => $r('POST', "{$b}/domains/{$s['domain']}/verify"),

            // --- coupons ---
            'GET api/v1/stores/{store}/coupons' => $r('GET', "{$b}/coupons"),
            'POST api/v1/stores/{store}/coupons' => $r('POST', "{$b}/coupons", ['code' => 'NEWONE', 'type' => 'fixed', 'amount' => 100]),
            'GET api/v1/stores/{store}/coupons/{coupon}' => $r('GET', "{$b}/coupons/{$s['coupon']}"),
            'PATCH api/v1/stores/{store}/coupons/{coupon}' => $r('PATCH', "{$b}/coupons/{$s['coupon']}", ['revision' => 1, 'status' => 'active']),
            'DELETE api/v1/stores/{store}/coupons/{coupon}' => $r('DELETE', "{$b}/coupons/{$s['coupon']}"),

            // --- reports ---
            'GET api/v1/stores/{store}/reports/sales' => $r('GET', "{$b}/reports/sales"),
            'GET api/v1/stores/{store}/reports/profit' => $r('GET', "{$b}/reports/profit"),
            'GET api/v1/stores/{store}/reports/delivery' => $r('GET', "{$b}/reports/delivery"),

            // --- orders ---
            'GET api/v1/stores/{store}/orders' => $r('GET', "{$b}/orders"),
            'POST api/v1/stores/{store}/orders' => $r('POST', "{$b}/orders", $this->manualBody($s['variant']), true),
            'POST api/v1/stores/{store}/orders/quote' => $r('POST', "{$b}/orders/quote", $this->manualBody($s['variant'])),
            'POST api/v1/stores/{store}/orders/bulk' => $r('POST', "{$b}/orders/bulk", ['action' => 'confirm', 'ids' => [$s['pending']]]),
            'GET api/v1/stores/{store}/orders/{order}' => $r('GET', "{$b}/orders/{$s['pending']}"),
            'PATCH api/v1/stores/{store}/orders/{order}' => $r('PATCH', "{$b}/orders/{$s['pending']}", ['revision' => 1, 'note' => 'Gift wrap']),
            'POST api/v1/stores/{store}/orders/{order}/confirm' => $r('POST', "{$b}/orders/{$s['pending']}/confirm"),
            'POST api/v1/stores/{store}/orders/{order}/ready' => $r('POST', "{$b}/orders/{$s['confirmed']}/ready"),
            'POST api/v1/stores/{store}/orders/{order}/ship' => $r('POST', "{$b}/orders/{$s['confirmed']}/ship"),
            'POST api/v1/stores/{store}/orders/{order}/deliver' => $r('POST', "{$b}/orders/{$s['booked']}/deliver"),
            'POST api/v1/stores/{store}/orders/{order}/return' => $r('POST', "{$b}/orders/{$s['booked']}/return", ['reason' => 'refused']),
            'POST api/v1/stores/{store}/orders/{order}/cancel' => $r('POST', "{$b}/orders/{$s['pending']}/cancel", ['reason' => 'duplicate']),
            'POST api/v1/stores/{store}/orders/{order}/notes' => $r('POST', "{$b}/orders/{$s['pending']}/notes", ['body' => 'Called']),
            'POST api/v1/stores/{store}/orders/{order}/refunds' => $r('POST', "{$b}/orders/{$s['delivered']}/refunds", ['amount' => 100, 'method' => 'cash'], true),
            'GET api/v1/stores/{store}/orders/{order}/payment-links' => $r('GET', "{$b}/orders/{$s['pending']}/payment-links"),
            'POST api/v1/stores/{store}/orders/{order}/payment-links' => $r('POST', "{$b}/orders/{$s['confirmed']}/payment-links", [
                'amount_kind' => 'full', 'provider' => 'bkash', 'expires_in_minutes' => 120, 'cancel_if_unpaid' => false, 'send_sms' => false,
            ], true),
            'DELETE api/v1/stores/{store}/orders/{order}/payment-links/{link}' => $r('DELETE', "{$b}/orders/{$s['pending']}/payment-links/{$s['link']}"),
            'POST api/v1/stores/{store}/orders/{order}/payment-links/{link}/resend' => $r('POST', "{$b}/orders/{$s['pending']}/payment-links/{$s['link']}/resend"),
            'POST api/v1/stores/{store}/orders/{order}/items/quote' => $r('POST', "{$b}/orders/{$s['pending']}/items/quote", ['items' => [['id' => $s['pending_item'], 'quantity' => 2]]]),
            'PUT api/v1/stores/{store}/orders/{order}/items' => $r('PUT', "{$b}/orders/{$s['pending']}/items", ['revision' => 1, 'items' => [['id' => $s['pending_item'], 'quantity' => 2]]]),
            'POST api/v1/stores/{store}/orders/{order}/restock' => $r('POST', "{$b}/orders/{$s['delivered']}/restock", ['lines' => [['item_id' => $s['delivered_item'], 'quantity' => 1]]]),
            'POST api/v1/stores/{store}/orders/{order}/returns' => $r('POST', "{$b}/orders/{$s['delivered']}/returns", ['type' => 'return', 'reason' => 'damaged', 'lines' => [['order_item_id' => $s['delivered_item'], 'quantity' => 1]]]),
            'POST api/v1/stores/{store}/orders/{order}/shipments' => $r('POST', "{$b}/orders/{$s['confirmed']}/shipments", ['provider' => 'steadfast'], true),

            // --- returns ---
            'GET api/v1/stores/{store}/returns' => $r('GET', "{$b}/returns"),
            'GET api/v1/stores/{store}/returns/{return}' => $r('GET', "{$b}/returns/{$s['return']}"),
            'POST api/v1/stores/{store}/returns/{return}/approve' => $r('POST', "{$b}/returns/{$s['return']}/approve"),
            'POST api/v1/stores/{store}/returns/{return}/reject' => $r('POST', "{$b}/returns/{$s['return']}/reject", ['reason' => 'Used item']),
            'POST api/v1/stores/{store}/returns/{return}/receive' => $r('POST', "{$b}/returns/{$s['return']}/receive", ['checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true], 'lines' => []]),
            'POST api/v1/stores/{store}/returns/{return}/close' => $r('POST', "{$b}/returns/{$s['return']}/close"),
            'POST api/v1/stores/{store}/returns/{return}/exchange-order' => $r('POST', "{$b}/returns/{$s['return']}/exchange-order", ['shipping_amount_override' => 0], true),
            'POST api/v1/stores/{store}/returns/{return}/notes' => $r('POST', "{$b}/returns/{$s['return']}/notes", ['body' => 'Checked']),

            // --- documents ---
            'POST api/v1/stores/{store}/documents' => $r('POST', "{$b}/documents", ['kind' => 'packing_slip', 'order_ids' => [$s['confirmed']]]),
            'POST api/v1/stores/{store}/documents/preview' => $r('POST', "{$b}/documents/preview", ['kind' => 'label_4x6']),
            'GET api/v1/stores/{store}/documents/{document}' => $r('GET', "{$b}/documents/".($s['document'] ?? Str::ulid())),

            // --- shipments ---
            'GET api/v1/stores/{store}/shipments' => $r('GET', "{$b}/shipments"),
            'POST api/v1/stores/{store}/shipments/bulk' => $r('POST', "{$b}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => [$s['confirmed']]]),
            'POST api/v1/stores/{store}/shipments/sync' => $r('POST', "{$b}/shipments/sync"),
            'GET api/v1/stores/{store}/shipment-batches/{batch}' => $r('GET', "{$b}/shipment-batches/".($s['batch'] ?? Str::ulid())),
            'GET api/v1/stores/{store}/shipments/{shipment}' => $r('GET', "{$b}/shipments/{$s['shipment']}"),
            'POST api/v1/stores/{store}/shipments/{shipment}/refresh' => $r('POST', "{$b}/shipments/{$s['shipment']}/refresh"),
            'POST api/v1/stores/{store}/shipments/{shipment}/cancel' => $r('POST', "{$b}/shipments/{$s['shipment']}/cancel"),
            'POST api/v1/stores/{store}/shipments/{shipment}/mark-cancelled' => $r('POST', "{$b}/shipments/{$s['shipment']}/mark-cancelled"),
        ];
    }

    /** @return array<string, mixed> the theme's default settings document */
    private function defaultThemeConfig(): array
    {
        return app(ThemeRegistry::class)->defaults('modern-commerce');
    }

    /** The current zones, unchanged (a valid PUT body). @param array<string, string> $h */
    private function shippingBody(array $h): array
    {
        $current = $this->req($h, 'GET', "{$this->s['base']}/shipping")->json('data');

        return ['revision' => $current['revision'] ?? 1, 'zones' => $current['zones'] ?? []];
    }
}

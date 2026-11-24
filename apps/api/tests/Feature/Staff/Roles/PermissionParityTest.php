<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Customers\Models\CustomerNote;
use App\Domain\Developer\Webhooks\Sending\HostResolver;
use App\Domain\Documents\TemplateConfig;
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
            'campaign' => $campaign, 'scheduled_campaign' => $scheduledCampaign,
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

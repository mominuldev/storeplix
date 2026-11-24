<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Customers\Models\CustomerNote;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/**
 * PHASE-8-3 §10 per-key enforcement dataset (AC 1): a custom role with only one key (+ its prerequisites) gets 2xx on
 * a representative route of that key and 403 on a route of a sibling key; an empty role keeps base access; and every
 * conditional check of §3.2 has an allowed and a denied case.
 */
#[Group('roles')]
#[Group('security')]
class PermissionEnforcementTest extends TestCase
{
    use RefreshDatabase, ShipmentFixtures;

    /** @var array<string, mixed> */
    private array $s;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $this->withoutMiddleware(ThrottleRequests::class);
        config(['couriers.fake' => true]);

        [, $tenant, $store, $h, $variant] = $this->courierShop();
        $this->growth($tenant);
        $base = "/api/v1/stores/{$store->id}";
        $product = $this->inTenant($tenant, fn () => ProductVariant::query()->whereKey($variant)->value('product_id'));
        $customer = $this->api($h, 'POST', "{$base}/customers", ['name' => 'Karim Uddin', 'phone' => '01712345678'])->assertCreated()->json('data.id');
        $pending = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $confirmed = $this->confirmedOrder($h, $store, $variant);
        $booked = $this->confirmedOrder($h, $store, $variant);
        $shipment = $this->book($h, $store, $booked)->assertCreated()->json('data.id');
        $delivered = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $this->api($h, 'POST', "{$base}/orders/{$delivered}/{$step}", ['notify_customer' => false])->assertOk();
        }

        $this->s = compact('tenant', 'store', 'h', 'variant', 'base', 'product', 'customer', 'pending', 'confirmed', 'shipment', 'delivered');
    }

    private function growth(Tenant $tenant): void
    {
        $this->inTenant($tenant, fn () => Subscription::query()->update([
            'plan_id' => Plan::query()->where('code', Plan::GROWTH)->value('id'), 'status' => Subscription::ACTIVE, 'trial_ends_at' => null,
        ]));
        FeatureGate::forget($tenant->id);
    }

    /** @param list<string> $keys @return array<string, string> headers of a new member holding exactly $keys */
    private function holder(array $keys): array
    {
        $role = $this->api($this->s['h'], 'POST', '/api/v1/roles', ['name' => 'R '.Str::random(8), 'permissions' => $keys])->assertCreated()->json('data.id');
        $user = User::factory()->create();
        $this->inTenant($this->s['tenant'], fn () => TenantUser::query()->create([
            'tenant_id' => $this->s['tenant']->id, 'user_id' => $user->id, 'role_id' => $role,
        ]));

        return $this->tenantHeaders($user, $this->s['tenant']);
    }

    /** The key plus its prerequisites (transitively). @return list<string> */
    private static function withPrerequisites(Permission $p): array
    {
        $out = [$p->value];
        foreach ($p->requires() as $r) {
            $out = [...$out, ...self::withPrerequisites($r)];
        }

        return array_values(array_unique($out));
    }

    private function hit(array $h, array $req): TestResponse
    {
        [$method, $path] = $req;
        $body = $req[2] ?? [];
        $url = str_starts_with($path, '/api/') ? $path : $this->s['base'].$path;
        $url = strtr($url, [
            '{product}' => $this->s['product'], '{customer}' => $this->s['customer'], '{pending}' => $this->s['pending'],
            '{confirmed}' => $this->s['confirmed'], '{shipment}' => $this->s['shipment'], '{delivered}' => $this->s['delivered'],
        ]);
        $body = json_decode(strtr((string) json_encode($body), ['{variant}' => $this->s['variant']]), true);

        return $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], $method, $url, $body);
    }

    /** @return array<string, array{0: string, 1: array<int, mixed>, 2: array<int, mixed>}> key → [allowed request, denied sibling request] */
    public static function keys(): array
    {
        return [
            'orders.view' => ['orders.view', ['GET', '/orders'], ['POST', '/orders/{pending}/confirm']],
            'orders.process' => ['orders.process', ['POST', '/orders/{pending}/confirm'], ['POST', '/orders/{delivered}/refunds', ['amount' => 100, 'method' => 'cash']]],
            'orders.refund' => ['orders.refund', ['POST', '/orders/{delivered}/refunds', ['amount' => 100, 'method' => 'cash']], ['POST', '/orders/{confirmed}/shipments', ['provider' => 'steadfast']]],
            'fraud.manage' => ['fraud.manage', ['GET', '/fraud-guard/settings'], ['POST', '/orders/{pending}/confirm']], // PHASE-8-8 §2.1
            'shipments.manage' => ['shipments.manage', ['POST', '/orders/{confirmed}/shipments', ['provider' => 'steadfast']], ['POST', '/shipments/{shipment}/mark-cancelled']],
            'shipments.cancel' => ['shipments.cancel', ['POST', '/shipments/{shipment}/mark-cancelled'], ['GET', '/customers']],
            'products.edit' => ['products.edit', ['POST', '/products', ['name' => 'Shirt', 'variants' => [['price_amount' => 1000]]]], ['DELETE', '/products/{product}']],
            'products.delete' => ['products.delete', ['DELETE', '/products/{product}'], ['POST', '/inventory/adjustments', ['reason' => 'received', 'items' => [['variant_id' => '{variant}', 'mode' => 'delta', 'quantity' => 1]]]]],
            'inventory.adjust' => ['inventory.adjust', ['POST', '/inventory/adjustments', ['reason' => 'received', 'items' => [['variant_id' => '{variant}', 'mode' => 'delta', 'quantity' => 1]]]], ['PATCH', '/products/{product}', ['revision' => 1, 'name' => 'X']]],
            'customers.view' => ['customers.view', ['GET', '/customers/{customer}'], ['POST', '/customers', ['name' => 'Salma Begum', 'phone' => '01812345679']]],
            'customers.edit' => ['customers.edit', ['POST', '/customers', ['name' => 'Salma Begum', 'phone' => '01812345679']], ['DELETE', '/customers/{customer}']],
            'customers.delete' => ['customers.delete', ['DELETE', '/customers/{customer}'], ['GET', '/reports/sales']],
            'costs.view' => ['costs.view', ['GET', '/products/{product}'], ['GET', '/reports/profit']],
            'reports.view' => ['reports.view', ['GET', '/reports/delivery'], ['GET', '/reports/profit']],
            'expenses.manage' => ['expenses.manage', ['GET', '/expenses/summary'], ['GET', '/reports/delivery']], // PHASE-8-7 §2.1
            'data.export' => ['data.export', ['POST', '/exports', ['type' => 'customers']], ['GET', '/imports/template?type=products']],
            'data.import' => ['data.import', ['GET', '/imports/template?type=products'], ['POST', '/exports', ['type' => 'customers']]],
            'marketing.manage' => ['marketing.manage', ['POST', '/coupons', ['code' => 'NEW10', 'type' => 'fixed', 'amount' => 100]], ['PATCH', '/settings', ['seo' => ['hide_from_search' => true]]]],
            'settings.manage' => ['settings.manage', ['PATCH', '/settings', ['seo' => ['hide_from_search' => true]]], ['POST', '/couriers/steadfast/test']],
            'integrations.manage' => ['integrations.manage', ['POST', '/couriers/steadfast/test'], ['POST', '/domains', ['hostname' => 'shop-x.example.com']]],
            'domains.manage' => ['domains.manage', ['POST', '/domains', ['hostname' => 'shop-x.example.com']], ['GET', '/api/v1/staff']],
            'developers.manage' => ['developers.manage', ['GET', '/api/v1/api-keys'], ['GET', '/api/v1/staff']], // PHASE-8-4 §2.1
            'staff.manage' => ['staff.manage', ['GET', '/api/v1/staff'], ['GET', '/api/v1/audit-logs']],
            'audit.view' => ['audit.view', ['GET', '/api/v1/audit-logs'], ['GET', '/api/v1/subscription']],
            'billing.view' => ['billing.view', ['GET', '/api/v1/subscription'], ['POST', '/api/v1/billing/change-plan', ['plan_code' => 'starter', 'interval' => 'month']]],
        ];
    }

    #[DataProvider('keys')]
    public function test_each_key_opens_its_routes_and_nothing_else(string $key, array $allowed, array $denied): void
    {
        $h = $this->holder(self::withPrerequisites(Permission::from($key)));

        $ok = $this->hit($h, $allowed);
        $this->assertTrue($ok->isSuccessful(), "{$key}: {$allowed[0]} {$allowed[1]} gave {$ok->status()} ".$ok->getContent());
        $this->hit($h, $denied)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
    }

    public function test_every_grantable_key_is_in_the_dataset(): void
    {
        $this->assertSame(array_map(fn (Permission $p) => $p->value, Permission::grantableCases()), array_keys(self::keys()));
    }

    /** Q116: a role with no permissions keeps base access and nothing more. */
    public function test_an_empty_role_keeps_base_access_only(): void
    {
        $h = $this->holder([]);
        foreach (['/api/v1/stores', $this->s['base'], '/products', '/products/{product}', '/categories', '/inventory', '/inventory/movements',
            '/coupons', '/settings', '/shipping', '/domains', '/payment-gateways', '/couriers', '/dashboard', '/launch-checklist',
            '/themes', '/pages', '/navigation', '/document-templates', '/api/v1/features', '/api/v1/media', '/api/v1/themes', '/api/v1/page-templates'] as $path) {
            $this->hit($h, ['GET', $path])->assertOk();
        }
        foreach (['/orders', '/shipments', '/customers', '/returns', '/reports/sales', '/api/v1/staff', '/api/v1/roles', '/api/v1/subscription', '/api/v1/audit-logs'] as $path) {
            $this->hit($h, ['GET', $path])->assertForbidden();
        }
        $this->hit($h, ['GET', '/products/{product}'])->assertJsonPath('data.variants.0.cost_amount', null);
        $this->hit($h, ['GET', '/dashboard'])->assertJsonPath('data.inventory.stock_value_cost_amount', null);
    }

    public function test_paid_cancel_needs_orders_refund(): void
    {
        ['tenant' => $tenant, 'pending' => $id] = $this->s;
        $this->inTenant($tenant, fn () => Order::query()->whereKey($id)->update(['paid_amount' => 500, 'payment_status' => 'partially_paid']));
        $process = $this->holder(['orders.view', 'orders.process']);
        $this->hit($process, ['GET', '/orders/{pending}'])->assertJsonPath('data.allowed_transitions', ['confirmed'])
            ->assertJsonPath('data.can.refund', false);
        $this->hit($process, ['POST', '/orders/{pending}/cancel', ['reason' => 'other']])->assertForbidden();
        $refund = $this->holder(['orders.view', 'orders.process', 'orders.refund']);
        $this->hit($refund, ['GET', '/orders/{pending}'])->assertJsonPath('data.can.refund', true);
        $this->hit($refund, ['POST', '/orders/{pending}/cancel', ['reason' => 'other']])->assertOk();
    }

    public function test_cod_override_needs_orders_refund(): void
    {
        $ship = $this->holder(['shipments.manage']);
        $this->hit($ship, ['POST', '/orders/{confirmed}/shipments', ['provider' => 'steadfast', 'cod_amount' => 100]])->assertForbidden();
        $both = $this->holder(['shipments.manage', 'orders.view', 'orders.process', 'orders.refund']);
        $this->hit($both, ['POST', '/orders/{confirmed}/shipments', ['provider' => 'steadfast', 'cod_amount' => 100]])->assertCreated();
    }

    public function test_bulk_delete_needs_products_delete(): void
    {
        $body = ['action' => 'delete', 'ids' => [$this->s['product']]];
        $this->hit($this->holder(['products.edit']), ['POST', '/products/bulk', $body])->assertForbidden();
        $this->hit($this->holder(['products.edit']), ['POST', '/products/bulk', ['action' => 'archive', 'ids' => [$this->s['product']]]])->assertOk();
        $this->hit($this->holder(['products.edit', 'products.delete']), ['POST', '/products/bulk', $body])->assertOk();
    }

    public function test_branding_media_delete_needs_settings_manage(): void
    {
        $upload = fn (array $h, string $purpose) => $this->flushHeaders()->withHeaders($h)->post('/api/v1/media', [
            'file' => UploadedFile::fake()->createWithContent('l.png', $this->imageBytes(300, 300)), 'purpose' => $purpose,
        ], ['Accept' => 'application/json']);
        $logo = $upload($this->s['h'], 'logo')->assertCreated()->json('data.id');
        $editor = $this->holder(['products.edit']);
        $image = $upload($editor, 'product_image')->assertCreated()->json('data.id');
        $upload($this->holder([]), 'product_image')->assertForbidden();

        $this->hit($editor, ['DELETE', "/api/v1/media/{$logo}"])->assertForbidden();
        $this->hit($editor, ['DELETE', "/api/v1/media/{$image}"])->assertNoContent();
        $this->hit($this->holder(['settings.manage']), ['DELETE', "/api/v1/media/{$logo}"])->assertNoContent();
    }

    public function test_deleting_another_authors_note_needs_customers_delete(): void
    {
        $this->hit($this->s['h'], ['POST', '/customers/{customer}/notes', ['body' => 'VIP']])->assertCreated();
        $note = $this->inTenant($this->s['tenant'], fn () => CustomerNote::query()->value('id'));
        $editor = $this->holder(['customers.view', 'customers.edit']);
        $this->hit($editor, ['GET', '/customers/{customer}'])->assertJsonPath('data.notes.0.can_delete', false);
        $this->hit($editor, ['DELETE', "/customers/{customer}/notes/{$note}"])->assertForbidden();
        $own = $this->hit($editor, ['POST', '/customers/{customer}/notes', ['body' => 'Mine']])->assertCreated()->json('data.id');
        $this->hit($editor, ['DELETE', "/customers/{customer}/notes/{$own}"])->assertNoContent();
        $this->hit($this->holder(['customers.view', 'customers.edit', 'customers.delete']), ['DELETE', "/customers/{customer}/notes/{$note}"])->assertNoContent();
    }

    public function test_profit_report_and_cost_fields_need_costs_view(): void
    {
        $this->hit($this->holder(['reports.view']), ['GET', '/reports/profit'])->assertForbidden();
        $this->hit($this->holder(['reports.view', 'costs.view']), ['GET', '/reports/profit'])->assertOk();
        $this->hit($this->holder(['orders.view']), ['GET', '/orders/{pending}'])->assertJsonPath('data.items.0.unit_cost_amount', null);
        $this->hit($this->holder(['costs.view']), ['GET', '/dashboard'])->assertJsonPath('data.inventory.stock_value_cost_amount', fn ($v) => is_int($v));
    }

    /** SEC-M1: `data.export` without `costs.view` must not get cost prices through a product CSV. */
    public function test_product_export_carries_cost_only_for_costs_view(): void
    {
        Storage::fake('local');
        $this->inTenant($this->s['tenant'], fn () => ProductVariant::query()->whereKey($this->s['variant'])->update(['cost_amount' => 55500]));
        $costColumn = function (array $h): array {
            $export = $this->hit($h, ['POST', '/exports', ['type' => 'products']])->assertStatus(202)->json('data');
            $csv = $this->get($export['download_url'])->assertOk()->streamedContent();
            $lines = array_map('str_getcsv', explode("\r\n", trim(ltrim($csv, "\xEF\xBB\xBF"))));
            $i = array_search('cost_price', $lines[0], true);
            $this->assertIsInt($i);

            return array_map(fn (array $row) => $row[$i] ?? '', array_slice($lines, 1));
        };

        $this->assertSame([''], $costColumn($this->holder(['data.export'])));
        $this->assertSame(['555'], $costColumn($this->holder(['data.export', 'costs.view'])));
        $this->assertSame(['555'], $costColumn($this->s['h']));
    }

    /** SEC-M2: `data.import` does not get around the keys of what the file writes. */
    public function test_imports_need_the_keys_of_what_they_write(): void
    {
        Storage::fake('local');
        $upload = fn (array $h, string $type, string $csv) => $this->flushHeaders()->withHeaders($h)->post("{$this->s['base']}/imports", [
            'type' => $type, 'file' => UploadedFile::fake()->createWithContent('f.csv', $csv),
        ], ['Accept' => 'application/json']);
        $products = "name,price,cost_price\nNew shirt,500,300\n";
        $noCost = "name,price\nOther shirt,500\n";
        $customers = "name,phone\nRahim,01912345678\n";

        $only = $this->holder(['data.import']);
        $upload($only, 'products', $products)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $upload($only, 'customers', $customers)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $upload($this->holder(['data.import', 'products.edit']), 'products', $products)->assertForbidden();
        $upload($this->holder(['data.import', 'inventory.adjust']), 'products', $products)->assertForbidden();
        $upload($this->holder(['data.import', 'customers.view', 'customers.edit']), 'customers', $customers)->assertCreated();

        // Uploaded by someone allowed; a member without the keys can't validate or run it either.
        $import = $upload($this->s['h'], 'products', $products)->assertCreated()->json('data');
        $this->hit($only, ['POST', "/imports/{$import['id']}/validate", ['column_map' => $import['suggested_map'], 'options' => ['update_existing' => true, 'import_as_draft' => false, 'create_missing_categories' => true]]])
            ->assertForbidden();

        // products.edit + inventory.adjust: a file that sets cost needs costs.view on run; one without cost runs.
        $stock = $this->holder(['data.import', 'products.edit', 'inventory.adjust']);
        $validated = function (array $h, string $csv): string {
            $import = $this->flushHeaders()->withHeaders($h)->post("{$this->s['base']}/imports", [
                'type' => 'products', 'file' => UploadedFile::fake()->createWithContent('f.csv', $csv),
            ], ['Accept' => 'application/json'])->assertCreated()->json('data');
            $this->hit($h, ['POST', "/imports/{$import['id']}/validate", ['column_map' => $import['suggested_map'], 'options' => ['update_existing' => true, 'import_as_draft' => false, 'create_missing_categories' => true]]])
                ->assertStatus(202);

            return $import['id'];
        };
        $withCost = $validated($stock, $products);
        $this->hit($stock, ['POST', "/imports/{$withCost}/run"])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->hit($stock, ['DELETE', "/imports/{$withCost}"])->assertNoContent();
        $this->hit($stock, ['POST', '/imports/'.$validated($stock, $noCost).'/run'])->assertStatus(202);
        $costs = $this->holder(['data.import', 'products.edit', 'inventory.adjust', 'costs.view']);
        $this->hit($costs, ['POST', '/imports/'.$validated($costs, "name,price,cost_price\nThird shirt,500,300\n").'/run'])->assertStatus(202);
    }
}

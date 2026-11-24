<?php

declare(strict_types=1);

namespace Tests\Feature\Purchasing;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Media\Models\Media;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/**
 * PHASE-8-8B §5.5 quick purchase, §7 reorder suggestions, §8.1 supplier invoices (S176), P88B-15 supplier CSV import
 * (S177), inventory INCOMING, impersonation (S178) and the limiter.
 */
#[Group('purchasing')]
class PurchasingExtrasTest extends TestCase
{
    use PurchasingFixtures, RefreshDatabase, SpaBrowser;

    private const OPTIONS = ['update_existing' => true, 'import_as_draft' => false, 'create_missing_categories' => true];

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPurchasing();
    }

    public function test_quick_purchase_with_payment_damaged_and_one_audit_entry(): void
    {
        [$owner, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store, stock: 0);
        $b = $this->variant($h, $store, stock: 5, cost: 400);
        $supplier = $this->addSupplier($h, $store, ['name' => 'Islampur Wholesale']);
        $key = 'quick-'.Str::random(10);
        $body = [
            'supplier_id' => $supplier['id'], 'shipping_amount' => 600, 'supplier_invoice_ref' => 'CASH-9',
            'lines' => [['variant_id' => $a, 'unit_cost_amount' => 1000, 'quantity' => 6, 'damaged' => 1], ['variant_id' => $b, 'unit_cost_amount' => 500, 'quantity' => 6]],
            'payment' => ['amount' => 5000, 'method' => 'cash', 'paid_on' => self::TODAY],
        ];
        $po = $this->quick($h, $store, $body, $key)->assertCreated()->json('data');
        $this->assertSame(['received', 12, 11, 1, 0, null], [$po['status'], $po['units_ordered'], $po['units_received'], $po['units_damaged'], $po['units_left'], $po['sent_via']]);
        $this->assertSame([9000, 600, 9600, 5000, 'partially_paid'], [$po['subtotal_amount'], $po['shipping_amount'], $po['total_amount'], $po['paid_amount'], $po['payment_status']]);
        // shares 400 / 200 → landed 1 067 (6 400 ÷ 6 = 1 066.67) and 533 (3 200 ÷ 6 = 533.33)
        $this->assertSame([1067, 533], array_column($po['lines'], 'landed_unit_cost_amount'));
        $this->assertSame(5 * 1067 + 6 * 533, $po['received_value_amount']);
        $this->assertSame(['CASH-9', ['id' => $owner->id, 'name' => $owner->name]], [$po['receipts'][0]['supplier_invoice_ref'], $po['receipts'][0]['received_by']]);
        $this->assertSame([5, 11], [$this->onHand($tenant, $a), $this->onHand($tenant, $b)]);
        $this->assertSame([1067, 473], [$this->costOf($tenant, $a), $this->costOf($tenant, $b)]); // (5 × 400 + 6 × 533) ÷ 11 = 472.5 → 473
        $this->assertSame(['quick_received'], array_column($po['events'], 'type'));
        $this->assertSame(5000, $po['payments'][0]['amount']);
        $this->assertSame(['purchasing.supplier_created', 'purchasing.quick_received'], array_column($this->purchasingAudit($tenant), 'action'));

        $again = $this->quick($h, $store, $body, $key)->assertCreated()->assertHeader('Idempotent-Replayed', 'true');
        $this->assertSame($po['id'], $again->json('data.id'));
        $this->assertSame(1, $this->platformTable('purchase_orders')->where('tenant_id', $tenant->id)->count());
        $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders/quick'), $body)->assertStatus(400);
        $this->quick($h, $store, ['lines' => [['variant_id' => $a, 'unit_cost_amount' => 10, 'quantity' => 1, 'damaged' => 2]]] + $body)
            ->assertUnprocessable()->assertJsonValidationErrorFor('lines.0.damaged', 'error.details');
        $this->quick($h, $store, ['lines' => [['variant_id' => $a, 'quantity' => 1]]] + $body)->assertUnprocessable()->assertJsonValidationErrorFor('lines.0.unit_cost_amount', 'error.details');
        $this->quick($h, $store, ['payment' => ['amount' => 1, 'method' => 'cash', 'paid_on' => '2026-11-21']] + $body)->assertUnprocessable()->assertJsonValidationErrorFor('payment.paid_on', 'error.details');
        $this->assertSame(1, $this->platformTable('purchase_orders')->where('tenant_id', $tenant->id)->count());
    }

    public function test_reorder_suggestions_from_shipped_units_and_lead_time(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $this->assertSame([], $this->api($h, 'GET', $this->pUrl($store, '/purchasing/reorder-suggestions'))->assertOk()->json('data'));

        $fast = $this->variant($h, $store, stock: 70, name: 'Fast Seller');
        $slow = $this->variant($h, $store, stock: 100, name: 'Slow Seller');
        $never = $this->variant($h, $store, stock: 0, name: 'Never Bought');
        $supplier = $this->addSupplier($h, $store, ['name' => 'Karim Traders', 'lead_time_days' => 10]);
        $po = $this->ordered($h, $store, $supplier['id'], [[$fast, 800, 10]]);
        $this->receive($h, $store, $po['id'], [['item_id' => $po['lines'][0]['id'], 'received' => 10]])->assertCreated(); // on hand 80

        // Shipped in 30 days: fast 60 (2/day), slow 3, never 30 (1/day); an older shipment doesn't count.
        $ship = fn (string $v, int $q) => $this->inTenant($tenant, fn () => app(InventoryService::class)->ship($store->id, [['variant_id' => $v, 'quantity' => $q]], strtolower((string) Str::ulid()), null));
        foreach ([[$fast, 60], [$slow, 3]] as [$v, $q]) {
            $this->platformTable('inventories')->where('tenant_id', $tenant->id)->where('variant_id', $v)->increment('committed', $q);
            $ship($v, $q);
        }
        $this->setOnHand($tenant, $never, 30);
        $this->platformTable('inventories')->where('tenant_id', $tenant->id)->where('variant_id', $never)->increment('committed', 30);
        $ship($never, 30);
        $this->platformTable('inventory_movements')->where('tenant_id', $tenant->id)->where('variant_id', $slow)->where('reason', 'order_shipped')->update(['created_at' => now()->subDays(31)]);
        $this->ordered($h, $store, $supplier['id'], [[$fast, 800, 6]]); // incoming 6

        $groups = $this->api($h, 'GET', $this->pUrl($store, '/purchasing/reorder-suggestions'))->assertOk()->json('data');
        // fast: available 20, incoming 6 → floor(26 ÷ 2) = 13 ≤ 10 + 7 → suggest max(1, 60 − 20 − 6) = 34
        // never: available 0 → 0 days ("Out of stock"), no supplier → lead 7 → suggest 30
        $this->assertSame([null, ['id' => $supplier['id'], 'name' => 'Karim Traders', 'lead_time_days' => 10]], array_column($groups, 'supplier'));
        $this->assertSame(['variant_id' => $never, 'available' => 0, 'incoming' => 0, 'sold_30d' => 30, 'days_left' => 0, 'suggested_quantity' => 30, 'last_unit_cost_amount' => null],
            array_intersect_key($groups[0]['items'][0], array_flip(['variant_id', 'available', 'incoming', 'sold_30d', 'days_left', 'suggested_quantity', 'last_unit_cost_amount'])));
        $this->assertSame(['variant_id' => $fast, 'available' => 20, 'incoming' => 6, 'sold_30d' => 60, 'days_left' => 13, 'suggested_quantity' => 34, 'last_unit_cost_amount' => 800],
            array_intersect_key($groups[1]['items'][0], array_flip(['variant_id', 'available', 'incoming', 'sold_30d', 'days_left', 'suggested_quantity', 'last_unit_cost_amount'])));
        $this->assertSame('Fast Seller', $groups[1]['items'][0]['product']['name']);

        // INCOMING on the inventory list.
        $inv = collect($this->api($h, 'GET', $this->pUrl($store, '/inventory'))->assertOk()->json('data'))->keyBy('variant_id');
        $this->assertSame([6, 0], [$inv[$fast]['incoming'], $inv[$slow]['incoming']]);
    }

    #[Group('security')]
    public function test_invoice_upload_attach_and_signed_download(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store);
        $supplier = $this->addSupplier($h, $store);
        $po = $this->ordered($h, $store, $supplier['id'], [[$a, 100, 4]]);

        $this->uploadInvoice($h, $store, 'bill.pdf', 'not a pdf')->assertUnprocessable()->assertJsonValidationErrorFor('file', 'error.details');
        $this->uploadInvoice($h, $store, 'bill.png', "%PDF-1.4\n%%EOF\n")->assertUnprocessable(); // extension trick
        $up = $this->uploadInvoice($h, $store)->assertCreated()->json('data');
        $this->assertSame(['application/pdf', 'ready'], [$up['mime'], $up['status']]);
        $media = $this->platformQuery(Media::class)->where('tenant_id', $tenant->id)->whereKey($up['id'])->first();
        $this->assertSame(['purchase_invoice', 'local'], [$media->purpose, $media->disk]);
        $this->assertStringStartsWith("tenants/{$tenant->id}/", $media->path);
        // Never in the media library (S176).
        $this->assertSame([], array_column($this->api($h, 'GET', '/api/v1/media')->assertOk()->json('data'), 'id'));
        $this->api($h, 'GET', "/api/v1/media/{$up['id']}")->assertNotFound();

        // Another tenant's invoice can't be attached.
        [, , $storeB, $hB] = $this->buyer('beta');
        $foreign = $this->uploadInvoice($hB, $storeB)->assertCreated()->json('data.id');
        $this->receive($h, $store, $po['id'], [['item_id' => $po['lines'][0]['id'], 'received' => 1]], ['invoice_media_id' => $foreign])
            ->assertUnprocessable()->assertJsonValidationErrorFor('invoice_media_id', 'error.details');

        $body = $this->receive($h, $store, $po['id'], [['item_id' => $po['lines'][0]['id'], 'received' => 1]], ['invoice_media_id' => $up['id']])->assertCreated()->json('data');
        $invoice = $body['receipts'][0]['invoice'];
        $this->assertSame([$up['id'], 'application/pdf', 'ready'], [$invoice['id'], $invoice['mime'], $invoice['status']]);
        $download = $this->flushHeaders()->get((string) $invoice['url'])->assertOk();
        $download->assertHeader('X-Content-Type-Options', 'nosniff');
        $this->assertStringContainsString('attachment', (string) $download->headers->get('Content-Disposition'));
        $this->flushHeaders()->get((string) $invoice['url'].'x')->assertForbidden();
        // Already attached → can't be attached again.
        $this->receive($h, $store, $po['id'], [['item_id' => $po['lines'][0]['id'], 'received' => 1]], ['invoice_media_id' => $up['id']])->assertUnprocessable();

        // Staff with inventory.adjust may upload (receivers attach invoices).
        [, $staff] = $this->memberAs($tenant, TenantUser::ROLE_STAFF);
        $this->uploadInvoice($staff, $store)->assertCreated();
        $this->assertTrue(Storage::disk('local')->exists($media->path));
    }

    #[Group('security')]
    public function test_supplier_csv_import(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $existing = $this->addSupplier($h, $store, ['name' => 'Rahman Fabrics', 'phone' => '01711000222', 'city' => 'Dhaka']);
        $byName = $this->addSupplier($h, $store, ['name' => 'PackRight BD']);
        [, , $storeB, $hB] = $this->buyer('beta');
        $this->addSupplier($hB, $storeB, ['name' => 'Nila Textiles', 'phone' => '01911000444']); // another tenant: never matched

        $csv = "Supplier name,Phone,City,Supplies,Payment terms,Lead time,Pays by,Account,Notes\n"
            ."Rahman Fab (new name),+8801711000222,Chattogram,,30,5,bkash,01711000222,\n"
            ."packright bd,,Narayanganj,Boxes,,3,cash,,\n"
            ."Nila Textiles,01911000444,,,,,,,\n"
            ."=HYPERLINK(\"x\"),12345,,,,,,,\n"
            .",01811000555,,,,,,,\n";
        $import = $this->flushHeaders()->withHeaders($h)->post($this->pUrl($store, '/imports'), [
            'type' => 'suppliers', 'file' => UploadedFile::fake()->createWithContent('suppliers.csv', $csv),
        ], ['Accept' => 'application/json'])->assertCreated()->json('data');
        $this->assertSame([
            'Supplier name' => 'name', 'Phone' => 'phone', 'City' => 'city', 'Supplies' => 'supplies', 'Payment terms' => 'payment_terms_days',
            'Lead time' => 'lead_time_days', 'Pays by' => 'pays_by_method', 'Account' => 'pays_by_account', 'Notes' => 'notes',
        ], $import['suggested_map']);
        $this->api($h, 'POST', $this->pUrl($store, "/imports/{$import['id']}/validate"), ['column_map' => $import['suggested_map'], 'options' => self::OPTIONS])->assertStatus(202);
        $validated = $this->api($h, 'GET', $this->pUrl($store, "/imports/{$import['id']}"))->assertOk()->json('data');
        $this->assertSame(['total' => 5, 'create' => 1, 'update' => 2, 'errors' => 2], array_intersect_key($validated['summary'], array_flip(['total', 'create', 'update', 'errors'])));

        $report = $this->flushHeaders()->withHeaders($h)->get($this->pUrl($store, "/imports/{$import['id']}/error-report"))->assertOk()->getContent();
        $this->assertStringContainsString("\"'=HYPERLINK(\"\"x\"\")\"", (string) $report); // formula-safe (S177)

        $this->api($h, 'POST', $this->pUrl($store, "/imports/{$import['id']}/run"))->assertStatus(202);
        $rows = $this->platformQuery(Supplier::class)->where('tenant_id', $tenant->id)->orderBy('name')->get()->keyBy('id');
        $this->assertCount(3, $rows);
        $this->assertSame(['Rahman Fab (new name)', 'Chattogram', 30, 5, 'bkash'], [$rows[$existing['id']]->name, $rows[$existing['id']]->city, $rows[$existing['id']]->payment_terms_days, $rows[$existing['id']]->lead_time_days, $rows[$existing['id']]->pays_by_method]);
        $this->assertSame(['PackRight BD', 'Narayanganj', 'Boxes'], [$rows[$byName['id']]->name, $rows[$byName['id']]->city, $rows[$byName['id']]->supplies]);
        $new = $rows->first(fn ($s) => $s->name === 'Nila Textiles');
        $this->assertSame('8801911000444', $new->phone);
        $this->assertContains('purchasing.suppliers_imported', array_column($this->purchasingAudit($tenant), 'action'));

        // Permissions and plan: data.import alone isn't enough; Free → 402.
        [, $staff] = $this->memberAs($tenant, TenantUser::ROLE_STAFF);
        $this->flushHeaders()->withHeaders($staff)->post($this->pUrl($store, '/imports'), ['type' => 'suppliers', 'file' => UploadedFile::fake()->createWithContent('s.csv', "name\nA\n")], ['Accept' => 'application/json'])->assertForbidden();
        [, , $free, $hF] = $this->freeBuyer();
        $this->flushHeaders()->withHeaders($hF)->post($this->pUrl($free, '/imports'), ['type' => 'suppliers', 'file' => UploadedFile::fake()->createWithContent('s.csv', "name\nA\n")], ['Accept' => 'application/json'])->assertStatus(402);
        $this->flushHeaders()->withHeaders($h)->get($this->pUrl($store, '/imports/template?type=suppliers'))->assertOk();
    }

    #[Group('security')]
    public function test_impersonation_reads_but_cannot_write(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $supplier = $this->addSupplier($h, $store);
        $po = $this->ordered($h, $store, $supplier['id'], [[$this->variant($h, $store), 100, 2]]);

        $this->useSpaBrowser();
        Mail::fake();
        $staff = User::factory()->create();
        $staff->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($staff, $tenant, 'Customer ticket: purchase order check', 'ZD-88', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];

        $this->browser('GET', $this->pUrl($store, "/purchase-orders/{$po['id']}"), [], $t)->assertOk()->assertJsonPath('data.total_amount', 200);
        $this->browser('GET', $this->pUrl($store, '/suppliers'), [], $t)->assertOk();
        $this->browser('POST', $this->pUrl($store, '/suppliers'), ['name' => 'X'], $t)->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        $this->browser('POST', $this->pUrl($store, "/purchase-orders/{$po['id']}/receipts"), ['lines' => [['item_id' => $po['lines'][0]['id'], 'received' => 1]]], $t + ['Idempotency-Key' => (string) Str::uuid()])->assertForbidden();
        $this->browser('POST', $this->pUrl($store, "/purchase-orders/{$po['id']}/close"), [], $t)->assertForbidden();
        $this->assertSame('ordered', $this->getPo($h, $store, $po['id'])->json('data.status'));
    }

    public function test_write_limiter(): void
    {
        $this->app->forgetInstance(ThrottleRequests::class); // setUp turned throttles off
        [, , $store, $h] = $this->buyer();
        for ($i = 0; $i < 60; $i++) {
            $this->api($h, 'POST', $this->pUrl($store, '/suppliers'), ['name' => "Supplier {$i}"])->assertCreated();
        }
        $this->api($h, 'POST', $this->pUrl($store, '/suppliers'), ['name' => 'One more'])->assertTooManyRequests();
        $this->api($h, 'GET', $this->pUrl($store, '/suppliers'))->assertOk(); // reads aren't limited by it
    }
}

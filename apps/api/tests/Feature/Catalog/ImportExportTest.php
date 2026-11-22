<?php

namespace Tests\Feature\Catalog;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Customers\Models\Customer;
use App\Domain\DataTransfer\Csv\CsvCell;
use App\Domain\DataTransfer\Models\DataExport;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Database\Seeders\PlanSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

class ImportExportTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase;

    public const OPTIONS = ['update_existing' => true, 'import_as_draft' => false, 'create_missing_categories' => true];

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        config(['storeplix.bulk_per_hour' => 1000]);
    }

    protected function upload(array $h, Store $store, string $csv, string $type = 'products', string $name = 'file.csv'): TestResponse
    {
        return $this->flushHeaders()->withHeaders($h)->post("/api/v1/stores/{$store->id}/imports", [
            'type' => $type,
            'file' => UploadedFile::fake()->createWithContent($name, $csv),
        ], ['Accept' => 'application/json']);
    }

    /** Upload + validate with the suggested map. @return array<string, mixed> DataImport */
    protected function validated(array $h, Store $store, string $csv, string $type = 'products', array $options = self::OPTIONS): array
    {
        $import = $this->upload($h, $store, $csv, $type)->assertCreated()->json('data');
        $map = array_map(fn ($f) => $f, $import['suggested_map']);

        return $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/validate", ['column_map' => $map, 'options' => $options])
            ->assertStatus(202)->json('data');
    }

    /** @return array<int, array<string, mixed>> row_number → row */
    protected function rows(array $h, Store $store, string $id): array
    {
        $rows = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/imports/{$id}/rows?per_page=100")->assertOk()->json('data');

        return array_column($rows, null, 'row_number');
    }

    public function test_upload_checks(): void
    {
        [, , $store, $h] = $this->shop();
        foreach (["PK\x03\x04zip", "\x1f\x8bgzip", "\xD0\xCF\x11\xE0xls", '%PDF-1.4', "name,price\nA\0,1"] as $bad) {
            $this->upload($h, $store, $bad)->assertStatus(422)->assertJsonPath('error.code', 'unsupported_file')
                ->assertJsonPath('error.message', 'Save the file as CSV UTF-8 and try again.');
        }
        $this->upload($h, $store, "name,price\n\xC3\x28bad,1")->assertStatus(422)->assertJsonPath('error.code', 'unsupported_file');
        $this->upload($h, $store, "name,price\n")->assertStatus(422)->assertJsonPath('error.code', 'empty_file');
        $this->upload($h, $store, "name,price\n".str_repeat("A,1\n", 5001))->assertStatus(422)->assertJsonPath('error.code', 'too_many_rows');
        $this->upload($h, $store, implode(',', array_map(fn ($i) => "c{$i}", range(1, 51)))."\n".str_repeat('1,', 50)."1\n")
            ->assertStatus(422)->assertJsonPath('error.code', 'too_many_columns');
        $this->upload($h, $store, "name,price\n\"".str_repeat('a', 10001)."\",1\n")->assertStatus(422)->assertJsonPath('error.code', 'cell_too_long');
        $this->upload($h, $store, 'name,price'."\n".str_repeat('a', 70000).",1\n")->assertStatus(422)->assertJsonPath('error.code', 'line_too_long');
        $this->upload($h, $store, "name,Name\nA,B\n")->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->upload($h, $store, str_repeat('a', 10_485_761))->assertStatus(413)->assertJsonPath('error.code', 'payload_too_large');

        // BOM + semicolon delimiter + samples + Shopify suggestions.
        $import = $this->upload($h, $store, "\xEF\xBB\xBFHandle;Title;Variant SKU;Variant Price;Option1 Name;Option1 Value;Body (HTML)\nx;Shirt;;950;Size;M;<p>Hi</p>\n", name: 'shop<ify>.csv')
            ->assertCreated()->assertJsonPath('data.status', 'uploaded')->assertJsonPath('data.row_count', 1)
            ->assertJsonPath('data.samples.Title', 'Shirt')->assertJsonPath('data.filename', 'shop_ify_.csv')->json('data');
        $this->assertSame(['Handle' => 'handle', 'Title' => 'name', 'Variant SKU' => 'sku', 'Variant Price' => 'price',
            'Option1 Name' => 'option1_name', 'Option1 Value' => 'option1_value', 'Body (HTML)' => 'description'], $import['suggested_map']);

        $woo = $this->upload($h, $store, "Name,Regular price,Sale price,Stock,Categories,Size\nA,100,80,3,Women,M\n")->json('data.suggested_map');
        $this->assertSame(['Name' => 'name', 'Regular price' => 'compare_at_price', 'Sale price' => 'price', 'Stock' => 'stock', 'Categories' => 'category', 'Size' => 'option1_value'], $woo);
    }

    public function test_validate_summary_normalisation_and_run_idempotent(): void
    {
        Bus::fake([RevalidateStorefront::class]);
        [$owner, $tenant, $store, $h] = $this->shop();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Women']);
        $csv = implode("\n", [
            'handle,name,description,status,category,tags,option1_name,option1_value,sku,price,compare_at_price,cost_price,stock,image_urls',
            'jamdani,Jamdani Three-Piece,<b>Soft</b> cotton,active,Women > Three-piece,"eid, jamdani",Size,M,JT-M,"৳ 3,450",3950,2100,১৪,',
            'jamdani,,,,,,Size,L,JT-L,3450,3950,2100,9,',
            'tee,Tee,Plain,,Missing,,,,TEE-1,950tk,,,5,https://x.test/a.jpg',
            'bad,Bad stock,,,,,,,BAD-1,100,,,-3,',
            'noprice,No price,,,,,,,NP-1,,,,,',
            'jamdani,Late row,,,,,Size,XL,JT-XL,3450,,,1,',
        ])."\n";
        $import = $this->validated($h, $store, $csv);
        $this->assertSame('validated', $import['status']);
        $this->assertSame(['total' => 6, 'create' => 3, 'update' => 0, 'unchanged' => 0, 'warnings' => 2, 'errors' => 3, 'over_limit' => 0], $import['summary']);

        $rows = $this->rows($h, $store, $import['id']);
        $this->assertSame('warning', $rows[2]['status']);
        $this->assertSame(345000, $rows[2]['preview']['price_amount']);
        $this->assertSame(14, $rows[2]['preview']['stock']);
        $this->assertSame(2, $rows[2]['preview']['variants']);
        $messages = array_column($rows[2]['messages'], 'message');
        $this->assertContains('Formatting was removed.', $messages);
        $this->assertContains('Price "৳ 3,450" read as ৳ 3,450', $messages);
        $this->assertContains('Price "950tk" read as ৳ 950', array_column($rows[4]['messages'], 'message'));
        $this->assertContains("Photos from links aren't imported yet.", array_column($rows[4]['messages'], 'message'));
        $this->assertSame("Stock can't be negative.", $rows[5]['messages'][0]['message']);
        $this->assertSame('error', $rows[6]['status']);
        $this->assertSame('Rows for one product must be next to each other.', $rows[7]['messages'][0]['message']);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/imports/{$import['id']}/rows?filter[status]=error")->assertJsonCount(3, 'data');

        // Nothing changed before run.
        $this->assertSame(0, Product::withoutTenancy()->where('store_id', $store->id)->count());

        $done = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/run")->assertStatus(202)->json('data');
        $this->assertSame('completed', $done['status']);
        $products = Product::withoutTenancy()->where('store_id', $store->id)->orderBy('name')->get();
        $this->assertSame(['Jamdani Three-Piece', 'Tee'], $products->pluck('name')->all());
        $jamdani = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/products/{$products[0]->id}")->json('data');
        $this->assertSame('jamdani', $jamdani['slug']);
        $this->assertSame(['M', 'L'], array_column($jamdani['variants'], 'title'));
        $this->assertSame([14, 9], array_column(array_column($jamdani['variants'], 'inventory'), 'on_hand'));
        $this->assertSame(['eid', 'jamdani'], $jamdani['tags']);
        $this->assertSame('Three-piece', $jamdani['categories'][0]['name']);
        $this->assertSame('active', $jamdani['status']);
        $this->assertSame([['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'Soft cotton']]]], $jamdani['description']['content']);
        $this->assertSame(1, Category::withoutTenancy()->where('store_id', $store->id)->where('name', 'Missing')->count());
        $ledger = InventoryMovement::withoutTenancy()->where('reason', 'import')->count();
        $this->assertSame(3, $ledger);
        $this->assertTrue(AuditLog::query()->where('action', 'import.run')->exists());
        Bus::assertDispatchedTimes(RevalidateStorefront::class, 1);

        // Same file again → unchanged rows, no new ledger rows, no new products.
        $again = $this->validated($h, $store, $csv);
        $this->assertSame(3, $again['summary']['unchanged']);
        $this->assertSame(0, $again['summary']['create']);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$again['id']}/run")->assertStatus(202);
        $this->assertSame($ledger, InventoryMovement::withoutTenancy()->where('reason', 'import')->count());
        $this->assertSame(2, Product::withoutTenancy()->where('store_id', $store->id)->count());

        // Stock on an update is a SET with an `import` ledger row.
        $third = $this->validated($h, $store, "sku,name,price,stock\nJT-M,Jamdani Three-Piece,3450,20\n");
        $this->assertSame(1, $third['summary']['update']);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$third['id']}/run")->assertStatus(202);
        $last = InventoryMovement::withoutTenancy()->where('reason', 'import')->latest('id')->first();
        $this->assertSame(6, $last->delta);
        $this->assertSame(20, $last->on_hand_after);
        $this->assertSame('import', $last->reference_type);
    }

    public function test_missing_category_without_create_option_and_state_rules(): void
    {
        [, , $store, $h] = $this->shop();
        $options = ['create_missing_categories' => false] + self::OPTIONS;
        $import = $this->validated($h, $store, "name,price,category\nA,10,Nope\n", options: $options);
        $this->assertSame(1, $import['summary']['create']);

        // rows before validation → 409; run twice → 409; delete while validated → 204.
        $fresh = $this->upload($h, $store, "name,price\nB,1\n")->json('data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/imports/{$fresh['id']}/rows")->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$fresh['id']}/run")->assertStatus(409);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$fresh['id']}/validate", ['column_map' => ['name' => 'name'], 'options' => self::OPTIONS])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['column_map']]]);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$fresh['id']}/validate", ['column_map' => ['name' => 'name', 'price' => 'name'], 'options' => self::OPTIONS])
            ->assertStatus(422);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$fresh['id']}/validate", ['column_map' => ['name' => 'name', 'price' => 'bogus'], 'options' => self::OPTIONS])
            ->assertStatus(422);
        $this->api($h, 'DELETE', "/api/v1/stores/{$store->id}/imports/{$fresh['id']}")->assertNoContent();
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/imports/{$fresh['id']}")->assertJsonPath('data.status', 'cancelled');
    }

    public function test_one_active_import_per_store(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $a = $this->upload($h, $store, "name,price\nA,1\n")->json('data');
        $this->tenancy()->run($tenant, fn () => DataImport::query()->whereKey($a['id'])->update(['status' => 'validating']));
        $this->upload($h, $store, "name,price\nB,1\n")->assertStatus(409)->assertJsonPath('error.code', 'import_in_progress');
        $this->api($h, 'DELETE', "/api/v1/stores/{$store->id}/imports/{$a['id']}")->assertStatus(409);
    }

    public function test_plan_limit_on_run_and_allow_partial(): void
    {
        $this->seed(PlanSeeder::class);
        [, $tenant, $store, $h] = $this->shop();
        $this->onFreePlan($tenant, $store, 98);
        $csv = "name,price,sku\nA,1,A1\nB,1,B1\nC,1,C1\n";
        $import = $this->validated($h, $store, $csv);
        $this->assertSame(1, $import['summary']['over_limit']);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/run")
            ->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached')
            ->assertJsonPath('error.message', 'Your plan has room for 2 more products; this file creates 3.');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/run", ['allow_partial' => true])->assertStatus(202)
            ->assertJsonPath('data.summary.create', 2)->assertJsonPath('data.summary.errors', 1);
        $this->assertSame(100, Product::withoutTenancy()->where('store_id', $store->id)->count());
    }

    public function test_customer_import_upsert_and_duplicates(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", ['name' => 'Old name', 'phone' => '01711111111', 'district' => 'Dhaka']);
        $csv = implode("\n", [
            'Name,Phone,Email,District,Channel,Accepts marketing,Note',
            'New name,01711-111111,,,facebook,yes,',
            'Rina,01822222222,rina@x.test,Sylhet,tiktok,no,Calls after 6pm',
            'Dup,+8801822222222,,,,,',
            'Foreign,+14155550100,,,,,',
            'Mail only,,MAIL@x.test,,,,',
        ])."\n";
        $import = $this->validated($h, $store, $csv, 'customers');
        $this->assertSame(['total' => 5, 'create' => 2, 'update' => 1, 'unchanged' => 0, 'warnings' => 1, 'errors' => 2, 'over_limit' => 0], $import['summary']);
        $rows = $this->rows($h, $store, $import['id']);
        $this->assertSame('Same phone as row 3.', $rows[4]['messages'][0]['message']);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/run")->assertStatus(202);

        $this->tenancy()->run($tenant, function () {
            $old = Customer::query()->where('phone', '8801711111111')->first();
            $this->assertSame('New name', $old->name);
            $this->assertSame('Dhaka', $old->district); // empty cell keeps the value
            $rina = Customer::query()->where('phone', '8801822222222')->withCount('notes')->first();
            $this->assertSame('import', $rina->source);
            $this->assertNull($rina->channel);
            $this->assertSame(1, $rina->notes_count);
            $this->assertSame(3, Customer::query()->count());
        });

        $again = $this->validated($h, $store, $csv, 'customers');
        $this->assertSame(3, $again['summary']['unchanged']);
    }

    #[Group('security')]
    public function test_error_report_export_and_template_are_formula_safe(): void
    {
        [, , $store, $h] = $this->shop();
        $import = $this->validated($h, $store, "name,price,sku\n=HYPERLINK(\"http://evil\"),abc,@SUM\n");
        $report = $this->flushHeaders()->withHeaders($h)->get("/api/v1/stores/{$store->id}/imports/{$import['id']}/error-report")->assertOk();
        $this->assertStringStartsWith("\xEF\xBB\xBF", $report->getContent());
        $this->assertStringContainsString("\"'=HYPERLINK(\"\"http://evil\"\")\"", $report->getContent());
        $this->assertStringContainsString("\"'@SUM\"", $report->getContent());

        $template = $this->flushHeaders()->withHeaders($h)->get("/api/v1/stores/{$store->id}/imports/template?type=products")
            ->assertOk()->assertHeader('Content-Disposition', 'attachment; filename="storeplix-products-template.csv"');
        $this->assertStringContainsString("\r\n", $template->getContent());

        $this->createProduct($h, $store, ['name' => '-Danger', 'tags' => ['+cmd'], 'variants' => [['price_amount' => 100, 'sku' => 'S-1']], 'seo' => ['title' => '@title']]);
        $export = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/exports", ['type' => 'products'])->assertStatus(202)->json('data');
        $this->assertSame('completed', $export['status']);
        $csv = $this->get($export['download_url'])->assertOk()->streamedContent();
        $this->assertStringContainsString("\"'-Danger\"", $csv);
        $this->assertStringContainsString("\"'+cmd\"", $csv);
        $this->assertStringContainsString("\"'@title\"", $csv);
        $this->assertStringNotContainsString(',"-Danger"', $csv);
    }

    public function test_csv_cell_safe_unit(): void
    {
        foreach (['=1+1', '+1', '-1', '@a', "\tx", "\rx", '＝1', '＋1', '－1', '＠a', ' =1', "\n@x", '-5'] as $cell) {
            $this->assertSame("'".$cell, CsvCell::safe($cell), json_encode($cell));
            $this->assertSame($cell, CsvCell::unescape(CsvCell::safe($cell)));
        }
        foreach (['', 'শাড়ি', 'Plain', "'quoted", '5'] as $cell) {
            $this->assertSame($cell, CsvCell::safe($cell));
        }
    }

    public function test_export_round_trip_expiry_and_audit(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->createProduct($h, $store, $this->variableProduct());
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", ['name' => 'Farhana', 'phone' => '01556120987', 'tags' => ['vip']]);

        $export = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/exports", ['type' => 'products', 'filters' => ['status' => ['active']]])->json('data');
        $this->assertMatchesRegularExpression('/^'.$store->slug.'-products-\d{8}-\d{4}\.csv$/', $export['filename']);
        $this->assertSame(2, $export['row_count']);
        $csv = $this->get($export['download_url'])->assertOk()->streamedContent();
        $lines = explode("\r\n", trim($csv));
        $this->assertSame("\xEF\xBB\xBF\"handle\",\"name\",\"description\"", substr($lines[0], 0, 32));

        // Re-import the export: every row unchanged.
        $re = $this->validated($h, $store, $csv);
        $this->assertSame(2, $re['summary']['unchanged']);
        $this->assertSame(0, $re['summary']['errors']);

        $customers = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/exports", ['type' => 'customers'])->json('data');
        $this->assertStringContainsString('"8801556120987"', $this->get($customers['download_url'])->streamedContent());
        $this->assertTrue(AuditLog::query()->where('action', 'customer.exported')->exists());
        $this->assertSame(3, AuditLog::query()->where('action', 'export.created')->count() + 1);

        // Signed URL expires after 5 minutes; export expires after 24 h.
        $url = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/exports/{$export['id']}")->json('data.download_url');
        $this->travel(6)->minutes();
        $this->get($url)->assertForbidden();
        $this->travel(25)->hours();
        $this->artisan('data:expire-exports')->assertSuccessful();
        $h = $this->tenantHeaders(...$this->ownerOf($tenant));
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/exports/{$export['id']}")->assertJsonPath('data.status', 'expired')->assertJsonPath('data.download_url', null);
        $this->assertSame(DataExport::EXPIRED, DataExport::withoutTenancy()->find($export['id'])->status);
    }

    #[Group('security')]
    public function test_staff_cannot_import_or_export(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, $staffH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->upload($staffH, $store, "name,price\nA,1\n")->assertForbidden();
        $this->api($staffH, 'POST', "/api/v1/stores/{$store->id}/exports", ['type' => 'customers'])->assertForbidden();
        $this->api($staffH, 'GET', "/api/v1/stores/{$store->id}/imports/template?type=products")->assertForbidden();
        $import = $this->upload($h, $store, "name,price\nA,1\n")->json('data');
        $this->api($staffH, 'GET', "/api/v1/stores/{$store->id}/imports/{$import['id']}")->assertForbidden();
    }

    #[Group('security')]
    public function test_description_script_stays_text(): void
    {
        [, , $store, $h] = $this->shop();
        $import = $this->validated($h, $store, "name,price,description\nX,1,\"<script>alert(1)</script>Hello\"\n");
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/run")->assertStatus(202);
        $id = Product::withoutTenancy()->where('store_id', $store->id)->value('id');
        $desc = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/products/{$id}")->json('data.description');
        $this->assertSame('alert(1)Hello', $desc['content'][0]['content'][0]['text']);
        $this->assertStringNotContainsString('<script', json_encode($desc));
    }

    protected function onFreePlan(Tenant $tenant, Store $store, int $existing): void
    {
        $this->tenancy()->run($tenant, function () use ($store, $existing) {
            Subscription::query()->update(['plan_id' => Plan::query()->where('code', Plan::FREE)->value('id'), 'status' => Subscription::ACTIVE]);
            for ($i = 0; $i < $existing; $i++) {
                $p = new Product(['name' => "P{$i}", 'slug' => "p-{$i}", 'type' => 'simple', 'currency' => 'BDT']);
                $p->store_id = $store->id;
                $p->save();
            }
        });
        FeatureGate::forget($tenant->id);
    }

    /** @return array{0: User, 1: Tenant} */
    protected function ownerOf(Tenant $tenant): array
    {
        [$user] = $this->merchant(TenantUser::ROLE_ADMIN, $tenant);

        return [$user, $tenant];
    }
}

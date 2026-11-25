<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Identity\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** PHASE-8-8D §5.3: till catalog with stock at the register location, exact scan lookup, exact phone lookup (S203). */
#[Group('pos')]
class PosCatalogApiTest extends TestCase
{
    use PosFixtures, RefreshDatabase, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_catalog_lists_active_products_by_name_with_stock_at_the_register_location(): void
    {
        $s = $this->posShop(shopStock: 4, onlineStock: 10, price: 45000);
        [$h, $store] = [$s['h'], $s['store']];
        $variable = $this->createProduct($h, $store, $this->variableProduct('Aarong Kurta', ['M', 'L'], ['Red'], 'AK'));
        $untracked = $this->createProduct($h, $store, $this->simpleProduct('Zz gift wrap', 1000, ['status' => 'active'], ['track_inventory' => false]))['variants'][0]['id'];
        $this->createProduct($h, $store, $this->simpleProduct('Draft thing', 1000, ['status' => 'draft']));
        $this->adjustAt($h, $store, [['variant_id' => $variable['variants'][1]['id'], 'mode' => 'delta', 'quantity' => 2, 'location_id' => $s['shop']]])->assertOk();

        $data = $this->api($h, 'GET', $this->pUrl($store, "/catalog?register_id={$s['register']}"))->assertOk()
            ->assertJsonPath('meta.per_page', 40)->assertJsonPath('meta.next_cursor', null)->json('data');
        $this->assertSame(['Aarong Kurta', 'Zz gift wrap'], [$data[0]['name'], $data[2]['name']]);
        $this->assertCount(3, $data); // the draft is hidden
        $kurta = $data[0];
        $this->assertSame('BDT', $kurta['currency']);
        $this->assertSame(['Red', 'M'], [$kurta['variants'][0]['options'][1]['value'], $kurta['variants'][0]['options'][0]['value']]);
        $this->assertSame('M · Red', $kurta['variants'][0]['title']);
        $this->assertSame(0, $kurta['variants'][0]['available']); // nothing at the shop (10 online)
        $this->assertSame(2, $kurta['variants'][1]['available']);
        $this->assertSame(4, $data[1]['variants'][0]['available']);
        $this->assertNull($data[2]['variants'][0]['available']); // untracked
        $this->assertSame($untracked, $data[2]['variants'][0]['id']);

        $this->api($h, 'GET', $this->pUrl($store, "/catalog?register_id={$s['register']}&q=kurta"))->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', $this->pUrl($store, "/catalog?register_id={$s['register']}&q=ak-red-l"))->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', $this->pUrl($store, "/catalog?register_id={$s['register']}&q=%25"))->assertOk()->assertJsonCount(0, 'data');
        $this->api($h, 'GET', $this->pUrl($store, '/catalog'))->assertStatus(422)->assertJsonValidationErrors(['register_id'], 'error.details');

        $category = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Kurtas'])->assertCreated()->json('data.id');
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$variable['id']}", ['revision' => $variable['revision'], 'category_ids' => [$category]])->assertOk();
        $this->api($h, 'GET', $this->pUrl($store, "/catalog?register_id={$s['register']}&filter[category_id]={$category}"))->assertOk()
            ->assertJsonCount(1, 'data')->assertJsonPath('data.0.product_id', $variable['id']);
    }

    public function test_catalog_pages_by_cursor_40_at_a_time(): void
    {
        $s = $this->posShop();
        for ($i = 0; $i < 40; $i++) {
            $this->stocked($s['h'], $s['store'], price: 1000, stock: 1, extra: ['name' => sprintf('Item %02d', $i)]);
        }
        $first = $this->api($s['h'], 'GET', $this->pUrl($s['store'], "/catalog?register_id={$s['register']}"))->assertOk()->assertJsonCount(40, 'data')->json();
        $this->assertNotNull($first['meta']['next_cursor']);
        $this->api($s['h'], 'GET', $this->pUrl($s['store'], "/catalog?register_id={$s['register']}&cursor=".urlencode($first['meta']['next_cursor'])))->assertOk()
            ->assertJsonCount(1, 'data')->assertJsonPath('meta.next_cursor', null);
    }

    public function test_lookup_is_an_exact_case_insensitive_sku_then_barcode_match(): void
    {
        $s = $this->posShop(shopStock: 3);
        [$h, $store] = [$s['h'], $s['store']];
        $variable = $this->createProduct($h, $store, $this->variableProduct('Panjabi', ['M', 'L'], ['Blue'], 'PJ'));
        $sku = $variable['variants'][1]['sku'];
        $this->api($h, 'GET', $this->pUrl($store, "/lookup?register_id={$s['register']}&code=".strtolower($sku)))->assertOk()
            ->assertJsonPath('data.product_id', $variable['id'])->assertJsonCount(1, 'data.variants')
            ->assertJsonPath('data.variants.0.id', $variable['variants'][1]['id'])->assertJsonPath('data.variants.0.available', 0);

        $barcode = $this->platformQuery(ProductVariant::class)->whereKey($s['variant'])->value('barcode');
        $this->api($h, 'GET', $this->pUrl($store, "/lookup?register_id={$s['register']}&code={$barcode}"))->assertOk()
            ->assertJsonPath('data.variants.0.id', $s['variant'])->assertJsonPath('data.variants.0.available', 3);

        foreach (['PJ%', 'PJ-Blue-_', substr($sku, 0, 4), 'nothing'] as $code) {
            $this->api($h, 'GET', $this->pUrl($store, "/lookup?register_id={$s['register']}&code=".urlencode($code)))->assertNotFound()
                ->assertJsonPath('error.code', 'pos_code_not_found')->assertJsonPath('error.details.code', $code);
        }
        $this->api($h, 'GET', $this->pUrl($store, "/lookup?register_id={$s['register']}&code=".str_repeat('A', 65)))->assertStatus(422);
    }

    #[Group('security')]
    public function test_customer_lookup_by_exact_phone_only_with_its_own_limiter(): void
    {
        $s = $this->posShop(shopStock: 5, price: 10000);
        [$h, $store] = [$s['h'], $s['store']];
        $session = $this->posSession($s);
        $this->cashSale($s, $session, 1, ['customer' => ['phone' => '01711552211', 'name' => 'Farhana Yasmin']]);

        $this->api($h, 'GET', $this->pUrl($store, '/customers/lookup?phone=01711-552211'))->assertOk()
            ->assertJsonPath('data.name', 'Farhana Yasmin')->assertJsonPath('data.phone', '8801711552211')
            ->assertJsonPath('data.orders_count', 1)->assertJsonPath('data.total_spent_amount', 10000)
            ->assertJsonPath('data.risk', fn ($r) => is_array($r));
        foreach (['0171155221', '01711', '8801711552212', 'farhana', '%'] as $phone) {
            $this->api($h, 'GET', $this->pUrl($store, '/customers/lookup?phone='.urlencode($phone)))->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }

        $this->app->forgetInstance(ThrottleRequests::class);
        $this->withMiddleware(ThrottleRequests::class);
        $status = [];
        for ($i = 0; $i < 31; $i++) {
            $status[] = $this->api($h, 'GET', $this->pUrl($store, '/customers/lookup?phone=01711552211'))->status();
        }
        $this->assertSame(429, end($status));
        $this->assertSame(30, count(array_filter($status, fn ($c) => $c === 200)));
    }

    #[Group('security')]
    public function test_impersonation_reads_but_never_sells(): void
    {
        $s = $this->posShop();
        [$store, $tenant] = [$s['store'], $s['tenant']];
        $session = $this->posSession($s);
        $this->useSpaBrowser();
        Mail::fake();
        $support = User::factory()->create();
        $support->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($support, $tenant, 'Customer ticket: till check', 'ZD-92', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];
        $this->browser('GET', $this->pUrl($store, "/sessions/{$session}"), [], $t)->assertOk();
        $this->browser('POST', $this->pUrl($store, '/sales'), $this->saleBody($session, [['variant_id' => $s['variant'], 'quantity' => 1]], $s['price']), $t + ['Idempotency-Key' => (string) Str::uuid()])
            ->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        $this->browser('POST', $this->pUrl($store, "/sessions/{$session}/close"), ['counted_cash_amount' => 0, 'left_in_drawer_amount' => 0, 'revision' => 1], $t + ['Idempotency-Key' => (string) Str::uuid()])
            ->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
    }
}

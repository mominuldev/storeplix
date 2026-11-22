<?php

namespace Tests\Feature\Commerce;

use App\Domain\Catalog\Models\Product;
use App\Domain\Documents\DocumentRenderer;
use App\Domain\Documents\Drivers\GotenbergClient;
use App\Domain\Documents\Models\Document;
use App\Domain\Documents\Models\DocumentTemplate;
use App\Domain\Documents\TemplateConfig;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-5B §4.8 / §7 / §13 "Documents" (P5B-50–P5B-58), S34, S35. Runs with DOCUMENTS_DRIVER=html; Gotenberg via Http::fake. */
class DocumentsTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
        Storage::fake('local');
        config(['documents.driver' => 'html', 'storeplix.private_disk' => 'local']);
    }

    /** @return array{0: Tenant, 1: Store, 2: array<string, string>, 3: list<array<string, mixed>>} */
    private function shopWithOrders(int $n = 2, string $slug = 'shop', ?string $productName = null): array
    {
        [, $tenant, $store, $h] = $this->liveShop($slug);
        [$p, $v] = $this->stocked($h, $store, 107000, 50);
        if ($productName !== null) {
            $this->inTenant($tenant, fn () => Product::query()->whereKey($p['id'])->update(['name' => $productName]));
        }
        $orders = [];
        for ($i = 0; $i < $n; $i++) {
            $orders[] = $this->manual($h, $store, $this->manualBody($v, 1, ['notify_customer' => false, 'contact' => ['name' => 'রহিম উদ্দিন'],
                'shipping_address' => ['address_line' => 'মিরপুর ১০, ঢাকা']]))->assertCreated()->json('data');
        }

        return [$tenant, $store, $h, $orders];
    }

    private function create(array $h, Store $store, string $kind, array $ids, array $extra = []): TestResponse
    {
        return $this->api($h, 'POST', "/api/v1/stores/{$store->id}/documents", ['kind' => $kind, 'order_ids' => $ids] + $extra);
    }

    private function fetch(string $url): TestResponse
    {
        return $this->flushHeaders()->get(str_replace(config('app.url'), '', $url));
    }

    public function test_templates_defaults_validation_and_permissions(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $list = $this->api($staff, 'GET', "/api/v1/stores/{$store->id}/document-templates")->assertOk();
        $this->assertSame(TemplateConfig::KINDS, array_column($list->json('data'), 'kind'));
        $list->assertJsonPath('data.4.paper', ['width_mm' => 100, 'height_mm' => 150, 'label' => '4 × 6 in'])
            ->assertJsonPath('data.1.paper.height_mm', null)->assertJsonPath('data.0.is_default', true)->assertJsonPath('data.0.revision', 0)
            ->assertJsonPath('data.4.config.show_prices', false)->assertJsonPath('data.0.config.show_prices', true);

        $config = ['show_logo' => false, 'show_bin' => true, 'show_product_names' => true, 'show_prices' => true, 'show_sku' => true, 'language' => 'bn', 'footer_text' => 'Exchange within 7 days'];
        $url = "/api/v1/stores/{$store->id}/document-templates/label_4x6";
        $this->api($staff, 'PUT', $url, ['config' => $config])->assertForbidden();
        $this->api($h, 'PUT', $url, ['config' => ['language' => 'fr'] + $config])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['config' => ['footer_text' => "a\x07b"] + $config])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['config' => $config + ['html' => '<b>x</b>']])->assertStatus(422);
        $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/document-templates/label_3x4", ['config' => $config])->assertNotFound();
        $this->api($h, 'PUT', $url, ['revision' => 0, 'config' => $config])->assertOk()
            ->assertJsonPath('data.config.show_prices', false)->assertJsonPath('data.config.language', 'bn')->assertJsonPath('data.revision', 1)->assertJsonPath('data.is_default', false);
        $this->api($h, 'PUT', $url, ['revision' => 0, 'config' => $config])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PUT', $url, ['revision' => 1, 'config' => $config])->assertOk()->assertJsonPath('data.revision', 2);
    }

    #[Group('security')]
    public function test_generate_download_printed_flags_and_escaping(): void
    {
        [$tenant, $store, $h, $orders] = $this->shopWithOrders(2, productName: '<img src=http://evil.test/x.png> Panjabi');
        $ids = array_column($orders, 'id');

        $doc = $this->create($h, $store, 'invoice_a4', $ids)->assertStatus(202)->json('data');
        $this->assertSame('ready', $doc['status']); // sync queue in tests
        $this->assertSame(2, $doc['orders_count']);
        $this->assertSame(2, $doc['pages']);
        $this->assertNotNull($doc['download_url']);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/documents/{$doc['id']}")->assertOk()->assertJsonPath('data.status', 'ready');

        $file = $this->fetch($doc['download_url'])->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $this->assertStringContainsString('inline; filename=invoices-2-orders.html', (string) $file->headers->get('Content-Disposition'));
        $this->assertStringContainsString('sandbox', (string) $file->headers->get('Content-Security-Policy'));
        $html = $file->streamedContent();
        // S34: product names are text, never markup or a remote fetch
        $this->assertStringNotContainsString('<img src=http://evil', $html);
        $this->assertStringContainsString('&lt;img src=http://evil.test/x.png&gt; Panjabi', $html);
        $this->assertStringContainsString($orders[0]['number'], $html);
        $this->assertStringContainsString('রহিম উদ্দিন', $html);
        $this->assertStringContainsString('৳ 1,070', $html, 'Latin digits (Q51)');
        $this->assertStringNotContainsString('<script', $html);

        // printed flags + "Printed today" / "Not printed" filters + one `document` event per order
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[printed]=invoice")->assertJsonCount(2, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[not_printed]=invoice")->assertJsonCount(0, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[not_printed]=label")->assertJsonCount(2, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$ids[0]}")->assertJsonPath('data.events.0.type', 'document')
            ->assertJsonPath('data.label_printed_at', null)->assertJsonPath('data.invoice_printed_at', fn ($v) => $v !== null);
        Carbon::setTestNow(now()->addDay());
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[printed]=invoice")->assertJsonCount(0, 'data');
        Carbon::setTestNow();

        $label = $this->create($h, $store, 'label_4x6', [$ids[0]], ['language' => 'bn'])->json('data');
        $labelHtml = $this->fetch($label['download_url'])->assertOk()->streamedContent();
        $this->assertStringContainsString('টাকা নিন', $labelHtml);
        $this->assertStringContainsString('data:image/svg+xml;base64,', $labelHtml, 'barcode / QR inline');
        $this->assertStringContainsString($orders[0]['number'].'-label.html', (string) $this->fetch($label['download_url'])->headers->get('Content-Disposition'));
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$ids[0]}")->assertJsonPath('data.label_printed_at', fn ($v) => $v !== null);
    }

    #[Group('security')]
    public function test_signed_url_expiry_foreign_tenant_and_prune(): void
    {
        [$tenant, $store, $h, $orders] = $this->shopWithOrders(1);
        [$tenantB] = $this->shopWithOrders(1, 'bravo');
        $doc = $this->create($h, $store, 'packing_slip', [$orders[0]['id']])->json('data');
        $url = $doc['download_url'];

        $this->fetch($url.'x')->assertForbidden(); // tampered signature
        $this->fetch(str_replace('tenant='.$tenant->id, 'tenant='.$tenantB->id, $url))->assertForbidden();
        $forged = URL::temporarySignedRoute('documents.download', now()->addMinutes(5), ['document' => $doc['id'], 'tenant' => $tenantB->id]);
        $this->fetch($forged)->assertNotFound(); // validly signed for B: A's document doesn't exist there (S35)
        Carbon::setTestNow(now()->addMinutes(6));
        $this->fetch($url)->assertForbidden();
        Carbon::setTestNow();

        $path = $this->inTenant($tenant, fn () => Document::query()->whereKey($doc['id'])->value('file_path'));
        Storage::disk('local')->assertExists($path);
        Carbon::setTestNow(now()->addHours(25));
        $this->artisan('documents:prune')->assertSuccessful();
        Storage::disk('local')->assertMissing($path);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/documents/{$doc['id']}")->assertJsonPath('data.status', 'expired')->assertJsonPath('data.download_url', null);
        $fresh = URL::temporarySignedRoute('documents.download', now()->addMinutes(5), ['document' => $doc['id'], 'tenant' => $tenant->id]);
        $this->fetch($fresh)->assertNotFound();
        Carbon::setTestNow();
    }

    public function test_input_validation_foreign_orders_and_queue_limit(): void
    {
        [$tenant, $store, $h, $orders] = $this->shopWithOrders(1);
        [, $storeB, , $ordersB] = $this->shopWithOrders(1, 'bravo');
        $this->create($h, $store, 'invoice_a4', [$orders[0]['id'], $ordersB[0]['id']])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['order_ids.1']]]);
        $this->create($h, $store, 'label_3x4', [$orders[0]['id']])->assertStatus(422);
        $this->create($h, $store, 'invoice_a4', [])->assertStatus(422);
        $this->create($h, $store, 'invoice_a4', array_fill(0, 101, $orders[0]['id']))->assertStatus(422);

        $this->inTenant($tenant, function () use ($store, $orders) {
            for ($i = 0; $i < 10; $i++) {
                $d = new Document;
                $d->store_id = $store->id;
                $d->kind = 'invoice_a4';
                $d->order_ids = [$orders[0]['id']];
                $d->save();
            }
        });
        $this->create($h, $store, 'invoice_a4', [$orders[0]['id']])->assertStatus(409)->assertJsonPath('error.code', 'conflict');
        $this->assertTenantIsolation($h, [['GET', "/api/v1/stores/{$store->id}/documents/01jzzzzzzzzzzzzzzzzzzzzzzz"]]);
    }

    public function test_preview_uses_a_sample_or_a_chosen_order(): void
    {
        [, $store, $h, $orders] = $this->shopWithOrders(1);
        [, , , $ordersB] = $this->shopWithOrders(1, 'bravo');
        $url = "/api/v1/stores/{$store->id}/documents/preview";
        $html = $this->api($h, 'POST', $url, ['kind' => 'invoice_a4'])->assertOk()->json('data.html');
        $this->assertStringContainsString('SP-1042', $html);
        $this->assertStringNotContainsString('@font-face', $html, 'previews use the browser fonts');
        $bn = $this->api($h, 'POST', $url, ['kind' => 'label_4x6', 'order_id' => $orders[0]['id'], 'config' => TemplateConfig::defaults('label_4x6') + ['language' => 'bn']])
            ->assertOk()->json('data.html');
        $this->assertStringContainsString($orders[0]['number'], $bn);
        $this->assertStringContainsString('lang="en"', $bn); // `+` keeps the default language: en
        $this->api($h, 'POST', $url, ['kind' => 'label_4x6', 'config' => ['language' => 'bn'] + TemplateConfig::defaults('label_4x6')])->assertOk()
            ->assertJsonPath('data.html', fn ($v) => str_contains($v, 'প্রাপক'));
        $this->api($h, 'POST', $url, ['kind' => 'invoice_a4', 'order_id' => $ordersB[0]['id']])->assertStatus(422);
    }

    /** VAT display + BIN (P5B-56): floor(total × rate / (10 000 + rate)); totals unchanged. */
    public function test_vat_line_and_bin(): void
    {
        [$tenant, $store, $h, $orders] = $this->shopWithOrders(1);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/settings", ['tax' => ['display' => 'included', 'rate_bps' => 1500, 'bin' => '000123456-0101'], 'invoice' => ['footer' => 'No returns on sale items']])
            ->assertOk()->assertJsonPath('data.commerce.tax', ['display' => 'included', 'rate_bps' => 1500, 'bin' => '000123456-0101']);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/settings", ['tax' => ['bin' => '12']])->assertStatus(422);
        $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/document-templates/invoice_a4", ['config' => ['show_bin' => true] + TemplateConfig::defaults('invoice_a4')])->assertOk();
        $html = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/documents/preview", ['kind' => 'invoice_a4', 'order_id' => $orders[0]['id']])->json('data.html');
        $total = $orders[0]['total_amount'];
        $vat = intdiv($total * 1500, 11500);
        $this->assertStringContainsString('Prices include VAT 15%: ৳ '.number_format($vat / 100, $vat % 100 === 0 ? 0 : 2), $html);
        $this->assertStringContainsString('000123456-0101', $html);
        $this->assertStringContainsString('No returns on sale items', $html);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$orders[0]['id']}")->assertJsonPath('data.total_amount', $total)->assertJsonPath('data.tax_amount', 0);
    }

    /** HTML snapshot per kind × language (html driver). Snapshots live in tests/Fixtures/documents; missing ones are written. */
    public function test_html_snapshots_per_kind_and_language(): void
    {
        Carbon::setTestNow('2026-11-22 10:00:00');
        [, $tenant, $store] = $this->liveShop('snap');
        $store->forceFill(['name' => 'Snapshot Shop'])->save();
        $renderer = app(DocumentRenderer::class);
        foreach (TemplateConfig::KINDS as $kind) {
            foreach (['en', 'bn'] as $language) {
                $html = $this->inTenant($tenant, fn () => $renderer->html($kind, collect([$renderer->sample($store->fresh('primaryDomain'))]), $store->fresh('primaryDomain'),
                    TemplateConfig::normalise($kind, ['language' => $language]), $language, embedFonts: false));
                $html = (string) preg_replace('/snap[a-z0-9]{6}\.storeplix\.test/', 'snap.storeplix.test', $html);
                $html = (string) preg_replace('#data:image/svg\+xml;base64,[A-Za-z0-9+/=]+#', 'data:image/svg+xml;base64,…', $html);
                $file = base_path("tests/Fixtures/documents/{$kind}.{$language}.html");
                if (! is_file($file)) {
                    @mkdir(dirname($file), 0755, true);
                    file_put_contents($file, $html);
                }
                $this->assertSame(file_get_contents($file), $html, "snapshot {$kind}.{$language} changed (delete the file to refresh)");
            }
        }
        Carbon::setTestNow();
    }

    /** Gotenberg driver (Http::fake): multipart route, fonts sent, basic auth, no remote URL, PDF pages counted. */
    public function test_gotenberg_driver_request_and_failures(): void
    {
        config(['documents.driver' => 'gotenberg', 'documents.gotenberg.url' => 'http://gotenberg:3000', 'documents.gotenberg.username' => 'sp', 'documents.gotenberg.password' => 'secret']);
        Http::preventStrayRequests();
        Http::fake(['gotenberg:3000/forms/chromium/convert/html' => Http::sequence()
            ->push("%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n%%EOF", 200, ['Content-Type' => 'application/pdf'])
            ->push('boom', 503)]);
        [$tenant, $store, $h, $orders] = $this->shopWithOrders(2);

        $doc = $this->create($h, $store, 'label_4x6', array_column($orders, 'id'), ['language' => 'bn'])->assertStatus(202)->json('data');
        $this->assertSame(['ready', 2], [$doc['status'], $doc['pages']]);
        Http::assertSent(function (HttpRequest $request) {
            $parts = collect($request->data())->keyBy(fn ($p) => $p['filename'] ?? $p['name']);
            $html = (string) ($parts['index.html']['contents'] ?? '');

            return $request->url() === 'http://gotenberg:3000/forms/chromium/convert/html'
                && $request->hasHeader('Authorization', 'Basic '.base64_encode('sp:secret'))
                && isset($parts['NotoSansBengali-Regular.ttf'], $parts['Inter-Bold.woff2'])
                && ($parts['paperWidth']['contents'] ?? null) === '3.937' && ($parts['paperHeight']['contents'] ?? null) === '5.906'
                && ($parts['preferCssPageSize']['contents'] ?? null) === 'true'
                && str_contains($html, "url('NotoSansBengali-Regular.ttf')") && str_contains($html, 'রহিম উদ্দিন')
                && preg_match('#(https?:)?//[a-z0-9]#i', $html) !== 1; // S34: nothing for Chromium to fetch
        });
        $pdf = $this->fetch($doc['download_url'])->assertOk()->assertHeader('Content-Type', 'application/pdf');
        $this->assertStringStartsWith('%PDF-', $pdf->streamedContent());

        $failed = $this->create($h, $store, 'invoice_a4', [$orders[0]['id']])->json('data');
        $this->assertSame(['failed', 'renderer_unavailable', null], [$failed['status'], $failed['error_code'], $failed['download_url']]);
        $this->assertSame('3.15', GotenbergClient::inches(80));
    }

    #[Group('tenancy')]
    public function test_documents_are_isolated_by_tenant_and_store(): void
    {
        [$ta, $sa, $ha, $oa] = $this->shopWithOrders(1, 'alpha');
        [$tb, $sb, $hb, $ob] = $this->shopWithOrders(1, 'bravo');
        foreach ([[$ha, $sa, $oa], [$hb, $sb, $ob]] as [$h, $s, $o]) {
            $this->create($h, $s, 'invoice_a4', [$o[0]['id']])->assertStatus(202);
            $this->api($h, 'PUT', "/api/v1/stores/{$s->id}/document-templates/invoice_a4", ['config' => TemplateConfig::defaults('invoice_a4')])->assertOk();
        }
        foreach ([Document::class, DocumentTemplate::class] as $model) {
            $this->assertStoreIsolation($model, $ta, $sa, $sb);
            $this->assertStoreIsolation($model, $tb, $sb, $sa);
        }
        $docB = $this->inTenant($tb, fn () => Document::query()->value('id'));
        $this->assertTenantIsolation($ha, [['GET', "/api/v1/stores/{$sa->id}/documents/{$docB}"]]);
        $this->inTenant($ta, fn () => $this->assertSame(1, Order::query()->whereNotNull('invoice_printed_at')->count()));
        $this->inTenant($ta, fn () => $this->assertNotNull(StoreSetting::query()->first()));
    }
}

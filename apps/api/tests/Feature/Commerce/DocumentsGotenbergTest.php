<?php

declare(strict_types=1);

namespace Tests\Feature\Commerce;

use App\Domain\Documents\DocumentRenderer;
use App\Domain\Documents\Drivers\GotenbergClient;
use App\Domain\Documents\Models\Document;
use App\Domain\Documents\TemplateConfig;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * PHASE-5B-CONTRACT §7 / §13 "Documents" against a REAL Gotenberg (CI job `api-documents`): Bangla is shaped with the
 * embedded Noto Sans Bengali (`pdffonts`), the text round-trips (`pdftotext`), every kind × language is a PDF with the
 * expected pages, the queued job stores a PDF, and 100 labels render in < 20 s.
 *
 * Needs GOTENBERG_URL (+ GOTENBERG_USERNAME / GOTENBERG_PASSWORD) and poppler-utils; skips otherwise, and the CI job
 * fails on a skip.
 */
#[Group('documents')]
class DocumentsGotenbergTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    private const NAME = 'রহিম উদ্দিন';

    private const ADDRESS = 'মিরপুর ১০, ঢাকা';

    protected function setUp(): void
    {
        parent::setUp();
        $url = (string) env('GOTENBERG_URL', '');
        if ($url === '') {
            $this->markTestSkipped('GOTENBERG_URL is not set (real Gotenberg needed).');
        }
        foreach (['pdffonts', 'pdftotext'] as $bin) {
            if (trim((string) shell_exec('command -v '.$bin)) === '') {
                $this->markTestSkipped("{$bin} (poppler-utils) is not installed.");
            }
        }
        // The one suite that talks to a real service: TestCase blocks stray HTTP, allow it to Gotenberg only.
        Http::preventStrayRequests();
        Http::allowStrayRequests([rtrim($url, '/').'/*']);
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
        Storage::fake('local');
        config([
            'documents.driver' => 'gotenberg',
            'documents.gotenberg.url' => $url,
            'documents.gotenberg.username' => env('GOTENBERG_USERNAME'),
            'documents.gotenberg.password' => env('GOTENBERG_PASSWORD'),
            'documents.gotenberg.timeout' => 60,
            'storeplix.private_disk' => 'local',
        ]);
    }

    /** §7: label with Bangla deliver-to → NotoSansBengali embedded, `pdftotext` returns the same strings. */
    public function test_bangla_label_embeds_the_font_and_round_trips_the_text(): void
    {
        [$tenant, $store] = $this->labelShop();
        $pdf = $this->inTenant($tenant, fn () => $this->pdf('label_4x6', $store, $this->samples($store, 1), 'bn'));

        $fonts = $this->poppler('pdffonts', $pdf);
        $this->assertMatchesRegularExpression('/NotoSansBengali/i', $fonts, "Bangla font not embedded:\n{$fonts}");
        foreach (preg_split('/\R/', trim($fonts)) as $line) {
            if (preg_match('/NotoSansBengali/i', $line)) {
                $this->assertMatchesRegularExpression('/\byes\s+yes\b/', $line, "NotoSansBengali must be embedded + subset:\n{$line}");
            }
        }

        $text = $this->text($pdf);
        $this->assertTextHas(self::NAME, $text);
        $this->assertTextHas(self::ADDRESS, $text);
        // Q51 default: digits stay Latin in data the shop prints itself (order number, amounts).
        $this->assertStringContainsString('SP-1042', $text);
    }

    /** Every kind × language renders to a real PDF; page count matches the layout (labels/invoices one per order). */
    public function test_every_kind_and_language_renders_a_pdf(): void
    {
        [$tenant, $store] = $this->labelShop();
        $this->inTenant($tenant, function () use ($store) {
            $orders = $this->samples($store, 2);
            foreach (TemplateConfig::KINDS as $kind) {
                foreach (['en', 'bn'] as $language) {
                    $pdf = $this->pdf($kind, $store, $orders, $language);
                    $this->assertStringStartsWith('%PDF-', $pdf, "{$kind}.{$language}");
                    // A5 two-up: 2 orders on ONE sheet (QA 5b-4 found a blank second page); the others one page per order.
                    $this->assertSame(DocumentRenderer::pages($kind, 2), $this->pages($pdf), "{$kind}.{$language} pages");
                    if ($kind === 'receipt_80mm') {
                        // One page as long as the content, not a fixed 297 mm (no blank paper fed on the roll).
                        [$w, $hgt] = $this->pageSize($pdf);
                        $this->assertEqualsWithDelta(80 / 25.4 * 72, $w, 1.0, 'roll width 80 mm');
                        $this->assertLessThan(297 / 25.4 * 72 - 20, $hgt, "{$kind}.{$language}: the roll page must fit the content");
                    }
                    $this->assertTextHas(self::NAME, $this->text($pdf), "{$kind}.{$language} customer name");
                }
            }
        });
    }

    /** The queued RenderDocument job with the gotenberg driver stores a PDF and the signed download serves it. */
    public function test_queued_job_stores_a_pdf_and_download_serves_it(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('gtb');
        [, $v] = $this->stocked($h, $store, 107000, 10);
        $order = $this->manual($h, $store, $this->manualBody($v, 1, ['notify_customer' => false, 'contact' => ['name' => self::NAME],
            'shipping_address' => ['address_line' => self::ADDRESS]]))->assertCreated()->json('data');

        $doc = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/documents", ['kind' => 'label_4x6', 'order_ids' => [$order['id']], 'config' => ['language' => 'bn']])
            ->assertStatus(202)->json('data');
        $row = $this->inTenant($tenant, fn () => Document::query()->findOrFail($doc['id']));
        $this->assertSame('ready', $row->status, 'job must finish (QUEUE_CONNECTION=sync): '.json_encode($row->only(['error_code', 'error_message'])));
        $this->assertSame(1, $row->pages);

        $ready = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/documents/{$doc['id']}")->assertOk()->json('data');
        $res = $this->flushHeaders()->get(str_replace(config('app.url'), '', (string) $ready['download_url']))->assertOk();
        $this->assertStringStartsWith('application/pdf', (string) $res->headers->get('Content-Type'));
        $this->assertTextHas(self::NAME, $this->text((string) $res->streamedContent()));
    }

    /** §7 budget: a 100-label batch (the per-document maximum) renders in < 20 s. */
    public function test_one_hundred_labels_render_under_twenty_seconds(): void
    {
        [$tenant, $store] = $this->labelShop();
        [$pdf, $seconds] = $this->inTenant($tenant, function () use ($store) {
            $orders = $this->samples($store, 100);
            $start = microtime(true);
            $pdf = $this->pdf('label_4x6', $store, $orders, 'bn');

            return [$pdf, microtime(true) - $start];
        });
        fwrite(STDERR, sprintf("\n100 labels: %.2f s, %d bytes\n", $seconds, strlen($pdf)));
        $this->assertSame(100, $this->pages($pdf));
        $this->assertLessThan(20.0, $seconds, sprintf('100 labels took %.2f s (budget 20 s)', $seconds));
    }

    // ---------------------------------------------------------------------------------------------------------------

    /** @return array{0: Tenant, 1: Store} */
    private function labelShop(): array
    {
        [, $tenant, $store] = $this->liveShop('gtb');

        return [$tenant, $this->inTenant($tenant, fn () => $store->fresh('primaryDomain'))];
    }

    /** @return Collection<int, Order> */
    private function samples(Store $store, int $n): Collection
    {
        $renderer = app(DocumentRenderer::class);

        return collect(range(1, $n))->map(function (int $i) use ($renderer, $store) {
            $order = $renderer->sample($store);
            $address = $order->shipping_address;
            $address['address_line'] = self::ADDRESS;
            $order->forceFill([
                'id' => sprintf('01sampl%019d', $i),
                'number' => $i === 1 ? 'SP-1042' : 'SP-'.(1042 + $i),
                'customer_name' => self::NAME,
                'shipping_address' => $address,
            ]);

            return $order;
        });
    }

    private function pdf(string $kind, Store $store, Collection $orders, string $language): string
    {
        $renderer = app(DocumentRenderer::class);
        $html = $renderer->html($kind, $orders, $store, TemplateConfig::normalise($kind, ['language' => $language]), $language, embedFonts: true);
        $file = (new GotenbergClient)->render($html, $kind);
        $this->assertSame('pdf', $file['extension']);

        return $file['bytes'];
    }

    private function pages(string $pdf): int
    {
        preg_match('/^Pages:\s+(\d+)/m', $this->poppler('pdfinfo', $pdf), $m);

        return (int) ($m[1] ?? 0);
    }

    /** @return array{0: float, 1: float} first page width/height in points */
    private function pageSize(string $pdf): array
    {
        preg_match('/^Page size:\s+([\d.]+) x ([\d.]+) pts/m', $this->poppler('pdfinfo', $pdf), $m);

        return [(float) ($m[1] ?? 0), (float) ($m[2] ?? 0)];
    }

    /**
     * Text round-trip, whitespace ignored: pdftotext splits shaped Bangla words at combining vowel signs
     * ("মিরপু র" for "মিরপুর") although the glyphs are placed correctly (checked visually). Every code point must
     * still come back, in order.
     */
    private function assertTextHas(string $needle, string $text, string $message = ''): void
    {
        $strip = fn (string $s) => (string) preg_replace('/\s+/u', '', $s);
        $this->assertStringContainsString($strip($needle), $strip($text), $message);
    }

    /** pdftotext output with whitespace runs collapsed to one space. */
    private function text(string $pdf): string
    {
        return (string) preg_replace('/\s+/u', ' ', $this->poppler('pdftotext', $pdf, '-enc UTF-8', '-'));
    }

    private function poppler(string $bin, string $pdf, string $args = '', string $out = ''): string
    {
        $path = tempnam(sys_get_temp_dir(), 'sp-doc-').'.pdf';
        file_put_contents($path, $pdf);
        try {
            return (string) shell_exec(sprintf('%s %s %s %s 2>&1', $bin, $args, escapeshellarg($path), $out));
        } finally {
            @unlink($path);
        }
    }
}

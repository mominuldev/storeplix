<?php

declare(strict_types=1);

namespace Tests\Feature\Expenses;

use App\Domain\Expenses\ExpenseReceipts;
use App\Domain\Media\Http\Controllers\MediaController;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\Models\Media;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Route as RoutingRoute;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-7 §5, S143–S146: receipt upload sniffing, private storage, signed delivery, binding, media-library separation, prune. */
#[Group('expenses')]
#[Group('security')]
class ExpenseReceiptsTest extends TestCase
{
    use ExpenseFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpExpenses();
    }

    public function test_upload_sniffing_matrix(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $unsupported = ExpenseReceipts::UNSUPPORTED;
        $cases = [
            'svg' => ['r.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', null, $unsupported],
            'html' => ['r.html', '<!doctype html><html><body>hi</body></html>', null, $unsupported],
            'gif' => ['r.gif', $this->imageBytes(300, 300, 'gif'), null, $unsupported],
            'php' => ['r.php', '<?php echo 1;', null, $unsupported],
            'jpeg named .pdf' => ['r.pdf', $this->imageBytes(300, 300, 'jpeg'), null, $unsupported],
            'pdf named .jpg' => ['r.jpg', self::pdf(), 'image/jpeg', $unsupported],
            'pdf without %%EOF' => ['r.pdf', "%PDF-1.4\n1 0 obj<<>>endobj\n".str_repeat('x', 2048), null, $unsupported],
            'over 5 MB' => ['r.pdf', "%PDF-1.4\n".str_repeat('x', 5 * 1024 * 1024)."\n%%EOF\n", null, 'The file may not be larger than 5 MB.'],
            'over 40 MP' => ['r.png', self::pngHeader(7000, 6000), null, ExpenseReceipts::TOO_MANY_PIXELS],
            'tiny image' => ['r.png', $this->imageBytes(50, 50), null, 'Each side must be between 100 and 10000 px.'],
        ];
        foreach ($cases as $label => [$name, $bytes, $mime, $message]) {
            $this->upload($h, $store, $name, $bytes, $mime)->assertUnprocessable()
                ->assertJsonPath('error.details.file.0', $message, "case: {$label}");
        }
        $this->assertSame(0, $this->platformQuery(Media::class)->where('tenant_id', $tenant->id)->count());
        $this->assertSame([], Storage::disk('local')->allFiles());
        $this->assertSame([], Storage::disk('public')->allFiles());

        foreach (['png' => 'png', 'jpeg' => 'jpg', 'webp' => 'webp'] as $format => $ext) {
            $id = $this->imageReceipt($h, $store, $format);
            $media = $this->mediaRow($tenant, $id);
            $this->assertSame(['expense_receipt', 'local', Media::READY, []], [$media->purpose, $media->disk, $media->status, $media->variants]);
            $this->assertSame("tenants/{$tenant->id}/media/{$id}/original.{$ext}", $media->path);
            Storage::disk('local')->assertExists($media->path);
        }
        $pdf = $this->upload($h, $store, 'bill.pdf', self::pdf())->assertCreated()->json('data');
        $this->assertSame(['mime' => 'application/pdf', 'size_bytes' => strlen(self::pdf())], ['mime' => $pdf['mime'], 'size_bytes' => $pdf['size_bytes']]);
        $this->assertArrayNotHasKey('url', $pdf);
        Storage::disk('local')->assertExists("tenants/{$tenant->id}/media/{$pdf['id']}/original.pdf");
        $this->assertSame([], Storage::disk('public')->allFiles());
    }

    public function test_image_receipts_lose_exif_and_answer_409_while_processing(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        Queue::fake();
        $bytes = $this->jpegWithGps();
        $this->assertStringContainsString('GPSLatitude', $bytes);
        $id = $this->upload($h, $store, 'photo.jpg', $bytes)->assertCreated()->json('data.id');
        $e = $this->addExpense($h, $store, ['receipt_id' => $id]);
        $this->api($h, 'GET', $this->eUrl($store, "/{$e['id']}/receipt"))->assertStatus(409)->assertJsonPath('error.code', 'receipt_processing');

        $this->inTenant($tenant, fn () => app()->call([new ProcessMedia($id), 'handle']));
        $stored = Storage::disk('local')->get($this->mediaRow($tenant, $id)->path);
        $this->assertStringNotContainsString('GPSLatitude', $stored);
        $this->assertStringNotContainsString('Exif', $stored);
        $this->api($h, 'GET', $this->eUrl($store, "/{$e['id']}/receipt"))->assertOk();
    }

    public function test_signed_link_and_download_headers(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $plain = $this->addExpense($h, $store);
        $this->api($h, 'GET', $this->eUrl($store, "/{$plain['id']}/receipt"))->assertNotFound()->assertJsonPath('error.code', 'receipt_not_found');

        $pdf = $this->addExpense($h, $store, ['spent_on' => '2026-11-03', 'receipt_id' => $this->pdfReceipt($h, $store)]);
        $this->assertSame(['id', 'mime', 'size_bytes', 'status'], array_keys($pdf['receipt']));
        $link = $this->api($h, 'GET', $this->eUrl($store, "/{$pdf['id']}/receipt"))->assertOk()->assertHeader('Cache-Control', 'no-store, private')->json('data');
        $this->assertSame(['application/pdf', '2026-11-20T06:05:00Z'], [$link['mime'], $link['expires_at']]);

        $res = $this->flushHeaders()->get($link['url'])->assertOk();
        $this->assertSame('application/pdf', $res->headers->get('Content-Type'));
        $this->assertSame('attachment; filename=receipt-2026-11-03.pdf', $res->headers->get('Content-Disposition'));
        $this->assertSame('nosniff', $res->headers->get('X-Content-Type-Options'));
        $this->assertSame("sandbox; default-src 'none'", $res->headers->get('Content-Security-Policy'));
        $this->assertStringContainsString('no-store', (string) $res->headers->get('Cache-Control'));
        $this->assertSame('no-referrer', $res->headers->get('Referrer-Policy'));
        $this->assertSame(self::pdf(), $res->streamedContent());

        $img = $this->addExpense($h, $store, ['spent_on' => '2026-11-04', 'receipt_id' => $this->imageReceipt($h, $store, 'png')]);
        $imgLink = $this->api($h, 'GET', $this->eUrl($store, "/{$img['id']}/receipt"))->assertOk()->json('data.url');
        $this->assertSame('inline; filename=receipt-2026-11-04.png', $this->flushHeaders()->get($imgLink)->assertOk()->headers->get('Content-Disposition'));

        // Tampered signature, other parameters, expiry.
        $this->flushHeaders()->get($link['url'].'0')->assertForbidden();
        $this->flushHeaders()->get(str_replace('tenant=', 'tenant=x', $link['url']))->assertForbidden();
        $this->travel(6)->minutes();
        $this->flushHeaders()->get($link['url'])->assertForbidden();
    }

    public function test_download_refuses_foreign_detached_public_or_unowned_rows(): void
    {
        [, $tenantA, $storeA, $hA] = $this->shop(slug: 'alpha');
        [, $tenantB, $storeB, $hB] = $this->shop(slug: 'beta');
        $b = $this->addExpense($hB, $storeB, ['receipt_id' => $this->pdfReceipt($hB, $storeB)]);
        $signed = fn (string $media, string $tenant) => URL::temporarySignedRoute('expense-receipts.download', now()->addMinutes(5), ['media' => $media, 'tenant' => $tenant]);

        // B's media id in a link signed for tenant A → 404.
        $this->flushHeaders()->get($signed($b['receipt']['id'], $tenantA->id))->assertNotFound();
        $this->flushHeaders()->get($signed($b['receipt']['id'], $tenantB->id))->assertOk();

        // An unattached receipt → 404.
        $loose = $this->pdfReceipt($hA, $storeA);
        $this->flushHeaders()->get($signed($loose, $tenantA->id))->assertNotFound();

        // A row moved to the public disk, or a path outside the tenant prefix → 404.
        $a = $this->addExpense($hA, $storeA, ['receipt_id' => $this->pdfReceipt($hA, $storeA)]);
        $rid = $a['receipt']['id'];
        $this->inTenant($tenantA, fn () => DB::table('media')->where('id', $rid)->update(['disk' => 'public']));
        $this->flushHeaders()->get($signed($rid, $tenantA->id))->assertNotFound();
        $this->inTenant($tenantA, fn () => DB::table('media')->where('id', $rid)->update(['disk' => 'local', 'path' => "tenants/{$tenantB->id}/media/{$rid}/original.pdf"]));
        $this->flushHeaders()->get($signed($rid, $tenantA->id))->assertNotFound();
    }

    public function test_receipt_binding_rules_and_removal(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, , $otherStore, $hOther] = $this->shop(slug: 'other');
        $body = ['amount' => 1000, 'category' => 'other', 'paid_from' => 'cash', 'spent_on' => '2026-11-20'];
        $refused = [
            'other tenant' => $this->pdfReceipt($hOther, $otherStore),
            'product image' => $this->productImage($h),
            'unknown' => strtolower((string) Str::ulid()),
        ];
        $failed = $this->pdfReceipt($h, $store);
        $this->inTenant($tenant, fn () => DB::table('media')->where('id', $failed)->update(['status' => Media::FAILED]));
        $refused['failed'] = $failed;
        $taken = $this->pdfReceipt($h, $store);
        $first = $this->addExpense($h, $store, ['receipt_id' => $taken]);
        $refused['attached elsewhere'] = $taken;
        foreach ($refused as $label => $id) {
            $this->api($h, 'POST', $this->eUrl($store), $body + ['receipt_id' => $id])->assertUnprocessable()
                ->assertJsonValidationErrorFor('receipt_id', 'error.details');
        }
        $this->api($h, 'PATCH', $this->eUrl($store, "/{$first['id']}"), ['receipt_id' => strtoupper($taken)])->assertOk(); // same receipt: no change

        // Replace: the old row and object are deleted; remove: the same.
        $oldPath = $this->mediaRow($tenant, $taken)->path;
        $new = $this->pdfReceipt($h, $store);
        $this->api($h, 'PATCH', $this->eUrl($store, "/{$first['id']}"), ['receipt_id' => $new])->assertOk()->assertJsonPath('data.receipt.id', $new);
        $this->assertNull($this->mediaRow($tenant, $taken));
        Storage::disk('local')->assertMissing($oldPath);
        $newPath = $this->mediaRow($tenant, $new)->path;
        $this->api($h, 'PATCH', $this->eUrl($store, "/{$first['id']}"), ['receipt_id' => null])->assertOk()->assertJsonPath('data.receipt', null);
        $this->assertNull($this->mediaRow($tenant, $new));
        Storage::disk('local')->assertMissing($newPath);

        // Deleting an expense deletes its receipt.
        $third = $this->pdfReceipt($h, $store);
        $e = $this->addExpense($h, $store, ['receipt_id' => $third]);
        $path = $this->mediaRow($tenant, $third)->path;
        $this->api($h, 'DELETE', $this->eUrl($store, "/{$e['id']}"))->assertNoContent();
        $this->assertNull($this->mediaRow($tenant, $third));
        Storage::disk('local')->assertMissing($path);
    }

    /** S145: every generic media route (taken from the live route list) refuses or hides a receipt. */
    public function test_receipts_never_go_through_the_media_library(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $receipt = $this->imageReceipt($h, $store, 'png');
        $this->addExpense($h, $store, ['receipt_id' => $receipt]);
        $loose = $this->pdfReceipt($h, $store);
        $this->productImage($h);

        $routes = collect(Route::getRoutes()->getRoutes())->filter(fn (RoutingRoute $r) => str_starts_with((string) $r->getName(), 'media.')
            || str_starts_with((string) $r->getActionName(), MediaController::class.'@'));
        $this->assertGreaterThanOrEqual(4, $routes->count());

        foreach ($routes as $route) {
            foreach (array_diff($route->methods(), ['HEAD']) as $method) {
                foreach ([$receipt, $loose] as $id) {
                    $uri = '/'.str_replace(['{media}'], [$id], $route->uri());
                    $res = match (true) {
                        $method === 'POST' => $this->flushHeaders()->withHeaders($h)->post($uri, [
                            'file' => UploadedFile::fake()->createWithContent('r.png', $this->imageBytes(300, 300)), 'purpose' => 'expense_receipt',
                        ], ['Accept' => 'application/json']),
                        default => $this->api($h, $method, $uri.($method === 'GET' && ! str_contains($route->uri(), '{media}') ? '?filter[purpose]=product_image' : '')),
                    };
                    $label = "{$method} {$route->uri()}";
                    $this->assertContains($res->status(), [200, 404, 422], $label);
                    $this->assertStringNotContainsString($id, (string) $res->getContent(), $label);
                }
            }
        }
        $this->api($h, 'GET', '/api/v1/media')->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', '/api/v1/media?filter[purpose]=expense_receipt')->assertUnprocessable();
        $this->api($h, 'GET', "/api/v1/media/{$receipt}")->assertNotFound()->assertJsonPath('error.code', 'not_found');
        $this->api($h, 'DELETE', "/api/v1/media/{$loose}")->assertNotFound();
        $this->assertNotNull($this->mediaRow($tenant, $loose));
        $this->assertSame(2, $this->platformQuery(Media::class)->where('tenant_id', $tenant->id)->where('purpose', 'expense_receipt')->count());
    }

    public function test_prune_deletes_only_old_unattached_receipts(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $old = $this->pdfReceipt($h, $store);
        $attached = $this->pdfReceipt($h, $store);
        $this->addExpense($h, $store, ['receipt_id' => $attached]);
        $oldPath = $this->mediaRow($tenant, $old)->path;
        $this->travel(25)->hours();
        $recent = $this->pdfReceipt($h, $store);

        $this->artisan('expenses:prune-receipts')->assertSuccessful();
        $this->assertNull($this->mediaRow($tenant, $old));
        Storage::disk('local')->assertMissing($oldPath);
        $this->assertNotNull($this->mediaRow($tenant, $attached));
        Storage::disk('local')->assertExists($this->mediaRow($tenant, $attached)->path);
        $this->assertNotNull($this->mediaRow($tenant, $recent));
    }
}

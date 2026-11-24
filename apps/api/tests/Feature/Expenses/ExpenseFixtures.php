<?php

declare(strict_types=1);

namespace Tests\Feature\Expenses;

use App\Domain\Expenses\Models\Expense;
use App\Domain\Expenses\Models\ExpenseRecurrence;
use App\Domain\Media\Models\Media;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Carbon\CarbonImmutable;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\Feature\Reports\ReportFixtures;
use Tests\Support\CatalogFixtures;
use Tests\Support\RoleFixtures;

/**
 * Phase 8.7 helpers: a shop at 12:00 Dhaka on Fri 20 Nov 2026 (06:00 UTC), fake local/public disks, expenses and
 * receipts through the API, a minimal PDF, a PNG header with any declared size, a JPEG carrying an EXIF/GPS segment.
 */
trait ExpenseFixtures
{
    use CatalogFixtures, ReportFixtures, RoleFixtures;

    protected const NOW_UTC = '2026-11-20 06:00:00';

    protected function setUpExpenses(bool $throttle = false): void
    {
        if (! $throttle) {
            $this->withoutMiddleware(ThrottleRequests::class);
        }
        $this->travelTo(CarbonImmutable::parse(self::NOW_UTC, 'UTC'));
        Storage::fake('local');
        Storage::fake('public');
    }

    protected function eUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/expenses".$suffix;
    }

    /** @param array<string, mixed> $body @return array<string, mixed> */
    protected function addExpense(array $h, Store $store, array $body = []): array
    {
        return $this->api($h, 'POST', $this->eUrl($store), $body + [
            'amount' => 10000, 'category' => 'packaging', 'paid_from' => 'cash', 'spent_on' => '2026-11-20',
        ])->assertCreated()->json('data');
    }

    protected function upload(array $h, Store $store, string $name, string $bytes, ?string $clientMime = null): TestResponse
    {
        $fake = UploadedFile::fake()->createWithContent($name, $bytes); // keeps the temp file alive for the request
        $file = $clientMime === null ? $fake : new UploadedFile((string) $fake->getRealPath(), $name, $clientMime, null, true);

        return $this->flushHeaders()->withHeaders($h)->post($this->eUrl($store, '/receipts'), ['file' => $file], ['Accept' => 'application/json']);
    }

    protected function pdfReceipt(array $h, Store $store): string
    {
        return $this->upload($h, $store, 'bill.pdf', self::pdf())->assertCreated()->json('data.id');
    }

    protected function imageReceipt(array $h, Store $store, string $format = 'jpeg'): string
    {
        return $this->upload($h, $store, 'bill.'.($format === 'jpeg' ? 'jpg' : $format), $this->imageBytes(300, 300, $format))->assertCreated()->json('data.id');
    }

    protected static function pdf(string $body = '1 0 obj<<>>endobj'): string
    {
        return "%PDF-1.4\n{$body}\ntrailer<<>>\n%%EOF\n";
    }

    /** A PNG with only a signature, an IHDR declaring $w × $h, and IEND (getimagesize reads the header only). */
    protected static function pngHeader(int $w, int $h): string
    {
        $chunk = fn (string $type, string $data) => pack('N', strlen($data)).$type.$data.pack('N', crc32($type.$data));

        return "\x89PNG\r\n\x1a\n".$chunk('IHDR', pack('NNCCCCC', $w, $h, 8, 2, 0, 0, 0)).$chunk('IDAT', gzcompress('')).$chunk('IEND', '');
    }

    /** A JPEG with an APP1 Exif segment carrying a GPS marker string. */
    protected function jpegWithGps(): string
    {
        $jpeg = $this->imageBytes(300, 300, 'jpeg');
        $exif = "Exif\0\0MM\0\x2A\0\0\0\x08\0\0\0\0\0\0GPSLatitude=23.8103N;GPSLongitude=90.4125E";
        $app1 = "\xFF\xE1".pack('n', strlen($exif) + 2).$exif;

        return substr($jpeg, 0, 2).$app1.substr($jpeg, 2);
    }

    protected function expenseRow(Tenant $tenant, string $id): ?Expense
    {
        return $this->platformQuery(Expense::class)->where('tenant_id', $tenant->id)->whereKey($id)->first();
    }

    /** @return Collection<int, Expense> */
    protected function expensesOf(Tenant $tenant): Collection
    {
        return $this->platformQuery(Expense::class)->where('tenant_id', $tenant->id)->orderBy('spent_on')->orderBy('id')->get();
    }

    protected function recurrenceRow(Tenant $tenant, string $id): ExpenseRecurrence
    {
        return $this->platformQuery(ExpenseRecurrence::class)->where('tenant_id', $tenant->id)->whereKey($id)->firstOrFail();
    }

    protected function mediaRow(Tenant $tenant, string $id): ?Media
    {
        return $this->platformQuery(Media::class)->where('tenant_id', $tenant->id)->whereKey($id)->first();
    }

    /** @return list<array<string, mixed>> */
    protected function auditRows(Tenant $tenant, string $prefix = 'expense.'): array
    {
        return $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'like', $prefix.'%')
            ->orderBy('created_at')->orderBy('id')->get()
            ->map(fn ($r) => ['action' => $r->action, 'actor_type' => $r->actor_type, 'meta' => json_decode((string) $r->meta, true)])->all();
    }

    protected function repeat(): void
    {
        $this->artisan('expenses:repeat', ['--sync' => true])->assertSuccessful();
    }
}

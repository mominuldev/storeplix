<?php

namespace App\Domain\DataTransfer\Jobs;

use App\Domain\Catalog\Http\Controllers\ProductController;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Customers\Http\Controllers\CustomerController;
use App\Domain\Customers\Models\Customer;
use App\Domain\DataTransfer\Export\CsvWriter;
use App\Domain\DataTransfer\Import\ImportColumns;
use App\Domain\DataTransfer\Import\ImportValues;
use App\Domain\DataTransfer\Models\DataExport;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\TenantStorage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use League\Csv\Writer;
use Throwable;

/** Queued export (§5.5): streams rows with cursor() to a temp file, then stores it privately for 24 h. */
class RunExport implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $timeout = 300;

    public int $tries = 1;

    public function __construct(public readonly string $exportId)
    {
        $this->onQueue('bulk');
    }

    public function handle(TenantStorage $storage): void
    {
        $export = DataExport::query()->find($this->exportId);
        if ($export === null || $export->status !== DataExport::QUEUED) {
            return;
        }
        $export->forceFill(['status' => DataExport::RUNNING])->save();
        $store = Store::query()->findOrFail($export->store_id);

        $tmp = tempnam(sys_get_temp_dir(), 'exp');
        try {
            $writer = CsvWriter::toPath($tmp);
            $count = $export->type === 'products'
                ? $this->products($writer, $store, $export->filters ?? [])
                : $this->customers($writer, $store, $export->filters ?? []);
            unset($writer);

            $path = $storage->exportPath($export->id);
            $in = fopen($tmp, 'rb');
            $storage->privateDisk()->writeStream($path, $in);
            if (is_resource($in)) {
                fclose($in);
            }
            $export->forceFill([
                'status' => DataExport::COMPLETED,
                'file_path' => $path,
                'row_count' => $count,
                'expires_at' => now()->addHours(DataExport::TTL_HOURS),
            ])->save();
        } finally {
            @unlink($tmp);
        }
    }

    /** @param array<string, mixed> $filters */
    private function products(Writer $writer, Store $store, array $filters): int
    {
        $writer->insertOne(ImportColumns::PRODUCT_FIELDS);
        $listFilter = array_filter([
            'status' => isset($filters['status']) ? implode(',', (array) $filters['status']) : null,
            'category_id' => $filters['category_id'] ?? null,
            'stock' => $filters['stock'] ?? null,
        ]);
        $query = ProductController::filtered($store, $listFilter, trim((string) ($filters['q'] ?? '')))
            ->when(! empty($filters['ids']), fn ($q) => $q->whereIn('products.id', array_map('strtolower', $filters['ids'])))
            ->orderBy('products.created_at')->orderBy('products.id');

        $categories = Category::query()->where('store_id', $store->id)->get(['id', 'parent_id', 'name'])->keyBy('id');
        $path = function (string $id) use ($categories): string {
            $names = [];
            for ($c = $categories[$id] ?? null; $c !== null; $c = $c->parent_id ? ($categories[$c->parent_id] ?? null) : null) {
                array_unshift($names, $c->name);
            }

            return implode(' > ', $names);
        };

        $count = 0;
        foreach ($query->with(['variants.inventory', 'categories', 'images.media'])->lazyById(100, 'products.id', 'id') as $product) {
            /** @var Product $product */
            $options = $product->options ?? [];
            foreach ($product->variants as $i => $variant) {
                /** @var ProductVariant $variant */
                $first = $i === 0;
                $values = $variant->optionValues(count($options));
                $row = [
                    $product->slug,
                    $first ? $product->name : '',
                    $first ? ImportValues::plainText($product->description) : '',
                    $first ? $product->status : '',
                    $first ? implode(' | ', $product->categories->map(fn ($c) => $path($c->id))->all()) : '',
                    $first ? implode(', ', $product->tags ?? []) : '',
                ];
                foreach ([0, 1, 2] as $k) {
                    $row[] = $options[$k]['name'] ?? '';
                    $row[] = $values[$k] ?? '';
                }
                $row = [...$row,
                    $variant->sku ?? '',
                    $variant->barcode ?? '',
                    ImportValues::major($variant->price_amount),
                    ImportValues::major($variant->compare_at_amount),
                    ImportValues::major($variant->cost_amount),
                    (string) ($variant->inventory?->on_hand ?? 0),
                    $variant->weight_grams === null ? '' : rtrim(rtrim(number_format($variant->weight_grams / 1000, 3, '.', ''), '0'), '.'),
                    $first ? ($product->seo_title ?? '') : '',
                    $first ? ($product->seo_description ?? '') : '',
                    $first ? implode(' | ', array_filter($product->images->map(fn ($img) => MediaPresenter::url($img->media, ['w1600', 'w1024']))->all())) : '',
                ];
                $writer->insertOne($row);
                $count++;
            }
        }

        return $count;
    }

    /** @param array<string, mixed> $filters */
    private function customers(Writer $writer, Store $store, array $filters): int
    {
        $writer->insertOne(ImportColumns::CUSTOMER_EXPORT_FIELDS);
        $listFilter = array_filter([
            'channel' => isset($filters['channel']) ? (array) $filters['channel'] : null,
            'tag' => $filters['tag'] ?? null,
            'created_at' => isset($filters['created_from']) ? ['gte' => $filters['created_from']] : null,
        ]);
        $count = 0;
        foreach (CustomerController::filtered($store, $listFilter, trim((string) ($filters['q'] ?? '')))->orderBy('id')->lazyById(500) as $c) {
            /** @var Customer $c */
            $writer->insertOne([
                $c->name, $c->phone ?? '', $c->email ?? '', $c->district ?? '', $c->area ?? '', $c->channel ?? '',
                implode(', ', $c->tags ?? []), $c->accepts_marketing ? 'yes' : 'no',
            ]);
            $count++;
        }

        return $count;
    }

    public function failed(?Throwable $e): void
    {
        Log::error('export.failed', ['export_id' => $this->exportId, 'error' => $e?->getMessage()]);
        if ($this->tenantId !== null) {
            app(TenantContext::class)->run($this->tenantId, fn () => DataExport::query()->whereKey($this->exportId)
                ->whereIn('status', [DataExport::QUEUED, DataExport::RUNNING])->update(['status' => DataExport::FAILED, 'updated_at' => now()]));
        }
    }
}

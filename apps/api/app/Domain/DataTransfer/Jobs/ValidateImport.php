<?php

namespace App\Domain\DataTransfer\Jobs;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\DataTransfer\Import\CustomerImportValidator;
use App\Domain\DataTransfer\Import\ImportFile;
use App\Domain\DataTransfer\Import\ProductImportValidator;
use App\Domain\DataTransfer\Import\SupplierImportValidator;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\DataTransfer\Models\DataImportRow;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/** Dry-run (§5.4): streams the file, writes data_import_rows in batches of 500, fills the summary. Nothing else changes. */
class ValidateImport implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $timeout = 300;

    public int $tries = 1;

    public function __construct(public readonly string $importId)
    {
        $this->onQueue('bulk');
    }

    public function handle(TenantContext $context, TenantCache $cache): void
    {
        $import = DataImport::query()->find($this->importId);
        if ($import === null || $import->status !== DataImport::VALIDATING) {
            return;
        }
        $store = Store::query()->findOrFail($import->store_id);

        $lock = Cache::lock($cache->key("import:{$store->id}"), 600);
        if (! $lock->block(10)) {
            throw new \RuntimeException('Import lock busy.');
        }

        try {
            $result = ImportFile::withLocalPath($import, function (string $path) use ($import, $store, $context) {
                $records = ImportFile::rows($path, $import);
                $options = $import->options + DataImport::DEFAULT_OPTIONS;
                if ($import->type === DataImport::PRODUCTS) {
                    $tenant = $context->tenant();
                    $limit = FeatureGate::limit($tenant, Limit::Products);
                    $remaining = $limit === null ? null : max(0, $limit - FeatureGate::usage($tenant, Limit::Products));

                    return (new ProductImportValidator)->validate($store, $import->column_map ?? [], $options, $records, $remaining);
                }

                if ($import->type === DataImport::SUPPLIERS) {
                    return (new SupplierImportValidator)->validate($store, $import->column_map ?? [], $options, $records);
                }

                return (new CustomerImportValidator)->validate($store, $import->column_map ?? [], $options, $records);
            });

            DB::transaction(function () use ($import, $result) {
                DataImportRow::query()->where('import_id', $import->id)->delete();
                $tenantId = $import->tenant_id;
                foreach (array_chunk($result['rows'], 500) as $chunk) {
                    DataImportRow::query()->insert(array_map(fn (array $row) => [
                        'id' => strtolower((string) Str::ulid()),
                        'tenant_id' => $tenantId,
                        'store_id' => $import->store_id,
                        'import_id' => $import->id,
                        'row_number' => $row['row_number'],
                        'status' => $row['status'],
                        'action' => $row['action'],
                        'label' => $row['label'] === '' ? '—' : $row['label'],
                        'key' => $row['key'] !== null ? mb_substr($row['key'], 0, 254) : null,
                        'values' => json_encode($row['values'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                        'messages' => json_encode($row['messages'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                        'result_id' => null,
                    ], $chunk));
                }
                $import->forceFill([
                    'status' => DataImport::VALIDATED,
                    'summary' => $result['summary'],
                    'row_count' => count($result['rows']),
                    'processed_rows' => count($result['rows']),
                    'validated_at' => now(),
                    'failure_reason' => null,
                ])->save();
            });
        } finally {
            $lock->release();
        }
    }

    public function failed(?Throwable $e): void
    {
        Log::error('import.validate_failed', ['import_id' => $this->importId, 'error' => $e?->getMessage()]);
        if ($this->tenantId !== null) {
            app(TenantContext::class)->run($this->tenantId, fn () => DataImport::query()->whereKey($this->importId)
                ->where('status', DataImport::VALIDATING)
                ->update(['status' => DataImport::FAILED, 'failure_reason' => 'We could not check this file. Try again or contact support.', 'updated_at' => now()]));
        }
    }
}

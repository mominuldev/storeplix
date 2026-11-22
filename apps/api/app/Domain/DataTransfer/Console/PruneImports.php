<?php

namespace App\Domain\DataTransfer\Console;

use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\Media\TenantStorage;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/** Retention (§2): imports older than 30 days lose their file and rows. */
class PruneImports extends Command
{
    protected $signature = 'data:prune-imports {--days=30}';

    protected $description = 'Delete CSV imports (rows + file) older than N days';

    public function handle(TenantContext $context, TenantStorage $storage): int
    {
        $count = 0;
        // cross-tenant: scheduled retention job; each delete then runs inside the row's own tenant.
        DataImport::withoutTenancy()->where('created_at', '<', now()->subDays((int) $this->option('days')))
            ->whereNotIn('status', [DataImport::VALIDATING, DataImport::IMPORTING])
            ->select(['id', 'tenant_id', 'file_path'])->lazyById(200)
            ->each(function (DataImport $import) use ($context, $storage, &$count) {
                $context->run($import->tenant_id, function () use ($import, $storage) {
                    if ($storage->ownsPath($import->file_path)) {
                        $storage->privateDisk()->delete($import->file_path);
                    }
                    DataImport::query()->whereKey($import->id)->delete(); // rows cascade
                });
                $count++;
            });
        $this->info("Pruned {$count} imports.");

        return self::SUCCESS;
    }
}

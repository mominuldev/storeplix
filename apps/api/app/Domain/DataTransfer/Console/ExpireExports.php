<?php

namespace App\Domain\DataTransfer\Console;

use App\Domain\DataTransfer\Models\DataExport;
use App\Domain\Media\TenantStorage;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/** Retention (P4-20): export files are deleted after 24 h and the export becomes `expired`. */
class ExpireExports extends Command
{
    protected $signature = 'data:expire-exports';

    protected $description = 'Delete export files past expires_at and mark them expired';

    public function handle(TenantContext $context, TenantStorage $storage): int
    {
        $count = 0;
        // cross-tenant: scheduled retention job; each update then runs inside the row's own tenant.
        DataExport::withoutTenancy()->where('status', DataExport::COMPLETED)->where('expires_at', '<=', now())
            ->select(['id', 'tenant_id', 'file_path'])->lazyById(200)
            ->each(function (DataExport $export) use ($context, $storage, &$count) {
                $context->run($export->tenant_id, function () use ($export, $storage) {
                    if ($export->file_path !== null && $storage->ownsPath($export->file_path)) {
                        $storage->privateDisk()->delete($export->file_path);
                    }
                    DataExport::query()->whereKey($export->id)->update(['status' => DataExport::EXPIRED, 'file_path' => null, 'updated_at' => now()]);
                });
                $count++;
            });
        $this->info("Expired {$count} exports.");

        return self::SUCCESS;
    }
}

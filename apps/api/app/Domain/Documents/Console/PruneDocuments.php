<?php

namespace App\Domain\Documents\Console;

use App\Domain\Documents\Models\Document;
use App\Domain\Media\TenantStorage;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/** P5B-53 retention: delete files of documents past expires_at (24 h) and mark them `expired`. Hourly. */
class PruneDocuments extends Command
{
    protected $signature = 'documents:prune';

    protected $description = 'Delete generated documents past expires_at and mark them expired';

    public function handle(TenantContext $context, TenantStorage $storage): int
    {
        $count = 0;
        // cross-tenant: scheduled retention job (platform connection); each delete runs inside the row's own tenant.
        Document::withoutTenancy()->where('status', Document::READY)->where('expires_at', '<=', now())
            ->select(['id', 'tenant_id', 'file_path'])->lazyById(200)
            ->each(function (Document $document) use ($context, $storage, &$count) {
                $context->run($document->tenant_id, function () use ($document, $storage) {
                    if ($document->file_path !== null && $storage->ownsPath($document->file_path)) {
                        $storage->privateDisk()->delete($document->file_path);
                    }
                    Document::query()->whereKey($document->id)->update(['status' => Document::EXPIRED, 'file_path' => null, 'updated_at' => now()]);
                });
                $count++;
            });
        $this->info("Expired {$count} documents.");

        return self::SUCCESS;
    }
}

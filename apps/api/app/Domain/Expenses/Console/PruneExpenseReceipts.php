<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Console;

use App\Domain\Expenses\ExpenseReceipts;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * `expenses:prune-receipts` (daily 03:30 UTC, PHASE-8-7 §9): unattached receipts older than 24 h. Discovery on the
 * platform connection; per tenant the ROW is deleted first under `NOT EXISTS (expense with this receipt)` (the FK
 * RESTRICT is the backstop against an attach racing the prune), and the object after commit only when that delete
 * removed the row and the path is under the tenant prefix (S146).
 */
class PruneExpenseReceipts extends Command
{
    protected $signature = 'expenses:prune-receipts';

    protected $description = 'Delete expense receipts never attached to an expense (older than 24 hours)';

    public function handle(TenantContext $context, ExpenseReceipts $receipts): int
    {
        $count = 0;
        // cross-tenant: scheduled retention job (platform connection); each delete runs inside the row's own tenant.
        Media::withoutTenancy()->where('purpose', MediaPurpose::ExpenseReceipt->value)->where('created_at', '<', now()->subDay())
            ->whereNotExists(fn ($q) => $q->select(DB::raw(1))->from('expenses')->whereColumn('expenses.receipt_media_id', 'media.id'))
            ->select(['id', 'tenant_id'])->lazyById(200)
            ->each(function (Media $candidate) use ($context, $receipts, &$count) {
                $context->run($candidate->tenant_id, function () use ($candidate, $receipts, &$count) {
                    DB::transaction(function () use ($candidate, $receipts, &$count) {
                        /** @var Media|null $media */
                        $media = Media::query()->whereKey($candidate->id)->where('purpose', MediaPurpose::ExpenseReceipt->value)->first();
                        if ($media === null) {
                            return;
                        }
                        $deleted = Media::query()->whereKey($media->id)
                            ->whereNotExists(fn ($q) => $q->select(DB::raw(1))->from('expenses')->whereColumn('expenses.receipt_media_id', 'media.id'))
                            ->delete();
                        if ($deleted === 1) {
                            $receipts->deleteObjectAfterCommit($media);
                            $count++;
                        }
                    });
                });
            });
        $this->info("expenses:prune-receipts: {$count} deleted.");

        return self::SUCCESS;
    }
}

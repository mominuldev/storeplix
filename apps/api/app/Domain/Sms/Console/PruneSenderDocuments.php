<?php

declare(strict_types=1);

namespace App\Domain\Sms\Console;

use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Tenancy\Support\PlatformDb;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * PHASE-8-9A §8.2 (S216): the trade licence of a request that ended (rejected | cancelled | superseded | revoked) is
 * deleted from the private disk `sender_document_retention_days` (180) days after it ended. The `media` row stays
 * (sms_sender_ids.document_media_id is NOT NULL with FK RESTRICT) and is marked `failed` with no path left to serve, so
 * it is never pruned twice and the admin stream answers 404. Files are deleted per tenant, only under that tenant's
 * storage prefix.
 */
class PruneSenderDocuments extends Command
{
    protected $signature = 'sms:prune-sender-documents';

    protected $description = 'Prune trade licences of finished sender ID requests (PHASE-8-9A §8.2)';

    public function handle(TenantContext $context, TenantStorage $storage): int
    {
        $before = now()->subDays((int) config('sms.sender_document_retention_days', 180));
        // cross-tenant: sender-ID document retention (platform job on the admin connection)
        $rows = PlatformDb::connection()->table('sms_sender_ids as s')
            ->join('media as m', 'm.id', '=', 's.document_media_id')
            ->whereIn('s.status', SmsSenderId::ENDED)
            ->where('m.status', '<>', Media::FAILED)
            ->where(fn ($q) => $q->where('s.ended_at', '<', $before)->orWhere(fn ($x) => $x->whereNull('s.ended_at')->where('s.reviewed_at', '<', $before)))
            ->get(['s.tenant_id', 's.document_media_id']);
        $pruned = 0;
        foreach ($rows->groupBy('tenant_id') as $tenantId => $group) {
            $context->run((string) $tenantId, function () use ($group, $storage, &$pruned) {
                foreach ($group as $row) {
                    $media = Media::query()->whereKey($row->document_media_id)->where('purpose', MediaPurpose::SenderIdDocument->value)->first();
                    if ($media === null || ! $storage->ownsPath($media->path)) {
                        continue;
                    }
                    $storage->deleteAll($media);
                    $media->forceFill(['status' => Media::FAILED, 'variants' => []])->save();
                    $pruned++;
                }
            });
        }
        $this->info("Pruned {$pruned} sender ID documents.");

        return self::SUCCESS;
    }
}

<?php

declare(strict_types=1);

namespace App\Domain\Ai\Console;

use App\Domain\Ai\AiPhotoLibrary;
use App\Domain\Ai\AiRunner;
use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Support\PlatformDb;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `ai:prune` (daily, PHASE-8-9D §11.3, P89D-18/58): per tenant — unapplied photo results after 7 days, replaced
 * originals after 30 days unless still used anywhere, generation rows (outputs) after 90 days, and generations stuck
 * queued / running for over an hour → failed + refunded. The tenant list comes from the platform connection (ids only);
 * every deletion runs inside TenantContext::run (files under the tenant prefix).
 */
class PruneAi extends Command
{
    protected $signature = 'ai:prune';

    protected $description = 'Prune AI photo results, kept originals and old AI generations';

    public function handle(TenantContext $context, AiPhotoLibrary $photos, AiRunner $runner): int
    {
        $r = (array) config('ai.retention');
        // cross-tenant: retention sweep — tenants that have AI generations (ids only).
        $tenants = PlatformDb::connection()->table('ai_generations')->distinct()->pluck('tenant_id')->all();
        $totals = ['results' => 0, 'originals' => 0, 'rows' => 0, 'stuck' => 0];
        foreach ($tenants as $tenantId) {
            $context->run((string) $tenantId, function () use ($photos, $runner, $r, &$totals) {
                AiGeneration::query()->whereIn('status', [AiGeneration::QUEUED, AiGeneration::RUNNING])->where('updated_at', '<', now()->subHour())
                    ->pluck('id')->each(function (string $id) use ($runner, &$totals) {
                        $runner->abandon($id);
                        $totals['stuck']++;
                    });

                $unapplied = AiGeneration::query()->where('kind', AiGeneration::PHOTO)->whereIn('status', [AiGeneration::SUCCEEDED, AiGeneration::FAILED])
                    ->whereNotNull('result_media_id')->where('created_at', '<', now()->subDays((int) ($r['unapplied_results'] ?? 7)))->get();
                foreach ($unapplied as $g) {
                    $media = Media::query()->whereKey($g->result_media_id)->where('purpose', MediaPurpose::AiPhoto->value)->first();
                    if ($media !== null) {
                        $photos->deleteMedia($media);
                        $totals['results']++;
                    }
                    AiGeneration::query()->whereKey($g->id)->update(['result_media_id' => null, 'updated_at' => now()]);
                }

                // original_media_id stays on the row (undo then answers 409: the keep window is over).
                $kept = AiGeneration::query()->whereNotNull('original_media_id')->where('original_kept_until', '<', now())
                    ->whereIn('original_media_id', Media::query()->select('id'))->get();
                foreach ($kept as $g) {
                    $original = (string) $g->original_media_id;
                    $media = Media::query()->find($original);
                    if ($media !== null && ! AiPhotoLibrary::inUse($original)) {
                        $photos->deleteMedia($media);
                        $totals['originals']++;
                    }
                }

                $totals['rows'] += AiGeneration::query()->where('created_at', '<', now()->subDays((int) ($r['outputs'] ?? 90)))
                    ->whereNotIn('status', [AiGeneration::QUEUED, AiGeneration::RUNNING])->delete();
            });
        }
        $this->info("ai:prune: {$totals['results']} result(s), {$totals['originals']} original(s), {$totals['rows']} generation(s), {$totals['stuck']} stuck job(s).");

        return self::SUCCESS;
    }
}

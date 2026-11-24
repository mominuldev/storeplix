<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Jobs;

use App\Domain\Marketing\CampaignPipeline;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * PHASE-8-5 §5.1 step 1: audience snapshot + allowance check + batch dispatch for a campaign that entered `sending`.
 * Unique per campaign; a second copy only re-dispatches the queued recipients (harmless: claims are conditional).
 */
class StartCampaign implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    /** < REDIS_QUEUE_RETRY_AFTER (360) with margin; the snapshot is DB-only work (chunked inserts). */
    public int $timeout = 240;

    public int $uniqueFor = 300;

    public function __construct(public readonly string $campaignId)
    {
        $this->onQueue((string) config('campaigns.queue', 'campaigns'));
    }

    public function uniqueId(): string
    {
        return 'campaign-start:'.$this->campaignId;
    }

    public function handle(CampaignPipeline $pipeline): void
    {
        $pipeline->start($this->campaignId);
    }
}

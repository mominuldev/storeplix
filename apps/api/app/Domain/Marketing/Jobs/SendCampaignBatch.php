<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Jobs;

use App\Domain\Marketing\CampaignPipeline;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * PHASE-8-5 §5.1 steps 2–4: ≤ 100 recipients of one campaign, on queue `campaigns`. `tries = 1` like SendSms: the
 * provider call is never repeated by the queue (P85-11); a recipient left `sending` becomes `unknown` (reap-stuck).
 */
class SendCampaignBatch implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    /**
     * < REDIS_QUEUE_RETRY_AFTER (360) with margin. The pipeline stops claiming recipients after
     * `campaigns.batch_budget_seconds` (150); the rest stay `queued` and dispatch-due resumes them.
     */
    public int $timeout = 240;

    /** @param list<string> $recipientIds */
    public function __construct(public readonly string $campaignId, public readonly array $recipientIds)
    {
        $this->onQueue((string) config('campaigns.queue', 'campaigns'));
    }

    public function handle(CampaignPipeline $pipeline): void
    {
        $pipeline->sendBatch($this->campaignId, $this->recipientIds);
    }
}

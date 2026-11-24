<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Console;

use App\Domain\Marketing\CampaignPipeline;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `campaigns:reap-stuck` (every 5 min, PHASE-8-5 §5.1 step 5, P85-11): recipients `sending` for more than 15 minutes
 * become `unknown` — never retried (the provider may have accepted the message). Then the campaign may finish.
 */
class ReapStuckRecipients extends Command
{
    protected $signature = 'campaigns:reap-stuck';

    protected $description = 'Mark campaign recipients stuck in sending as unknown';

    public function handle(TenantContext $context): int
    {
        $cutoff = now()->subMinutes((int) config('campaigns.stuck_after_minutes', 15));
        // cross-tenant: scheduler discovery (platform connection); updates run inside each tenant.
        $rows = CampaignRecipient::withoutTenancy()->where('status', CampaignRecipient::SENDING)->where('updated_at', '<', $cutoff)
            ->limit(5000)->get(['id', 'tenant_id', 'campaign_id']);
        $total = 0;
        foreach ($rows->groupBy('tenant_id') as $tenantId => $group) {
            $context->run((string) $tenantId, function () use ($group, $cutoff, &$total) {
                foreach ($group->groupBy('campaign_id') as $campaignId => $recipients) {
                    $total += CampaignRecipient::query()->whereIn('id', $recipients->pluck('id')->all())
                        ->where('status', CampaignRecipient::SENDING)->where('updated_at', '<', $cutoff)
                        ->update(['status' => CampaignRecipient::UNKNOWN, 'updated_at' => now()]);
                    app(CampaignPipeline::class)->finish((string) $campaignId);
                }
            });
        }
        $this->info("campaigns:reap-stuck: {$total} marked unknown.");

        return self::SUCCESS;
    }
}

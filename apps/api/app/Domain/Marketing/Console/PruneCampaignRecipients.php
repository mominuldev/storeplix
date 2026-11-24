<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Console;

use App\Domain\Marketing\Models\CampaignRecipient;
use Illuminate\Console\Command;

/**
 * `campaigns:prune-recipients` (daily, P85-28): recipient rows older than 13 months are deleted in batches; campaign
 * rows and their aggregate counters stay; suppressions are kept forever; conversions keep the campaign (recipient_id
 * is set null).
 */
class PruneCampaignRecipients extends Command
{
    protected $signature = 'campaigns:prune-recipients';

    protected $description = 'Delete campaign recipients older than the retention window';

    public function handle(): int
    {
        $cutoff = now()->subMonths((int) config('campaigns.recipient_retention_months', 13));
        $total = 0;
        do {
            // cross-tenant: retention sweep on the platform connection.
            $ids = CampaignRecipient::withoutTenancy()->where('created_at', '<', $cutoff)
                ->whereNotIn('status', [CampaignRecipient::QUEUED, CampaignRecipient::SENDING])->limit(1000)->pluck('id')->all();
            if ($ids !== []) {
                // cross-tenant: retention sweep on the platform connection.
                $total += CampaignRecipient::withoutTenancy()->whereIn('id', $ids)->delete();
            }
        } while (count($ids) === 1000);
        $this->info("campaigns:prune-recipients: {$total} deleted.");

        return self::SUCCESS;
    }
}

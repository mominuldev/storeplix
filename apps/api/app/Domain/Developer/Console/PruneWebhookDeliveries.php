<?php

declare(strict_types=1);

namespace App\Domain\Developer\Console;

use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use Illuminate\Console\Command;

/** `webhooks:prune-deliveries` (daily, Q135): deletes delivery log rows older than 30 days, in batches. */
class PruneWebhookDeliveries extends Command
{
    protected $signature = 'webhooks:prune-deliveries';

    protected $description = 'Delete outbound webhook deliveries older than the retention window';

    public function handle(): int
    {
        $cutoff = now()->subDays((int) config('webhooks_out.retention_days', 30));
        $total = 0;
        do {
            // cross-tenant: retention sweep on the platform connection.
            $ids = WebhookDelivery::withoutTenancy()->where('created_at', '<', $cutoff)->limit(1000)->pluck('id')->all();
            if ($ids !== []) {
                $total += WebhookDelivery::withoutTenancy()->whereIn('id', $ids)->delete();
            }
        } while (count($ids) === 1000);
        $this->info("webhooks:prune-deliveries: {$total} deleted.");

        return self::SUCCESS;
    }
}
